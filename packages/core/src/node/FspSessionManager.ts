import { bytesEqual, fromHex, toHex } from "../codec/hex.js";
import {
  decodeLinkNegotiationMessage,
  encodeLinkNegotiationMessage,
  LINK_NEGOTIATION_SERVICE_PORT,
  type LinkNegotiationMessage,
} from "../linkNegotiation.js";
import {
  segmentDirectFspTransportRecord,
} from "../fsp/directTransport.js";
import { FspSession } from "../fsp/session.js";
import { FspReceiverReports } from "../fsp/receiverReports.js";
import {
  decodeFspEstablished,
  encodeDataPacket,
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_FLAG_K,
  FSP_MSG_DATA,
  FSP_MSG_ENDPOINT_DATA,
  FSP_MSG_RECEIVER_REPORT,
  FSP_MSG_COORDS_WARMUP,
  FSP_PHASE_ESTABLISHED,
  peekFspPhase,
} from "../fsp/wire.js";
import type { FipsIdentity } from "../identity/index.js";
import {
  compareNodeAddr,
  deriveNodeAddr,
  nodeAddrToHex,
  type NodeAddr,
} from "../nodeaddr/index.js";
import type { Logger } from "../transport/types.js";

import type {
  DatagramEvent,
  EndpointDataEvent,
  FipsServiceHandler,
  RandomSource,
  ServiceContext,
  SessionEvent,
} from "./types.js";
import type { FipsRouting } from "./FipsRouting.js";
import type { AdjacentPeer } from "./PeerState.js";

interface Session {
  remoteNodeAddr: NodeAddr;
  remotePubkeyHex?: string;
  remotePubkey?: Uint8Array;
  fsp: FspSession;
  currentKBit: boolean;
  pendingResponderFsp?: FspSession;
  previousFsp?: { fsp: FspSession; kBit: boolean; expiresAtMs: number };
  earlyEstablishedRecords?: Array<{ peer: AdjacentPeer; frame: Uint8Array }>;
  earlyEstablishedBytes?: number;
  setupPromise?: Promise<void>;
  setupTimer?: ReturnType<typeof setTimeout>;
  setupResolve?: () => void;
  setupReject?: (err: Error) => void;
  receiverReports?: FspReceiverReports;
  routeWarmup?: { peer: AdjacentPeer; remaining: number };
}

interface FspSessionManagerConfig {
  identity: FipsIdentity;
  random: RandomSource;
  localEpoch: Uint8Array;
  logger: Logger;
  routing: FipsRouting;
  getPeerByNodeAddr: (nodeAddrHex: string) => AdjacentPeer | undefined;
  emitDatagram: (event: DatagramEvent) => void;
  emitEndpointData: (event: EndpointDataEvent) => void;
  handleLinkNegotiation: (
    remotePubkeyHex: string,
    message: LinkNegotiationMessage,
  ) => Promise<void>;
  emitSession: (event: SessionEvent) => void;
}

const FSP_REKEY_DRAIN_MS = 45_000;
const FSP_DEFAULT_PATH_MTU = 1_200;
const MAX_EARLY_ESTABLISHED_RECORDS = 16;
const MAX_EARLY_ESTABLISHED_BYTES = 64 * 1024;

export class FspSessionManager {
  private readonly services = new Map<number, FipsServiceHandler>();
  private readonly sessions = new Map<string, Session>();
  private readonly localEpoch: Uint8Array;
  private reportTimer?: ReturnType<typeof setInterval>;
  private reportsSending = false;

  constructor(private readonly cfg: FspSessionManagerConfig) {
    if (cfg.localEpoch.length !== 8) throw new Error("FSP local epoch must be 8 bytes");
    this.localEpoch = new Uint8Array(cfg.localEpoch);
  }

  registerService(port: number, handler: FipsServiceHandler): () => void {
    if (port === 256 || port === LINK_NEGOTIATION_SERVICE_PORT) {
      throw new Error(`FSP service port ${port} is reserved`);
    }
    this.services.set(port, handler);
    return () => {
      if (this.services.get(port) === handler) this.services.delete(port);
    };
  }

  start(): void {
    if (this.reportTimer) return;
    this.reportTimer = setInterval(() => { void this.sendReceiverReports(); }, 1_000);
  }

  stop(): void {
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = undefined;
    for (const [nodeHex, session] of [...this.sessions]) {
      if (session.setupPromise) {
        this.rejectSessionSetup(session, nodeHex, new Error("FSP session manager stopped"));
        continue;
      }
      session.fsp.close();
      session.pendingResponderFsp?.close();
      session.previousFsp?.fsp.close();
    }
    this.sessions.clear();
  }

  closePeerSessions(remotePubkeyHex: string): void {
    for (const [nodeHex, session] of this.sessions) {
      if (session.remotePubkeyHex !== remotePubkeyHex) continue;
      if (session.setupPromise) {
        this.rejectSessionSetup(session, nodeHex, new Error("remote FIPS peer restarted"));
        continue;
      }
      session.fsp.close();
      session.pendingResponderFsp?.close();
      session.previousFsp?.fsp.close();
      this.sessions.delete(nodeHex);
      this.cfg.emitSession({ remotePubkey: remotePubkeyHex, state: "closed" });
    }
  }

  async sendDatagram(args: {
    dst: string;
    srcPort?: number;
    dstPort: number;
    payload: Uint8Array;
  }): Promise<void> {
    const session = await this.ensureSession(args.dst);
    await this.sendSessionMessage(session, FSP_MSG_DATA, encodeDataPacket({
      srcPort: args.srcPort ?? 0,
      dstPort: args.dstPort,
      payload: args.payload,
    }));
  }

  async sendEndpointData(args: {
    dst: string;
    payload: Uint8Array;
  }): Promise<void> {
    const session = await this.ensureSession(args.dst);
    await this.sendSessionMessage(session, FSP_MSG_ENDPOINT_DATA, args.payload);
  }

  private async sendSessionMessage(session: Session, msgType: number, payload: Uint8Array): Promise<void> {
    const directPeer = this.directPeerForSession(session);
    if (directPeer) {
      session.routeWarmup = undefined;
      await this.sendDirectFsp(directPeer, session.fsp.encryptMessage(
        msgType, payload, FSP_FLAG_DIRECT_TRANSPORT | (session.currentKBit ? FSP_FLAG_K : 0),
      ));
      return;
    }
    await this.cfg.routing.sendFspToward(session.remoteNodeAddr, (nextHop) => {
      // Resolve the actual route before encrypting, including any key cutover while waiting.
      const flags = session.currentKBit ? FSP_FLAG_K : 0;
      if (session.routeWarmup?.peer !== nextHop) session.routeWarmup = { peer: nextHop, remaining: 5 };
      const frames: Uint8Array[] = [];
      const destCoords = this.cfg.routing.coordinatesFor(nodeAddrToHex(session.remoteNodeAddr));
      if (session.routeWarmup.remaining > 0 && destCoords
        && !bytesEqual(deriveNodeAddr(nextHop.pubkey), session.remoteNodeAddr)) {
        frames.push(session.fsp.encryptMessage(FSP_MSG_COORDS_WARMUP, new Uint8Array(), flags, {
          srcCoords: this.cfg.routing.coords, destCoords,
        }));
        session.routeWarmup.remaining--;
      }
      frames.push(session.fsp.encryptMessage(msgType, payload, flags));
      return frames;
    });
  }

  async sendReceiverReports(): Promise<void> {
    if (this.reportsSending) return;
    this.reportsSending = true;
    try {
      await Promise.all([...this.sessions.values()].map(async (session) => {
        if (session.fsp.state !== "established") return;
        const report = session.receiverReports?.build(performance.now());
        if (!report) return;
        try {
          await this.sendSessionMessage(session, FSP_MSG_RECEIVER_REPORT, report);
        } catch (error) {
          this.cfg.logger.warn("FSP receiver report send failed", error);
        }
      }));
    } finally {
      this.reportsSending = false;
    }
  }

  async sendLinkNegotiation(
    remotePubkeyHex: string,
    message: LinkNegotiationMessage,
  ): Promise<void> {
    await this.sendDatagram({
      dst: remotePubkeyHex,
      srcPort: LINK_NEGOTIATION_SERVICE_PORT,
      dstPort: LINK_NEGOTIATION_SERVICE_PORT,
      payload: encodeLinkNegotiationMessage(message),
    });
  }

  async handleFromPeer(
    peer: AdjacentPeer,
    srcNodeAddr: NodeAddr,
    fspFrame: Uint8Array,
  ): Promise<void> {
    const phase = peekFspPhase(fspFrame);
    const srcNodeHex = nodeAddrToHex(srcNodeAddr);
    const session = this.sessions.get(srcNodeHex);
    if (phase === FSP_PHASE_ESTABLISHED) {
      await this.handleEstablished(peer, srcNodeHex, session, fspFrame);
      return;
    }
    if (phase === 1) {
      await this.handleSessionSetup(peer, srcNodeAddr, srcNodeHex, session, fspFrame);
      return;
    }
    if (phase === 2) {
      if (!session) throw new Error(`FSP msg2 with no session ${srcNodeHex}`);
      const wasEstablished = session.fsp.state === "established";
      const reply = session.fsp.handleSessionAck(fspFrame, (n) => this.cfg.random.bytes(n));
      if (!wasEstablished) {
        const eventPubkey = session.remotePubkeyHex ?? srcNodeHex;
        this.cfg.emitSession({ remotePubkey: eventPubkey, state: "established" });
        this.resolveSessionSetup(session);
      }
      await this.cfg.routing.sendFspToward(srcNodeAddr, reply);
      return;
    }
    if (phase === 3) {
      if (!session) throw new Error(`FSP msg3 with no session ${srcNodeHex}`);
      await this.handleSessionMsg3(peer, srcNodeAddr, srcNodeHex, session, fspFrame);
      return;
    }
    throw new Error(`unknown FSP phase ${phase}`);
  }

  private async handleEstablished(
    peer: AdjacentPeer,
    srcNodeHex: string,
    session: Session | undefined,
    fspFrame: Uint8Array,
  ): Promise<void> {
    if (!session) {
      throw new Error(`FSP Established before handshake from ${srcNodeHex}`);
    }
    if (session.fsp.state === "handshaking") {
      this.queueEarlyEstablishedRecord(session, peer, fspFrame, srcNodeHex);
      return;
    }
    if (session.fsp.state !== "established") {
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
      } else if (session.pendingResponderFsp?.state === "handshaking") {
        this.queueEarlyEstablishedRecord(session, peer, fspFrame, srcNodeHex);
        return;
      } else if (session.previousFsp?.kBit === receivedKBit) {
        receiveFsp = session.previousFsp.fsp;
      } else {
        throw new Error(
          `FSP Established epoch mismatch: receivedK=${Number(receivedKBit)}`
          + ` currentK=${Number(session.currentKBit)}`,
        );
      }
    }
    const result = receiveFsp.decryptIncoming(fspFrame, (received) => {
      this.cfg.routing.learnReverseRoute(srcNodeHex, peer);
      if (promotePending) this.promotePendingSession(session, receiveFsp, receivedKBit, srcNodeHex);
      session.receiverReports ??= new FspReceiverReports();
      session.receiverReports.record(received, performance.now(), receiveFsp === session.fsp);
    });
    const srcHex = session.remotePubkeyHex ?? srcNodeHex;
    if (result.msgType === FSP_MSG_DATA && result.data) {
      await this.deliverDatagram(srcHex, result.data);
    }
    if (result.msgType === FSP_MSG_ENDPOINT_DATA && result.endpointData) {
      this.cfg.emitEndpointData({
        src: srcHex,
        dst: toHex(this.cfg.identity.publicKey),
        payload: result.endpointData,
      });
      return;
    }
  }

  private promotePendingSession(
    session: Session,
    receiveFsp: FspSession,
    receivedKBit: boolean,
    srcNodeHex: string,
  ): void {
    session.previousFsp?.fsp.close();
    session.previousFsp = {
      fsp: session.fsp,
      kBit: session.currentKBit,
      expiresAtMs: Date.now() + FSP_REKEY_DRAIN_MS,
    };
    session.fsp = receiveFsp;
    session.receiverReports?.resetEpoch();
    session.currentKBit = receivedKBit;
    session.pendingResponderFsp = undefined;
    if (receiveFsp.remotePubkey) {
      session.remotePubkey = receiveFsp.remotePubkey;
      session.remotePubkeyHex = toHex(receiveFsp.remotePubkey);
    }
    this.cfg.logger.debug("promoted authenticated FSP rekey epoch", srcNodeHex, receivedKBit);
  }

  private async deliverDatagram(
    srcHex: string,
    datagram: { srcPort: number; dstPort: number; payload: Uint8Array },
  ): Promise<void> {
    if (datagram.dstPort === LINK_NEGOTIATION_SERVICE_PORT) {
      await this.cfg.handleLinkNegotiation(
        srcHex,
        decodeLinkNegotiationMessage(datagram.payload),
      );
      return;
    }
    const handler = this.services.get(datagram.dstPort);
    const reply: ServiceContext["reply"] = async (data, replyPort) => {
      await this.sendDatagram({
        dst: srcHex,
        srcPort: datagram.dstPort,
        dstPort: replyPort ?? datagram.srcPort,
        payload: data,
      });
    };
    this.cfg.emitDatagram({
      src: srcHex,
      dst: toHex(this.cfg.identity.publicKey),
      srcPort: datagram.srcPort,
      dstPort: datagram.dstPort,
      payload: datagram.payload,
    });
    if (handler) {
      await handler({
        src: srcHex,
        srcPort: datagram.srcPort,
        dstPort: datagram.dstPort,
        payload: datagram.payload,
        reply,
      });
    }
  }

  private async handleSessionSetup(
    peer: AdjacentPeer,
    srcNodeAddr: NodeAddr,
    srcNodeHex: string,
    session: Session | undefined,
    fspFrame: Uint8Array,
  ): Promise<void> {
    let reply: Uint8Array;
    if (session?.pendingResponderFsp?.matchesSessionSetup(fspFrame)) {
      reply = session.pendingResponderFsp.handleSessionSetup(
        fspFrame,
        (n) => this.cfg.random.bytes(n),
        this.cfg.routing.coords,
      );
    } else if (session?.fsp.matchesSessionSetup(fspFrame)) {
      reply = session.fsp.handleSessionSetup(
        fspFrame,
        (n) => this.cfg.random.bytes(n),
        this.cfg.routing.coords,
      );
    } else if (session?.fsp.state === "established") {
      const pending = new FspSession({
        identity: this.cfg.identity,
        role: "responder",
        localEpoch: this.localEpoch,
      });
      reply = pending.handleSessionSetup(
        fspFrame,
        (n) => this.cfg.random.bytes(n),
        this.cfg.routing.coords,
      );
      session.pendingResponderFsp?.close();
      session.pendingResponderFsp = pending;
    } else if (session?.fsp.state === "handshaking" && session.fsp.role === "initiator") {
      const order = compareNodeAddr(this.cfg.identity.nodeAddr, srcNodeAddr);
      if (order < 0) {
        this.cfg.logger.debug("simultaneous FSP handshake: local initiator wins", srcNodeHex);
        return;
      }
      if (order === 0) throw new Error("simultaneous FSP handshake with local identity");

      this.cfg.logger.debug("simultaneous FSP handshake: remote initiator wins", srcNodeHex);
      session.fsp.close();
      const responder = new FspSession({
        identity: this.cfg.identity,
        role: "responder",
        localEpoch: this.localEpoch,
      });
      reply = responder.handleSessionSetup(
        fspFrame,
        (n) => this.cfg.random.bytes(n),
        this.cfg.routing.coords,
      );
      session.fsp = responder;
    } else {
      const fsp = new FspSession({
        identity: this.cfg.identity,
        role: "responder",
        localEpoch: this.localEpoch,
      });
      reply = fsp.handleSessionSetup(
        fspFrame,
        (n) => this.cfg.random.bytes(n),
        this.cfg.routing.coords,
      );
      session = { remoteNodeAddr: srcNodeAddr, fsp, currentKBit: false };
      this.sessions.set(srcNodeHex, session);
      this.cfg.emitSession({ remotePubkey: srcNodeHex, state: "establishing" });
    }
    await this.cfg.routing.sendFspReplyToward(srcNodeAddr, reply, peer);
  }

  private async handleSessionMsg3(
    peer: AdjacentPeer,
    srcNodeAddr: NodeAddr,
    srcNodeHex: string,
    session: Session,
    fspFrame: Uint8Array,
  ): Promise<void> {
    const handshakeFsp = session.pendingResponderFsp ?? session.fsp;
    const promotesPendingEpoch = session.pendingResponderFsp === handshakeFsp;
    handshakeFsp.handleSessionMsg3(fspFrame);
    const remoteRestarted = promotesPendingEpoch
      && session.fsp.remoteEpoch !== undefined
      && handshakeFsp.remoteEpoch !== undefined
      && !bytesEqual(session.fsp.remoteEpoch, handshakeFsp.remoteEpoch);
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
    if (promotesPendingEpoch) {
      if (remoteRestarted) {
        this.replaceRestartedSession(session, handshakeFsp, srcNodeHex);
      } else {
        this.promotePendingSession(
          session,
          handshakeFsp,
          !session.currentKBit,
          srcNodeHex,
        );
      }
    }
    this.cfg.routing.learnReverseRoute(srcNodeHex, peer);
    this.cfg.emitSession({
      remotePubkey: session.remotePubkeyHex ?? srcNodeHex,
      state: "established",
    });
    this.resolveSessionSetup(session);
    await this.drainEarlyEstablishedRecords(session, srcNodeHex);
  }

  private queueEarlyEstablishedRecord(
    session: Session,
    peer: AdjacentPeer,
    frame: Uint8Array,
    srcNodeHex: string,
  ): void {
    // Validate the public envelope before retaining anything. Direct FSP and
    // the routed final handshake use different carriers, so a valid first
    // encrypted record can overtake Msg3 even on an otherwise ordered link.
    decodeFspEstablished(frame);
    const records = session.earlyEstablishedRecords ?? [];
    const retainedBytes = session.earlyEstablishedBytes ?? 0;
    if (
      records.length >= MAX_EARLY_ESTABLISHED_RECORDS
      || retainedBytes + frame.length > MAX_EARLY_ESTABLISHED_BYTES
    ) {
      throw new Error(`early FSP Established queue full for ${srcNodeHex}`);
    }
    records.push({ peer, frame: new Uint8Array(frame) });
    session.earlyEstablishedRecords = records;
    session.earlyEstablishedBytes = retainedBytes + frame.length;
    this.cfg.logger.debug("queued FSP Established until final handshake", srcNodeHex);
  }

  private async drainEarlyEstablishedRecords(
    session: Session,
    srcNodeHex: string,
  ): Promise<void> {
    const records = session.earlyEstablishedRecords;
    session.earlyEstablishedRecords = undefined;
    session.earlyEstablishedBytes = 0;
    if (!records || records.length === 0) return;
    this.cfg.logger.debug("draining early FSP Established records", srcNodeHex, records.length);
    for (const { peer, frame } of records) {
      await this.handleEstablished(peer, srcNodeHex, session, frame);
    }
  }

  private replaceRestartedSession(
    session: Session,
    replacement: FspSession,
    srcNodeHex: string,
  ): void {
    session.previousFsp?.fsp.close();
    session.fsp.close();
    session.fsp = replacement;
    session.currentKBit = false;
    session.pendingResponderFsp = undefined;
    session.previousFsp = undefined;
    session.receiverReports = undefined;
    if (replacement.remotePubkey) {
      session.remotePubkey = replacement.remotePubkey;
      session.remotePubkeyHex = toHex(replacement.remotePubkey);
    }
    this.cfg.logger.debug("replaced restarted FSP session", srcNodeHex);
  }

  private async ensureSession(remotePubkeyHex: string): Promise<Session> {
    const remotePubkey = fromHex(remotePubkeyHex);
    const remoteNodeAddr = deriveNodeAddr(remotePubkey);
    const remoteNodeHex = nodeAddrToHex(remoteNodeAddr);
    let session = this.sessions.get(remoteNodeHex);
    if (session && session.fsp.state === "established") return session;
    if (session && session.fsp.state === "handshaking") {
      await this.waitForSessionSetup(session, remoteNodeHex);
      return session;
    }
    const directPeer = this.cfg.getPeerByNodeAddr(remoteNodeHex);
    if (directPeer?.link.state !== "established"
      && !this.cfg.routing.coordinatesFor(remoteNodeHex)) {
      await this.cfg.routing.ensureFirstContactRoute(
        remoteNodeAddr,
        remoteNodeHex,
        remotePubkey,
      );
    }
    const fsp = new FspSession({
      identity: this.cfg.identity,
      role: "initiator",
      remotePubkey,
      localEpoch: this.localEpoch,
    });
    session = { remoteNodeAddr, remotePubkeyHex, remotePubkey, fsp, currentKBit: false };
    this.sessions.set(remoteNodeHex, session);
    this.cfg.emitSession({ remotePubkey: remotePubkeyHex, state: "establishing" });
    const setupDone = this.waitForSessionSetup(session, remoteNodeHex);
    const msg1 = fsp.buildSessionSetup(
      (n) => this.cfg.random.bytes(n),
      this.cfg.routing.coords,
      this.cfg.routing.coordinatesFor(remoteNodeHex) ?? [remoteNodeAddr],
    );
    try {
      await this.cfg.routing.sendFspToward(remoteNodeAddr, msg1);
      await setupDone;
    } catch (error) {
      if (this.sessions.get(remoteNodeHex) === session && session.fsp.state !== "established") {
        this.rejectSessionSetup(
          session,
          remoteNodeHex,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      await setupDone.catch(() => undefined);
      throw error;
    }
    return session;
  }

  private waitForSessionSetup(session: Session, remoteNodeHex: string): Promise<void> {
    if (session.setupPromise) return session.setupPromise;
    session.setupPromise = new Promise<void>((resolve, reject) => {
      session.setupResolve = resolve;
      session.setupReject = reject;
      session.setupTimer = setTimeout(() => {
        this.rejectSessionSetup(session, remoteNodeHex, new Error("FSP handshake timeout"));
      }, 15_000);
    });
    return session.setupPromise;
  }

  private resolveSessionSetup(session: Session): void {
    if (session.setupTimer) clearTimeout(session.setupTimer);
    const resolve = session.setupResolve;
    session.setupPromise = undefined;
    session.setupTimer = undefined;
    session.setupResolve = undefined;
    session.setupReject = undefined;
    resolve?.();
  }

  private rejectSessionSetup(session: Session, remoteNodeHex: string, error: Error): void {
    if (session.setupTimer) clearTimeout(session.setupTimer);
    const reject = session.setupReject;
    session.setupPromise = undefined;
    session.setupTimer = undefined;
    session.setupResolve = undefined;
    session.setupReject = undefined;
    if (this.sessions.get(remoteNodeHex) === session) {
      session.fsp.close();
      session.pendingResponderFsp?.close();
      session.previousFsp?.fsp.close();
      this.sessions.delete(remoteNodeHex);
      this.cfg.emitSession({
        remotePubkey: session.remotePubkeyHex ?? remoteNodeHex,
        state: "closed",
      });
    }
    reject?.(error);
  }

  private prunePreviousFsp(session: Session, nowMs: number): void {
    if (!session.previousFsp || session.previousFsp.expiresAtMs > nowMs) return;
    session.previousFsp.fsp.close();
    session.previousFsp = undefined;
  }

  private directPeerForSession(session: Session): AdjacentPeer | undefined {
    if (!session.fsp.remoteSupportsDirectFspTransport) return undefined;
    const peer = this.cfg.getPeerByNodeAddr(nodeAddrToHex(session.remoteNodeAddr));
    return peer?.link.state === "established" ? peer : undefined;
  }

  private async sendDirectFsp(peer: AdjacentPeer, fspFrame: Uint8Array): Promise<void> {
    const pathMtu = Math.min(peer.transport.mtu, FSP_DEFAULT_PATH_MTU);
    const packets = segmentDirectFspTransportRecord(fspFrame, pathMtu);
    for (const packet of packets) {
      await peer.transport.send(peer.remoteAddr, packet);
    }
  }
}
