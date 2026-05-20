import { randomBytes } from "@noble/hashes/utils";

import { toHex } from "../codec/hex.js";
import { FmpLink } from "../fmp/link.js";
import { FspSession } from "../fsp/session.js";
import {
  decodeFmpEstablished,
  FMP_PHASE_ESTABLISHED,
  FMP_PHASE_MSG1,
  FMP_PHASE_MSG2,
  peekFmpPhase,
} from "../fmp/wire.js";
import {
  FSP_MSG_DATA,
  FSP_MSG_ENDPOINT_DATA,
  FSP_PHASE_ESTABLISHED,
  peekFspPhase,
} from "../fsp/wire.js";
import type { FipsIdentity } from "../identity/index.js";
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

import {
  decodeForwardEnvelope,
  encodeForwardEnvelope,
  FORWARD_VERSION,
} from "./forward.js";

interface AdjacentPeer {
  pubkey: Uint8Array;           // 33 compressed
  pubkeyHex: string;
  remoteAddr: TransportAddress;
  transport: Transport;
  link: FmpLink;
  outgoingHandshake?: {
    resolve: () => void;
    reject: (err: Error) => void;
  };
}

interface Session {
  remotePubkeyHex: string;
  remotePubkey: Uint8Array;
  fsp: FspSession;
  setupResolve?: () => void;
  setupReject?: (err: Error) => void;
}

let sessionIdxCounter = 1;
function nextSessionIdx(): number {
  const v = sessionIdxCounter++;
  return v >>> 0;
}

const defaultRandom: RandomSource = { bytes: (n) => randomBytes(n) };

export class FipsNode {
  readonly identity: FipsIdentity;
  readonly forwarding: boolean;
  private readonly transports: Transport[];
  private readonly random: RandomSource;
  private readonly logger: Logger;

  private services = new Map<number, FipsServiceHandler>();
  private peers = new Map<string, AdjacentPeer>();  // by transportAddressKey
  private peersByPubkey = new Map<string, AdjacentPeer>(); // by pubkey hex
  private sessions = new Map<string, Session>();    // by remote pubkey hex
  private listeners = new Map<FipsEventName, Set<(event: unknown) => void>>();
  private started = false;

  constructor(cfg: FipsNodeConfig) {
    this.identity = cfg.identity;
    this.transports = cfg.transports;
    this.forwarding = cfg.forwarding ?? false;
    this.random = cfg.random ?? defaultRandom;
    this.logger = cfg.logger ?? noopLogger;
    for (const s of cfg.services ?? []) {
      this.services.set(s.port, s.handler);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    for (const t of this.transports) {
      await t.start({
        localIdentity: this.identity,
        onPacket: (p) => this.onTransportPacket(t, p),
        onConnectionState: (e) => this.onTransportConn(t, e),
        logger: this.logger,
      });
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    for (const t of this.transports) {
      try {
        await t.stop();
      } catch (err) {
        this.emit("error", { err: err as Error, where: "transport.stop" });
      }
    }
    this.peers.clear();
    this.peersByPubkey.clear();
    this.sessions.clear();
    this.started = false;
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
    const key = transportAddressKey(addr);
    if (this.peers.has(key) && this.peers.get(key)!.link.state === "established") return;
    await transport.connect(addr);
    const link = new FmpLink({
      identity: this.identity,
      remotePubkey,
      role: "initiator",
      sessionIdx: nextSessionIdx(),
    });
    const peer: AdjacentPeer = {
      pubkey: remotePubkey,
      pubkeyHex: addr.addr,
      remoteAddr: addr,
      transport,
      link,
    };
    this.peers.set(key, peer);
    this.peersByPubkey.set(addr.addr, peer);

    const handshakeDone = new Promise<void>((resolve, reject) => {
      peer.outgoingHandshake = { resolve, reject };
    });
    const msg1 = link.buildMsg1((n) => this.random.bytes(n));
    await transport.send(addr, msg1.packet);
    const timer = setTimeout(() => {
      peer.outgoingHandshake?.reject(new Error("FMP handshake timeout"));
    }, 15_000);
    try {
      await handshakeDone;
    } finally {
      clearTimeout(timer);
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
    const fspFrame = session.fsp.encryptDatagram({
      srcPort: args.srcPort ?? 0,
      dstPort: args.dstPort,
      payload: args.payload,
    });
    await this.sendFspToward(args.dst, fspFrame);
  }

  /** Send app-owned endpoint bytes to a target identity without service ports. */
  async sendEndpointData(args: {
    dst: string; // remote pubkey hex
    payload: Uint8Array;
  }): Promise<void> {
    const session = await this.ensureSession(args.dst);
    const fspFrame = session.fsp.encryptEndpointData(args.payload);
    await this.sendFspToward(args.dst, fspFrame);
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
        this.peers.delete(key);
        this.peersByPubkey.delete(peer.pubkeyHex);
        for (const pkHex of this.sessions.keys()) {
          if (pkHex === peer.pubkeyHex) {
            this.sessions.delete(pkHex);
            this.emit("session", { remotePubkey: pkHex, state: "closed" });
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

  private onTransportPacket(
    transport: Transport,
    p: ReceivedTransportPacket,
  ): void {
    try {
      const phase = peekFmpPhase(p.data);
      const key = transportAddressKey(p.remoteAddr);
      let peer = this.peers.get(key);
      switch (phase) {
        case FMP_PHASE_MSG1: {
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
          const result = peer.link.handleMsg1(p.data, (n) => this.random.bytes(n));
          peer.pubkey = result.remotePubkey;
          peer.pubkeyHex = toHex(result.remotePubkey);
          this.peersByPubkey.set(peer.pubkeyHex, peer);
          if (result.reply) {
            void transport.send(p.remoteAddr, result.reply).catch((err) => {
              this.emit("error", { err: err as Error, where: "send Msg2" });
            });
          }
          this.emit("peer", {
            remotePubkey: peer.pubkeyHex,
            remoteAddr: peer.remoteAddr,
            state: "connected",
          });
          break;
        }
        case FMP_PHASE_MSG2: {
          if (!peer) throw new Error("FMP Msg2 with no peer state");
          peer.link.handleMsg2(p.data);
          peer.pubkeyHex = toHex(peer.link.remotePubkey!);
          this.peersByPubkey.set(peer.pubkeyHex, peer);
          this.emit("peer", {
            remotePubkey: peer.pubkeyHex,
            remoteAddr: peer.remoteAddr,
            state: "connected",
          });
          peer.outgoingHandshake?.resolve();
          peer.outgoingHandshake = undefined;
          break;
        }
        case FMP_PHASE_ESTABLISHED: {
          if (!peer || peer.link.state !== "established") {
            throw new Error("FMP Established before handshake complete");
          }
          // Inner is encoded by FmpLink.encryptOutgoing — its inner payload is
          // either FORWARD_ENVELOPE (peer-to-peer routed packet) or DATA
          // intended for this hop's FSP layer.
          const { msgType, payload } = peer.link.decryptIncoming(p.data);
          // msgType DATA (0x01) carries FSP frames bound for THIS node (i.e.
          // the FMP link's remote endpoint is also the FSP endpoint). Forwarded
          // packets use the FORWARD envelope (see node/forward.ts).
          void msgType;
          this.routeIncomingFsp(peer, payload);
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

  /**
   * Incoming FMP-inner bytes: could be an FSP frame for us, or a FORWARD
   * envelope to relay if forwarding is enabled.
   */
  private routeIncomingFsp(peer: AdjacentPeer, inner: Uint8Array): void {
    if (inner.length >= 1 && inner[0] === FORWARD_VERSION) {
      this.handleForwardEnvelope(peer, inner).catch((err) => {
        this.emit("error", { err: err as Error, where: "forward" });
      });
      return;
    }
    // Otherwise: an FSP frame addressed to this node from the peer.
    void this.handleFspFromPeer(peer, peer.pubkey, inner).catch((err) => {
      this.emit("error", { err: err as Error, where: "fsp" });
    });
  }

  private async handleForwardEnvelope(peer: AdjacentPeer, inner: Uint8Array): Promise<void> {
    const env = decodeForwardEnvelope(inner);
    const dstHex = toHex(env.dstPubkey);
    const ourHex = toHex(this.identity.publicKey);
    if (dstHex === ourHex) {
      // Final destination is us: process FSP, using env.srcPubkey as the
      // logical session counterparty.
      await this.handleFspFromPeer(peer, env.srcPubkey, env.fspFrame);
      return;
    }
    if (!this.forwarding) {
      this.logger.warn("dropping forward; forwarding=false");
      return;
    }
    if (env.ttl <= 0) {
      this.logger.warn("dropping forward; ttl=0");
      return;
    }
    const nextHop = this.peersByPubkey.get(dstHex);
    if (!nextHop || nextHop.link.state !== "established") {
      this.logger.warn("no next-hop FMP link", dstHex);
      return;
    }
    const repacked = encodeForwardEnvelope({
      version: FORWARD_VERSION,
      ttl: env.ttl - 1,
      srcPubkey: env.srcPubkey,
      dstPubkey: env.dstPubkey,
      fspFrame: env.fspFrame,
    });
    const outer = nextHop.link.encryptOutgoing(repacked);
    await nextHop.transport.send(nextHop.remoteAddr, outer);
  }

  private async handleFspFromPeer(
    _peer: AdjacentPeer,
    srcPubkey: Uint8Array,
    fspFrame: Uint8Array,
  ): Promise<void> {
    const phase = peekFspPhase(fspFrame);
    const srcHex = toHex(srcPubkey);
    let session = this.sessions.get(srcHex);
    if (phase === FSP_PHASE_ESTABLISHED) {
      if (!session || session.fsp.state !== "established") {
        throw new Error(`FSP Established before handshake from ${srcHex}`);
      }
      const result = session.fsp.decryptIncoming(fspFrame);
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
      const fsp = new FspSession({ identity: this.identity, role: "responder" });
      const reply = fsp.handleMsg1(fspFrame, (n) => this.random.bytes(n));
      session = { remotePubkeyHex: srcHex, remotePubkey: srcPubkey, fsp };
      this.sessions.set(srcHex, session);
      this.emit("session", { remotePubkey: srcHex, state: "establishing" });
      await this.sendFspToward(srcHex, reply);
      return;
    }
    if (phase === 2) {
      if (!session) throw new Error(`FSP msg2 with no session ${srcHex}`);
      const reply = session.fsp.handleMsg2(fspFrame, (n) => this.random.bytes(n));
      this.emit("session", { remotePubkey: srcHex, state: "established" });
      await this.sendFspToward(srcHex, reply);
      session.setupResolve?.();
      session.setupResolve = undefined;
      session.setupReject = undefined;
      return;
    }
    if (phase === 3) {
      if (!session) throw new Error(`FSP msg3 with no session ${srcHex}`);
      session.fsp.handleMsg3(fspFrame);
      this.emit("session", { remotePubkey: srcHex, state: "established" });
      return;
    }
    throw new Error(`unknown FSP phase ${phase}`);
  }

  private async ensureSession(remotePubkeyHex: string): Promise<Session> {
    let session = this.sessions.get(remotePubkeyHex);
    if (session && session.fsp.state === "established") return session;
    if (session && session.fsp.state === "handshaking") {
      await new Promise<void>((resolve, reject) => {
        session!.setupResolve = resolve;
        session!.setupReject = reject;
      });
      return session;
    }
    const remotePubkey = hexBytes(remotePubkeyHex);
    const fsp = new FspSession({
      identity: this.identity,
      role: "initiator",
      remotePubkey,
    });
    session = { remotePubkeyHex, remotePubkey, fsp };
    this.sessions.set(remotePubkeyHex, session);
    this.emit("session", { remotePubkey: remotePubkeyHex, state: "establishing" });
    const msg1 = fsp.buildMsg1((n) => this.random.bytes(n));
    await this.sendFspToward(remotePubkeyHex, msg1);
    await new Promise<void>((resolve, reject) => {
      session!.setupResolve = resolve;
      session!.setupReject = reject;
      setTimeout(() => reject(new Error("FSP handshake timeout")), 15_000);
    });
    return session;
  }

  /**
   * Send an FSP frame toward `remotePubkeyHex`. If we have a direct FMP link
   * to that pubkey, wrap as inner-data. Otherwise wrap in a FORWARD envelope
   * and send via any forwarding-eligible adjacent peer.
   */
  private async sendFspToward(
    remotePubkeyHex: string,
    fspFrame: Uint8Array,
  ): Promise<void> {
    const direct = this.peersByPubkey.get(remotePubkeyHex);
    if (direct && direct.link.state === "established") {
      const outer = direct.link.encryptOutgoing(fspFrame);
      await direct.transport.send(direct.remoteAddr, outer);
      return;
    }
    // No direct link: try forwarding through any established adjacent peer.
    const dstPubkey = hexBytes(remotePubkeyHex);
    const envelope = encodeForwardEnvelope({
      version: FORWARD_VERSION,
      ttl: 8,
      srcPubkey: this.identity.publicKey,
      dstPubkey,
      fspFrame,
    });
    for (const peer of this.peersByPubkey.values()) {
      if (peer.link.state === "established") {
        const outer = peer.link.encryptOutgoing(envelope);
        await peer.transport.send(peer.remoteAddr, outer);
        return;
      }
    }
    throw new Error(`no route to ${remotePubkeyHex}`);
  }
}

function hexBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Silence the "imported but unused" check on decodeFmpEstablished.
void decodeFmpEstablished;
