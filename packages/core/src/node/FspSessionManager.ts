import { bytesEqual, fromHex, toHex } from "../codec/hex.js";
import {
  decodeLinkNegotiationMessage,
  encodeLinkNegotiationMessage,
  LINK_NEGOTIATION_SERVICE_PORT,
  type LinkNegotiationMessage,
} from "../linkNegotiation.js";
import { segmentDirectFspTransportRecord } from "../fsp/directTransport.js";
import { FspSession } from "../fsp/session.js";
import { decodeFspExtensionCapabilities, FspExtensions } from "../fsp/extensions.js";
import { FspReceiverReports } from "../fsp/receiverReports.js";
import { unsupportedTraversalAnswer } from "../fsp/unsupportedTraversal.js";
import {
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_FLAG_K,
  FSP_MSG_DATA,
  FSP_MSG_ENDPOINT_DATA,
  FSP_MSG_RECEIVER_REPORT,
  FSP_MSG_COORDS_WARMUP,
  FSP_MSG_TRAVERSAL_OFFER,
  FSP_MSG_TRAVERSAL_ANSWER,
  FSP_PHASE_ESTABLISHED,
  parseFspEstablished,
  peekFspPhase,
  type DataPacket,
} from "../fsp/wire.js";
import type { FipsIdentity } from "../identity/index.js";
import { encodeNpub } from "../identity/nip19.js";
import { compareNodeAddr, deriveNodeAddr, nodeAddrToHex, type NodeAddr } from "../nodeaddr/index.js";
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
import { peerNodeAddr, sameCompressedIdentity, type AdjacentPeer } from "./PeerState.js";

interface Session {
  remoteNodeAddr: NodeAddr;
  remoteNodeHex?: string;
  remotePubkeyHex?: string;
  remotePubkey?: Uint8Array;
  indexedPubkeys?: string[];
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
  extensions?: FspExtensions;
}

interface SessionMessageOptions {
  forceWrapped?: boolean;
  routeNeutral?: boolean;
}

interface FspSessionManagerConfig {
  identity: FipsIdentity;
  random: RandomSource;
  localEpoch: Uint8Array;
  logger: Logger;
  routing: FipsRouting;
  strictClient?: boolean;
  assertPeerAllowed?: (pubkey: Uint8Array) => void;
  assertNodeAllowed?: (nodeAddr: NodeAddr) => void;
  getPeerByNodeAddr: (nodeAddrHex: string) => AdjacentPeer | undefined;
  emitDatagram: (event: DatagramEvent) => void;
  emitEndpointData: (event: EndpointDataEvent) => void;
  handleLinkNegotiation: (remotePubkeyHex: string, message: LinkNegotiationMessage) => Promise<void>;
  emitSession: (event: SessionEvent) => void;
}

const FSP_REKEY_DRAIN_MS = 45_000;
const MAX_MISSING_SESSION_RECOVERIES = 64;
const MISSING_SESSION_RETRY_MS = 15_000;
const FSP_DEFAULT_PATH_MTU = 1_200;
const MAX_EARLY_ESTABLISHED_RECORDS = 16;
const MAX_EARLY_ESTABLISHED_BYTES = 64 * 1024;
const EMPTY_BYTES = new Uint8Array(0);

export class FspSessionManager {
  private readonly services = new Map<number, FipsServiceHandler>();
  private readonly sessions = new Map<string, Session>();
  private readonly sessionsByPubkey = new Map<string, Session>();
  private readonly localEpoch: Uint8Array;
  private readonly localPubkeyHex: string;
  private reportTimer?: ReturnType<typeof setInterval>;
  private reportsEnabled = false;
  private reportsSending = false;
  private readonly missingSessionRecoveries = new Map<string, {
    abort: AbortController; expiresAtMs: number; promise: Promise<void>;
  }>();
  private recoveryGeneration = 0;

  constructor(private readonly cfg: FspSessionManagerConfig) {
    if (cfg.localEpoch.length !== 8) throw new Error("FSP local epoch must be 8 bytes");
    this.localEpoch = new Uint8Array(cfg.localEpoch);
    this.localPubkeyHex = toHex(cfg.identity.publicKey);
  }

  resetLocalEpoch(): void {
    this.localEpoch.set(this.cfg.localEpoch);
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

  start(): void { this.reportsEnabled = true; this.syncReportTimer(); }

  stop(): void {
    this.reportsEnabled = false;
    this.recoveryGeneration++;
    for (const recovery of this.missingSessionRecoveries.values()) recovery.abort.abort();
    this.missingSessionRecoveries.clear();
    this.syncReportTimer();
    for (const [nodeHex, session] of [...this.sessions]) {
      if (session.setupPromise) this.rejectSessionSetup(session, nodeHex, new Error("FSP session manager stopped"));
      else this.closeSessionHandles(session);
    }
    this.sessions.clear();
    this.sessionsByPubkey.clear();
  }

  private syncReportTimer(): void {
    if (this.reportsEnabled && this.sessions.size > 0) {
      this.reportTimer ??= setInterval(() => { void this.sendReceiverReports(); }, 1_000);
    } else if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = undefined;
    }
  }

  closePeerSessions(remotePubkeyHex: string): void {
    if (!remotePubkeyHex) return; // A pending carrier may not know its peer yet.
    const remoteKey = fromHex(remotePubkeyHex);
    for (const [nodeHex, session] of this.sessions) {
      if (!session.remotePubkey || !sameCompressedIdentity(session.remotePubkey, remoteKey)) continue;
      if (session.setupPromise) {
        this.rejectSessionSetup(session, nodeHex, new Error("remote FIPS peer restarted"));
        continue;
      }
      this.closeSessionHandles(session);
      this.sessions.delete(nodeHex);
      this.cfg.emitSession({
        remotePubkey: session.remotePubkeyHex ?? remotePubkeyHex,
        state: "closed",
        ...(session.fsp.peerId && { peerId: session.fsp.peerId }),
      });
    }
  }

  async sendDatagram(args: {
    dst: string;
    srcPort?: number;
    dstPort: number;
    payload: Uint8Array;
  }): Promise<void> {
    const session = await this.ensureSession(args.dst);
    const data: DataPacket = { srcPort: args.srcPort ?? 0, dstPort: args.dstPort, payload: args.payload };
    await this.sendEncryptedFrame(
      session,
      (flags) => session.fsp.encryptDatagram(data, flags),
      { routeNeutral: !!decodeFspExtensionCapabilities(data) },
    );
  }

  async sendEndpointData(args: { dst: string; payload: Uint8Array }): Promise<void> {
    const session = await this.ensureSession(args.dst);
    await this.sendSessionMessage(session, FSP_MSG_ENDPOINT_DATA, args.payload);
  }

  private sendSessionMessage(
    session: Session, msgType: number, payload: Uint8Array, options: SessionMessageOptions = {},
  ): Promise<void> {
    return this.sendEncryptedFrame(
      session,
      (flags) => session.fsp.encryptMessage(msgType, payload, flags),
      options,
    );
  }

  private async sendEncryptedFrame(
    session: Session,
    encode: (flags: number) => Uint8Array,
    options: SessionMessageOptions = {},
  ): Promise<void> {
    this.cfg.assertNodeAllowed?.(session.remoteNodeAddr);
    const directPeer = options.forceWrapped ? undefined : this.directPeerForSession(session);
    if (directPeer) {
      if (!options.routeNeutral) session.routeWarmup = undefined;
      await this.sendDirectFsp(directPeer, encode(
        FSP_FLAG_DIRECT_TRANSPORT | (session.currentKBit ? FSP_FLAG_K : 0),
      ));
      return;
    }
    await this.cfg.routing.sendFspToward(session.remoteNodeAddr, (nextHop) => {
      // Resolve the actual route before encrypting, including any key cutover while waiting.
      const flags = session.currentKBit ? FSP_FLAG_K : 0;
      const frames: Uint8Array[] = [];
      if (!options.routeNeutral) {
        if (session.routeWarmup?.peer !== nextHop) session.routeWarmup = { peer: nextHop, remaining: 5 };
        const destHex = (session.remoteNodeHex ??= nodeAddrToHex(session.remoteNodeAddr));
        const destCoords = this.cfg.routing.coordinatesFor(destHex);
        if (session.routeWarmup.remaining > 0 && destCoords
          && !bytesEqual(peerNodeAddr(nextHop), session.remoteNodeAddr)) {
          frames.push(session.fsp.encryptMessage(FSP_MSG_COORDS_WARMUP, EMPTY_BYTES, flags, {
            srcCoords: this.cfg.routing.coords, destCoords,
          }));
          session.routeWarmup.remaining--;
        }
      }
      frames.push(encode(flags));
      return frames;
    });
  }

  async sendReceiverReports(): Promise<void> {
    if (this.reportsSending) return;
    if (this.sessions.size === 0) { this.syncReportTimer(); return; }
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

  async sendLinkNegotiation(remotePubkeyHex: string, message: LinkNegotiationMessage): Promise<void> {
    await this.sendDatagram({
      dst: remotePubkeyHex,
      srcPort: LINK_NEGOTIATION_SERVICE_PORT,
      dstPort: LINK_NEGOTIATION_SERVICE_PORT,
      payload: encodeLinkNegotiationMessage(message),
    });
  }

  async handleFromPeer(peer: AdjacentPeer, srcNodeAddr: NodeAddr, fspFrame: Uint8Array): Promise<void> {
    this.cfg.assertNodeAllowed?.(srcNodeAddr);
    const phase = peekFspPhase(fspFrame);
    const srcNodeHex = nodeAddrToHex(srcNodeAddr);
    const session = this.sessions.get(srcNodeHex);
    if (phase === FSP_PHASE_ESTABLISHED) {
      if (!session) {
        // Validate the envelope, then authenticate a new handshake; never clear
        // healthy sessions merely because a carrier or an offer disappeared.
        parseFspEstablished(fspFrame, false);
        await this.recoverMissingSession(srcNodeAddr, srcNodeHex);
        return;
      }
      await this.handleEstablished(peer, srcNodeHex, session, fspFrame);
      return;
    }
    if (phase === 1) {
      await this.handleSessionSetup(peer, srcNodeAddr, srcNodeHex, session, fspFrame);
      return;
    }
    if (phase === 2) {
      if (!session) throw new Error(`FSP msg2 with no session ${srcNodeHex}`);
      await this.handleSessionAck(srcNodeAddr, srcNodeHex, session, fspFrame);
      return;
    }
    if (phase === 3) {
      if (!session) throw new Error(`FSP msg3 with no session ${srcNodeHex}`);
      await this.handleSessionMsg3(peer, srcNodeAddr, srcNodeHex, session, fspFrame);
      return;
    }
    throw new Error(`unknown FSP phase ${phase}`);
  }

  private async handleSessionAck(
    srcNodeAddr: NodeAddr,
    srcNodeHex: string,
    session: Session,
    fspFrame: Uint8Array,
  ): Promise<void> {
    const handshakeFsp = session.fsp;
    const wasEstablished = handshakeFsp.state === "established";
    const reply = handshakeFsp.handleSessionAck(fspFrame, (n) => this.cfg.random.bytes(n));
    const stillCurrent = () => this.sessions.get(srcNodeHex) === session
      && session.fsp === handshakeFsp && handshakeFsp.state === "established";
    try {
      await this.cfg.routing.sendFspToward(srcNodeAddr, reply);
    } catch (error) {
      // Preserve the outcome of an intervening timeout, stop, or replacement.
      if (!stillCurrent()) return;
      if (!wasEstablished) {
        this.rejectSessionSetup(session, srcNodeHex,
          error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
    if (!stillCurrent() || wasEstablished) return;
    const eventPubkey = session.remotePubkeyHex ?? srcNodeHex;
    this.cfg.emitSession({ remotePubkey: eventPubkey, peerId: handshakeFsp.peerId, state: "established" });
    this.resolveSessionSetup(session);
    // Optional capability I/O must not keep the authenticated setup deadline alive.
    void this.requestExtensions(session);
  }

  private async recoverMissingSession(nodeAddr: NodeAddr, nodeHex: string): Promise<void> {
    const now = Date.now();
    for (const [key, recovery] of this.missingSessionRecoveries) {
      if (recovery.expiresAtMs <= now) {
        recovery.abort.abort();
        this.missingSessionRecoveries.delete(key);
      }
    }
    const existing = this.missingSessionRecoveries.get(nodeHex);
    if (existing) return existing.promise;
    if (this.missingSessionRecoveries.size >= MAX_MISSING_SESSION_RECOVERIES) return;
    const abort = new AbortController();
    const generation = this.recoveryGeneration;
    const promise = this.cfg.routing.resolveIdentity(nodeAddr, abort)
      .then(async (identity) => {
        if (generation !== this.recoveryGeneration) return;
        await this.ensureSession(toHex(identity));
        if (generation === this.recoveryGeneration) this.missingSessionRecoveries.delete(nodeHex);
      }).catch((error) => {
        this.cfg.logger.debug("missing FSP session recovery failed", nodeHex, error);
        const recovery = this.missingSessionRecoveries.get(nodeHex);
        if (recovery?.abort === abort) recovery.expiresAtMs = Date.now() + MISSING_SESSION_RETRY_MS;
      });
    this.missingSessionRecoveries.set(nodeHex, { abort, expiresAtMs: Infinity, promise });
    await promise;
  }

  private async handleEstablished(
    peer: AdjacentPeer,
    srcNodeHex: string,
    session: Session,
    fspFrame: Uint8Array,
  ): Promise<void> {
    if (session.fsp.state === "handshaking") {
      this.queueEarlyEstablishedRecord(session, peer, fspFrame, srcNodeHex);
      return;
    }
    if (session.fsp.state !== "established") {
      throw new Error(`FSP Established before handshake from ${srcNodeHex}`);
    }
    this.prunePreviousFsp(session, Date.now());
    const established = parseFspEstablished(fspFrame, false);
    const receivedKBit = (established.flags & FSP_FLAG_K) !== 0;
    const selected = this.selectReceiveFsp(session, peer, srcNodeHex, receivedKBit, fspFrame);
    if (!selected) return;
    const { receiveFsp, promotePending } = selected;
    let authenticated = false;
    let result: ReturnType<FspSession["decryptParsed"]>;
    try {
      result = receiveFsp.decryptParsed(established, (received) => {
        authenticated = true;
        if (promotePending) this.promotePendingSession(session, receiveFsp, receivedKBit, srcNodeHex);
        session.receiverReports ??= new FspReceiverReports();
        session.receiverReports.record(received, performance.now(), receiveFsp === session.fsp);
      });
    } catch (error) {
      // Preserve prior authenticated-malformed accounting; AEAD/replay failures
      // never reach the callback and must never reinforce a route.
      if (authenticated) this.cfg.routing.learnReverseRoute(srcNodeHex, peer);
      throw error;
    }
    if (result.msgType !== FSP_MSG_DATA || !result.data || !decodeFspExtensionCapabilities(result.data)) {
      this.cfg.routing.learnReverseRoute(srcNodeHex, peer);
    }
    await this.dispatchAuthenticatedRecord(session, receiveFsp, srcNodeHex, result);
  }

  private selectReceiveFsp(
    session: Session,
    peer: AdjacentPeer,
    srcNodeHex: string,
    receivedKBit: boolean,
    fspFrame: Uint8Array,
  ): { receiveFsp: FspSession; promotePending: boolean } | undefined {
    if (receivedKBit === session.currentKBit) return { receiveFsp: session.fsp, promotePending: false };
    if (session.pendingResponderFsp?.state === "established") {
      return { receiveFsp: session.pendingResponderFsp, promotePending: true };
    }
    if (session.pendingResponderFsp?.state === "handshaking") {
      this.queueEarlyEstablishedRecord(session, peer, fspFrame, srcNodeHex);
      return undefined;
    }
    if (session.previousFsp?.kBit === receivedKBit) {
      return { receiveFsp: session.previousFsp.fsp, promotePending: false };
    }
    throw new Error(
      `FSP Established epoch mismatch: receivedK=${Number(receivedKBit)}`
      + ` currentK=${Number(session.currentKBit)}`,
    );
  }

  private async dispatchAuthenticatedRecord(
    session: Session,
    receiveFsp: FspSession,
    srcNodeHex: string,
    result: ReturnType<FspSession["decryptParsed"]>,
  ): Promise<void> {
    if (result.msgType === FSP_MSG_TRAVERSAL_OFFER && result.payload && receiveFsp.remotePubkey) {
      this.cfg.assertPeerAllowed?.(receiveFsp.remotePubkey);
      const answer = unsupportedTraversalAnswer(
        result.payload, Date.now(), encodeNpub(receiveFsp.remotePubkey.subarray(1)),
        encodeNpub(this.cfg.identity.xOnlyPubkey), (length) => this.cfg.random.bytes(length),
      );
      if (answer) await this.sendSessionMessage(session, FSP_MSG_TRAVERSAL_ANSWER, answer);
      return;
    }
    const peerId = receiveFsp.peerId;
    if (!peerId) throw new Error("established FSP session has no authenticated peer ID");
    const srcHex = session.remotePubkeyHex ?? srcNodeHex;
    if (result.msgType === FSP_MSG_DATA && result.data) {
      session.extensions ??= new FspExtensions();
      if (await session.extensions.receive(result.data, (payload) => this.sendExtension(session, payload))) return;
      await this.deliverDatagram(srcHex, peerId, result.data);
      return;
    }
    if (result.msgType === FSP_MSG_ENDPOINT_DATA && result.endpointData) {
      this.cfg.emitEndpointData({ peerId, src: srcHex, dst: this.localPubkeyHex, payload: result.endpointData });
    }
  }

  private promotePendingSession(
    session: Session,
    receiveFsp: FspSession,
    receivedKBit: boolean,
    srcNodeHex: string,
  ): void {
    session.extensions ??= new FspExtensions();
    if (session.fsp.remoteSupportsDirectFspTransport) session.extensions.rememberDirectSupport();
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
    this.syncSessionRemoteKey(session, receiveFsp.remotePubkey);
    this.cfg.logger.debug("promoted authenticated FSP rekey epoch", srcNodeHex, receivedKBit);
  }

  private async deliverDatagram(srcHex: string, peerId: string, datagram: DataPacket): Promise<void> {
    if (datagram.dstPort === LINK_NEGOTIATION_SERVICE_PORT) {
      await this.cfg.handleLinkNegotiation(srcHex, decodeLinkNegotiationMessage(datagram.payload));
      return;
    }
    this.cfg.emitDatagram({
      peerId,
      src: srcHex,
      dst: this.localPubkeyHex,
      srcPort: datagram.srcPort,
      dstPort: datagram.dstPort,
      payload: datagram.payload,
    });
    const handler = this.services.get(datagram.dstPort);
    if (!handler) return;
    const reply: ServiceContext["reply"] = async (data, replyPort) => {
      await this.sendDatagram({
        dst: srcHex,
        srcPort: datagram.dstPort,
        dstPort: replyPort ?? datagram.srcPort,
        payload: data,
      });
    };
    await handler({
      peerId, src: srcHex, srcPort: datagram.srcPort, dstPort: datagram.dstPort, payload: datagram.payload, reply,
    });
  }

  private createResponderSetup(fspFrame: Uint8Array, srcNodeAddr: NodeAddr): { fsp: FspSession; reply: Uint8Array } {
    const fsp = new FspSession({
      identity: this.cfg.identity,
      role: "responder",
      localEpoch: this.localEpoch,
      strictClient: this.cfg.strictClient,
    });
    const reply = fsp.handleSessionSetup(
      fspFrame, (n) => this.cfg.random.bytes(n), this.cfg.routing.coords, srcNodeAddr,
    );
    return { fsp, reply };
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
        fspFrame, (n) => this.cfg.random.bytes(n), this.cfg.routing.coords, srcNodeAddr,
      );
    } else if (session?.fsp.matchesSessionSetup(fspFrame)) {
      reply = session.fsp.handleSessionSetup(
        fspFrame, (n) => this.cfg.random.bytes(n), this.cfg.routing.coords, srcNodeAddr,
      );
    } else if (session?.fsp.state === "established") {
      const next = this.createResponderSetup(fspFrame, srcNodeAddr);
      reply = next.reply;
      session.pendingResponderFsp?.close();
      session.pendingResponderFsp = next.fsp;
    } else if (session?.fsp.state === "handshaking" && session.fsp.role === "initiator") {
      const order = compareNodeAddr(this.cfg.identity.nodeAddr, srcNodeAddr);
      if (order < 0) {
        this.cfg.logger.debug("simultaneous FSP handshake: local initiator wins", srcNodeHex);
        return;
      }
      if (order === 0) throw new Error("simultaneous FSP handshake with local identity");
      this.cfg.logger.debug("simultaneous FSP handshake: remote initiator wins", srcNodeHex);
      session.fsp.close();
      const next = this.createResponderSetup(fspFrame, srcNodeAddr);
      reply = next.reply;
      session.fsp = next.fsp;
    } else {
      const next = this.createResponderSetup(fspFrame, srcNodeAddr);
      reply = next.reply;
      session = {
        remoteNodeAddr: new Uint8Array(srcNodeAddr),
        remoteNodeHex: srcNodeHex,
        fsp: next.fsp,
        currentKBit: false,
      };
      this.sessions.set(srcNodeHex, session);
      this.syncReportTimer();
      this.cfg.emitSession({ remotePubkey: srcNodeHex, state: "establishing" });
    }
    await this.cfg.routing.sendFspReplyToward(srcNodeAddr, reply, peer);
  }

  private async handleSessionMsg3(
    peer: AdjacentPeer, srcNodeAddr: NodeAddr, srcNodeHex: string, session: Session, fspFrame: Uint8Array,
  ): Promise<void> {
    const handshakeFsp = session.pendingResponderFsp ?? session.fsp;
    const promotesPendingEpoch = session.pendingResponderFsp === handshakeFsp;
    const fresh = !promotesPendingEpoch && handshakeFsp.state !== "established";
    handshakeFsp.handleSessionMsg3(fspFrame);
    const remoteRestarted = promotesPendingEpoch
      && session.fsp.remoteEpoch !== undefined
      && handshakeFsp.remoteEpoch !== undefined
      && !bytesEqual(session.fsp.remoteEpoch, handshakeFsp.remoteEpoch);
    if (handshakeFsp.remotePubkey) {
      try {
        this.cfg.assertPeerAllowed?.(handshakeFsp.remotePubkey);
        if (!bytesEqual(deriveNodeAddr(handshakeFsp.remotePubkey), srcNodeAddr)) {
          throw new Error("FSP msg3 authenticated key does not match claimed source NodeAddr");
        }
        if (session.remotePubkey && !sameCompressedIdentity(session.remotePubkey, handshakeFsp.remotePubkey)) {
          throw new Error("FSP rekey changed the authenticated remote identity");
        }
      } catch (error) {
        handshakeFsp.close();
        if (session.pendingResponderFsp === handshakeFsp) {
          session.pendingResponderFsp = undefined;
        } else {
          this.sessions.delete(srcNodeHex);
          this.unindexSession(session);
        }
        throw error;
      }
      this.syncSessionRemoteKey(session, handshakeFsp.remotePubkey);
    }
    if (promotesPendingEpoch) {
      if (remoteRestarted) this.replaceRestartedSession(session, handshakeFsp, srcNodeHex);
      else this.promotePendingSession(session, handshakeFsp, !session.currentKBit, srcNodeHex);
    }
    this.cfg.routing.learnReverseRoute(srcNodeHex, peer);
    this.cfg.emitSession({
      remotePubkey: session.remotePubkeyHex ?? srcNodeHex,
      peerId: handshakeFsp.peerId,
      state: "established",
      ...(remoteRestarted ? { restarted: true } : {}),
    });
    this.resolveSessionSetup(session);
    // A slow optional write must not block authenticated records already queued.
    if (fresh || remoteRestarted) void this.requestExtensions(session);
    await this.drainEarlyEstablishedRecords(session, srcNodeHex);
  }

  private queueEarlyEstablishedRecord(
    session: Session,
    peer: AdjacentPeer,
    frame: Uint8Array,
    srcNodeHex: string,
  ): void {
    // Validate the public envelope before retaining anything.
    parseFspEstablished(frame, false);
    const records = session.earlyEstablishedRecords ?? [];
    const retainedBytes = session.earlyEstablishedBytes ?? 0;
    if (records.length >= MAX_EARLY_ESTABLISHED_RECORDS || retainedBytes + frame.length > MAX_EARLY_ESTABLISHED_BYTES) {
      throw new Error(`early FSP Established queue full for ${srcNodeHex}`);
    }
    records.push({ peer, frame: new Uint8Array(frame) });
    session.earlyEstablishedRecords = records;
    session.earlyEstablishedBytes = retainedBytes + frame.length;
    this.cfg.logger.debug("queued FSP Established until final handshake", srcNodeHex);
  }

  private async drainEarlyEstablishedRecords(session: Session, srcNodeHex: string): Promise<void> {
    const records = session.earlyEstablishedRecords;
    session.earlyEstablishedRecords = undefined;
    session.earlyEstablishedBytes = 0;
    if (!records || records.length === 0) return;
    this.cfg.logger.debug("draining early FSP Established records", srcNodeHex, records.length);
    for (const { peer, frame } of records) {
      try {
        await this.handleEstablished(peer, srcNodeHex, session, frame);
      } catch (error) {
        this.cfg.logger.warn("queued FSP Established record failed", error);
      }
    }
  }

  private replaceRestartedSession(session: Session, replacement: FspSession, srcNodeHex: string): void {
    session.previousFsp?.fsp.close();
    session.fsp.close();
    session.fsp = replacement;
    session.currentKBit = false;
    session.pendingResponderFsp = undefined;
    session.previousFsp = undefined;
    session.receiverReports = undefined;
    session.extensions = new FspExtensions();
    session.routeWarmup = undefined;
    this.syncSessionRemoteKey(session, replacement.remotePubkey);
    this.cfg.logger.debug("replaced restarted FSP session", srcNodeHex);
  }

  private async ensureSession(remotePubkeyHex: string): Promise<Session> {
    const cached = this.sessionsByPubkey.get(remotePubkeyHex);
    if (cached && cached.fsp.state === "established"
      && this.cfg.routing.hasUsableRoute(cached.remoteNodeHex ??= nodeAddrToHex(cached.remoteNodeAddr))) {
      if (cached.remotePubkey) this.cfg.assertPeerAllowed?.(cached.remotePubkey);
      return cached;
    }
    const remotePubkey = fromHex(remotePubkeyHex);
    this.cfg.assertPeerAllowed?.(remotePubkey);
    const remoteNodeAddr = deriveNodeAddr(remotePubkey);
    const remoteNodeHex = nodeAddrToHex(remoteNodeAddr);
    // Cached coordinates can outlive their carrier. Establish a routed path
    // before signaling a transport that itself needs this FSP session.
    if (!this.cfg.routing.hasUsableRoute(remoteNodeHex)) {
      await this.cfg.routing.ensureFirstContactRoute(remoteNodeAddr, remoteNodeHex, remotePubkey);
    }
    const concurrent = this.findExistingSession(remoteNodeHex, remotePubkeyHex);
    if (concurrent) return concurrent;
    return this.initiateSession(remotePubkey, remotePubkeyHex, remoteNodeAddr, remoteNodeHex);
  }

  private findExistingSession(remoteNodeHex: string, remotePubkeyHex: string): Session | Promise<Session> | undefined {
    const session = this.sessions.get(remoteNodeHex);
    if (!session) return undefined;
    if (session.fsp.state === "established") {
      this.indexSession(session, remotePubkeyHex);
      return session;
    }
    if (session.fsp.state === "handshaking") {
      return this.waitForSessionSetup(session, remoteNodeHex).then(() => session);
    }
    return undefined;
  }

  private async initiateSession(
    remotePubkey: Uint8Array,
    remotePubkeyHex: string,
    remoteNodeAddr: NodeAddr,
    remoteNodeHex: string,
  ): Promise<Session> {
    const fsp = new FspSession({
      identity: this.cfg.identity,
      role: "initiator",
      remotePubkey,
      localEpoch: this.localEpoch,
      strictClient: this.cfg.strictClient,
    });
    const session: Session = { remoteNodeAddr, remoteNodeHex, remotePubkeyHex, remotePubkey, fsp, currentKBit: false };
    this.sessions.set(remoteNodeHex, session);
    this.syncReportTimer();
    this.indexSession(session, remotePubkeyHex);
    this.cfg.emitSession({ remotePubkey: remotePubkeyHex, state: "establishing" });
    const setupDone = this.waitForSessionSetup(session, remoteNodeHex);
    const msg1 = fsp.buildSessionSetup(
      (n) => this.cfg.random.bytes(n),
      this.cfg.routing.coords,
      this.cfg.routing.coordinatesFor(remoteNodeHex) ?? [remoteNodeAddr],
    );
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const stillInitiating = () => this.sessions.get(remoteNodeHex) === session
      && session.fsp === fsp && fsp.state === "handshaking";
    const scheduleRetry = (delayMs: number) => {
      if (!stillInitiating()) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!stillInitiating()) return;
        void this.cfg.routing.sendFspToward(remoteNodeAddr, msg1)
          .catch((error) => this.cfg.logger.debug("FSP setup resend failed", error))
          .finally(() => scheduleRetry(delayMs * 2));
      }, delayMs);
    };
    try {
      await this.cfg.routing.sendFspToward(remoteNodeAddr, msg1);
      scheduleRetry(1_000);
      await setupDone;
    } catch (error) {
      if (this.sessions.get(remoteNodeHex) === session && session.fsp.state !== "established") {
        this.rejectSessionSetup(session, remoteNodeHex, error instanceof Error ? error : new Error(String(error)));
      }
      await setupDone.catch(() => undefined);
      throw error;
    } finally {
      if (retryTimer) clearTimeout(retryTimer);
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
    // Observe immediately; actual waiters still receive the rejected promise.
    void session.setupPromise.catch(() => {});
    return session.setupPromise;
  }

  private resolveSessionSetup(session: Session): void {
    const resolve = session.setupResolve;
    this.clearSetupWaiter(session);
    resolve?.();
  }

  private rejectSessionSetup(session: Session, remoteNodeHex: string, error: Error): void {
    const reject = session.setupReject;
    this.clearSetupWaiter(session);
    if (this.sessions.get(remoteNodeHex) === session) {
      this.closeSessionHandles(session);
      this.sessions.delete(remoteNodeHex);
      this.cfg.emitSession({
        remotePubkey: session.remotePubkeyHex ?? remoteNodeHex,
        ...(session.fsp.peerId && { peerId: session.fsp.peerId }),
        state: "closed",
      });
    }
    reject?.(error);
  }

  private clearSetupWaiter(session: Session): void {
    if (session.setupTimer) clearTimeout(session.setupTimer);
    session.setupPromise = session.setupTimer = session.setupResolve = session.setupReject = undefined;
  }

  private closeSessionHandles(session: Session): void {
    session.fsp.close();
    session.pendingResponderFsp?.close();
    session.previousFsp?.fsp.close();
    this.unindexSession(session);
  }

  private syncSessionRemoteKey(session: Session, remotePubkey: Uint8Array | undefined): void {
    if (!remotePubkey) return;
    session.remotePubkey = remotePubkey;
    session.remotePubkeyHex = toHex(remotePubkey);
    this.indexSession(session, session.remotePubkeyHex);
  }

  private indexSession(session: Session, pubkeyHex: string): void {
    if (this.sessionsByPubkey.get(pubkeyHex) === session) return;
    if ((session.indexedPubkeys?.length ?? 0) >= 4) return;
    this.sessionsByPubkey.set(pubkeyHex, session);
    (session.indexedPubkeys ??= []).push(pubkeyHex);
  }

  private unindexSession(session: Session): void {
    for (const key of session.indexedPubkeys ?? []) {
      if (this.sessionsByPubkey.get(key) === session) this.sessionsByPubkey.delete(key);
    }
    session.indexedPubkeys = undefined;
  }

  private prunePreviousFsp(session: Session, nowMs: number): void {
    if (!session.previousFsp || session.previousFsp.expiresAtMs > nowMs) return;
    session.previousFsp.fsp.close();
    session.previousFsp = undefined;
  }

  private directPeerForSession(session: Session): AdjacentPeer | undefined {
    if (!session.fsp.remoteSupportsDirectFspTransport && !session.extensions?.supportsDirect) return undefined;
    const peer = this.cfg.getPeerByNodeAddr((session.remoteNodeHex ??= nodeAddrToHex(session.remoteNodeAddr)));
    return peer?.link.state === "established" ? peer : undefined;
  }

  private async requestExtensions(session: Session): Promise<void> {
    session.extensions ??= new FspExtensions();
    try {
      await session.extensions.request((payload) => this.sendExtension(session, payload));
    } catch (error) {
      this.cfg.logger.debug("FSP extension request send failed", error);
    }
  }

  private sendExtension(session: Session, payload: Uint8Array): Promise<void> {
    return this.sendEncryptedFrame(
      session,
      (flags) => session.fsp.encryptDatagram({
        srcPort: LINK_NEGOTIATION_SERVICE_PORT,
        dstPort: LINK_NEGOTIATION_SERVICE_PORT,
        payload,
      }, flags),
      { forceWrapped: !session.fsp.remoteSupportsDirectFspTransport, routeNeutral: true },
    );
  }

  private async sendDirectFsp(peer: AdjacentPeer, fspFrame: Uint8Array): Promise<void> {
    const pathMtu = Math.min(peer.transport.mtu, FSP_DEFAULT_PATH_MTU);
    const packets = segmentDirectFspTransportRecord(fspFrame, pathMtu);
    for (const packet of packets) {
      this.cfg.assertPeerAllowed?.(peer.pubkey);
      await peer.transport.send(peer.remoteAddr, packet);
    }
  }
}
