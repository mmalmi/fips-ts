/**
 * FSP end-to-end session — same Rust-compatible wire envelope as before,
 * with the inner handshake now using the real Noise_XK_secp256k1_ChaChaPoly_SHA256
 * pattern. 8-byte epoch payloads at handshake steps 2 and 3 (XK msg1 has no
 * payload).
 */

import { aeadOpen, aeadSealInto } from "../crypto/aead.js";
import { ReplayWindow } from "../crypto/replay.js";
import { readU16le, readU32le, writeU16le, writeU32le } from "../codec/binary.js";
import { bytesEqual, toHex } from "../codec/hex.js";
import type { FipsIdentity } from "../identity/index.js";
import { CipherState, NoiseHandshake } from "../noise/index.js";
import { deriveNodeAddr, type NodeAddr } from "../nodeaddr/index.js";
import {
  decodeSessionAck,
  decodeSessionMsg3,
  decodeSessionSetup,
  encodeSessionAck,
  encodeSessionMsg3,
  encodeSessionSetup,
  SESSION_FLAG_DIRECT_FSP_TRANSPORT,
} from "../protocol/session.js";

import {
  allocateFspEstablishedFrame,
  decodeFspHandshake,
  encodeFspHandshake,
  FSP_ESTABLISHED_HEADER_LEN,
  FSP_INNER_HEADER_LEN,
  FSP_MSG_DATA,
  FSP_MSG_ENDPOINT_DATA,
  FSP_MSG_KEEPALIVE,
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_FLAG_CP,
  FSP_FLAG_K,
  NOISE_XK_MSG1_LEN,
  NOISE_XK_MSG2_LEN,
  NOISE_XK_MSG3_LEN,
  parseFspEstablished,
  type DataPacket,
  type FspEstablished,
  type ParsedFspEstablished,
} from "./wire.js";

export type FspRole = "initiator" | "responder";

export interface FspSessionInit {
  identity: FipsIdentity;
  remotePubkey?: Uint8Array; // 33 compressed; initiator must supply
  role: FspRole;
  ephemeralOverride?: Uint8Array;
  localEpoch?: Uint8Array;
  strictClient?: boolean;
}

const EPOCH_LEN = 8;
const EMPTY_BYTES = new Uint8Array(0);

export class FspSession {
  readonly identity: FipsIdentity;
  readonly role: FspRole;
  remotePubkey?: Uint8Array;
  remoteEpoch?: Uint8Array;

  private authenticatedPeerId?: string;

  /** X-only identity proven by this handshake, retained across close. */
  get peerId(): string | undefined { return this.authenticatedPeerId; }

  private readonly localEpoch: Uint8Array;
  private readonly strictClient: boolean;
  private hs?: NoiseHandshake;
  private tx?: CipherState;
  private rx?: CipherState;
  private receivedSessionSetup?: Uint8Array;
  private sentSessionAck?: Uint8Array;
  private receivedSessionAck?: Uint8Array;
  private sentSessionMsg3?: Uint8Array;
  private establishedMsg3?: Uint8Array;
  private pendingRemoteDirectFspTransport = false;
  private remoteDirectFspTransport = false;
  private txCounter = 0n;
  private sessionStartMs = 0;
  private replay = new ReplayWindow();

  state: "init" | "handshaking" | "established" | "closed" = "init";

  constructor(init: FspSessionInit) {
    this.identity = init.identity;
    this.role = init.role;
    this.strictClient = init.strictClient ?? false;
    this.localEpoch = init.localEpoch ? new Uint8Array(init.localEpoch) : new Uint8Array(EPOCH_LEN);
    if (this.localEpoch.length !== EPOCH_LEN) {
      throw new Error(`FSP local epoch must be ${EPOCH_LEN} bytes`);
    }
    if (init.remotePubkey) this.remotePubkey = init.remotePubkey;
    this.hs = new NoiseHandshake({
      pattern: "XK",
      role: init.role,
      identity: init.identity,
      remoteStatic: init.remotePubkey,
      ephemeralOverride: init.ephemeralOverride,
    });
  }

  get remoteSupportsDirectFspTransport(): boolean {
    return this.remoteDirectFspTransport;
  }

  buildMsg1(_rand: (n: number) => Uint8Array): Uint8Array {
    const noiseMsg = this.writeXkMsg1("only initiator builds XK msg1");
    return encodeFspHandshake({ phase: 1, noiseMsg });
  }

  buildSessionSetup(
    _rand: (n: number) => Uint8Array,
    srcCoords: NodeAddr | NodeAddr[],
    destCoords: NodeAddr | NodeAddr[],
  ): Uint8Array {
    const noiseMsg = this.writeXkMsg1("only initiator builds SessionSetup");
    return encodeSessionSetup({
      srcCoords: this.strictClient ? [this.identity.nodeAddr] : normalizeCoords(srcCoords),
      destCoords: this.strictClient ? [deriveNodeAddr(this.remotePubkey!)] : normalizeCoords(destCoords),
      flags: 0,
      handshakePayload: noiseMsg,
    });
  }

  handleMsg1(packet: Uint8Array, _rand: (n: number) => Uint8Array): Uint8Array {
    if (this.role !== "responder") throw new Error("only responder handles XK msg1");
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 1) throw new Error("expected XK msg1");
    return encodeFspHandshake({ phase: 2, noiseMsg: this.respondToXkMsg1(frame.noiseMsg) });
  }

  handleSessionSetup(
    packet: Uint8Array,
    _rand: (n: number) => Uint8Array,
    localCoords: NodeAddr | NodeAddr[],
    remoteNodeAddr?: NodeAddr,
  ): Uint8Array {
    if (this.role !== "responder") throw new Error("only responder handles SessionSetup");
    if (this.receivedSessionSetup) {
      if (bytesEqual(packet, this.receivedSessionSetup) && this.sentSessionAck) {
        return new Uint8Array(this.sentSessionAck);
      }
      throw new Error("unexpected FSP SessionSetup after handshake start");
    }
    const setup = decodeSessionSetup(packet);
    if (setup.handshakePayload.length !== NOISE_XK_MSG1_LEN) throw new Error("bad XK msg1 length");
    const noiseMsg = this.respondToXkMsg1(setup.handshakePayload);
    // XK Msg1 does not yet authenticate the initiator's static identity.
    this.pendingRemoteDirectFspTransport = (setup.flags & SESSION_FLAG_DIRECT_FSP_TRANSPORT) !== 0;
    const reply = encodeSessionAck({
      srcCoords: this.strictClient ? [this.identity.nodeAddr] : normalizeCoords(localCoords),
      destCoords: this.strictClient ? (remoteNodeAddr ? [remoteNodeAddr] : setup.srcCoords.slice(0, 1)) : setup.srcCoords,
      flags: 0,
      handshakePayload: noiseMsg,
    });
    this.state = "handshaking";
    this.receivedSessionSetup = new Uint8Array(packet);
    this.sentSessionAck = new Uint8Array(reply);
    return reply;
  }

  matchesSessionSetup(packet: Uint8Array): boolean {
    return this.receivedSessionSetup !== undefined && bytesEqual(packet, this.receivedSessionSetup);
  }

  handleMsg2(packet: Uint8Array, _rand: (n: number) => Uint8Array): Uint8Array {
    if (this.role !== "initiator") throw new Error("only initiator handles XK msg2");
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 2) throw new Error("expected XK msg2");
    const noiseMsg = this.completeInitiatorXk(frame.noiseMsg);
    this.finalize();
    return encodeFspHandshake({ phase: 3, noiseMsg });
  }

  handleSessionAck(packet: Uint8Array, _rand: (n: number) => Uint8Array): Uint8Array {
    if (this.role !== "initiator") throw new Error("only initiator handles SessionAck");
    if (this.receivedSessionAck) {
      if (bytesEqual(packet, this.receivedSessionAck) && this.sentSessionMsg3) {
        return new Uint8Array(this.sentSessionMsg3);
      }
      throw new Error("unexpected FSP SessionAck after establishment");
    }
    const ack = decodeSessionAck(packet);
    const noiseMsg = this.completeInitiatorXk(ack.handshakePayload);
    this.remoteDirectFspTransport = (ack.flags & SESSION_FLAG_DIRECT_FSP_TRANSPORT) !== 0;
    const reply = encodeSessionMsg3({ flags: 0, handshakePayload: noiseMsg });
    this.receivedSessionAck = new Uint8Array(packet);
    this.sentSessionMsg3 = new Uint8Array(reply);
    this.finalize();
    return reply;
  }

  handleMsg3(packet: Uint8Array): void {
    if (this.role !== "responder") throw new Error("only responder handles XK msg3");
    if (this.checkEstablishedMsg3Replay(packet)) return;
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 3) throw new Error("expected XK msg3");
    this.completeResponderXk(frame.noiseMsg, packet, false);
  }

  handleSessionMsg3(packet: Uint8Array): void {
    if (this.role !== "responder") throw new Error("only responder handles SessionMsg3");
    if (this.checkEstablishedMsg3Replay(packet)) return;
    const msg3 = decodeSessionMsg3(packet);
    this.completeResponderXk(msg3.handshakePayload, packet, true);
  }

  encryptDatagram(
    data: DataPacket,
    flags = 0,
    coords?: Pick<FspEstablished, "srcCoords" | "destCoords">,
  ): Uint8Array {
    if (!Number.isInteger(data.srcPort) || data.srcPort < 0 || data.srcPort > 0xffff) {
      throw new RangeError(`u16 out of range: ${data.srcPort}`);
    }
    if (!Number.isInteger(data.dstPort) || data.dstPort < 0 || data.dstPort > 0xffff) {
      throw new RangeError(`u16 out of range: ${data.dstPort}`);
    }
    return this.sealMessage(FSP_MSG_DATA, data.payload, flags, coords, data.srcPort, data.dstPort);
  }

  encryptEndpointData(payload: Uint8Array, flags = 0): Uint8Array {
    return this.encryptMessage(FSP_MSG_ENDPOINT_DATA, payload, flags);
  }

  encryptMessage(
    msgType: number,
    payload: Uint8Array,
    flags = 0,
    coords?: Pick<FspEstablished, "srcCoords" | "destCoords">,
  ): Uint8Array {
    if (!Number.isInteger(msgType) || msgType < 0 || msgType > 0xff) {
      throw new Error("FSP message type must be one byte");
    }
    return this.sealMessage(msgType, payload, flags, coords);
  }

  encryptKeepalive(flags = 0): Uint8Array {
    return this.encryptMessage(FSP_MSG_KEEPALIVE, EMPTY_BYTES, flags);
  }

  decryptIncoming(
    packet: Uint8Array,
    onAuthenticated?: (received: { counter: bigint; timestamp: number; bytes: number }) => void,
  ): { msgType: number; data?: DataPacket; endpointData?: Uint8Array; payload?: Uint8Array } {
    if (this.state !== "established" || !this.rx) throw new Error("FSP not established");
    return this.decryptParsed(parseFspEstablished(packet, false), onAuthenticated);
  }

  /** Internal hot-path decrypt when the caller already parsed the outer frame. */
  decryptParsed(
    est: ParsedFspEstablished,
    onAuthenticated?: (received: { counter: bigint; timestamp: number; bytes: number }) => void,
  ): { msgType: number; data?: DataPacket; endpointData?: Uint8Array; payload?: Uint8Array } {
    if (this.state !== "established" || !this.rx) throw new Error("FSP not established");
    if (!this.replay.check(est.counter)) throw new Error("FSP replay/duplicate counter");
    const plaintext = aeadOpen(this.rx.getKey(), est.counter, est.ciphertext, est.aad);
    this.replay.accept(est.counter);
    if (plaintext.length < FSP_INNER_HEADER_LEN) throw new Error("FSP inner packet too short");
    const timestamp = readU32le(plaintext, 0);
    const msgType = plaintext[4]!;
    onAuthenticated?.({ counter: est.counter, timestamp, bytes: plaintext.length });
    if (msgType === FSP_MSG_DATA) {
      if (plaintext.length < FSP_INNER_HEADER_LEN + 4) throw new Error("DataPacket too short");
      return {
        msgType,
        data: {
          srcPort: readU16le(plaintext, FSP_INNER_HEADER_LEN),
          dstPort: readU16le(plaintext, FSP_INNER_HEADER_LEN + 2),
          payload: plaintext.slice(FSP_INNER_HEADER_LEN + 4),
        },
      };
    }
    const payload = plaintext.slice(FSP_INNER_HEADER_LEN);
    return msgType === FSP_MSG_ENDPOINT_DATA
      ? { msgType, endpointData: payload, payload }
      : { msgType, payload };
  }

  close(): void {
    this.state = "closed";
    this.hs = undefined;
    this.tx = undefined;
    this.rx = undefined;
  }

  private writeXkMsg1(roleErr: string): Uint8Array {
    if (this.role !== "initiator") throw new Error(roleErr);
    if (!this.remotePubkey) throw new Error("initiator needs remote pubkey");
    if (!this.hs) throw new Error("noise handshake state missing");
    this.state = "handshaking";
    const noiseMsg = this.hs.writeMessage(EMPTY_BYTES);
    if (noiseMsg.length !== NOISE_XK_MSG1_LEN) {
      throw new Error(`XK msg1 size ${noiseMsg.length} != ${NOISE_XK_MSG1_LEN}`);
    }
    return noiseMsg;
  }

  private respondToXkMsg1(noiseMsg1: Uint8Array): Uint8Array {
    if (!this.hs) throw new Error("noise handshake state missing");
    const payload = this.hs.readMessage(noiseMsg1);
    if (payload.length !== 0) throw new Error("XK msg1 inner payload must be empty");
    const noiseMsg = this.hs.writeMessage(this.localEpoch);
    if (noiseMsg.length !== NOISE_XK_MSG2_LEN) {
      throw new Error(`XK msg2 size ${noiseMsg.length} != ${NOISE_XK_MSG2_LEN}`);
    }
    return noiseMsg;
  }

  private completeInitiatorXk(noiseMsg2: Uint8Array): Uint8Array {
    if (!this.hs) throw new Error("noise handshake state missing");
    if (noiseMsg2.length !== NOISE_XK_MSG2_LEN) throw new Error("bad XK msg2 length");
    const payload = this.hs.readMessage(noiseMsg2);
    if (payload.length !== EPOCH_LEN) throw new Error("XK msg2 inner payload must be 8 bytes");
    this.remoteEpoch = new Uint8Array(payload);
    const noiseMsg = this.hs.writeMessage(this.localEpoch);
    if (noiseMsg.length !== NOISE_XK_MSG3_LEN) {
      throw new Error(`XK msg3 size ${noiseMsg.length} != ${NOISE_XK_MSG3_LEN}`);
    }
    return noiseMsg;
  }

  private checkEstablishedMsg3Replay(packet: Uint8Array): boolean {
    if (this.state !== "established") return false;
    if (this.establishedMsg3 && bytesEqual(packet, this.establishedMsg3)) return true;
    throw new Error("unexpected FSP Msg3 after establishment");
  }

  private completeResponderXk(noiseMsg3: Uint8Array, packet: Uint8Array, promoteDirect: boolean): void {
    if (!this.hs) throw new Error("noise handshake state missing");
    if (noiseMsg3.length !== NOISE_XK_MSG3_LEN) throw new Error("bad XK msg3 length");
    const payload = this.hs.readMessage(noiseMsg3);
    if (payload.length !== EPOCH_LEN) throw new Error("XK msg3 inner payload must be 8 bytes");
    this.remoteEpoch = new Uint8Array(payload);
    const rs = this.hs.getRemoteStatic();
    if (!rs) throw new Error("XK responder did not capture remote static");
    this.remotePubkey = rs;
    if (promoteDirect) this.remoteDirectFspTransport = this.pendingRemoteDirectFspTransport;
    this.establishedMsg3 = new Uint8Array(packet);
    this.finalize();
  }

  private finalize(): void {
    if (!this.hs) throw new Error("noise handshake state missing");
    const remoteStatic = this.hs.getRemoteStatic();
    if (!remoteStatic || remoteStatic.length !== 33) {
      throw new Error("missing authenticated compressed peer key");
    }
    const { tx, rx } = this.hs.splitTxRx();
    this.authenticatedPeerId = toHex(remoteStatic.subarray(1));
    this.tx = tx;
    this.rx = rx;
    this.sessionStartMs = performance.now();
    this.state = "established";
    this.hs = undefined;
  }

  private sealMessage(
    msgType: number,
    payload: Uint8Array,
    flags: number,
    coords?: Pick<FspEstablished, "srcCoords" | "destCoords">,
    srcPort?: number,
    dstPort?: number,
  ): Uint8Array {
    if (this.state !== "established" || !this.tx) throw new Error("FSP not established");
    if (this.txCounter >= 0xffff_ffff_ffff_ffffn) throw new Error("FSP nonce exhausted");
    const counter = this.txCounter++;
    validateEstablishedFlags(flags);
    if (coords) {
      flags |= FSP_FLAG_CP;
      if (this.strictClient) {
        coords = {
          srcCoords: [this.identity.nodeAddr],
          destCoords: this.remotePubkey ? [deriveNodeAddr(this.remotePubkey)] : [],
        };
      }
    }
    const hasPorts = srcPort !== undefined;
    const innerLen = FSP_INNER_HEADER_LEN + (hasPorts ? 4 : 0) + payload.length;
    const { frame, payloadOffset } = allocateFspEstablishedFrame({ flags, counter }, innerLen, coords);
    writeU32le(frame, payloadOffset, Math.floor(performance.now() - this.sessionStartMs) >>> 0);
    frame[payloadOffset + 4] = msgType & 0xff;
    frame[payloadOffset + 5] = 0;
    if (hasPorts) {
      writeU16le(frame, payloadOffset + FSP_INNER_HEADER_LEN, srcPort);
      writeU16le(frame, payloadOffset + FSP_INNER_HEADER_LEN + 2, dstPort!);
      frame.set(payload, payloadOffset + FSP_INNER_HEADER_LEN + 4);
    } else {
      frame.set(payload, payloadOffset + FSP_INNER_HEADER_LEN);
    }
    aeadSealInto(
      this.tx.getKey(),
      counter,
      frame.subarray(payloadOffset, payloadOffset + innerLen),
      frame.subarray(0, FSP_ESTABLISHED_HEADER_LEN),
      frame.subarray(payloadOffset),
    );
    return frame;
  }
}

function validateEstablishedFlags(flags: number): void {
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new Error("FSP flags must be one byte");
  }
  if ((flags & ~(FSP_FLAG_DIRECT_TRANSPORT | FSP_FLAG_K)) !== 0) {
    throw new Error("unsupported FSP established flags");
  }
}

function normalizeCoords(coords: NodeAddr | NodeAddr[]): NodeAddr[] {
  return coords instanceof Uint8Array ? [coords] : coords;
}
