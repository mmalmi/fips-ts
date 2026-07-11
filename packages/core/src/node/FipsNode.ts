import { randomBytes } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha256";

import { bytesEqual, toHex } from "../codec/hex.js";
import { FmpLink, type FmpHandshakeResult } from "../fmp/link.js";
import {
  DirectFspTransportReassembler,
  isDirectFspTransportFragment,
  segmentDirectFspTransportRecord,
} from "../fsp/directTransport.js";
import { FspSession } from "../fsp/session.js";
import {
  decodeFmpMsg2,
  decodeFmpEstablished,
  FMP_PHASE_ESTABLISHED,
  FMP_PHASE_MSG1,
  FMP_PHASE_MSG2,
  peekFmpPhase,
} from "../fmp/wire.js";
import {
  decodeFspEstablished,
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_FLAG_K,
  FSP_MSG_DATA,
  FSP_MSG_ENDPOINT_DATA,
  FSP_PHASE_ESTABLISHED,
  isDirectFspEstablished,
  peekFspPhase,
} from "../fsp/wire.js";
import {
  compressedPubkeyFromXOnly,
  signSchnorr,
  type FipsIdentity,
} from "../identity/index.js";
import {
  compareNodeAddr,
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
import {
  decodeLookupRequest,
  decodeLookupResponse,
  encodeLookupRequestPayload,
  encodeLookupResponsePayload,
  lookupResponseProofBytes,
} from "../protocol/discovery.js";
import {
  noopLogger,
  type Logger,
  type ReceivedTransportPacket,
  type Transport,
  type TransportAddress,
  type TransportConnectionStateEvent,
  transportAddressKey,
} from "../transport/types.js";

import type {
  DatagramEvent,
  EndpointDataEvent,
  ErrorEvent,
  FipsEventName,
  FipsNodeConfig,
  FipsServiceHandler,
  PeerEvent,
  RandomSource,
  ServiceContext,
  SessionEvent,
} from "./types.js";
import { LearnedRouteTable } from "./LearnedRouteTable.js";

interface AdjacentPeer {
  pubkey: Uint8Array;           // 33 compressed
  pubkeyHex: string;
  remoteAddr: TransportAddress;
  transport: Transport;
  link: FmpLink;
  pendingResponderLink?: FmpLink;
  drainingResponderLinks?: Map<number, { link: FmpLink; expiresAtMs: number }>;
  abandonedInitiatorSessionIdx?: number;
  outgoingHandshake?: {
    resolve: () => void;
    reject: (err: Error) => void;
  };
}

interface Session {
  remoteNodeAddr: NodeAddr;
  remotePubkeyHex?: string;
  remotePubkey?: Uint8Array;
  fsp: FspSession;
  currentKBit: boolean;
  pendingResponderFsp?: FspSession;
  previousFsp?: { fsp: FspSession; kBit: boolean; expiresAtMs: number };
  setupResolve?: () => void;
  setupReject?: (err: Error) => void;
}

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
}

let sessionIdxCounter = 1;
function nextSessionIdx(): number {
  const v = sessionIdxCounter++;
  return v >>> 0;
}

const defaultRandom: RandomSource = { bytes: (n) => randomBytes(n) };
const FMP_HANDSHAKE_TIMEOUT_MS = 15_000;
const FMP_HANDSHAKE_RESEND_MS = 1_000;
const FMP_HEARTBEAT_INTERVAL_MS = 5_000;
const FMP_REPLACED_LINK_DRAIN_MS = 10_000;
const FSP_REKEY_DRAIN_MS = 45_000;
const FSP_DEFAULT_PATH_MTU = 1_200;
const ROUTE_RESOLUTION_TIMEOUT_MS = 5_000;
const MAX_PENDING_ROUTE_RESOLUTIONS = 64;
const LOOKUP_REVERSE_PATH_TTL_MS = 30_000;
const MAX_LOOKUP_REVERSE_PATHS = 256;
const REPLY_LEARNED_ROUTE_TTL_SECONDS = 300;
const MAX_REPLY_LEARNED_ROUTES_PER_DESTINATION = 4;
const MAX_REPLY_LEARNED_LOOKUP_PEERS = 16;

export class FipsNode {
  readonly identity: FipsIdentity;
  readonly forwarding: boolean;
  private readonly routingMode: "tree" | "reply_learned";
  private readonly transports: Transport[];
  private readonly random: RandomSource;
  private readonly logger: Logger;
  private readonly defaultRoute?: string;
  private readonly heartbeatIntervalMs: number;

  private services = new Map<number, FipsServiceHandler>();
  private peers = new Map<string, AdjacentPeer>();  // by transportAddressKey
  private peersByPubkey = new Map<string, AdjacentPeer>(); // by pubkey hex
  private peersByNodeAddr = new Map<string, AdjacentPeer>(); // by NodeAddr hex
  private pendingPeerConnects = new Map<string, Promise<void>>(); // by transportAddressKey
  private pendingRouteResolutions = new Map<string, PendingRouteResolution>(); // by NodeAddr hex
  private lookupReversePaths = new Map<string, LookupReversePath>();
  private readonly learnedRoutes = new LearnedRouteTable();
  private sessions = new Map<string, Session>();    // by remote NodeAddr hex
  private listeners = new Map<FipsEventName, Set<(event: unknown) => void>>();
  private discoveryTasks = new Set<Promise<void>>();
  private discoveryConnectTasks = new Set<Promise<void>>();
  private discoveryGeneration = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly directFspReassembler = new DirectFspTransportReassembler();
  private started = false;

  constructor(cfg: FipsNodeConfig) {
    this.identity = cfg.identity;
    this.transports = cfg.transports;
    this.forwarding = cfg.forwarding ?? false;
    this.routingMode = cfg.routingMode ?? "tree";
    this.defaultRoute = cfg.defaultRoute?.toLowerCase();
    if (this.defaultRoute && !/^(02|03)[0-9a-f]{64}$/.test(this.defaultRoute)) {
      throw new Error("defaultRoute must be a 33-byte compressed pubkey hex");
    }
    this.random = cfg.random ?? defaultRandom;
    this.logger = cfg.logger ?? noopLogger;
    this.heartbeatIntervalMs = cfg.heartbeatIntervalMs ?? FMP_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
      throw new Error("heartbeatIntervalMs must be a positive safe integer");
    }
    for (const s of cfg.services ?? []) {
      this.services.set(s.port, s.handler);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    const startedTransports: Transport[] = [];
    try {
      for (const t of this.transports) {
        await t.start({
          localIdentity: this.identity,
          onPacket: (p) => this.onTransportPacket(t, p),
          onConnectionState: (e) => this.onTransportConn(t, e),
          logger: this.logger,
        });
        startedTransports.push(t);
      }
    } catch (err) {
      for (const t of startedTransports.reverse()) {
        try {
          await t.stop();
        } catch {
          // Preserve the original start failure.
        }
      }
      throw err;
    }
    this.started = true;
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeats();
    }, this.heartbeatIntervalMs);
    const generation = ++this.discoveryGeneration;
    for (const transport of this.transports) {
      if (!transport.discover) continue;
      const task = this.consumeDiscovery(transport, generation);
      this.discoveryTasks.add(task);
      void task.finally(() => this.discoveryTasks.delete(task));
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.discoveryGeneration++;
    for (const peer of this.peers.values()) {
      peer.outgoingHandshake?.reject(new Error("FIPS node stopped"));
      peer.link.close();
      peer.pendingResponderLink?.close();
      for (const draining of peer.drainingResponderLinks?.values() ?? []) {
        draining.link.close();
      }
    }
    for (const pending of this.pendingRouteResolutions.values()) {
      pending.abort.abort();
    }
    for (const session of this.sessions.values()) {
      session.fsp.close();
      session.pendingResponderFsp?.close();
      session.previousFsp?.fsp.close();
    }
    for (const t of this.transports) {
      try {
        await t.stop();
      } catch (err) {
        this.emit("error", { err: err as Error, where: "transport.stop" });
      }
    }
    await Promise.allSettled([...this.discoveryTasks]);
    this.discoveryTasks.clear();
    await Promise.allSettled([...this.discoveryConnectTasks]);
    this.discoveryConnectTasks.clear();
    this.peers.clear();
    this.peersByPubkey.clear();
    this.peersByNodeAddr.clear();
    this.pendingPeerConnects.clear();
    this.pendingRouteResolutions.clear();
    this.lookupReversePaths.clear();
    this.learnedRoutes.clear();
    this.sessions.clear();
    this.directFspReassembler.clear();
  }

  private async consumeDiscovery(
    transport: Transport,
    generation: number,
  ): Promise<void> {
    try {
      for await (const discovered of transport.discover!()) {
        if (!this.started || generation !== this.discoveryGeneration) return;
        const task = this.connectDiscoveredPeer(transport, discovered, generation);
        this.discoveryConnectTasks.add(task);
        void task.finally(() => this.discoveryConnectTasks.delete(task));
      }
    } catch (err) {
      if (this.started && generation === this.discoveryGeneration) {
        this.emit("error", { err: err as Error, where: "transport.discover" });
      }
    }
  }

  private async connectDiscoveredPeer(
    transport: Transport,
    discovered: { publicKey?: Uint8Array; remoteAddr: TransportAddress },
    generation: number,
  ): Promise<void> {
    try {
      const remotePubkey = discoveryPublicKey(discovered);
      if (bytesEqual(remotePubkey.subarray(1), this.identity.xOnlyPubkey)) return;
      await this.connectKnownPeer(transport, discovered.remoteAddr, remotePubkey);
    } catch (err) {
      if (!this.started || generation !== this.discoveryGeneration) return;
      this.emit("error", { err: err as Error, where: "transport.discover" });
      this.logger.warn("transport discovery connect failed", transport.type, err);
    }
  }

  registerService(port: number, handler: FipsServiceHandler): () => void {
    this.services.set(port, handler);
    return () => {
      if (this.services.get(port) === handler) this.services.delete(port);
    };
  }

  /**
   * Connect to an adjacent peer over a chosen transport. The address's `addr`
   * must be the remote node's 33-byte compressed pubkey in hex.
   */
  async connect(addr: TransportAddress): Promise<void> {
    const transport = this.transports.find((t) => t.type === addr.transport);
    if (!transport) throw new Error(`no transport registered for ${addr.transport}`);
    if (addr.addr.length !== 66) {
      throw new Error("transport addr must be 33-byte compressed pubkey hex");
    }
    const remotePubkey = hexBytes(addr.addr);
    await this.connectKnownPeer(transport, addr, remotePubkey);
  }

  private async connectKnownPeer(
    transport: Transport,
    addr: TransportAddress,
    remotePubkey: Uint8Array,
  ): Promise<void> {
    if (remotePubkey.length !== 33 || (remotePubkey[0] !== 0x02 && remotePubkey[0] !== 0x03)) {
      throw new Error("remote pubkey must be 33-byte compressed secp256k1 key");
    }
    const key = transportAddressKey(addr);
    if (this.peers.has(key) && this.peers.get(key)!.link.state === "established") return;
    const pendingConnect = this.pendingPeerConnects.get(key);
    if (pendingConnect) {
      await pendingConnect;
      return;
    }
    const connectPromise = this.connectAdjacentPeer(transport, addr, remotePubkey, key);
    this.pendingPeerConnects.set(key, connectPromise);
    try {
      await connectPromise;
    } finally {
      if (this.pendingPeerConnects.get(key) === connectPromise) {
        this.pendingPeerConnects.delete(key);
      }
    }
  }

  private async connectAdjacentPeer(
    transport: Transport,
    addr: TransportAddress,
    remotePubkey: Uint8Array,
    key: string,
  ): Promise<void> {
    this.logger.debug("fips connect transport start", addr.transport, addr.addr);
    await transport.connect(addr);
    this.logger.debug("fips connect transport ready", addr.transport, addr.addr);
    const link = new FmpLink({
      identity: this.identity,
      remotePubkey,
      role: "initiator",
      sessionIdx: nextSessionIdx(),
    });
    const peer: AdjacentPeer = {
      pubkey: remotePubkey,
      pubkeyHex: toHex(remotePubkey),
      remoteAddr: addr,
      transport,
      link,
    };
    this.peers.set(key, peer);
    this.rememberPeer(peer);

    const handshakeDone = new Promise<void>((resolve, reject) => {
      peer.outgoingHandshake = { resolve, reject };
    });
    const msg1 = link.buildMsg1((n) => this.random.bytes(n));
    const sendMsg1 = async (resend: boolean): Promise<void> => {
      await transport.send(addr, msg1.packet);
      this.logger.debug(
        resend ? "fips msg1 resent" : "fips msg1 sent",
        addr.transport,
        addr.addr,
        msg1.packet.length,
      );
    };
    await sendMsg1(false);
    const resendTimer = setInterval(() => {
      if (!peer.outgoingHandshake) return;
      void sendMsg1(true).catch((err) => {
        this.emit("error", { err: err as Error, where: "resend Msg1" });
      });
    }, FMP_HANDSHAKE_RESEND_MS);
    const timer = setTimeout(() => {
      this.logger.warn("fips handshake timeout", addr.transport, addr.addr);
      peer.outgoingHandshake?.reject(new Error("FMP handshake timeout"));
    }, FMP_HANDSHAKE_TIMEOUT_MS);
    try {
      await handshakeDone;
    } finally {
      clearTimeout(timer);
      clearInterval(resendTimer);
      peer.outgoingHandshake = undefined;
      if (peer.link.state !== "established" && this.peers.get(key) === peer) {
        this.peers.delete(key);
        this.peersByPubkey.delete(peer.pubkeyHex);
        if (peer.pubkey.length > 0) {
          this.peersByNodeAddr.delete(nodeAddrToHex(deriveNodeAddr(peer.pubkey)));
        }
      }
    }
  }

  /** Send a service datagram to a target identity (adjacent or routable). */
  async sendDatagram(args: {
    dst: string; // remote pubkey hex
    srcPort?: number;
    dstPort: number;
    payload: Uint8Array;
  }): Promise<void> {
    const session = await this.ensureSession(args.dst);
    const directPeer = this.directPeerForSession(session);
    const epochFlag = session.currentKBit ? FSP_FLAG_K : 0;
    const fspFrame = session.fsp.encryptDatagram(
      {
        srcPort: args.srcPort ?? 0,
        dstPort: args.dstPort,
        payload: args.payload,
      },
      epochFlag | (directPeer ? FSP_FLAG_DIRECT_TRANSPORT : 0),
    );
    if (directPeer) await this.sendDirectFsp(directPeer, fspFrame);
    else await this.sendFspToward(session.remoteNodeAddr, fspFrame);
  }

  /** Send app-owned endpoint bytes to a target identity without service ports. */
  async sendEndpointData(args: {
    dst: string; // remote pubkey hex
    payload: Uint8Array;
  }): Promise<void> {
    const session = await this.ensureSession(args.dst);
    const directPeer = this.directPeerForSession(session);
    const epochFlag = session.currentKBit ? FSP_FLAG_K : 0;
    const fspFrame = session.fsp.encryptEndpointData(
      args.payload,
      epochFlag | (directPeer ? FSP_FLAG_DIRECT_TRANSPORT : 0),
    );
    if (directPeer) await this.sendDirectFsp(directPeer, fspFrame);
    else await this.sendFspToward(session.remoteNodeAddr, fspFrame);
  }

  on(event: FipsEventName, cb: (data: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(event: "peer", data: PeerEvent): void;
  private emit(event: "datagram", data: DatagramEvent): void;
  private emit(event: "endpointData", data: EndpointDataEvent): void;
  private emit(event: "session", data: SessionEvent): void;
  private emit(event: "error", data: ErrorEvent): void;
  private emit(event: FipsEventName, data: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(data);
      } catch (err) {
        this.logger.warn("listener threw", err);
      }
    }
  }

  private onTransportConn(
    _transport: Transport,
    e: TransportConnectionStateEvent,
  ): void {
    if (e.state === "disconnected" || e.state === "failed") {
      const key = transportAddressKey(e.remoteAddr);
      const peer = this.peers.get(key);
      if (peer) {
        peer.link.close();
        peer.pendingResponderLink?.close();
        for (const draining of peer.drainingResponderLinks?.values() ?? []) {
          draining.link.close();
        }
        this.peers.delete(key);
        this.peersByPubkey.delete(peer.pubkeyHex);
        if (peer.pubkey.length > 0) {
          this.peersByNodeAddr.delete(nodeAddrToHex(deriveNodeAddr(peer.pubkey)));
        }
        for (const [nodeHex, session] of this.sessions) {
          if (session.remotePubkeyHex === peer.pubkeyHex) {
            this.sessions.delete(nodeHex);
            this.emit("session", { remotePubkey: peer.pubkeyHex, state: "closed" });
          }
        }
        this.emit("peer", {
          remotePubkey: peer.pubkeyHex,
          remoteAddr: peer.remoteAddr,
          state: "disconnected",
        });
      }
    }
  }

  private rememberPeer(peer: AdjacentPeer): void {
    if (peer.pubkey.length === 0 || !peer.pubkeyHex) return;
    this.peersByPubkey.set(peer.pubkeyHex, peer);
    this.peersByNodeAddr.set(nodeAddrToHex(deriveNodeAddr(peer.pubkey)), peer);
  }

  private onTransportPacket(
    transport: Transport,
    p: ReceivedTransportPacket,
  ): void {
    try {
      const key = transportAddressKey(p.remoteAddr);
      let peer = this.peers.get(key);
      let packet = p.data;
      if (isDirectFspTransportFragment(packet)) {
        if (!peer || peer.link.state !== "established" || peer.pubkey.length === 0) {
          throw new Error("direct FSP fragment before adjacent link handshake complete");
        }
        const reassembled = this.directFspReassembler.ingest(key, packet, p.receivedAtMs);
        if (!reassembled) return;
        packet = reassembled;
      }
      if (isDirectFspEstablished(packet)) {
        if (!peer || peer.link.state !== "established" || peer.pubkey.length === 0) {
          throw new Error("direct FSP before adjacent link handshake complete");
        }
        void this.handleFspFromPeer(peer, deriveNodeAddr(peer.pubkey), packet).catch((err) => {
          this.emit("error", { err: err as Error, where: "direct-fsp" });
        });
        return;
      }
      const phase = peekFmpPhase(packet);
      this.logger.debug(
        "fips packet received",
        p.remoteAddr.transport,
        p.remoteAddr.addr,
        packet.length,
        phase,
      );
      switch (phase) {
        case FMP_PHASE_MSG1: {
          let replacedEstablishedInitiator = false;
          let replacedHandshake: AdjacentPeer["outgoingHandshake"];
          if (peer?.link.role === "initiator") {
            if (peer.pubkey.length === 0) {
              throw new Error("outbound FMP peer is missing its expected identity");
            }
            const order = compareNodeAddr(
              this.identity.nodeAddr,
              deriveNodeAddr(peer.pubkey),
            );
            if (order < 0) {
              this.logger.debug(
                "simultaneous FMP handshake: local initiator wins",
                p.remoteAddr.transport,
                p.remoteAddr.addr,
              );
              break;
            }
            if (order === 0) throw new Error("simultaneous FMP handshake with local identity");

            replacedEstablishedInitiator = peer.link.state === "established";
            peer.abandonedInitiatorSessionIdx = peer.link.localSessionIdx;
            replacedHandshake = peer.outgoingHandshake;
            peer.link.close();
            peer.link = new FmpLink({
              identity: this.identity,
              role: "responder",
              sessionIdx: nextSessionIdx(),
            });
            this.logger.debug(
              "simultaneous FMP handshake: remote initiator wins",
              p.remoteAddr.transport,
              p.remoteAddr.addr,
            );
          }
          // Responder side: create link if absent.
          if (!peer) {
            const link = new FmpLink({
              identity: this.identity,
              role: "responder",
              sessionIdx: nextSessionIdx(),
            });
            peer = {
              pubkey: new Uint8Array(0),
              pubkeyHex: "",
              remoteAddr: p.remoteAddr,
              transport,
              link,
            };
            this.peers.set(key, peer);
          }
          const wasEstablished = replacedEstablishedInitiator
            || peer.link.state === "established";
          let result: FmpHandshakeResult;
          if (peer.link.role === "responder" && peer.link.state === "established") {
            try {
              result = peer.link.handleMsg1(packet, (n) => this.random.bytes(n));
            } catch (error) {
              if (!(error instanceof Error)
                || error.message !== "unexpected FMP Msg1 after establishment") {
                throw error;
              }
              result = this.stageResponderReplacement(peer, packet);
              this.logger.debug(
                "staged responder link after fresh authenticated Msg1",
                p.remoteAddr.transport,
                p.remoteAddr.addr,
              );
            }
          } else {
            result = peer.link.handleMsg1(packet, (n) => this.random.bytes(n));
          }
          peer.pubkey = result.remotePubkey;
          peer.pubkeyHex = toHex(result.remotePubkey);
          this.rememberPeer(peer);
          if (result.reply) {
            void transport.send(p.remoteAddr, result.reply).catch((err) => {
              this.emit("error", { err: err as Error, where: "send Msg2" });
            });
            this.logger.debug(
              "fips msg2 sent",
              p.remoteAddr.transport,
              p.remoteAddr.addr,
              result.reply.length,
            );
          }
          if (replacedHandshake) {
            peer.outgoingHandshake = undefined;
            replacedHandshake.resolve();
          }
          if (!wasEstablished) {
            this.emit("peer", {
              remotePubkey: peer.pubkeyHex,
              remoteAddr: peer.remoteAddr,
              state: "connected",
            });
          }
          break;
        }
        case FMP_PHASE_MSG2: {
          if (!peer) throw new Error("FMP Msg2 with no peer state");
          if (peer.link.role === "responder" && peer.abandonedInitiatorSessionIdx !== undefined) {
            const msg2 = decodeFmpMsg2(packet);
            if (msg2.receiverIdx === peer.abandonedInitiatorSessionIdx) {
              peer.abandonedInitiatorSessionIdx = undefined;
              this.logger.debug(
                "ignored Msg2 for abandoned simultaneous FMP initiator",
                p.remoteAddr.transport,
                p.remoteAddr.addr,
              );
              break;
            }
          }
          const wasEstablished = peer.link.state === "established";
          peer.link.handleMsg2(packet);
          peer.pubkey = peer.link.remotePubkey!;
          peer.pubkeyHex = toHex(peer.link.remotePubkey!);
          this.rememberPeer(peer);
          if (!wasEstablished) {
            this.emit("peer", {
              remotePubkey: peer.pubkeyHex,
              remoteAddr: peer.remoteAddr,
              state: "connected",
            });
            peer.outgoingHandshake?.resolve();
            peer.outgoingHandshake = undefined;
          }
          this.logger.debug("fips msg2 handled", p.remoteAddr.transport, p.remoteAddr.addr);
          break;
        }
        case FMP_PHASE_ESTABLISHED: {
          if (!peer || peer.link.state !== "established") {
            throw new Error("FMP Established before handshake complete");
          }
          this.pruneDrainingResponderLinks(peer, Date.now());
          const receiverIdx = decodeFmpEstablished(packet).receiverIdx;
          let link = peer.link;
          let promotePending = false;
          if (receiverIdx !== link.localSessionIdx) {
            if (peer.pendingResponderLink?.localSessionIdx === receiverIdx) {
              link = peer.pendingResponderLink;
              promotePending = true;
            } else {
              const draining = peer.drainingResponderLinks?.get(receiverIdx);
              if (!draining) {
                const pendingIdx = peer.pendingResponderLink?.localSessionIdx;
                throw new Error(
                  `FMP Established receiver_idx mismatch: received=${receiverIdx} active=${peer.link.localSessionIdx}`
                  + (pendingIdx === undefined ? "" : ` pending=${pendingIdx}`),
                );
              }
              link = draining.link;
            }
          }
          const { msgType, payload } = link.decryptIncoming(packet);
          if (promotePending) {
            const previous = peer.link;
            peer.link = link;
            peer.pendingResponderLink = undefined;
            const draining = peer.drainingResponderLinks ?? new Map();
            draining.set(previous.localSessionIdx, {
              link: previous,
              expiresAtMs: Date.now() + FMP_REPLACED_LINK_DRAIN_MS,
            });
            peer.drainingResponderLinks = draining;
            this.logger.debug(
              "promoted authenticated responder link",
              p.remoteAddr.transport,
              p.remoteAddr.addr,
              receiverIdx,
            );
          }
          this.routeIncomingLinkMessage(peer, msgType, payload).catch((err) => {
            this.emit("error", { err: err as Error, where: "link-message" });
          });
          break;
        }
        default:
          throw new Error(`unknown FMP phase ${phase}`);
      }
    } catch (err) {
      this.emit("error", { err: err as Error, where: "onTransportPacket" });
      this.logger.warn("transport packet error", err);
    }
  }

  private async routeIncomingLinkMessage(
    peer: AdjacentPeer,
    msgType: number,
    payload: Uint8Array,
  ): Promise<void> {
    if (msgType === LinkMessageType.LookupRequest) {
      await this.handleLookupRequest(peer, payload);
      return;
    }
    if (msgType === LinkMessageType.LookupResponse) {
      if (this.forwarding) await this.forwardLookupResponse(peer, payload);
      return;
    }
    if (msgType !== LinkMessageType.SessionDatagram) {
      if (isKnownUnhandledLinkMessage(msgType)) return;
      this.logger.warn("unsupported FMP link message", msgType);
      return;
    }

    const datagram = decodeSessionDatagramPayload(payload);
    if (bytesEqual(datagram.destAddr, this.identity.nodeAddr)) {
      this.logger.debug(
        "session datagram delivered locally",
        nodeAddrToHex(datagram.srcAddr),
        "phase",
        datagram.payload[0]! & 0x0f,
        "bytes",
        datagram.payload.length,
      );
      await this.handleFspFromPeer(peer, datagram.srcAddr, datagram.payload);
      return;
    }

    if (!this.forwarding) {
      this.logger.warn("dropping SessionDatagram; forwarding=false");
      return;
    }
    if (datagram.ttl <= 1) {
      this.logger.warn("dropping SessionDatagram; ttl exhausted");
      return;
    }
    this.logger.debug(
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
    await this.sendSessionDatagram(
      {
        ...datagram,
        ttl: datagram.ttl - 1,
      },
      peer,
    );
  }

  private async handleLookupRequest(
    sourcePeer: AdjacentPeer,
    payload: Uint8Array,
  ): Promise<void> {
    const request = decodeLookupRequest(payload);
    const targetHex = nodeAddrToHex(request.target);
    if (bytesEqual(request.target, this.identity.nodeAddr)) {
      const targetCoords = [this.identity.nodeAddr];
      const proof = signSchnorr(
        this.identity,
        sha256(lookupResponseProofBytes(request.requestId, request.target, targetCoords)),
      );
      await this.sendLinkMessage(
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
      this.logger.debug("lookup request answered locally", targetHex);
      return;
    }
    if (!this.forwarding || request.ttl === 0) {
      this.logger.debug("lookup request not forwarded", targetHex, "disabled-or-expired");
      return;
    }
    const reverseKey = lookupReverseKey(request.requestId, request.target);
    this.pruneLookupReversePaths(Date.now());
    if (this.lookupReversePaths.has(reverseKey)) return;

    const directOrLearned = this.nextHopFor(targetHex, sourcePeer);
    const fallbackPeers = this.routingMode === "reply_learned" && !directOrLearned
      ? [...this.peers.values()]
        .filter((peer) =>
          peer !== sourcePeer
          && peer.link.state === "established"
          && nodeAddrToHex(deriveNodeAddr(peer.pubkey)) !== nodeAddrToHex(request.origin)
          && (request.minMtu === 0 || peer.transport.mtu >= request.minMtu)
        )
        .slice(0, MAX_REPLY_LEARNED_LOOKUP_PEERS)
      : [];
    const nextHops = directOrLearned ? [directOrLearned] : fallbackPeers;
    if (nextHops.length === 0) {
      this.logger.debug("lookup request not forwarded", targetHex, "no-next-hop");
      return;
    }
    if (directOrLearned && request.minMtu !== 0 && directOrLearned.transport.mtu < request.minMtu) {
      this.logger.debug("lookup request not forwarded", targetHex, "mtu");
      return;
    }
    if (this.lookupReversePaths.has(reverseKey)) return;

    this.reserveLookupReversePath();
    this.lookupReversePaths.set(reverseKey, {
      peer: sourcePeer,
      expiresAtMs: Date.now() + LOOKUP_REVERSE_PATH_TTL_MS,
    });
    request.ttl -= 1;
    const encoded = encodeLookupRequestPayload(request);
    const results = await Promise.allSettled(
      nextHops.map((nextHop) =>
        this.sendLinkMessage(nextHop, LinkMessageType.LookupRequest, encoded)
      ),
    );
    if (results.every((result) => result.status === "rejected")) {
      this.lookupReversePaths.delete(reverseKey);
      throw new Error(`failed to forward lookup request for ${targetHex}`);
    }
    this.logger.debug(
      "lookup request forwarded",
      targetHex,
      nextHops.length,
    );
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
      this.logger.debug("lookup response not forwarded", nodeAddrToHex(response.target));
      return;
    }
    this.learnReverseRoute(nodeAddrToHex(response.target), sourcePeer);
    this.lookupReversePaths.delete(reverseKey);
    response.pathMtu = Math.min(response.pathMtu, reverse.peer.transport.mtu);
    await this.sendLinkMessage(
      reverse.peer,
      LinkMessageType.LookupResponse,
      encodeLookupResponsePayload(response),
    );
    this.logger.debug(
      "lookup response forwarded",
      nodeAddrToHex(response.target),
      reverse.peer.remoteAddr.transport,
      reverse.peer.remoteAddr.addr,
    );
  }

  private async sendLinkMessage(
    peer: AdjacentPeer,
    msgType: number,
    payload: Uint8Array,
  ): Promise<void> {
    const frame = peer.link.encryptOutgoing(payload, msgType);
    await peer.transport.send(peer.remoteAddr, frame);
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

  private async sendHeartbeats(): Promise<void> {
    const nowMs = Date.now();
    for (const peer of this.peers.values()) {
      this.pruneDrainingResponderLinks(peer, nowMs);
    }
    const peers = [...this.peers.values()].filter(
      (peer) => peer.link.state === "established",
    );
    await Promise.allSettled(peers.map(async (peer) => {
      const frame = peer.link.encryptOutgoing(
        new Uint8Array(0),
        LinkMessageType.Heartbeat,
      );
      try {
        await peer.transport.send(peer.remoteAddr, frame);
      } catch (err) {
        this.emit("error", { err: err as Error, where: "send Heartbeat" });
      }
    }));
  }

  private stageResponderReplacement(
    peer: AdjacentPeer,
    packet: Uint8Array,
  ): FmpHandshakeResult {
    let replacement = peer.pendingResponderLink;
    if (replacement) {
      try {
        return replacement.handleMsg1(packet, (n) => this.random.bytes(n));
      } catch (error) {
        if (!(error instanceof Error)
          || error.message !== "unexpected FMP Msg1 after establishment") {
          throw error;
        }
        replacement.close();
        peer.pendingResponderLink = undefined;
      }
    }
    replacement = new FmpLink({
      identity: this.identity,
      role: "responder",
      sessionIdx: nextSessionIdx(),
    });
    const result = replacement.handleMsg1(packet, (n) => this.random.bytes(n));
    if (peer.pubkey.length > 0 && !bytesEqual(peer.pubkey, result.remotePubkey)) {
      replacement.close();
      throw new Error("fresh FMP Msg1 changed the authenticated peer identity");
    }
    peer.pendingResponderLink = replacement;
    return result;
  }

  private pruneDrainingResponderLinks(peer: AdjacentPeer, nowMs: number): void {
    if (!peer.drainingResponderLinks) return;
    for (const [receiverIdx, draining] of peer.drainingResponderLinks) {
      if (draining.expiresAtMs > nowMs) continue;
      draining.link.close();
      peer.drainingResponderLinks.delete(receiverIdx);
    }
    if (peer.drainingResponderLinks.size === 0) {
      peer.drainingResponderLinks = undefined;
    }
  }

  private async handleFspFromPeer(
    peer: AdjacentPeer,
    srcNodeAddr: NodeAddr,
    fspFrame: Uint8Array,
  ): Promise<void> {
    const phase = peekFspPhase(fspFrame);
    const srcNodeHex = nodeAddrToHex(srcNodeAddr);
    let session = this.sessions.get(srcNodeHex);
    if (phase === FSP_PHASE_ESTABLISHED) {
      if (!session || session.fsp.state !== "established") {
        throw new Error(`FSP Established before handshake from ${srcNodeHex}`);
      }
      this.prunePreviousFsp(session, Date.now());
      const established = decodeFspEstablished(fspFrame);
      const receivedKBit = (established.flags & FSP_FLAG_K) !== 0;
      let receiveFsp = session.fsp;
      let promotePending = false;
      if (receivedKBit !== session.currentKBit) {
        if (session.pendingResponderFsp?.state === "established") {
          receiveFsp = session.pendingResponderFsp;
          promotePending = true;
        } else if (session.previousFsp?.kBit === receivedKBit) {
          receiveFsp = session.previousFsp.fsp;
        } else {
          throw new Error(
            `FSP Established epoch mismatch: receivedK=${Number(receivedKBit)}`
            + ` currentK=${Number(session.currentKBit)}`,
          );
        }
      }
      const result = receiveFsp.decryptIncoming(fspFrame);
      this.learnReverseRoute(srcNodeHex, peer);
      if (promotePending) {
        session.previousFsp?.fsp.close();
        session.previousFsp = {
          fsp: session.fsp,
          kBit: session.currentKBit,
          expiresAtMs: Date.now() + FSP_REKEY_DRAIN_MS,
        };
        session.fsp = receiveFsp;
        session.currentKBit = receivedKBit;
        session.pendingResponderFsp = undefined;
        if (receiveFsp.remotePubkey) {
          session.remotePubkey = receiveFsp.remotePubkey;
          session.remotePubkeyHex = toHex(receiveFsp.remotePubkey);
        }
        this.logger.debug("promoted authenticated FSP rekey epoch", srcNodeHex, receivedKBit);
      }
      const srcHex = session.remotePubkeyHex ?? srcNodeHex;
      if (result.msgType === FSP_MSG_DATA && result.data) {
        const dp = result.data;
        const handler = this.services.get(dp.dstPort);
        const reply: ServiceContext["reply"] = async (data, replyPort) => {
          await this.sendDatagram({
            dst: srcHex,
            srcPort: dp.dstPort,
            dstPort: replyPort ?? dp.srcPort,
            payload: data,
          });
        };
        this.emit("datagram", {
          src: srcHex,
          dst: toHex(this.identity.publicKey),
          srcPort: dp.srcPort,
          dstPort: dp.dstPort,
          payload: dp.payload,
        });
        if (handler) await handler({ src: srcHex, srcPort: dp.srcPort, dstPort: dp.dstPort, payload: dp.payload, reply });
      }
      if (result.msgType === FSP_MSG_ENDPOINT_DATA && result.endpointData) {
        this.emit("endpointData", {
          src: srcHex,
          dst: toHex(this.identity.publicKey),
          payload: result.endpointData,
        });
      }
      return;
    }
    // Handshake phases 1/2/3.
    if (phase === 1) {
      let reply: Uint8Array;
      if (session?.pendingResponderFsp?.matchesSessionSetup(fspFrame)) {
        reply = session.pendingResponderFsp.handleSessionSetup(
          fspFrame,
          (n) => this.random.bytes(n),
          this.identity.nodeAddr,
        );
      } else if (session?.fsp.matchesSessionSetup(fspFrame)) {
        reply = session.fsp.handleSessionSetup(
          fspFrame,
          (n) => this.random.bytes(n),
          this.identity.nodeAddr,
        );
      } else if (session?.fsp.state === "established") {
        const pending = new FspSession({ identity: this.identity, role: "responder" });
        reply = pending.handleSessionSetup(
          fspFrame,
          (n) => this.random.bytes(n),
          this.identity.nodeAddr,
        );
        session.pendingResponderFsp?.close();
        session.pendingResponderFsp = pending;
      } else {
        const fsp = new FspSession({ identity: this.identity, role: "responder" });
        reply = fsp.handleSessionSetup(
          fspFrame,
          (n) => this.random.bytes(n),
          this.identity.nodeAddr,
        );
        session = { remoteNodeAddr: srcNodeAddr, fsp, currentKBit: false };
        this.sessions.set(srcNodeHex, session);
        this.emit("session", { remotePubkey: srcNodeHex, state: "establishing" });
      }
      await this.sendFspReplyToward(srcNodeAddr, reply, peer);
      return;
    }
    if (phase === 2) {
      if (!session) throw new Error(`FSP msg2 with no session ${srcNodeHex}`);
      const reply = session.fsp.handleSessionAck(fspFrame, (n) => this.random.bytes(n));
      const eventPubkey = session.remotePubkeyHex ?? srcNodeHex;
      this.emit("session", { remotePubkey: eventPubkey, state: "established" });
      await this.sendFspToward(srcNodeAddr, reply);
      session.setupResolve?.();
      session.setupResolve = undefined;
      session.setupReject = undefined;
      return;
    }
    if (phase === 3) {
      if (!session) throw new Error(`FSP msg3 with no session ${srcNodeHex}`);
      const handshakeFsp = session.pendingResponderFsp ?? session.fsp;
      handshakeFsp.handleSessionMsg3(fspFrame);
      if (handshakeFsp.remotePubkey) {
        if (!bytesEqual(deriveNodeAddr(handshakeFsp.remotePubkey), srcNodeAddr)) {
          handshakeFsp.close();
          if (session.pendingResponderFsp === handshakeFsp) {
            session.pendingResponderFsp = undefined;
          } else {
            this.sessions.delete(srcNodeHex);
          }
          throw new Error("FSP msg3 authenticated key does not match claimed source NodeAddr");
        }
        if (session.remotePubkey && !bytesEqual(session.remotePubkey, handshakeFsp.remotePubkey)) {
          throw new Error("FSP rekey changed the authenticated remote identity");
        }
        session.remotePubkey = handshakeFsp.remotePubkey;
        session.remotePubkeyHex = toHex(handshakeFsp.remotePubkey);
      }
      this.learnReverseRoute(srcNodeHex, peer);
      this.emit("session", {
        remotePubkey: session.remotePubkeyHex ?? srcNodeHex,
        state: "established",
      });
      return;
    }
    throw new Error(`unknown FSP phase ${phase}`);
  }

  private async ensureSession(remotePubkeyHex: string): Promise<Session> {
    const remotePubkey = hexBytes(remotePubkeyHex);
    const remoteNodeAddr = deriveNodeAddr(remotePubkey);
    const remoteNodeHex = nodeAddrToHex(remoteNodeAddr);
    let session = this.sessions.get(remoteNodeHex);
    if (session && session.fsp.state === "established") return session;
    if (session && session.fsp.state === "handshaking") {
      await new Promise<void>((resolve, reject) => {
        session!.setupResolve = resolve;
        session!.setupReject = reject;
      });
      return session;
    }
    const fsp = new FspSession({
      identity: this.identity,
      role: "initiator",
      remotePubkey,
    });
    session = { remoteNodeAddr, remotePubkeyHex, remotePubkey, fsp, currentKBit: false };
    this.sessions.set(remoteNodeHex, session);
    this.emit("session", { remotePubkey: remotePubkeyHex, state: "establishing" });
    const msg1 = fsp.buildSessionSetup(
      (n) => this.random.bytes(n),
      this.identity.nodeAddr,
      remoteNodeAddr,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const setupDone = new Promise<void>((resolve, reject) => {
      session!.setupResolve = resolve;
      session!.setupReject = reject;
      timer = setTimeout(() => reject(new Error("FSP handshake timeout")), 15_000);
    });
    try {
      await this.sendFspToward(remoteNodeAddr, msg1);
      await setupDone;
    } finally {
      if (timer) clearTimeout(timer);
    }
    return session;
  }

  /**
   * Wrap an FSP frame in a SessionDatagram and send it toward a remote NodeAddr.
   */
  private async sendFspToward(
    remoteNodeAddr: NodeAddr,
    fspFrame: Uint8Array,
  ): Promise<void> {
    await this.sendSessionDatagram({
      ttl: 64,
      pathMtu: FSP_DEFAULT_PATH_MTU,
      srcAddr: this.identity.nodeAddr,
      destAddr: remoteNodeAddr,
      payload: fspFrame,
    });
  }

  /**
   * Return a pre-authentication FSP handshake response through the
   * authenticated adjacent peer that delivered the request. This mirrors
   * Rust fips-core's send_session_datagram_reply path and does not create a
   * learned route from an unauthenticated SessionDatagram source claim.
   */
  private async sendFspReplyToward(
    remoteNodeAddr: NodeAddr,
    fspFrame: Uint8Array,
    previousHop: AdjacentPeer,
  ): Promise<void> {
    const datagram: SessionDatagram = {
      ttl: 64,
      pathMtu: FSP_DEFAULT_PATH_MTU,
      srcAddr: this.identity.nodeAddr,
      destAddr: remoteNodeAddr,
      payload: fspFrame,
    };
    this.logger.debug(
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
    await this.sendLinkMessage(
      previousHop,
      LinkMessageType.SessionDatagram,
      encoded.subarray(1),
    );
  }

  private prunePreviousFsp(session: Session, nowMs: number): void {
    if (!session.previousFsp || session.previousFsp.expiresAtMs > nowMs) return;
    session.previousFsp.fsp.close();
    session.previousFsp = undefined;
  }

  private directPeerForSession(session: Session): AdjacentPeer | undefined {
    const peer = this.peersByNodeAddr.get(nodeAddrToHex(session.remoteNodeAddr));
    return peer?.link.state === "established" ? peer : undefined;
  }

  private async sendDirectFsp(peer: AdjacentPeer, fspFrame: Uint8Array): Promise<void> {
    const pathMtu = Math.min(peer.transport.mtu, FSP_DEFAULT_PATH_MTU);
    const packets = segmentDirectFspTransportRecord(fspFrame, pathMtu);
    for (const packet of packets) {
      await peer.transport.send(peer.remoteAddr, packet);
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
    if (!nextHop) throw new Error(`no route to ${destNodeHex}`);

    this.logger.debug(
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
    const direct = this.peersByNodeAddr.get(destNodeHex);
    if (direct?.link.state === "established" && direct !== excludedPeer) return direct;
    if (this.routingMode === "reply_learned") {
      const learnedNodeHex = this.learnedRoutes.selectNextHop(
        destNodeHex,
        Date.now(),
        (nextHop) => {
          const candidate = this.peersByNodeAddr.get(nextHop);
          return candidate?.link.state === "established" && candidate !== excludedPeer;
        },
      );
      if (learnedNodeHex) return this.peersByNodeAddr.get(learnedNodeHex);
    }
    const defaultPeer = this.defaultRoute
      ? this.peersByPubkey.get(this.defaultRoute)
      : undefined;
    return defaultPeer?.link.state === "established" && defaultPeer !== excludedPeer
      ? defaultPeer
      : undefined;
  }

  private learnReverseRoute(destinationNodeHex: string, nextHop: AdjacentPeer): void {
    if (this.routingMode !== "reply_learned") return;
    const localNodeHex = nodeAddrToHex(this.identity.nodeAddr);
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
    const resolvers = this.transports.filter(
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
      onAbort = () => reject(this.started ? noRoute() : new Error("FIPS node stopped"));
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
    await this.connectKnownPeer(
      resolved.transport,
      resolved.remoteAddr,
      resolved.remotePubkey,
    );
  }
}

function discoveryPublicKey(discovered: {
  publicKey?: Uint8Array;
  remoteAddr: TransportAddress;
}): Uint8Array {
  const hinted = discovered.publicKey;
  if (hinted?.length === 32) return compressedPubkeyFromXOnly(hinted);
  if (hinted?.length === 33) {
    if (hinted[0] !== 0x02 && hinted[0] !== 0x03) {
      throw new Error("discovered compressed pubkey has invalid prefix");
    }
    return new Uint8Array(hinted);
  }
  if (!hinted && discovered.remoteAddr.addr.length === 66) {
    return hexBytes(discovered.remoteAddr.addr);
  }
  throw new Error("discovered peer did not include a FIPS public key");
}

function hexBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function lookupReverseKey(requestId: bigint, target: NodeAddr): string {
  return `${requestId.toString(16)}:${nodeAddrToHex(target)}`;
}

function isKnownUnhandledLinkMessage(msgType: number): boolean {
  return (
    msgType === LinkMessageType.Heartbeat ||
    msgType === LinkMessageType.Disconnect ||
    msgType === LinkMessageType.SenderReport ||
    msgType === LinkMessageType.ReceiverReport ||
    msgType === LinkMessageType.TreeAnnounce ||
    msgType === LinkMessageType.FilterAnnounce
  );
}
