import { sha256 } from "@noble/hashes/sha256";

import { bytesEqual } from "../codec/hex.js";
import {
  signSchnorr,
  verifySchnorr,
  type FipsIdentity,
} from "../identity/index.js";
import {
  deriveNodeAddr,
  nodeAddrToHex,
  type NodeAddr,
} from "../nodeaddr/index.js";
import {
  decodeSessionDatagramPayload,
  encodeSessionDatagram,
  LinkMessageType,
  type SessionDatagram,
} from "../protocol/link.js";
import { decodeSessionAck, decodeSessionSetup } from "../protocol/session.js";
import {
  decodeTreeAnnouncePayload,
  encodeTreeAnnounce,
  verifyTreeAnnounce,
} from "../protocol/tree.js";
import {
  decodeLookupRequest,
  decodeLookupResponse,
  encodeLookupRequestPayload,
  encodeLookupResponsePayload,
  lookupResponseProofBytes,
  type LookupRequest,
} from "../protocol/discovery.js";
import type {
  Logger,
  Transport,
  TransportAddress,
} from "../transport/types.js";

import { BloomRouting } from "./BloomRouting.js";
import { LearnedRouteTable } from "./LearnedRouteTable.js";
import { OriginLookupRegistry } from "./OriginLookupRegistry.js";
import type { PendingOriginLookup } from "./OriginLookupRegistry.js";
import type { AdjacentPeer } from "./PeerState.js";
import {
  delay,
  discoveryPublicKey,
  isKnownUnhandledLinkMessage,
  lookupReverseKey,
  peerNodeKey,
} from "./routingHelpers.js";
import { TreeState } from "./TreeState.js";

interface PendingRouteResolution {
  promise: Promise<void>;
  abort: AbortController;
}

interface ResolvedRoute {
  transport: Transport;
  remoteAddr: TransportAddress;
  remotePubkey: Uint8Array;
}

interface LookupReversePath {
  peer: AdjacentPeer;
  expiresAtMs: number;
  forwardedNextHops: Set<string>;
  request: LookupRequest;
}

interface FipsRoutingConfig {
  identity: FipsIdentity;
  forwarding: boolean;
  routingMode: "tree" | "reply_learned";
  defaultRoute?: string;
  transports: Transport[];
  logger: Logger;
  randomBytes: (length: number) => Uint8Array;
  getPeers: () => Iterable<AdjacentPeer>;
  getPeerByPubkey: (pubkeyHex: string) => AdjacentPeer | undefined;
  getPeerByNodeAddr: (nodeAddrHex: string) => AdjacentPeer | undefined;
  sendLinkMessage: (
    peer: AdjacentPeer,
    msgType: number,
    payload: Uint8Array,
  ) => Promise<void>;
  connectKnownPeer: (
    transport: Transport,
    remoteAddr: TransportAddress,
    remotePubkey: Uint8Array,
  ) => Promise<void>;
  handleLocalSession: (
    peer: AdjacentPeer,
    srcNodeAddr: NodeAddr,
    payload: Uint8Array,
  ) => Promise<void>;
  emitError: (error: Error, where: string) => void;
  isStarted: () => boolean;
}

const ROUTE_RESOLUTION_TIMEOUT_MS = 5_000;
const MAX_PENDING_ROUTE_RESOLUTIONS = 64;
const LOOKUP_REVERSE_PATH_TTL_MS = 30_000;
const MAX_LOOKUP_REVERSE_PATHS = 256;
const LOOKUP_ORIGIN_TIMEOUT_MS = 5_000;
const LOOKUP_ORIGIN_RETRY_INTERVAL_MS = 250;
const LOOKUP_ORIGIN_TTL = 8;
const MAX_PENDING_ORIGIN_LOOKUPS = 64;
const REPLY_LEARNED_ROUTE_TTL_SECONDS = 300;
const MAX_REPLY_LEARNED_ROUTES_PER_DESTINATION = 4;
const MAX_REPLY_LEARNED_LOOKUP_PEERS = 16;
const FSP_DEFAULT_PATH_MTU = 1_200;

export class FipsRouting {
  private readonly treeState: TreeState;
  private readonly pendingRouteResolutions = new Map<string, PendingRouteResolution>();
  private readonly lookupReversePaths = new Map<string, LookupReversePath>();
  private readonly originLookups = new OriginLookupRegistry(MAX_PENDING_ORIGIN_LOOKUPS);
  private readonly learnedRoutes = new LearnedRouteTable();
  private readonly coordCache = new Map<string, NodeAddr[]>();
  private readonly bloomRouting: BloomRouting;

  constructor(private readonly cfg: FipsRoutingConfig) {
    this.treeState = new TreeState(cfg.identity);
    this.bloomRouting = new BloomRouting({
      identity: cfg.identity,
      logger: cfg.logger,
      getPeers: cfg.getPeers,
      isTreePeer: (nodeAddr) => this.treeState.isTreePeer(nodeAddr),
      sendLinkMessage: cfg.sendLinkMessage,
      emitError: cfg.emitError,
    });
  }

  get coords(): NodeAddr[] {
    return this.treeState.coords;
  }

  coordinatesFor(nodeAddrHex: string): NodeAddr[] | undefined {
    return this.coordCache.get(nodeAddrHex);
  }

  stop(): void {
    for (const pending of this.pendingRouteResolutions.values()) {
      pending.abort.abort();
    }
    this.originLookups.stop();
    this.pendingRouteResolutions.clear();
    this.lookupReversePaths.clear();
    this.learnedRoutes.clear();
  }

  removePeer(peerNodeAddr: NodeAddr): void {
    const wasTreePeer = this.treeState.isTreePeer(peerNodeAddr);
    const parentChanged = this.treeState.removePeer(peerNodeAddr);
    if (parentChanged) void this.sendTreeAnnounceToAll();
    if (parentChanged || wasTreePeer) void this.bloomRouting.sendAll();
  }

  async handleLinkMessage(
    peer: AdjacentPeer,
    msgType: number,
    payload: Uint8Array,
  ): Promise<void> {
    if (msgType === LinkMessageType.TreeAnnounce) {
      await this.handleTreeAnnounce(peer, payload);
      return;
    }
    if (msgType === LinkMessageType.FilterAnnounce) {
      await this.bloomRouting.handle(peer, payload);
      return;
    }
    if (msgType === LinkMessageType.LookupRequest) {
      await this.handleLookupRequest(peer, payload);
      return;
    }
    if (msgType === LinkMessageType.LookupResponse) {
      if (await this.handleOriginLookupResponse(peer, payload)) return;
      if (this.cfg.forwarding) await this.forwardLookupResponse(peer, payload);
      return;
    }
    if (msgType !== LinkMessageType.SessionDatagram) {
      if (isKnownUnhandledLinkMessage(msgType)) return;
      this.cfg.logger.warn("unsupported FMP link message", msgType);
      return;
    }

    const datagram = decodeSessionDatagramPayload(payload);
    this.cacheSessionCoordinates(datagram);
    if (bytesEqual(datagram.destAddr, this.cfg.identity.nodeAddr)) {
      this.cfg.logger.debug(
        "session datagram delivered locally",
        nodeAddrToHex(datagram.srcAddr),
        "phase",
        datagram.payload[0]! & 0x0f,
        "bytes",
        datagram.payload.length,
      );
      await this.cfg.handleLocalSession(peer, datagram.srcAddr, datagram.payload);
      return;
    }

    if (!this.cfg.forwarding) {
      this.cfg.logger.warn("dropping SessionDatagram; forwarding=false");
      return;
    }
    if (datagram.ttl <= 1) {
      this.cfg.logger.warn("dropping SessionDatagram; ttl exhausted");
      return;
    }
    this.cfg.logger.debug(
      "session datagram forwarded",
      nodeAddrToHex(datagram.srcAddr),
      nodeAddrToHex(datagram.destAddr),
      "phase",
      datagram.payload[0]! & 0x0f,
      "bytes",
      datagram.payload.length,
      "ttl",
      datagram.ttl,
    );
    await this.sendSessionDatagram({ ...datagram, ttl: datagram.ttl - 1 }, peer);
  }

  async sendTreeAnnounce(peer: AdjacentPeer): Promise<void> {
    if (peer.link.state !== "established") return;
    const encoded = encodeTreeAnnounce(this.treeState.announce());
    await this.cfg.sendLinkMessage(peer, LinkMessageType.TreeAnnounce, encoded.subarray(1));
  }

  scheduleTreeAnnounce(peer: AdjacentPeer): void {
    if (!peer.filterAnnounced) {
      peer.filterAnnounced = true;
      this.bloomRouting.schedule(peer);
    }
    if (peer.treeAnnounced) return;
    peer.treeAnnounced = true;
    setTimeout(() => {
      void this.sendTreeAnnounce(peer).catch((error) => {
        peer.treeAnnounced = false;
        this.cfg.emitError(error as Error, "send TreeAnnounce");
      });
    }, 0);
  }

  async replayPendingLookupsFor(peer: AdjacentPeer): Promise<void> {
    if (peer.link.state !== "established") return;
    const peerKey = peerNodeKey(peer);
    if (this.cfg.getPeerByNodeAddr(peerKey) !== peer) return;
    this.pruneLookupReversePaths(Date.now());
    const pending = [...this.lookupReversePaths.values()].filter((reverse) =>
      nodeAddrToHex(reverse.request.target) === peerKey
      && peerNodeKey(reverse.peer) !== peerKey
      && !reverse.forwardedNextHops.has(peerKey)
      && (reverse.request.minMtu === 0 || peer.transport.mtu >= reverse.request.minMtu)
    );
    await Promise.all(pending.map(async (reverse) => {
      reverse.forwardedNextHops.add(peerKey);
      try {
        await this.cfg.sendLinkMessage(
          peer,
          LinkMessageType.LookupRequest,
          encodeLookupRequestPayload(reverse.request),
        );
        this.cfg.logger.debug(
          "pending lookup replayed to established target",
          peerKey,
        );
      } catch (error) {
        reverse.forwardedNextHops.delete(peerKey);
        this.cfg.emitError(error as Error, "replay pending LookupRequest");
      }
    }));
  }

  async ensureFirstContactRoute(
    target: NodeAddr,
    targetHex: string,
    targetPubkey: Uint8Array,
  ): Promise<void> {
    const existing = this.originLookups.get(targetHex);
    if (existing) {
      await existing.promise;
      return;
    }
    const pending = this.originLookups.create({
      targetHex,
      targetPubkey,
      randomBytes: () => this.cfg.randomBytes(8),
      timeoutMs: LOOKUP_ORIGIN_TIMEOUT_MS,
    });

    const encoded = encodeLookupRequestPayload({
      requestId: pending.requestId,
      target,
      origin: this.cfg.identity.nodeAddr,
      ttl: LOOKUP_ORIGIN_TTL,
      minMtu: 0,
      originCoords: this.treeState.coords,
    });
    const retrying = this.retryOriginLookup(pending, encoded);
    try {
      await pending.promise;
    } finally {
      await retrying;
    }
  }

  private async refreshTransitRoute(
    target: NodeAddr,
    targetHex: string,
    previousHop: AdjacentPeer,
  ): Promise<void> {
    const existing = this.originLookups.get(targetHex);
    if (existing) {
      await existing.promise;
      return;
    }
    if (this.originLookupPeers(previousHop).length === 0) {
      throw new Error(`no route to ${targetHex}`);
    }
    const pending = this.originLookups.create({
      targetHex,
      randomBytes: () => this.cfg.randomBytes(8),
      timeoutMs: LOOKUP_ORIGIN_TIMEOUT_MS,
    });
    const encoded = encodeLookupRequestPayload({
      requestId: pending.requestId,
      target,
      origin: this.cfg.identity.nodeAddr,
      ttl: LOOKUP_ORIGIN_TTL,
      minMtu: 0,
      originCoords: this.treeState.coords,
    });
    const retrying = this.retryOriginLookup(pending, encoded, previousHop);
    try {
      await pending.promise;
    } finally {
      await retrying;
    }
  }

  async sendFspToward(remoteNodeAddr: NodeAddr, fspFrame: Uint8Array): Promise<void> {
    await this.sendSessionDatagram({
      ttl: 64,
      pathMtu: FSP_DEFAULT_PATH_MTU,
      srcAddr: this.cfg.identity.nodeAddr,
      destAddr: remoteNodeAddr,
      payload: fspFrame,
    });
  }

  async sendFspReplyToward(
    remoteNodeAddr: NodeAddr,
    fspFrame: Uint8Array,
    previousHop: AdjacentPeer,
  ): Promise<void> {
    const datagram: SessionDatagram = {
      ttl: 64,
      pathMtu: FSP_DEFAULT_PATH_MTU,
      srcAddr: this.cfg.identity.nodeAddr,
      destAddr: remoteNodeAddr,
      payload: fspFrame,
    };
    this.cfg.logger.debug(
      "session datagram reply routed",
      nodeAddrToHex(datagram.srcAddr),
      nodeAddrToHex(datagram.destAddr),
      "phase",
      datagram.payload[0]! & 0x0f,
      "bytes",
      datagram.payload.length,
      previousHop.remoteAddr.transport,
      previousHop.remoteAddr.addr,
    );
    const encoded = encodeSessionDatagram(datagram);
    await this.cfg.sendLinkMessage(
      previousHop,
      LinkMessageType.SessionDatagram,
      encoded.subarray(1),
    );
  }

  learnReverseRoute(destinationNodeHex: string, nextHop: AdjacentPeer): void {
    if (this.cfg.routingMode !== "reply_learned") return;
    const localNodeHex = nodeAddrToHex(this.cfg.identity.nodeAddr);
    const nextHopNodeHex = nodeAddrToHex(deriveNodeAddr(nextHop.pubkey));
    if (destinationNodeHex === localNodeHex) return;
    this.learnedRoutes.learn(
      destinationNodeHex,
      nextHopNodeHex,
      Date.now(),
      REPLY_LEARNED_ROUTE_TTL_SECONDS,
      MAX_REPLY_LEARNED_ROUTES_PER_DESTINATION,
    );
  }

  private async sendTreeAnnounceToAll(): Promise<void> {
    const peers = [...this.cfg.getPeers()].filter(
      (peer) => peer.link.state === "established",
    );
    await Promise.allSettled(peers.map((peer) => this.sendTreeAnnounce(peer)));
  }

  private async handleTreeAnnounce(peer: AdjacentPeer, payload: Uint8Array): Promise<void> {
    const announce = decodeTreeAnnouncePayload(payload);
    const peerNodeAddr = deriveNodeAddr(peer.pubkey);
    if (!bytesEqual(announce.ancestry[0]!.nodeAddr, peerNodeAddr)) {
      throw new Error("TreeAnnounce node address does not match authenticated peer");
    }
    if (!verifyTreeAnnounce(announce, peer.pubkey)) {
      throw new Error("TreeAnnounce signature verification failed");
    }
    const wasTreePeer = this.treeState.isTreePeer(peerNodeAddr);
    const changed = this.treeState.updatePeer(peerNodeAddr, announce);
    const isTreePeer = this.treeState.isTreePeer(peerNodeAddr);
    this.cfg.logger.debug(
      "tree announce accepted",
      nodeAddrToHex(peerNodeAddr),
      "depth",
      announce.ancestry.length - 1,
      "root",
      nodeAddrToHex(announce.ancestry.at(-1)!.nodeAddr),
    );
    if (changed) await this.sendTreeAnnounceToAll();
    if (changed || wasTreePeer !== isTreePeer) await this.bloomRouting.sendAll();
  }

  private cacheSessionCoordinates(datagram: SessionDatagram): void {
    const phase = datagram.payload[0]! & 0x0f;
    try {
      if (phase === 1) {
        const setup = decodeSessionSetup(datagram.payload);
        this.cacheCoordinates(datagram.srcAddr, setup.srcCoords);
        this.cacheCoordinates(datagram.destAddr, setup.destCoords);
      } else if (phase === 2) {
        const ack = decodeSessionAck(datagram.payload);
        this.cacheCoordinates(datagram.srcAddr, ack.srcCoords);
        this.cacheCoordinates(datagram.destAddr, ack.destCoords);
      }
    } catch (error) {
      this.cfg.logger.warn("invalid FSP session coordinates", error);
    }
  }

  private cacheCoordinates(nodeAddr: NodeAddr, coords: NodeAddr[]): void {
    if (coords.length === 0 || !bytesEqual(coords[0]!, nodeAddr)) return;
    this.coordCache.set(nodeAddrToHex(nodeAddr), coords.map((entry) => new Uint8Array(entry)));
  }

  private async handleLookupRequest(
    sourcePeer: AdjacentPeer,
    payload: Uint8Array,
  ): Promise<void> {
    const request = decodeLookupRequest(payload);
    const targetHex = nodeAddrToHex(request.target);
    if (bytesEqual(request.target, this.cfg.identity.nodeAddr)) {
      const targetCoords = this.treeState.coords;
      const proof = signSchnorr(
        this.cfg.identity,
        sha256(lookupResponseProofBytes(request.requestId, request.target, targetCoords)),
      );
      await this.cfg.sendLinkMessage(
        sourcePeer,
        LinkMessageType.LookupResponse,
        encodeLookupResponsePayload({
          requestId: request.requestId,
          target: request.target,
          pathMtu: Math.min(0xffff, sourcePeer.transport.mtu),
          targetCoords,
          proof,
        }),
      );
      this.cfg.logger.debug("lookup request answered locally", targetHex);
      return;
    }
    if (!this.cfg.forwarding || request.ttl === 0) {
      this.cfg.logger.debug("lookup request not forwarded", targetHex, "disabled-or-expired");
      return;
    }
    const reverseKey = lookupReverseKey(request.requestId, request.target);
    this.pruneLookupReversePaths(Date.now());
    const existingReverse = this.lookupReversePaths.get(reverseKey);
    if (existingReverse && peerNodeKey(existingReverse.peer) !== peerNodeKey(sourcePeer)) return;
    if (existingReverse) existingReverse.peer = sourcePeer;

    const directOrLearned = this.nextHopFor(targetHex, sourcePeer);
    const fallbackPeers = !directOrLearned
      ? [...this.cfg.getPeers()]
        .filter((peer) =>
          peer !== sourcePeer
          && peer.link.state === "established"
          && (
            this.treeState.isTreePeer(deriveNodeAddr(peer.pubkey))
            || this.cfg.routingMode === "reply_learned"
          )
          && nodeAddrToHex(deriveNodeAddr(peer.pubkey)) !== nodeAddrToHex(request.origin)
          && (request.minMtu === 0 || peer.transport.mtu >= request.minMtu)
        )
        .slice(0, MAX_REPLY_LEARNED_LOOKUP_PEERS)
      : [];
    const nextHops = (directOrLearned ? [directOrLearned] : fallbackPeers)
      .filter((nextHop) => !existingReverse?.forwardedNextHops.has(peerNodeKey(nextHop)));
    const canResolveDirectly = this.canResolveLookupDirectly(
      directOrLearned,
      fallbackPeers.length > 0,
    );
    if (!this.lookupCanProgress(nextHops, canResolveDirectly)) {
      this.cfg.logger.debug("lookup request not forwarded", targetHex, "no-next-hop");
      return;
    }
    if (directOrLearned && request.minMtu !== 0 && directOrLearned.transport.mtu < request.minMtu) {
      this.cfg.logger.debug("lookup request not forwarded", targetHex, "mtu");
      return;
    }
    const reverse = existingReverse ?? {
      peer: sourcePeer,
      expiresAtMs: Date.now() + LOOKUP_REVERSE_PATH_TTL_MS,
      forwardedNextHops: new Set<string>(),
      request: { ...request, ttl: request.ttl - 1 },
    };
    if (!existingReverse) {
      this.reserveLookupReversePath();
      this.lookupReversePaths.set(reverseKey, reverse);
    }
    if (canResolveDirectly) {
      void this.resolveAndForwardLookup(
        targetHex,
        reverseKey,
        reverse,
        sourcePeer,
      );
    }
    if (nextHops.length === 0) return;
    for (const nextHop of nextHops) reverse.forwardedNextHops.add(peerNodeKey(nextHop));
    const encoded = encodeLookupRequestPayload(reverse.request);
    const results = await Promise.allSettled(
      nextHops.map((nextHop) =>
        this.cfg.sendLinkMessage(nextHop, LinkMessageType.LookupRequest, encoded)
      ),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const nextHop = nextHops[index];
        if (nextHop) reverse.forwardedNextHops.delete(peerNodeKey(nextHop));
      }
    });
    if (results.every((result) => result.status === "rejected")) {
      if (reverse.forwardedNextHops.size === 0) this.lookupReversePaths.delete(reverseKey);
      throw new Error(`failed to forward lookup request for ${targetHex}`);
    }
    this.cfg.logger.debug("lookup request forwarded", targetHex, nextHops.length);
  }

  private async resolveAndForwardLookup(
    targetHex: string,
    reverseKey: string,
    reverse: LookupReversePath,
    sourcePeer: AdjacentPeer,
  ): Promise<void> {
    try {
      await this.resolveRoute(reverse.request.target, targetHex);
    } catch {
      this.cfg.logger.debug("lookup target transport resolution failed", targetHex);
      return;
    }
    if (this.lookupReversePaths.get(reverseKey) !== reverse) return;
    const nextHop = this.nextHopFor(targetHex, sourcePeer);
    if (
      !nextHop
      || (reverse.request.minMtu !== 0 && nextHop.transport.mtu < reverse.request.minMtu)
    ) return;
    const nextHopKey = peerNodeKey(nextHop);
    if (reverse.forwardedNextHops.has(nextHopKey)) return;
    reverse.forwardedNextHops.add(nextHopKey);
    try {
      await this.cfg.sendLinkMessage(
        nextHop,
        LinkMessageType.LookupRequest,
        encodeLookupRequestPayload(reverse.request),
      );
      this.cfg.logger.debug("lookup request forwarded after transport resolution", targetHex);
    } catch (error) {
      reverse.forwardedNextHops.delete(nextHopKey);
      this.cfg.emitError(error as Error, "forward resolved LookupRequest");
    }
  }

  private canResolveLookupDirectly(
    nextHop: AdjacentPeer | undefined,
    hasFallbackPeer = false,
  ): boolean {
    if (nextHop || hasFallbackPeer) return false;
    return this.cfg.transports.some((transport) => transport.resolve !== undefined);
  }

  private lookupCanProgress(nextHops: AdjacentPeer[], canResolveDirectly: boolean): boolean {
    return nextHops.length > 0 || canResolveDirectly;
  }

  private async forwardLookupResponse(
    sourcePeer: AdjacentPeer,
    payload: Uint8Array,
  ): Promise<void> {
    const response = decodeLookupResponse(payload);
    const reverseKey = lookupReverseKey(response.requestId, response.target);
    this.pruneLookupReversePaths(Date.now());
    const reverse = this.lookupReversePaths.get(reverseKey);
    if (!reverse || reverse.peer === sourcePeer) {
      this.cfg.logger.debug("lookup response not forwarded", nodeAddrToHex(response.target));
      return;
    }
    this.cacheCoordinates(response.target, response.targetCoords);
    this.learnReverseRoute(nodeAddrToHex(response.target), sourcePeer);
    this.lookupReversePaths.delete(reverseKey);
    response.pathMtu = Math.min(response.pathMtu, reverse.peer.transport.mtu);
    await this.cfg.sendLinkMessage(
      reverse.peer,
      LinkMessageType.LookupResponse,
      encodeLookupResponsePayload(response),
    );
    this.cfg.logger.debug(
      "lookup response forwarded",
      nodeAddrToHex(response.target),
      reverse.peer.remoteAddr.transport,
      reverse.peer.remoteAddr.addr,
    );
  }

  private async handleOriginLookupResponse(
    sourcePeer: AdjacentPeer,
    payload: Uint8Array,
  ): Promise<boolean> {
    const response = decodeLookupResponse(payload);
    const pending = this.originLookups.findRequest(response.requestId);
    if (!pending) return false;
    if (nodeAddrToHex(response.target) !== pending.targetHex) return true;
    // A locally originated first-contact lookup knows the compressed target
    // key and verifies its proof. A transit refresh only knows the NodeAddr;
    // its established end-to-end FSP session still authenticates payloads,
    // while this response is used solely to relearn a forwarding path.
    if (pending.targetPubkey) {
      const proofDigest = sha256(
        lookupResponseProofBytes(response.requestId, response.target, response.targetCoords),
      );
      const proofValid = verifySchnorr(
        response.proof,
        proofDigest,
        pending.targetPubkey.subarray(1),
      );
      if (!proofValid) {
        this.cfg.logger.warn("lookup response proof verification failed", pending.targetHex);
        return true;
      }
    }
    if (!bytesEqual(response.targetCoords[0]!, response.target)) {
      this.cfg.logger.warn("lookup response coordinates do not start at target", pending.targetHex);
      return true;
    }
    this.cacheCoordinates(response.target, response.targetCoords);
    this.learnReverseRoute(pending.targetHex, sourcePeer);
    this.originLookups.complete(pending);
    this.cfg.logger.debug("lookup response accepted", pending.targetHex);
    return true;
  }

  private originLookupPeers(excludedPeer?: AdjacentPeer): AdjacentPeer[] {
    const defaultPeer = this.cfg.defaultRoute
      ? this.cfg.getPeerByPubkey(this.cfg.defaultRoute)
      : undefined;
    return [...this.cfg.getPeers()]
      .filter((peer) => {
        if (peer === excludedPeer || peer.link.state !== "established") return false;
        if (this.cfg.routingMode === "reply_learned") return true;
        return peer === defaultPeer || this.treeState.isTreePeer(deriveNodeAddr(peer.pubkey));
      })
      .slice(0, MAX_REPLY_LEARNED_LOOKUP_PEERS);
  }

  private async retryOriginLookup(
    pending: PendingOriginLookup,
    encoded: Uint8Array,
    excludedPeer?: AdjacentPeer,
  ): Promise<void> {
    while (this.originLookups.get(pending.targetHex) === pending) {
      const peers = this.originLookupPeers(excludedPeer);
      await Promise.allSettled(
        peers.map((peer) =>
          this.cfg.sendLinkMessage(peer, LinkMessageType.LookupRequest, encoded)
        ),
      );
      if (this.originLookups.get(pending.targetHex) !== pending) return;
      await Promise.race([
        pending.promise.catch(() => undefined),
        delay(LOOKUP_ORIGIN_RETRY_INTERVAL_MS),
      ]);
    }
  }

  private async sendSessionDatagram(
    datagram: SessionDatagram,
    previousHop?: AdjacentPeer,
  ): Promise<void> {
    const destNodeHex = nodeAddrToHex(datagram.destAddr);
    let nextHop = this.nextHopFor(destNodeHex, previousHop);
    if (!nextHop && !previousHop) {
      await this.resolveRoute(datagram.destAddr, destNodeHex);
      nextHop = this.nextHopFor(destNodeHex, previousHop);
    }
    if (!nextHop && previousHop) {
      await this.refreshTransitRoute(datagram.destAddr, destNodeHex, previousHop);
      nextHop = this.nextHopFor(destNodeHex, previousHop);
    }
    if (!nextHop) throw new Error(`no route to ${destNodeHex}`);

    this.cfg.logger.debug(
      "session datagram routed",
      nodeAddrToHex(datagram.srcAddr),
      destNodeHex,
      "phase",
      datagram.payload[0]! & 0x0f,
      "bytes",
      datagram.payload.length,
      nextHop.remoteAddr.transport,
      nextHop.remoteAddr.addr,
    );

    const encoded = encodeSessionDatagram(datagram);
    const outer = nextHop.link.encryptOutgoing(
      encoded.subarray(1),
      LinkMessageType.SessionDatagram,
    );
    await nextHop.transport.send(nextHop.remoteAddr, outer);
  }

  private nextHopFor(
    destNodeHex: string,
    excludedPeer?: AdjacentPeer,
  ): AdjacentPeer | undefined {
    const direct = this.cfg.getPeerByNodeAddr(destNodeHex);
    if (direct?.link.state === "established" && direct !== excludedPeer) return direct;
    if (this.cfg.routingMode === "reply_learned") {
      const learnedNodeHex = this.learnedRoutes.selectNextHop(
        destNodeHex,
        Date.now(),
        (nextHop) => {
          const candidate = this.cfg.getPeerByNodeAddr(nextHop);
          return candidate?.link.state === "established" && candidate !== excludedPeer;
        },
      );
      if (learnedNodeHex) return this.cfg.getPeerByNodeAddr(learnedNodeHex);
    }
    const destCoords = this.coordCache.get(destNodeHex);
    if (destCoords) {
      const treeNodeHex = this.treeState.nextHop(destCoords, (nodeHex) => {
        const candidate = this.cfg.getPeerByNodeAddr(nodeHex);
        return candidate?.link.state === "established" && candidate !== excludedPeer;
      });
      if (treeNodeHex) return this.cfg.getPeerByNodeAddr(treeNodeHex);
    }
    const defaultPeer = this.cfg.defaultRoute
      ? this.cfg.getPeerByPubkey(this.cfg.defaultRoute)
      : undefined;
    return defaultPeer?.link.state === "established" && defaultPeer !== excludedPeer
      ? defaultPeer
      : undefined;
  }

  private pruneLookupReversePaths(nowMs: number): void {
    for (const [key, reverse] of this.lookupReversePaths) {
      if (reverse.expiresAtMs <= nowMs) this.lookupReversePaths.delete(key);
    }
  }

  private reserveLookupReversePath(): void {
    if (this.lookupReversePaths.size < MAX_LOOKUP_REVERSE_PATHS) return;
    const oldest = this.lookupReversePaths.keys().next().value as string | undefined;
    if (oldest !== undefined) this.lookupReversePaths.delete(oldest);
  }

  private async resolveRoute(destNodeAddr: NodeAddr, destNodeHex: string): Promise<void> {
    const existing = this.pendingRouteResolutions.get(destNodeHex);
    if (existing) {
      await existing.promise;
      return;
    }
    if (this.pendingRouteResolutions.size >= MAX_PENDING_ROUTE_RESOLUTIONS) {
      throw new Error(`route resolution capacity exceeded for ${destNodeHex}`);
    }

    const abort = new AbortController();
    const promise = this.resolveAndConnectRoute(destNodeAddr, destNodeHex, abort);
    this.pendingRouteResolutions.set(destNodeHex, { promise, abort });
    try {
      await promise;
    } finally {
      if (this.pendingRouteResolutions.get(destNodeHex)?.promise === promise) {
        this.pendingRouteResolutions.delete(destNodeHex);
      }
    }
  }

  private async resolveAndConnectRoute(
    destNodeAddr: NodeAddr,
    destNodeHex: string,
    abort: AbortController,
  ): Promise<void> {
    const resolvers = this.cfg.transports.filter(
      (transport): transport is Transport & Required<Pick<Transport, "resolve">> =>
        transport.resolve !== undefined,
    );
    if (resolvers.length === 0) throw new Error(`no route to ${destNodeHex}`);

    const resolutionTasks = resolvers.map(async (transport): Promise<ResolvedRoute> => {
      const discovered = await transport.resolve(destNodeAddr, abort.signal);
      if (!discovered) throw new Error("transport did not resolve destination");
      if (discovered.remoteAddr.transport !== transport.type) {
        throw new Error("resolved address transport mismatch");
      }
      const remotePubkey = discoveryPublicKey(discovered);
      if (!bytesEqual(deriveNodeAddr(remotePubkey), destNodeAddr)) {
        throw new Error("resolved identity does not match destination NodeAddr");
      }
      return { transport, remoteAddr: discovered.remoteAddr, remotePubkey };
    });
    const noRoute = (): Error => new Error(`no route to ${destNodeHex}`);
    const candidate = Promise.any(resolutionTasks).catch(() => {
      throw noRoute();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const boundary = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.cfg.isStarted() ? noRoute() : new Error("FIPS node stopped"));
      abort.signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => abort.abort(), ROUTE_RESOLUTION_TIMEOUT_MS);
    });

    let resolved: ResolvedRoute;
    try {
      resolved = await Promise.race([candidate, boundary]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) abort.signal.removeEventListener("abort", onAbort);
      if (!abort.signal.aborted) abort.abort();
    }
    await this.cfg.connectKnownPeer(
      resolved.transport,
      resolved.remoteAddr,
      resolved.remotePubkey,
    );
  }
}
