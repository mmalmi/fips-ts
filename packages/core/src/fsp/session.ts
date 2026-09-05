/**
 * FSP end-to-end session — same Rust-compatible wire envelope as before,
 * with the inner handshake now using the real Noise_XK_secp256k1_ChaChaPoly_SHA256
 * pattern. 8-byte epoch payloads at handshake steps 2 and 3 (XK msg1 has no
 * payload).
 */

import { aeadOpen, aeadSeal } from "../crypto/aead.js";
import { ReplayWindow } from "../crypto/replay.js";
import { bytesEqual } from "../codec/hex.js";
import type { FipsIdentity } from "../identity/index.js";
import { CipherState, NoiseHandshake } from "../noise/index.js";
import type { NodeAddr } from "../nodeaddr/index.js";
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
  decodeDataPacket,
  decodeFspEstablished,
  decodeFspHandshake,
  decodeFspInner,
  encodeDataPacket,
  encodeFspEstablished,
  encodeFspEstablishedHeader,
  encodeFspHandshake,
  encodeFspInner,
  FSP_MSG_DATA,
  FSP_MSG_ENDPOINT_DATA,
  FSP_MSG_KEEPALIVE,
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_FLAG_CP,
  FSP_FLAG_K,
  NOISE_XK_MSG1_LEN,
  NOISE_XK_MSG2_LEN,
  NOISE_XK_MSG3_LEN,
  type DataPacket,
  type FspEstablished,
} from "./wire.js";

export type FspRole = "initiator" | "responder";

export interface FspSessionInit {
  identity: FipsIdentity;
  remotePubkey?: Uint8Array; // 33 compressed; initiator must supply
  role: FspRole;
  ephemeralOverride?: Uint8Array;
  localEpoch?: Uint8Array;
}

const EPOCH_LEN = 8;

export class FspSession {
  readonly identity: FipsIdentity;
  readonly role: FspRole;
  remotePubkey?: Uint8Array;
  remoteEpoch?: Uint8Array;

  private readonly localEpoch: Uint8Array;
  private hs?: NoiseHandshake;
  private tx?: CipherState;
  private rx?: CipherState;
  private receivedSessionSetup?: Uint8Array;
  private sentSessionAck?: Uint8Array;
  private receivedSessionAck?: Uint8Array;
  private sentSessionMsg3?: Uint8Array;
  private establishedMsg3?: Uint8Array;
  private remoteDirectFspTransport = false;
  private txCounter = 0n;
  private sessionStartMs = 0;
  private replay = new ReplayWindow();

  state: "init" | "handshaking" | "established" | "closed" = "init";

  constructor(init: FspSessionInit) {
    this.identity = init.identity;
    this.role = init.role;
    this.localEpoch = init.localEpoch
      ? new Uint8Array(init.localEpoch)
      : new Uint8Array(EPOCH_LEN);
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
    if (this.role !== "initiator") throw new Error("only initiator builds XK msg1");
    if (!this.remotePubkey) throw new Error("initiator needs remote pubkey");
    if (!this.hs) throw new Error("noise handshake state missing");
    this.state = "handshaking";
    // XK msg1 carries no payload — `e` only (33 bytes).
    const noiseMsg = this.hs.writeMessage(new Uint8Array(0));
    if (noiseMsg.length !== NOISE_XK_MSG1_LEN) {
      throw new Error(`XK msg1 size ${noiseMsg.length} != ${NOISE_XK_MSG1_LEN}`);
    }
    return encodeFspHandshake({ phase: 1, noiseMsg });
  }

  buildSessionSetup(
    _rand: (n: number) => Uint8Array,
    srcCoords: NodeAddr | NodeAddr[],
    destCoords: NodeAddr | NodeAddr[],
  ): Uint8Array {
    if (this.role !== "initiator") throw new Error("only initiator builds SessionSetup");
    if (!this.remotePubkey) throw new Error("initiator needs remote pubkey");
    if (!this.hs) throw new Error("noise handshake state missing");
    this.state = "handshaking";
    const noiseMsg = this.hs.writeMessage(new Uint8Array(0));
    if (noiseMsg.length !== NOISE_XK_MSG1_LEN) {
      throw new Error(`XK msg1 size ${noiseMsg.length} != ${NOISE_XK_MSG1_LEN}`);
    }
    return encodeSessionSetup({
      srcCoords: normalizeCoords(srcCoords),
      destCoords: normalizeCoords(destCoords),
      flags: SESSION_FLAG_DIRECT_FSP_TRANSPORT,
      handshakePayload: noiseMsg,
    });
  }

  handleMsg1(packet: Uint8Array, _rand: (n: number) => Uint8Array): Uint8Array {
    if (this.role !== "responder") throw new Error("only responder handles XK msg1");
    if (!this.hs) throw new Error("noise handshake state missing");
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 1) throw new Error("expected XK msg1");
    const payload = this.hs.readMessage(frame.noiseMsg);
    if (payload.length !== 0) throw new Error("XK msg1 inner payload must be empty");
    const noiseMsg = this.hs.writeMessage(this.localEpoch);
    if (noiseMsg.length !== NOISE_XK_MSG2_LEN) {
      throw new Error(`XK msg2 size ${noiseMsg.length} != ${NOISE_XK_MSG2_LEN}`);
    }
    return encodeFspHandshake({ phase: 2, noiseMsg });
  }

  handleSessionSetup(
    packet: Uint8Array,
    _rand: (n: number) => Uint8Array,
    localCoords: NodeAddr | NodeAddr[],
  ): Uint8Array {
    if (this.role !== "responder") throw new Error("only responder handles SessionSetup");
    if (this.receivedSessionSetup) {
      if (bytesEqual(packet, this.receivedSessionSetup) && this.sentSessionAck) {
        return new Uint8Array(this.sentSessionAck);
      }
      throw new Error("unexpected FSP SessionSetup after handshake start");
    }
    if (!this.hs) throw new Error("noise handshake state missing");
    const setup = decodeSessionSetup(packet);
    if (setup.handshakePayload.length !== NOISE_XK_MSG1_LEN) {
      throw new Error("bad XK msg1 length");
    }
    const payload = this.hs.readMessage(setup.handshakePayload);
    if (payload.length !== 0) throw new Error("XK msg1 inner payload must be empty");
    this.remoteDirectFspTransport =
      (setup.flags & SESSION_FLAG_DIRECT_FSP_TRANSPORT) !== 0;
    const noiseMsg = this.hs.writeMessage(this.localEpoch);
    if (noiseMsg.length !== NOISE_XK_MSG2_LEN) {
      throw new Error(`XK msg2 size ${noiseMsg.length} != ${NOISE_XK_MSG2_LEN}`);
    }
    const reply = encodeSessionAck({
      srcCoords: normalizeCoords(localCoords),
      destCoords: setup.srcCoords,
      flags: SESSION_FLAG_DIRECT_FSP_TRANSPORT,
      handshakePayload: noiseMsg,
    });
    this.state = "handshaking";
    this.receivedSessionSetup = new Uint8Array(packet);
    this.sentSessionAck = new Uint8Array(reply);
    return reply;
  }

  matchesSessionSetup(packet: Uint8Array): boolean {
    return this.receivedSessionSetup !== undefined
      && bytesEqual(packet, this.receivedSessionSetup);
  }

  handleMsg2(packet: Uint8Array, _rand: (n: number) => Uint8Array): Uint8Array {
    if (this.role !== "initiator") throw new Error("only initiator handles XK msg2");
    if (!this.hs) throw new Error("noise handshake state missing");
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 2) throw new Error("expected XK msg2");
    if (frame.noiseMsg.length !== NOISE_XK_MSG2_LEN) throw new Error("bad XK msg2 length");
    const payload = this.hs.readMessage(frame.noiseMsg);
    if (payload.length !== EPOCH_LEN) throw new Error("XK msg2 inner payload must be 8 bytes");
    this.remoteEpoch = new Uint8Array(payload);
    const noiseMsg = this.hs.writeMessage(this.localEpoch);
    if (noiseMsg.length !== NOISE_XK_MSG3_LEN) {
      throw new Error(`XK msg3 size ${noiseMsg.length} != ${NOISE_XK_MSG3_LEN}`);
    }
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
    if (!this.hs) throw new Error("noise handshake state missing");
    const ack = decodeSessionAck(packet);
    if (ack.handshakePayload.length !== NOISE_XK_MSG2_LEN) throw new Error("bad XK msg2 length");
    const payload = this.hs.readMessage(ack.handshakePayload);
    if (payload.length !== EPOCH_LEN) throw new Error("XK msg2 inner payload must be 8 bytes");
    this.remoteDirectFspTransport =
      (ack.flags & SESSION_FLAG_DIRECT_FSP_TRANSPORT) !== 0;
    this.remoteEpoch = new Uint8Array(payload);
    const noiseMsg = this.hs.writeMessage(this.localEpoch);
    if (noiseMsg.length !== NOISE_XK_MSG3_LEN) {
      throw new Error(`XK msg3 size ${noiseMsg.length} != ${NOISE_XK_MSG3_LEN}`);
    }
    const reply = encodeSessionMsg3({ flags: 0, handshakePayload: noiseMsg });
    this.receivedSessionAck = new Uint8Array(packet);
    this.sentSessionMsg3 = new Uint8Array(reply);
    this.finalize();
    return reply;
  }

  handleMsg3(packet: Uint8Array): void {
    if (this.role !== "responder") throw new Error("only responder handles XK msg3");
    if (this.state === "established") {
      if (this.establishedMsg3 && bytesEqual(packet, this.establishedMsg3)) return;
      throw new Error("unexpected FSP Msg3 after establishment");
    }
    if (!this.hs) throw new Error("noise handshake state missing");
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 3) throw new Error("expected XK msg3");
    if (frame.noiseMsg.length !== NOISE_XK_MSG3_LEN) throw new Error("bad XK msg3 length");
    const payload = this.hs.readMessage(frame.noiseMsg);
    if (payload.length !== EPOCH_LEN) throw new Error("XK msg3 inner payload must be 8 bytes");
    this.remoteEpoch = new Uint8Array(payload);
    const rs = this.hs.getRemoteStatic();
    if (!rs) throw new Error("XK responder did not capture remote static");
    this.remotePubkey = rs;
    this.establishedMsg3 = new Uint8Array(packet);
    this.finalize();
  }

  handleSessionMsg3(packet: Uint8Array): void {
    if (this.role !== "responder") throw new Error("only responder handles SessionMsg3");
    if (this.state === "established") {
      if (this.establishedMsg3 && bytesEqual(packet, this.establishedMsg3)) return;
      throw new Error("unexpected FSP Msg3 after establishment");
    }
    if (!this.hs) throw new Error("noise handshake state missing");
    const msg3 = decodeSessionMsg3(packet);
    if (msg3.handshakePayload.length !== NOISE_XK_MSG3_LEN) throw new Error("bad XK msg3 length");
    const payload = this.hs.readMessage(msg3.handshakePayload);
    if (payload.length !== EPOCH_LEN) throw new Error("XK msg3 inner payload must be 8 bytes");
    this.remoteEpoch = new Uint8Array(payload);
    const rs = this.hs.getRemoteStatic();
    if (!rs) throw new Error("XK responder did not capture remote static");
    this.remotePubkey = rs;
    this.establishedMsg3 = new Uint8Array(packet);
    this.finalize();
  }

  private finalize(): void {
    if (!this.hs) throw new Error("noise handshake state missing");
    const { tx, rx } = this.hs.splitTxRx();
    this.tx = tx;
    this.rx = rx;
    this.sessionStartMs = performance.now();
    this.state = "established";
    this.hs = undefined;
  }

  encryptDatagram(data: DataPacket, flags = 0): Uint8Array {
    return this.encryptMessage(FSP_MSG_DATA, encodeDataPacket(data), flags);
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
    if (this.state !== "established" || !this.tx) throw new Error("FSP not established");
    if (!Number.isInteger(msgType) || msgType < 0 || msgType > 0xff) {
      throw new Error("FSP message type must be one byte");
    }
    if (this.txCounter >= 0xffff_ffff_ffff_ffffn) throw new Error("FSP nonce exhausted");
    const counter = this.txCounter++;
    const inner = encodeFspInner({
      timestamp: Math.floor(performance.now() - this.sessionStartMs) >>> 0,
      msgType,
      innerFlags: 0,
      payload,
    });
    validateEstablishedFlags(flags);
    if (coords) flags |= FSP_FLAG_CP;
    const aad = encodeFspEstablishedHeader({ flags, counter }, inner.length);
    const ciphertext = aeadSeal(this.tx.getKey(), counter, inner, aad);
    return encodeFspEstablished({ flags, counter, payloadLen: inner.length, ciphertext, ...coords });
  }

  encryptKeepalive(flags = 0): Uint8Array {
    return this.encryptMessage(FSP_MSG_KEEPALIVE, new Uint8Array(0), flags);
  }

  decryptIncoming(
    packet: Uint8Array,
    onAuthenticated?: (received: { counter: bigint; timestamp: number; bytes: number }) => void,
  ): { msgType: number; data?: DataPacket; endpointData?: Uint8Array; payload?: Uint8Array } {
    if (this.state !== "established" || !this.rx) throw new Error("FSP not established");
    const est = decodeFspEstablished(packet);
    if (!this.replay.check(est.counter)) {
      throw new Error("FSP replay/duplicate counter");
    }
    const aad = encodeFspEstablishedHeader(
      { flags: est.flags, counter: est.counter },
      est.payloadLen,
    );
    const plaintext = aeadOpen(this.rx.getKey(), est.counter, est.ciphertext, aad);
    this.replay.accept(est.counter);
    const inner = decodeFspInner(plaintext);
    onAuthenticated?.({ counter: est.counter, timestamp: inner.timestamp, bytes: plaintext.length });
    if (inner.msgType === FSP_MSG_DATA) {
      return { msgType: inner.msgType, data: decodeDataPacket(inner.payload) };
    }
    if (inner.msgType === FSP_MSG_ENDPOINT_DATA) {
      return { msgType: inner.msgType, endpointData: inner.payload, payload: inner.payload };
    }
    return { msgType: inner.msgType, payload: inner.payload };
  }

  close(): void {
    this.state = "closed";
    this.hs = undefined;
    this.tx = undefined;
    this.rx = undefined;
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
