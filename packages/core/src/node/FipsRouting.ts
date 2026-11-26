import { sha256 } from "@noble/hashes/sha256";

import { bytesEqual } from "../codec/hex.js";
import { signSchnorr, verifySchnorr, type FipsIdentity } from "../identity/index.js";
import { nodeAddrToHex, type NodeAddr } from "../nodeaddr/index.js";
import {
  encodeSessionDatagramPayload, LinkMessageType, parseSessionDatagramPayload,
  SESSION_DATAGRAM_HEADER_SIZE, type SessionDatagram,
} from "../protocol/link.js";
import { decodeSessionAck, decodeSessionSetup } from "../protocol/session.js";
import {
  decodeLinkExtension, encodeExtensionCapabilities, encodeExtensionClientOnly,
  FMP_EXTENSION_CLIENT_ROLE,
} from "../protocol/extensions.js";
import { FSP_FLAG_CP, parseFspEstablished } from "../fsp/wire.js";
import { FMP_AEAD_TAG_LEN, FMP_ESTABLISHED_HEADER_LEN } from "../fmp/wire.js";
import { decodeTreeAnnouncePayload, encodeTreeAnnounce, verifyTreeAnnounce } from "../protocol/tree.js";
import {
  decodeLookupRequest, decodeLookupResponse, encodeLookupRequestPayload,
  encodeLookupResponsePayload, lookupResponseProofBytes, type LookupRequest,
} from "../protocol/discovery.js";
import { noopLogger, type Logger, type Transport, type TransportAddress } from "../transport/types.js";

import { BloomRouting } from "./BloomRouting.js";
import { LearnedRouteTable } from "./LearnedRouteTable.js";
import { LookupBackoff, LookupForwardDeferrals, LookupForwardLimiter } from "./LookupLimits.js";
import { OriginLookupRegistry, type PendingOriginLookup } from "./OriginLookupRegistry.js";
import { peerNodeAddr, peerNodeKey, type AdjacentPeer } from "./PeerState.js";
import {
  frameCapacity, isKnownUnhandledLinkMessage, lookupReverseKey,
  resolveTransportIdentity, selectCarrier,
} from "./routingHelpers.js";
import { TreeState } from "./TreeState.js";

interface PendingRouteResolution { promise: Promise<void>; abort: AbortController; }
type OutboundSessionDatagram = Omit<SessionDatagram, "payload"> & {
  payload: Uint8Array | ((nextHop: AdjacentPeer) => Uint8Array[]);
};
interface LookupReversePath {
  peer: AdjacentPeer; expiresAtMs: number; forwardedNextHops: Set<string>; request: LookupRequest;
}

interface FipsRoutingConfig {
  identity: FipsIdentity;
  forwarding: boolean;
  strictClient?: boolean;
  assertNodeAllowed?: (nodeAddr: NodeAddr) => void;
  routingMode: "tree" | "reply_learned";
  defaultRoute?: string;
  transports: Transport[];
  logger: Logger;
  randomBytes: (length: number) => Uint8Array;
  getPeers: () => Iterable<AdjacentPeer>;
  getPeerByPubkey: (pubkeyHex: string) => AdjacentPeer | undefined;
  getPeerByNodeAddr: (nodeAddrHex: string) => AdjacentPeer | undefined;
  sendLinkMessage: (peer: AdjacentPeer, msgType: number, payload: Uint8Array) => Promise<void>;
  connectKnownPeer: (transport: Transport, remoteAddr: TransportAddress, remotePubkey: Uint8Array) => Promise<void>;
  handleLocalSession: (peer: AdjacentPeer, srcNodeAddr: NodeAddr, payload: Uint8Array) => Promise<void>;
  emitError: (error: Error, where: string) => void;
  isStarted: () => boolean;
}

const MAX_PENDING_ROUTE_RESOLUTIONS = 64;
const MAX_COORD_CACHE_ENTRIES = 4_096;
const LOOKUP_REVERSE_PATH_TTL_MS = 30_000;
const MAX_LOOKUP_REVERSE_PATHS = 256;
const LOOKUP_ORIGIN_TIMEOUT_MS = 5_000;
const LOOKUP_ORIGIN_TTL = 8;
const MAX_PENDING_ORIGIN_LOOKUPS = 64;
const REPLY_LEARNED_ROUTE_TTL_SECONDS = 300;
const MAX_REPLY_LEARNED_ROUTES_PER_DESTINATION = 4;
const MAX_REPLY_LEARNED_LOOKUP_PEERS = 16;
const FSP_DEFAULT_PATH_MTU = 1_200;
const MAX_LEGACY_SUPPORT_PROBES = 3;
// SessionDatagram already includes the message type; FMP adds its timestamp,
// established header and authentication tag around the forwarding envelope.
const ROUTED_FRAME_OVERHEAD = SESSION_DATAGRAM_HEADER_SIZE
  + FMP_ESTABLISHED_HEADER_LEN + FMP_AEAD_TAG_LEN + 4;

export class FipsRouting {
  private readonly treeState: TreeState;
  private readonly pendingRouteResolutions = new Map<string, PendingRouteResolution>();
  private readonly lookupReversePaths = new Map<string, LookupReversePath>();
  private readonly originLookups = new OriginLookupRegistry(MAX_PENDING_ORIGIN_LOOKUPS);
  private readonly learnedRoutes = new LearnedRouteTable();
  private readonly coordCache = new Map<string, NodeAddr[]>();
  private readonly lookupBackoff = new LookupBackoff();
  private readonly lookupForwardLimiter = new LookupForwardLimiter();
  private readonly deferredLookupForwards = new LookupForwardDeferrals();
  private readonly bloomRouting: BloomRouting;
  private readonly localNodeAddrHex: string;
  private readonly debugEnabled: boolean;
  private cachedTreeAnnounce?: { announce: ReturnType<TreeState["announce"]>; payload: Uint8Array };
  private pendingTreeBroadcast?: Promise<void>;
  private clientSequence = 0n;

  constructor(private readonly cfg: FipsRoutingConfig) {
    this.localNodeAddrHex = nodeAddrToHex(cfg.identity.nodeAddr);
    this.debugEnabled = cfg.logger !== noopLogger;
    this.treeState = new TreeState(cfg.identity);
    this.bloomRouting = new BloomRouting({
      identity: cfg.identity, forwarding: cfg.forwarding, strictClient: cfg.strictClient,
      logger: cfg.logger, getPeers: cfg.getPeers, sendLinkMessage: cfg.sendLinkMessage,
      emitError: cfg.emitError, isTreePeer: (nodeAddr) => this.treeState.isTreePeer(nodeAddr),
    });
  }

  get coords(): NodeAddr[] {
    return this.cfg.strictClient ? [this.cfg.identity.nodeAddr] : this.treeState.coords;
  }

  coordinatesFor(nodeAddrHex: string): NodeAddr[] | undefined {
    const coords = this.coordCache.get(nodeAddrHex);
    return this.cfg.strictClient ? coords?.slice(0, 1) : coords;
  }

  /** Whether a currently usable carrier can still route to this identity. */
  hasUsableRoute(nodeAddrHex: string): boolean {
    return this.nextHopFor(nodeAddrHex) !== undefined;
  }

  stop(): void {
    for (const pending of this.pendingRouteResolutions.values()) pending.abort.abort();
    this.originLookups.stop();
    this.deferredLookupForwards.clear();
    this.lookupBackoff.resetAll();
    this.pendingRouteResolutions.clear();
    this.lookupReversePaths.clear();
    this.learnedRoutes.clear();
    this.coordCache.clear();
    this.treeState.reset();
    this.cachedTreeAnnounce = undefined;
    this.pendingTreeBroadcast = undefined;
    this.bloomRouting.stop();
    for (const peer of this.cfg.getPeers()) {
      peer.clientSupported = peer.clientOnly = undefined;
      peer.routingRoleSequence = undefined;
      peer.extensionNamespace = peer.extensionCapabilities = undefined;
      peer.extensionRequestSent = peer.legacySupportProbes = undefined;
    }
  }

  removePeer(peerNodeAddr: NodeAddr): void {
    const wasTreePeer = this.treeState.isTreePeer(peerNodeAddr);
    const parentChanged = this.treeState.removePeer(peerNodeAddr);
    if (parentChanged) this.resetLookupBackoff();
    if (parentChanged) void this.sendTreeAnnounceToAll();
    if (parentChanged || wasTreePeer) void this.bloomRouting.sendAll();
  }

  async handleLinkMessage(peer: AdjacentPeer, msgType: number, payload: Uint8Array): Promise<void> {
    if (msgType === LinkMessageType.SessionDatagram) {
      await this.handleSessionDatagram(peer, payload);
      return;
    }
    if (msgType === LinkMessageType.Extension) {
      await this.handleExtensionMessage(peer, payload);
      return;
    }
    if (msgType === LinkMessageType.ClientSupport || msgType === LinkMessageType.ClientOnly) {
      await this.handleLegacyClientMessage(peer, msgType, payload);
      return;
    }
    if (msgType === 0x54) return;
    if (msgType === LinkMessageType.TreeAnnounce) {
      await this.handleTreeAnnounce(peer, payload);
      return;
    }
    if (msgType === LinkMessageType.FilterAnnounce) {
      await this.bloomRouting.handle(peer, payload);
      return;
    }
    if (msgType === LinkMessageType.LookupRequest) {
      await this.handleIncomingLookupRequest(peer, payload);
      return;
    }
    if (msgType === LinkMessageType.LookupResponse) {
      if (await this.handleOriginLookupResponse(peer, payload)) return;
      if (this.cfg.forwarding) await this.forwardLookupResponse(peer, payload);
      return;
    }
    if (!isKnownUnhandledLinkMessage(msgType)) this.cfg.logger.warn("unsupported FMP link message", msgType);
  }

  private async handleLegacyClientMessage(peer: AdjacentPeer, msgType: number, payload: Uint8Array): Promise<void> {
    if (msgType === LinkMessageType.ClientSupport) {
      if (payload.length !== 0 || peer.extensionNamespace) return;
      peer.extensionNamespace = "legacy";
      peer.clientSupported = true;
      if (this.cfg.strictClient) await this.sendTreeAnnounce(peer);
      else await this.cfg.sendLinkMessage(peer, LinkMessageType.ClientSupport, new Uint8Array());
      return;
    }
    if (peer.extensionNamespace !== "legacy" || payload.length !== 8) return;
    const sequence = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, true);
    await this.handleClientRole(peer, sequence);
  }

  private async handleIncomingLookupRequest(peer: AdjacentPeer, payload: Uint8Array): Promise<void> {
    const request = decodeLookupRequest(payload);
    this.cfg.assertNodeAllowed?.(request.origin);
    this.cfg.assertNodeAllowed?.(request.target);
    // The origin field is unsigned; identify our looped requests by ID and target.
    if (this.originLookups.findRequest(request.requestId)?.targetHex === nodeAddrToHex(request.target)) return;
    await this.handleLookupRequest(peer, request);
  }

  private async handleExtensionMessage(peer: AdjacentPeer, payload: Uint8Array): Promise<void> {
    const message = decodeLinkExtension(payload);
    if (!message) return;
    if (message.kind === 3) {
      if (peer.extensionNamespace === "namespaced" && ((peer.extensionCapabilities ?? 0) & FMP_EXTENSION_CLIENT_ROLE)) {
        await this.handleClientRole(peer, message.sequence);
      }
      return;
    }
    const hadSupport = peer.extensionNamespace === "namespaced"
      && !!((peer.extensionCapabilities ?? 0) & FMP_EXTENSION_CLIENT_ROLE);
    peer.extensionNamespace = "namespaced";
    peer.extensionCapabilities = (peer.extensionCapabilities ?? 0) | (message.capabilities & FMP_EXTENSION_CLIENT_ROLE);
    peer.clientSupported = !!(peer.extensionCapabilities & FMP_EXTENSION_CLIENT_ROLE);
    if (message.kind === 1) {
      await this.cfg.sendLinkMessage(peer, LinkMessageType.Extension,
        encodeExtensionCapabilities(2, FMP_EXTENSION_CLIENT_ROLE));
    }
    if (this.cfg.strictClient && peer.clientSupported && !hadSupport) await this.sendTreeAnnounce(peer);
  }

  private async handleSessionDatagram(peer: AdjacentPeer, payload: Uint8Array): Promise<void> {
    const datagram = parseSessionDatagramPayload(payload);
    this.cfg.assertNodeAllowed?.(datagram.srcAddr);
    this.cfg.assertNodeAllowed?.(datagram.destAddr);
    this.cacheSessionCoordinates(datagram);
    if (bytesEqual(datagram.destAddr, this.cfg.identity.nodeAddr)) {
      if (this.debugEnabled) {
        this.cfg.logger.debug("session datagram delivered locally", nodeAddrToHex(datagram.srcAddr),
          "phase", datagram.payload[0]! & 0x0f, "bytes", datagram.payload.length);
      }
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
    if (this.debugEnabled) {
      this.cfg.logger.debug("session datagram forwarded", nodeAddrToHex(datagram.srcAddr),
        nodeAddrToHex(datagram.destAddr), "phase", datagram.payload[0]! & 0x0f,
        "bytes", datagram.payload.length, "ttl", datagram.ttl);
    }
    datagram.ttl -= 1;
    await this.sendSessionDatagram(datagram, peer);
  }

  async sendTreeAnnounce(peer: AdjacentPeer, allowLegacyProbe = false): Promise<void> {
    if (peer.link.state !== "established") return;
    if (!peer.extensionRequestSent && peer.extensionNamespace !== "namespaced") {
      peer.extensionRequestSent = true;
      await this.cfg.sendLinkMessage(peer, LinkMessageType.Extension,
        encodeExtensionCapabilities(1, FMP_EXTENSION_CLIENT_ROLE));
      if (this.cfg.strictClient) return;
    }
    if (this.cfg.strictClient) {
      if (peer.extensionNamespace === "namespaced") {
        if ((peer.extensionCapabilities ?? 0) & FMP_EXTENSION_CLIENT_ROLE) {
          await this.cfg.sendLinkMessage(peer, LinkMessageType.Extension,
            encodeExtensionClientOnly(++this.clientSequence));
        }
      } else if (peer.extensionNamespace === "legacy") {
        const payload = new Uint8Array(8);
        new DataView(payload.buffer).setBigUint64(0, ++this.clientSequence, true);
        await this.cfg.sendLinkMessage(peer, LinkMessageType.ClientOnly, payload);
      } else if (allowLegacyProbe && (peer.legacySupportProbes ?? 0) < MAX_LEGACY_SUPPORT_PROBES) {
        peer.legacySupportProbes = (peer.legacySupportProbes ?? 0) + 1;
        await this.cfg.sendLinkMessage(peer, LinkMessageType.ClientSupport, new Uint8Array());
      }
      return;
    }
    const announce = this.treeState.announce();
    if (this.cachedTreeAnnounce?.announce !== announce) {
      this.cachedTreeAnnounce = { announce, payload: encodeTreeAnnounce(announce).subarray(1) };
    }
    await this.cfg.sendLinkMessage(peer, LinkMessageType.TreeAnnounce, this.cachedTreeAnnounce.payload);
  }

  private async handleClientRole(peer: AdjacentPeer, sequence: bigint): Promise<void> {
    const last = peer.routingRoleSequence;
    if (last !== undefined && (sequence < last || (sequence === last && !peer.clientOnly))) return;
    peer.routingRoleSequence = sequence;
    peer.clientSupported = true;
    if (!peer.clientOnly) {
      peer.clientOnly = true;
      this.removePeer(peerNodeAddr(peer));
      await this.bloomRouting.sendAll();
    }
  }

  scheduleTreeAnnounce(peer: AdjacentPeer): void {
    if (!this.cfg.strictClient && !peer.filterAnnounced) {
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

  /** Topology changed (new authenticated peer or tree coordinates): unreachable targets may now resolve. */
  resetLookupBackoff(): void { this.lookupBackoff.resetAll(); }

  /** An authenticated session proves this node reachable; drop its lookup backoff. */
  noteSessionEstablished(nodeAddrHex: string): void { this.lookupBackoff.recordSuccess(nodeAddrHex); }

  /** Reuse the authenticated heartbeat cadence for bounded capability retries. */
  async refreshClientRole(): Promise<void> {
    if (this.cfg.strictClient) await this.sendTreeAnnounceToAll(true);
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
      && frameCapacity(peer) >= reverse.request.minMtu
    );
    await Promise.all(pending.map(async (reverse) => {
      reverse.forwardedNextHops.add(peerKey);
      try {
        await this.cfg.sendLinkMessage(peer, LinkMessageType.LookupRequest, encodeLookupRequestPayload(reverse.request));
        this.cfg.logger.debug("pending lookup replayed to established target", peerKey);
      } catch (error) {
        reverse.forwardedNextHops.delete(peerKey);
        this.cfg.emitError(error as Error, "replay pending LookupRequest");
      }
    }));
  }

  async ensureFirstContactRoute(target: NodeAddr, targetHex: string, targetPubkey: Uint8Array): Promise<void> {
    const existing = this.originLookups.get(targetHex);
    if (existing) { await existing.promise; return; }
    this.assertLookupAllowed(targetHex);
    const hadLookupPeers = this.originLookupPeers().length > 0;
    await this.runOriginLookup({ target, targetHex, targetPubkey, minMtu: 0, retryWhenReachable: !hadLookupPeers });
  }

  /** Post-failure suppression keeps an offline target from triggering a fresh network-wide lookup. */
  private assertLookupAllowed(targetHex: string, excludedPeer?: AdjacentPeer, minMtu = 0): void {
    if (!this.lookupBackoff.isSuppressed(targetHex, Date.now())) return;
    // A failure that never reached any peer earns one retry once a peer exists.
    if (this.originLookupPeers(excludedPeer, minMtu).length > 0
      && this.lookupBackoff.retryDelayedWithRoute(targetHex)) return;
    this.cfg.logger.debug("lookup suppressed by backoff", targetHex, this.lookupBackoff.failureCount(targetHex));
    throw new Error(`no route to ${targetHex} (lookup backoff)`);
  }

  private async refreshTransitRoute(
    target: NodeAddr,
    targetHex: string,
    previousHop?: AdjacentPeer,
    minMtu = 0,
  ): Promise<string | undefined> {
    const existing = this.originLookups.get(targetHex);
    if (existing) {
      await existing.promise;
      if (existing.minMtu >= minMtu) return existing.nextHop;
      return this.refreshTransitRoute(target, targetHex, previousHop, minMtu);
    }
    if (this.originLookupPeers(previousHop, minMtu).length === 0) throw new Error(`no route to ${targetHex}`);
    this.assertLookupAllowed(targetHex, previousHop, minMtu);
    return this.runOriginLookup({ target, targetHex, minMtu, excludedPeer: previousHop });
  }

  private async runOriginLookup(args: {
    target: NodeAddr;
    targetHex: string;
    targetPubkey?: Uint8Array;
    minMtu: number;
    excludedPeer?: AdjacentPeer;
    retryWhenReachable?: boolean;
  }): Promise<string | undefined> {
    const pending = this.originLookups.create({
      targetHex: args.targetHex,
      targetPubkey: args.targetPubkey,
      minMtu: args.minMtu,
      randomBytes: () => this.cfg.randomBytes(8),
      timeoutMs: LOOKUP_ORIGIN_TIMEOUT_MS,
    });
    const request = {
      target: args.target,
      origin: this.cfg.identity.nodeAddr,
      ttl: LOOKUP_ORIGIN_TTL,
      minMtu: args.minMtu,
      originCoords: this.coords,
    };
    const retrying = this.retryOriginLookup(pending, request, args.excludedPeer);
    try {
      await pending.promise;
      return pending.nextHop;
    } catch (error) {
      if (pending.timedOut) this.lookupBackoff.recordFailure(args.targetHex, Date.now(), args.retryWhenReachable);
      throw error;
    } finally {
      await retrying;
    }
  }

  async sendFspToward(remoteNodeAddr: NodeAddr, fspFrame: OutboundSessionDatagram["payload"]): Promise<void> {
    await this.sendSessionDatagram({
      ttl: 64, pathMtu: FSP_DEFAULT_PATH_MTU,
      srcAddr: this.cfg.identity.nodeAddr, destAddr: remoteNodeAddr, payload: fspFrame,
    });
  }

  async sendFspReplyToward(remoteNodeAddr: NodeAddr, fspFrame: Uint8Array, previousHop: AdjacentPeer): Promise<void> {
    const nextHop = (this.cfg.routingMode === "tree" ? this.nextHopFor(nodeAddrToHex(remoteNodeAddr)) : undefined)
      ?? previousHop;
    await this.sendSessionDatagramVia(nextHop, {
      ttl: 64, pathMtu: FSP_DEFAULT_PATH_MTU,
      srcAddr: this.cfg.identity.nodeAddr, destAddr: remoteNodeAddr, payload: fspFrame,
    });
  }

  private async sendSessionDatagramVia(peer: AdjacentPeer, datagram: SessionDatagram): Promise<void> {
    if (this.debugEnabled) {
      this.cfg.logger.debug(
        "session datagram routed", nodeAddrToHex(datagram.srcAddr), nodeAddrToHex(datagram.destAddr),
        "phase", datagram.payload[0]! & 0x0f, "bytes", datagram.payload.length,
        peer.remoteAddr.transport, peer.remoteAddr.addr,
      );
    }
    await this.cfg.sendLinkMessage(peer, LinkMessageType.SessionDatagram, encodeSessionDatagramPayload(datagram));
  }

  learnReverseRoute(destinationNodeHex: string, nextHop: AdjacentPeer, pathMtu?: number): void {
    if (this.cfg.routingMode !== "reply_learned" && pathMtu === undefined) return;
    if (destinationNodeHex === this.localNodeAddrHex) return;
    this.learnedRoutes.learn(
      destinationNodeHex, peerNodeKey(nextHop), Date.now(),
      REPLY_LEARNED_ROUTE_TTL_SECONDS, MAX_REPLY_LEARNED_ROUTES_PER_DESTINATION, pathMtu,
    );
  }

  private broadcastTreeAnnounce(): Promise<void> {
    return (this.pendingTreeBroadcast ??= Promise.resolve().then(async () => {
      this.pendingTreeBroadcast = undefined;
      await this.sendTreeAnnounceToAll();
    }));
  }

  private async sendTreeAnnounceToAll(allowLegacyProbe = false): Promise<void> {
    const peers = [...this.cfg.getPeers()].filter((peer) => peer.link.state === "established");
    await Promise.allSettled(peers.map((peer) => this.sendTreeAnnounce(peer, allowLegacyProbe)));
  }

  private async handleTreeAnnounce(peer: AdjacentPeer, payload: Uint8Array): Promise<void> {
    const announce = decodeTreeAnnouncePayload(payload);
    const peerAddr = peerNodeAddr(peer);
    if (!bytesEqual(announce.ancestry[0]!.nodeAddr, peerAddr)) {
      throw new Error("TreeAnnounce node address does not match authenticated peer");
    }
    if (!verifyTreeAnnounce(announce, peer.pubkey)) {
      throw new Error("TreeAnnounce signature verification failed");
    }
    if (peer.routingRoleSequence !== undefined && announce.sequence <= peer.routingRoleSequence) return;
    peer.routingRoleSequence = announce.sequence;
    const wasClient = peer.clientOnly;
    peer.clientOnly = false;
    const wasTreePeer = this.treeState.isTreePeer(peerAddr);
    const changed = this.treeState.updatePeer(peerAddr, announce);
    const isTreePeer = this.treeState.isTreePeer(peerAddr);
    if (this.debugEnabled) {
      this.cfg.logger.debug("tree announce accepted", peerNodeKey(peer),
        "depth", announce.ancestry.length - 1, "root", nodeAddrToHex(announce.ancestry.at(-1)!.nodeAddr));
    }
    if (changed) this.resetLookupBackoff();
    if (changed) await this.broadcastTreeAnnounce();
    if (changed || wasClient || wasTreePeer !== isTreePeer) await this.bloomRouting.sendAll();
  }

  private cacheSessionCoordinates(datagram: SessionDatagram): void {
    const phase = datagram.payload[0]! & 0x0f;
    if (phase === 0 && (datagram.payload[1]! & FSP_FLAG_CP) === 0) return;
    try {
      if (phase === 1) {
        const setup = decodeSessionSetup(datagram.payload);
        this.cacheCoordinates(datagram.srcAddr, setup.srcCoords);
        this.cacheCoordinates(datagram.destAddr, setup.destCoords);
      } else if (phase === 2) {
        const ack = decodeSessionAck(datagram.payload);
        this.cacheCoordinates(datagram.srcAddr, ack.srcCoords);
        this.cacheCoordinates(datagram.destAddr, ack.destCoords);
      } else if (phase === 0) {
        const established = parseFspEstablished(datagram.payload, true);
        this.cacheCoordinates(datagram.srcAddr, established.srcCoords ?? []);
        this.cacheCoordinates(datagram.destAddr, established.destCoords ?? []);
      }
    } catch (error) {
      this.cfg.logger.warn("invalid FSP session coordinates", error);
    }
  }

  private cacheCoordinates(nodeAddr: NodeAddr, coords: NodeAddr[]): void {
    if (coords.length === 0 || !bytesEqual(coords[0]!, nodeAddr)) return;
    const key = nodeAddrToHex(nodeAddr);
    this.coordCache.delete(key);
    if (this.coordCache.size >= MAX_COORD_CACHE_ENTRIES) {
      const oldest = this.coordCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.coordCache.delete(oldest);
    }
    this.coordCache.set(key, coords.map((entry) => new Uint8Array(entry)));
  }

  private async handleLookupRequest(
    sourcePeer: AdjacentPeer,
    request: LookupRequest,
    allowDeferral = true,
  ): Promise<void> {
    const targetHex = nodeAddrToHex(request.target);
    if (frameCapacity(sourcePeer) < request.minMtu) return;
    if (bytesEqual(request.target, this.cfg.identity.nodeAddr)) {
      await this.answerLocalLookup(sourcePeer, request, targetHex);
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

    const { nextHops, canResolveDirectly } = this.selectLookupForwardTargets(
      sourcePeer, request, targetHex, existingReverse,
    );
    if (nextHops.length === 0 && !canResolveDirectly) {
      this.cfg.logger.debug("lookup request not forwarded", targetHex, "no-next-hop");
      return;
    }
    if (!this.lookupForwardLimiter.admit(peerNodeKey(sourcePeer), targetHex, Date.now())) {
      if (allowDeferral && !existingReverse) this.deferLookupForward(sourcePeer, request, targetHex);
      this.cfg.logger.debug("lookup request not forwarded", targetHex, "rate-limited");
      return;
    }
    const reverse = existingReverse ?? this.recordLookupReversePath(reverseKey, sourcePeer, request);
    if (canResolveDirectly) void this.resolveAndForwardLookup(targetHex, reverseKey, reverse, sourcePeer);
    if (nextHops.length > 0) await this.sendLookupToNextHops(reverse, reverseKey, nextHops, targetHex);
  }

  private selectLookupForwardTargets(
    sourcePeer: AdjacentPeer,
    request: LookupRequest,
    targetHex: string,
    existingReverse?: LookupReversePath,
  ): { nextHops: AdjacentPeer[]; canResolveDirectly: boolean } {
    const directOrLearned = this.nextHopFor(targetHex, sourcePeer, request.minMtu);
    const fallbackPeers = directOrLearned ? [] : this.lookupFallbackPeers(sourcePeer, request);
    const candidates = directOrLearned ? [directOrLearned] : fallbackPeers;
    const nextHops = existingReverse
      ? candidates.filter((nextHop) => !existingReverse.forwardedNextHops.has(peerNodeKey(nextHop)))
      : candidates;
    const canResolveDirectly = !directOrLearned && fallbackPeers.length === 0
      && this.cfg.transports.some((transport) => transport.resolve !== undefined);
    return { nextHops, canResolveDirectly };
  }

  private async answerLocalLookup(sourcePeer: AdjacentPeer, request: LookupRequest, targetHex: string): Promise<void> {
    const targetCoords = this.coords;
    const proof = signSchnorr(
      this.cfg.identity,
      sha256(lookupResponseProofBytes(request.requestId, request.target, targetCoords)),
    );
    await this.cfg.sendLinkMessage(sourcePeer, LinkMessageType.LookupResponse, encodeLookupResponsePayload({
      requestId: request.requestId, target: request.target, pathMtu: frameCapacity(sourcePeer), targetCoords, proof,
    }));
    this.cfg.logger.debug("lookup request answered locally", targetHex);
  }

  private recordLookupReversePath(reverseKey: string, sourcePeer: AdjacentPeer, request: LookupRequest): LookupReversePath {
    const reverse: LookupReversePath = {
      peer: sourcePeer,
      expiresAtMs: Date.now() + LOOKUP_REVERSE_PATH_TTL_MS,
      forwardedNextHops: new Set<string>(),
      request: { ...request, ttl: request.ttl - 1 },
    };
    if (this.lookupReversePaths.size >= MAX_LOOKUP_REVERSE_PATHS) {
      const oldest = this.lookupReversePaths.keys().next().value as string | undefined;
      if (oldest !== undefined) this.lookupReversePaths.delete(oldest);
    }
    this.lookupReversePaths.set(reverseKey, reverse);
    return reverse;
  }

  private async sendLookupToNextHops(
    reverse: LookupReversePath,
    reverseKey: string,
    nextHops: AdjacentPeer[],
    targetHex: string,
  ): Promise<void> {
    for (const nextHop of nextHops) reverse.forwardedNextHops.add(peerNodeKey(nextHop));
    const encoded = encodeLookupRequestPayload(reverse.request);
    const results = await Promise.allSettled(
      nextHops.map((nextHop) => this.cfg.sendLinkMessage(nextHop, LinkMessageType.LookupRequest, encoded)),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected" && nextHops[index]) {
        reverse.forwardedNextHops.delete(peerNodeKey(nextHops[index]!));
      }
    });
    if (results.every((result) => result.status === "rejected")) {
      if (reverse.forwardedNextHops.size === 0) this.lookupReversePaths.delete(reverseKey);
      throw new Error(`failed to forward lookup request for ${targetHex}`);
    }
    this.cfg.logger.debug("lookup request forwarded", targetHex, nextHops.length);
  }

  private lookupFallbackPeers(sourcePeer: AdjacentPeer, request: LookupRequest): AdjacentPeer[] {
    const originHex = nodeAddrToHex(request.origin);
    return [...this.cfg.getPeers()]
      .filter((peer) =>
        peer !== sourcePeer
        && peer.link.state === "established"
        && (this.treeState.isTreePeer(peerNodeAddr(peer)) || this.cfg.routingMode === "reply_learned")
        && peerNodeKey(peer) !== originHex
        && frameCapacity(peer) >= request.minMtu
      )
      .slice(0, MAX_REPLY_LEARNED_LOOKUP_PEERS);
  }

  /** Hold one rate-limited request per target until that target's next forwarding slot. */
  private deferLookupForward(sourcePeer: AdjacentPeer, request: LookupRequest, targetHex: string): void {
    const ingressKey = peerNodeKey(sourcePeer);
    const nowMs = Date.now();
    const dueMs = this.lookupForwardLimiter.nextSlotMs(ingressKey, targetHex, nowMs);
    if (dueMs === undefined) return;
    this.deferredLookupForwards.defer(targetHex, ingressKey, dueMs - nowMs, () => {
      if (!this.cfg.isStarted() || sourcePeer.link.state !== "established") return;
      void this.handleLookupRequest(sourcePeer, request, false).catch((error) => {
        this.cfg.emitError(error as Error, "forward deferred LookupRequest");
      });
    });
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
    const nextHop = this.nextHopFor(targetHex, sourcePeer, reverse.request.minMtu);
    if (!nextHop) return;
    const nextHopKey = peerNodeKey(nextHop);
    if (reverse.forwardedNextHops.has(nextHopKey)) return;
    reverse.forwardedNextHops.add(nextHopKey);
    try {
      await this.cfg.sendLinkMessage(nextHop, LinkMessageType.LookupRequest, encodeLookupRequestPayload(reverse.request));
      this.cfg.logger.debug("lookup request forwarded after transport resolution", targetHex);
    } catch (error) {
      reverse.forwardedNextHops.delete(nextHopKey);
      this.cfg.emitError(error as Error, "forward resolved LookupRequest");
    }
  }

  private async forwardLookupResponse(sourcePeer: AdjacentPeer, payload: Uint8Array): Promise<void> {
    const response = decodeLookupResponse(payload);
    const reverseKey = lookupReverseKey(response.requestId, response.target);
    this.pruneLookupReversePaths(Date.now());
    const reverse = this.lookupReversePaths.get(reverseKey);
    if (!reverse || reverse.peer === sourcePeer) {
      this.cfg.logger.debug("lookup response not forwarded", nodeAddrToHex(response.target));
      return;
    }
    const nextMtu = Math.min(response.pathMtu, frameCapacity(sourcePeer), frameCapacity(reverse.peer));
    if (nextMtu < reverse.request.minMtu) return;
    this.cacheCoordinates(response.target, response.targetCoords);
    this.learnReverseRoute(nodeAddrToHex(response.target), sourcePeer, Math.min(response.pathMtu, frameCapacity(sourcePeer)));
    this.lookupReversePaths.delete(reverseKey);
    response.pathMtu = nextMtu;
    await this.cfg.sendLinkMessage(reverse.peer, LinkMessageType.LookupResponse, encodeLookupResponsePayload(response));
    this.cfg.logger.debug("lookup response forwarded", nodeAddrToHex(response.target),
      reverse.peer.remoteAddr.transport, reverse.peer.remoteAddr.addr);
  }

  private async handleOriginLookupResponse(sourcePeer: AdjacentPeer, payload: Uint8Array): Promise<boolean> {
    const response = decodeLookupResponse(payload);
    const pending = this.originLookups.findRequest(response.requestId);
    if (!pending) return false;
    if (nodeAddrToHex(response.target) !== pending.targetHex) return true;
    if (Math.min(response.pathMtu, frameCapacity(sourcePeer)) < pending.minMtu) return true;
    if (pending.targetPubkey) {
      const proofDigest = sha256(lookupResponseProofBytes(response.requestId, response.target, response.targetCoords));
      if (!verifySchnorr(response.proof, proofDigest, pending.targetPubkey.subarray(1))) {
        this.cfg.logger.warn("lookup response proof verification failed", pending.targetHex);
        return true;
      }
    }
    if (!bytesEqual(response.targetCoords[0]!, response.target)) {
      this.cfg.logger.warn("lookup response coordinates do not start at target", pending.targetHex);
      return true;
    }
    this.cacheCoordinates(response.target, response.targetCoords);
    this.learnReverseRoute(pending.targetHex, sourcePeer, Math.min(response.pathMtu, frameCapacity(sourcePeer)));
    this.lookupBackoff.recordSuccess(pending.targetHex);
    this.originLookups.complete(pending, peerNodeKey(sourcePeer));
    this.cfg.logger.debug("lookup response accepted", pending.targetHex);
    return true;
  }

  private originLookupPeers(excludedPeer?: AdjacentPeer, minMtu = 0): AdjacentPeer[] {
    const defaultPeer = this.cfg.defaultRoute ? this.cfg.getPeerByPubkey(this.cfg.defaultRoute) : undefined;
    return [...this.cfg.getPeers()]
      .filter((peer) => {
        if (peer === excludedPeer || peer.link.state !== "established" || frameCapacity(peer) < minMtu) return false;
        if (this.cfg.routingMode === "reply_learned") return true;
        return peer === defaultPeer || this.treeState.isTreePeer(peerNodeAddr(peer));
      })
      .slice(0, MAX_REPLY_LEARNED_LOOKUP_PEERS);
  }

  private async retryOriginLookup(
    pending: PendingOriginLookup,
    request: Omit<LookupRequest, "requestId">,
    excludedPeer?: AdjacentPeer,
  ): Promise<void> {
    await this.originLookups.retry(pending, async () => {
      const encoded = encodeLookupRequestPayload({ ...request, requestId: pending.requestId });
      const peers = this.originLookupPeers(excludedPeer, pending.minMtu);
      await Promise.allSettled(
        peers.map((peer) => this.cfg.sendLinkMessage(peer, LinkMessageType.LookupRequest, encoded)),
      );
    });
  }

  private async sendSessionDatagram(datagram: OutboundSessionDatagram, previousHop?: AdjacentPeer): Promise<void> {
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

    const sendFrame = async (payload: Uint8Array, existing?: SessionDatagram): Promise<void> => {
      const minMtu = payload.length + ROUTED_FRAME_OVERHEAD;
      let hop = nextHop!;
      if (this.pathMtuFor(destNodeHex, hop) < minMtu) {
        let fallback = this.nextHopFor(destNodeHex, previousHop, minMtu);
        if (!fallback) {
          const resolved = await this.refreshTransitRoute(datagram.destAddr, destNodeHex, previousHop, minMtu);
          fallback = selectCarrier(this.cfg.getPeerByNodeAddr(resolved ?? ""), this.cfg.getPeers(), previousHop, minMtu);
        }
        if (!fallback) throw new Error(`no route to ${destNodeHex} with MTU ${minMtu}`);
        hop = fallback;
        nextHop = fallback;
      }
      await this.sendSessionDatagramVia(hop, existing ?? { ...datagram, payload });
    };

    if (typeof datagram.payload === "function") {
      for (const payload of datagram.payload(nextHop)) await sendFrame(payload);
    } else {
      await sendFrame(datagram.payload, datagram as SessionDatagram);
    }
  }

  private pathMtuFor(destination: string, peer: AdjacentPeer, nowMs = Date.now()): number {
    const nextHop = peerNodeKey(peer);
    const capacity = frameCapacity(peer);
    const verified = destination === nextHop
      ? capacity
      : this.learnedRoutes.pathMtu(destination, nextHop, nowMs) ?? FSP_DEFAULT_PATH_MTU;
    return Math.min(capacity, verified);
  }

  private nextHopFor(destNodeHex: string, excludedPeer?: AdjacentPeer, minMtu = 0): AdjacentPeer | undefined {
    const nowMs = minMtu > 0 || this.cfg.routingMode === "reply_learned" ? Date.now() : 0;
    const usablePeer = (nodeHex: string): AdjacentPeer | undefined => {
      const peer = selectCarrier(this.cfg.getPeerByNodeAddr(nodeHex), this.cfg.getPeers(), excludedPeer, minMtu);
      return peer && (minMtu === 0 || this.pathMtuFor(destNodeHex, peer, nowMs) >= minMtu) ? peer : undefined;
    };
    const direct = usablePeer(destNodeHex);
    if (direct) return direct;
    let cachedHop: string | undefined;
    let cachedPeer: AdjacentPeer | undefined;
    const canSend = (nodeHex: string): boolean => {
      const peer = usablePeer(nodeHex);
      if (!peer) return false;
      cachedHop = nodeHex;
      cachedPeer = peer;
      return true;
    };
    if (this.cfg.routingMode === "reply_learned") {
      const learnedNodeHex = this.learnedRoutes.selectNextHop(destNodeHex, nowMs, canSend);
      if (learnedNodeHex) return learnedNodeHex === cachedHop ? cachedPeer : usablePeer(learnedNodeHex);
    }
    const destCoords = this.coordCache.get(destNodeHex);
    if (destCoords) {
      const treeNodeHex = this.treeState.nextHop(destCoords, canSend);
      if (treeNodeHex) return treeNodeHex === cachedHop ? cachedPeer : usablePeer(treeNodeHex);
    }
    const defaultPeer = this.cfg.defaultRoute ? this.cfg.getPeerByPubkey(this.cfg.defaultRoute) : undefined;
    return defaultPeer ? usablePeer(peerNodeKey(defaultPeer)) : undefined;
  }

  private pruneLookupReversePaths(nowMs: number): void {
    for (const [key, reverse] of this.lookupReversePaths) {
      if (reverse.expiresAtMs <= nowMs) this.lookupReversePaths.delete(key);
    }
  }

  private async resolveRoute(destNodeAddr: NodeAddr, destNodeHex: string): Promise<void> {
    const existing = this.pendingRouteResolutions.get(destNodeHex);
    if (existing) { await existing.promise; return; }
    if (this.pendingRouteResolutions.size >= MAX_PENDING_ROUTE_RESOLUTIONS) {
      throw new Error(`route resolution capacity exceeded for ${destNodeHex}`);
    }
    const abort = new AbortController();
    const promise = resolveTransportIdentity(this.cfg.transports, destNodeAddr, abort, this.cfg.isStarted)
      .then((resolved) => this.cfg.connectKnownPeer(resolved.transport, resolved.remoteAddr, resolved.remotePubkey));
    this.pendingRouteResolutions.set(destNodeHex, { promise, abort });
    try {
      await promise;
    } finally {
      if (this.pendingRouteResolutions.get(destNodeHex)?.promise === promise) {
        this.pendingRouteResolutions.delete(destNodeHex);
      }
    }
  }

  /** Resolve only the identity: FSP signaling can be needed before its carrier exists. */
  async resolveIdentity(nodeAddr: NodeAddr, abort: AbortController): Promise<Uint8Array> {
    const adjacent = this.cfg.getPeerByNodeAddr(nodeAddrToHex(nodeAddr));
    if (adjacent?.link.state === "established" && adjacent.pubkey) return adjacent.pubkey;
    return (await resolveTransportIdentity(this.cfg.transports, nodeAddr, abort, this.cfg.isStarted)).remotePubkey;
  }
}
