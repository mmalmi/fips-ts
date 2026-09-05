import { randomBytes } from "@noble/hashes/utils";

import { bytesEqual, fromHex, toHex } from "../codec/hex.js";
import { FmpLink } from "../fmp/link.js";
import type { FipsIdentity } from "../identity/index.js";
import { deriveNodeAddr, nodeAddrToHex } from "../nodeaddr/index.js";
import { LinkMessageType } from "../protocol/link.js";
import {
  noopLogger,
  type Logger,
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
  SessionEvent,
} from "./types.js";
import { FipsRouting } from "./FipsRouting.js";
import {
  FmpTransportPacketProcessor,
} from "./FmpTransportPacketProcessor.js";
import { FspSessionManager } from "./FspSessionManager.js";
import { FMP_HANDSHAKE_TIMEOUT_MS, pruneDrainingResponderLinks, type AdjacentPeer } from "./PeerState.js";
import { discoveryPublicKey } from "./routingHelpers.js";

const defaultRandom: RandomSource = { bytes: (n) => randomBytes(n) };
const FMP_HANDSHAKE_RESEND_MS = 1_000;
const FMP_HEARTBEAT_INTERVAL_MS = 5_000;

export class FipsNode {
  readonly identity: FipsIdentity;
  readonly forwarding: boolean;
  private readonly routingMode: "tree" | "reply_learned";
  private readonly transports: Transport[];
  private readonly random: RandomSource;
  private readonly startupEpoch: Uint8Array;
  private nextFmpSessionIdx: number;
  private readonly logger: Logger;
  private readonly defaultRoute?: string;
  private readonly heartbeatIntervalMs: number;

  private peers = new Map<string, AdjacentPeer>();  // by transportAddressKey
  private peersByPubkey = new Map<string, AdjacentPeer>(); // by pubkey hex
  private peersByNodeAddr = new Map<string, AdjacentPeer>(); // by NodeAddr hex
  private pendingPeerConnects = new Map<string, Promise<void>>(); // by transportAddressKey
  private listeners = new Map<FipsEventName, Set<(event: unknown) => void>>();
  private discoveryTasks = new Set<Promise<void>>();
  private discoveryConnectTasks = new Set<Promise<void>>();
  private discoveryGeneration = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly routing: FipsRouting;
  private readonly sessionManager: FspSessionManager;
  private readonly packetProcessor: FmpTransportPacketProcessor;
  private started = false;

  constructor(cfg: FipsNodeConfig) {
    this.identity = cfg.identity;
    this.transports = expandCompanionTransports(cfg.transports);
    this.forwarding = cfg.forwarding ?? false;
    this.routingMode = cfg.routingMode ?? "tree";
    this.defaultRoute = cfg.defaultRoute?.toLowerCase();
    if (this.defaultRoute && !/^(02|03)[0-9a-f]{64}$/.test(this.defaultRoute)) {
      throw new Error("defaultRoute must be a 33-byte compressed pubkey hex");
    }
    this.random = cfg.random ?? defaultRandom;
    this.startupEpoch = this.random.bytes(8);
    if (this.startupEpoch.length !== 8) {
      throw new Error("FIPS random source returned a bad startup epoch");
    }
    this.nextFmpSessionIdx = readU32Le(this.startupEpoch) || 1;
    this.logger = cfg.logger ?? noopLogger;
    this.heartbeatIntervalMs = cfg.heartbeatIntervalMs ?? FMP_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
      throw new Error("heartbeatIntervalMs must be a positive safe integer");
    }
    this.routing = new FipsRouting({
      identity: this.identity,
      forwarding: this.forwarding,
      routingMode: this.routingMode,
      defaultRoute: this.defaultRoute,
      transports: this.transports,
      logger: this.logger,
      randomBytes: (length) => this.random.bytes(length),
      getPeers: () => this.peers.values(),
      getPeerByPubkey: (pubkeyHex) => this.peersByPubkey.get(pubkeyHex),
      getPeerByNodeAddr: (nodeAddrHex) => this.peersByNodeAddr.get(nodeAddrHex),
      sendLinkMessage: (peer, msgType, payload) =>
        this.sendLinkMessage(peer, msgType, payload),
      connectKnownPeer: (transport, remoteAddr, remotePubkey) =>
        this.connectKnownPeer(transport, remoteAddr, remotePubkey),
      handleLocalSession: (peer, srcNodeAddr, payload) =>
        this.sessionManager.handleFromPeer(peer, srcNodeAddr, payload),
      emitError: (error, where) => this.emit("error", { err: error, where }),
      isStarted: () => this.started,
    });
    this.sessionManager = new FspSessionManager({
      identity: this.identity,
      random: this.random,
      localEpoch: this.startupEpoch,
      logger: this.logger,
      routing: this.routing,
      getPeerByNodeAddr: (nodeAddrHex) => this.peersByNodeAddr.get(nodeAddrHex),
      emitDatagram: (event) => this.emit("datagram", event),
      emitEndpointData: (event) => this.emit("endpointData", event),
      handleLinkNegotiation: async (remotePubkeyHex, message) => {
        const transport = this.transports.find(
          (candidate) => candidate.type === message.linkType && candidate.handleLinkNegotiation,
        );
        if (!transport?.handleLinkNegotiation) {
          this.logger.debug("ignored link negotiation for disabled adapter", message.linkType);
          return;
        }
        await transport.handleLinkNegotiation(remotePubkeyHex, message);
      },
      emitSession: (event) => this.emit("session", event),
    });
    this.packetProcessor = new FmpTransportPacketProcessor({
      identity: this.identity,
      startupEpoch: this.startupEpoch,
      nextSessionIdx: () => this.allocateFmpSessionIdx(),
      randomBytes: (length) => this.random.bytes(length),
      logger: this.logger,
      peers: this.peers,
      peersByPubkey: this.peersByPubkey,
      peersByNodeAddr: this.peersByNodeAddr,
      routing: this.routing,
      sessionManager: this.sessionManager,
      emitError: (error, where) => this.emit("error", { err: error, where }),
      emitPeer: (event) => this.emit("peer", event),
      removePeerPath: (peer) => {
        const key = transportAddressKey(peer.remoteAddr);
        if (this.peers.get(key) === peer) this.removePeerPath(key, peer, true);
      },
      handlePeerRestart: (remotePubkeyHex, preserveTransport) => {
        for (const transport of this.transports) {
          if (transport === preserveTransport || !transport.handlePeerRestart) continue;
          void transport.handlePeerRestart(remotePubkeyHex).catch((error) => {
            this.emit("error", { err: error, where: "transport.handlePeerRestart" });
          });
        }
      },
    });
    for (const s of cfg.services ?? []) {
      this.sessionManager.registerService(s.port, s.handler);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    const startedTransports: Transport[] = [];
    try {
      for (const t of this.transports) {
        await t.start({
          localIdentity: this.identity,
          onPacket: (packet) => this.packetProcessor.process(t, packet),
          onConnectionState: (e) => this.onTransportConn(t, e),
          connectTransport: (addr) => this.connect(addr),
          sendLinkNegotiation: (remotePubkeyHex, message) =>
            this.sessionManager.sendLinkNegotiation(remotePubkeyHex, message),
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
    this.sessionManager.start();
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
    this.packetProcessor.clear();
    for (const peer of this.peers.values()) {
      peer.outgoingHandshake?.reject(new Error("FIPS node stopped"));
      peer.link.close();
      peer.pendingResponderLink?.close();
      for (const draining of peer.drainingResponderLinks?.values() ?? []) {
        draining.link.close();
      }
    }
    this.routing.stop();
    this.sessionManager.stop();
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
    return this.sessionManager.registerService(port, handler);
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
    const remotePubkey = fromHex(addr.addr);
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
    const pendingConnect = this.pendingPeerConnects.get(key);
    if (pendingConnect) {
      await pendingConnect;
      return;
    }
    if (this.peers.get(key)?.link.state === "established") return;
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
    const concurrentlyEstablished = this.peers.get(key);
    if (concurrentlyEstablished?.link.state === "established") return;
    if (concurrentlyEstablished) {
      this.packetProcessor.discardPendingResponder(concurrentlyEstablished);
      concurrentlyEstablished.link.close();
    }
    const link = new FmpLink({
      identity: this.identity,
      remotePubkey,
      role: "initiator",
      sessionIdx: this.allocateFmpSessionIdx(),
      localEpoch: this.startupEpoch,
    });
    const peer: AdjacentPeer = {
      pubkey: remotePubkey,
      pubkeyHex: toHex(remotePubkey),
      remoteAddr: addr,
      transport,
      link,
    };
    this.peers.set(key, peer);

    const handshakeDone = new Promise<void>((resolve, reject) => {
      peer.outgoingHandshake = { resolve, reject };
    });
    let resendTimer: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connected = false;
    try {
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
      resendTimer = setInterval(() => {
        if (!peer.outgoingHandshake) return;
        void sendMsg1(true).catch((err) => {
          this.emit("error", { err: err as Error, where: "resend Msg1" });
        });
      }, FMP_HANDSHAKE_RESEND_MS);
      timer = setTimeout(() => {
        this.logger.warn("fips handshake timeout", addr.transport, addr.addr);
        peer.outgoingHandshake?.reject(new Error("FMP handshake timeout"));
      }, FMP_HANDSHAKE_TIMEOUT_MS);
      await handshakeDone;
      connected = true;
    } finally {
      clearTimeout(timer);
      clearInterval(resendTimer);
      peer.outgoingHandshake = undefined;
      if (!connected && this.peers.get(key) === peer) {
        peer.link.close();
        this.packetProcessor.discardPendingResponder(peer);
        this.removePeerPath(key, peer, false);
      }
    }
  }

  private allocateFmpSessionIdx(): number {
    const value = this.nextFmpSessionIdx;
    this.nextFmpSessionIdx = (value + 1) >>> 0 || 1;
    return value;
  }

  /** Send a service datagram to a target identity (adjacent or routable). */
  async sendDatagram(args: {
    dst: string; // remote pubkey hex
    srcPort?: number;
    dstPort: number;
    payload: Uint8Array;
  }): Promise<void> {
    await this.sessionManager.sendDatagram(args);
  }

  /** Send app-owned endpoint bytes to a target identity without service ports. */
  async sendEndpointData(args: {
    dst: string; // remote pubkey hex
    payload: Uint8Array;
  }): Promise<void> {
    await this.sessionManager.sendEndpointData(args);
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
        const wasConnected = peer.link.state === "established" && !peer.outgoingHandshake;
        peer.outgoingHandshake?.reject(new Error("FMP transport disconnected"));
        peer.link.close();
        this.packetProcessor.discardPendingResponder(peer);
        for (const draining of peer.drainingResponderLinks?.values() ?? []) {
          draining.link.close();
        }
        this.removePeerPath(key, peer, true);
        if (wasConnected) {
          this.emit("peer", {
            remotePubkey: peer.pubkeyHex,
            remoteAddr: peer.remoteAddr,
            state: "disconnected",
          });
        }
      }
    }
  }

  private rememberPeer(peer: AdjacentPeer): void {
    if (peer.pubkey.length === 0 || !peer.pubkeyHex) return;
    this.peersByPubkey.set(peer.pubkeyHex, peer);
    this.peersByNodeAddr.set(nodeAddrToHex(deriveNodeAddr(peer.pubkey)), peer);
  }

  private removePeerPath(
    key: string,
    peer: AdjacentPeer,
    closeSessionWithoutAlternate: boolean,
  ): void {
    this.peers.delete(key);
    const alternates = [...this.peers.values()].filter((candidate) =>
      candidate !== peer
      && candidate.pubkeyHex === peer.pubkeyHex
      && (
        candidate.link.state === "established"
        || candidate.outgoingHandshake !== undefined
        || candidate.pendingResponderLink !== undefined
      )
    );
    const alternate = alternates.find((candidate) =>
      candidate.link.state === "established" && !candidate.outgoingHandshake
    );
    if (alternate) {
      this.rememberPeer(alternate);
      this.routing.scheduleTreeAnnounce(alternate);
      return;
    }
    if (this.peersByPubkey.get(peer.pubkeyHex) === peer) {
      this.peersByPubkey.delete(peer.pubkeyHex);
    }
    if (peer.pubkey.length > 0) {
      const peerNodeAddr = deriveNodeAddr(peer.pubkey);
      const nodeAddrHex = nodeAddrToHex(peerNodeAddr);
      if (this.peersByNodeAddr.get(nodeAddrHex) === peer) {
        this.peersByNodeAddr.delete(nodeAddrHex);
      }
      this.routing.removePeer(peerNodeAddr);
    }
    if (closeSessionWithoutAlternate && alternates.length === 0) {
      this.sessionManager.closePeerSessions(peer.pubkeyHex);
    }
  }


  private async sendLinkMessage(
    peer: AdjacentPeer,
    msgType: number,
    payload: Uint8Array,
  ): Promise<void> {
    const frame = peer.link.encryptOutgoing(payload, msgType);
    await peer.transport.send(peer.remoteAddr, frame);
  }

  private async sendHeartbeats(): Promise<void> {
    const nowMs = Date.now();
    for (const peer of this.peers.values()) {
      pruneDrainingResponderLinks(peer, nowMs);
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
}

function readU32Le(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

function expandCompanionTransports(configured: Transport[]): Transport[] {
  const explicitTypes = new Set(configured.map((transport) => transport.type));
  const expanded: Transport[] = [];
  const addedTypes = new Set<string>();
  for (const transport of configured) {
    for (const companion of transport.companionTransports?.() ?? []) {
      if (explicitTypes.has(companion.type) || addedTypes.has(companion.type)) continue;
      expanded.push(companion);
      addedTypes.add(companion.type);
    }
    expanded.push(transport);
    addedTypes.add(transport.type);
  }
  return expanded;
}
