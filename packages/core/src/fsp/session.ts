/**
 * FSP end-to-end session — same Rust-compatible wire envelope as before,
 * with the inner handshake now using the real Noise_XK_secp256k1_ChaChaPoly_SHA256
 * pattern. 8-byte epoch payloads at handshake steps 2 and 3 (XK msg1 has no
 * payload).
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha";

import { noiseNonce } from "../crypto/aead.js";
import { ReplayWindow } from "../crypto/replay.js";
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
  NOISE_XK_MSG1_LEN,
  NOISE_XK_MSG2_LEN,
  NOISE_XK_MSG3_LEN,
  type DataPacket,
} from "./wire.js";

export type FspRole = "initiator" | "responder";

export interface FspSessionInit {
  identity: FipsIdentity;
  remotePubkey?: Uint8Array; // 33 compressed; initiator must supply
  role: FspRole;
  ephemeralOverride?: Uint8Array;
}

const EPOCH_LEN = 8;

function epoch(): Uint8Array {
  return new Uint8Array(EPOCH_LEN);
}

export class FspSession {
  readonly identity: FipsIdentity;
  readonly role: FspRole;
  remotePubkey?: Uint8Array;

  private hs?: NoiseHandshake;
  private tx?: CipherState;
  private rx?: CipherState;
  private txCounter = 0n;
  private replay = new ReplayWindow();

  state: "init" | "handshaking" | "established" | "closed" = "init";

  constructor(init: FspSessionInit) {
    this.identity = init.identity;
    this.role = init.role;
    if (init.remotePubkey) this.remotePubkey = init.remotePubkey;
    this.hs = new NoiseHandshake({
      pattern: "XK",
      role: init.role,
      identity: init.identity,
      remoteStatic: init.remotePubkey,
      ephemeralOverride: init.ephemeralOverride,
    });
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
    srcNodeAddr: NodeAddr,
    destNodeAddr: NodeAddr,
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
      srcCoords: [srcNodeAddr],
      destCoords: [destNodeAddr],
      flags: 0,
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
    const noiseMsg = this.hs.writeMessage(epoch());
    if (noiseMsg.length !== NOISE_XK_MSG2_LEN) {
      throw new Error(`XK msg2 size ${noiseMsg.length} != ${NOISE_XK_MSG2_LEN}`);
    }
    return encodeFspHandshake({ phase: 2, noiseMsg });
  }

  handleSessionSetup(
    packet: Uint8Array,
    _rand: (n: number) => Uint8Array,
    localNodeAddr: NodeAddr,
  ): Uint8Array {
    if (this.role !== "responder") throw new Error("only responder handles SessionSetup");
    if (!this.hs) throw new Error("noise handshake state missing");
    const setup = decodeSessionSetup(packet);
    if (setup.handshakePayload.length !== NOISE_XK_MSG1_LEN) {
      throw new Error("bad XK msg1 length");
    }
    const payload = this.hs.readMessage(setup.handshakePayload);
    if (payload.length !== 0) throw new Error("XK msg1 inner payload must be empty");
    const noiseMsg = this.hs.writeMessage(epoch());
    if (noiseMsg.length !== NOISE_XK_MSG2_LEN) {
      throw new Error(`XK msg2 size ${noiseMsg.length} != ${NOISE_XK_MSG2_LEN}`);
    }
    return encodeSessionAck({
      srcCoords: [localNodeAddr],
      destCoords: setup.srcCoords,
      flags: 0,
      handshakePayload: noiseMsg,
    });
  }

  handleMsg2(packet: Uint8Array, _rand: (n: number) => Uint8Array): Uint8Array {
    if (this.role !== "initiator") throw new Error("only initiator handles XK msg2");
    if (!this.hs) throw new Error("noise handshake state missing");
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 2) throw new Error("expected XK msg2");
    if (frame.noiseMsg.length !== NOISE_XK_MSG2_LEN) throw new Error("bad XK msg2 length");
    const payload = this.hs.readMessage(frame.noiseMsg);
    if (payload.length !== EPOCH_LEN) throw new Error("XK msg2 inner payload must be 8 bytes");
    const noiseMsg = this.hs.writeMessage(epoch());
    if (noiseMsg.length !== NOISE_XK_MSG3_LEN) {
      throw new Error(`XK msg3 size ${noiseMsg.length} != ${NOISE_XK_MSG3_LEN}`);
    }
    this.finalize();
    return encodeFspHandshake({ phase: 3, noiseMsg });
  }

  handleSessionAck(packet: Uint8Array, _rand: (n: number) => Uint8Array): Uint8Array {
    if (this.role !== "initiator") throw new Error("only initiator handles SessionAck");
    if (!this.hs) throw new Error("noise handshake state missing");
    const ack = decodeSessionAck(packet);
    if (ack.handshakePayload.length !== NOISE_XK_MSG2_LEN) throw new Error("bad XK msg2 length");
    const payload = this.hs.readMessage(ack.handshakePayload);
    if (payload.length !== EPOCH_LEN) throw new Error("XK msg2 inner payload must be 8 bytes");
    const noiseMsg = this.hs.writeMessage(epoch());
    if (noiseMsg.length !== NOISE_XK_MSG3_LEN) {
      throw new Error(`XK msg3 size ${noiseMsg.length} != ${NOISE_XK_MSG3_LEN}`);
    }
    this.finalize();
    return encodeSessionMsg3({ flags: 0, handshakePayload: noiseMsg });
  }

  handleMsg3(packet: Uint8Array): void {
    if (this.role !== "responder") throw new Error("only responder handles XK msg3");
    if (!this.hs) throw new Error("noise handshake state missing");
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 3) throw new Error("expected XK msg3");
    if (frame.noiseMsg.length !== NOISE_XK_MSG3_LEN) throw new Error("bad XK msg3 length");
    const payload = this.hs.readMessage(frame.noiseMsg);
    if (payload.length !== EPOCH_LEN) throw new Error("XK msg3 inner payload must be 8 bytes");
    const rs = this.hs.getRemoteStatic();
    if (!rs) throw new Error("XK responder did not capture remote static");
    this.remotePubkey = rs;
    this.finalize();
  }

  handleSessionMsg3(packet: Uint8Array): void {
    if (this.role !== "responder") throw new Error("only responder handles SessionMsg3");
    if (!this.hs) throw new Error("noise handshake state missing");
    const msg3 = decodeSessionMsg3(packet);
    if (msg3.handshakePayload.length !== NOISE_XK_MSG3_LEN) throw new Error("bad XK msg3 length");
    const payload = this.hs.readMessage(msg3.handshakePayload);
    if (payload.length !== EPOCH_LEN) throw new Error("XK msg3 inner payload must be 8 bytes");
    const rs = this.hs.getRemoteStatic();
    if (!rs) throw new Error("XK responder did not capture remote static");
    this.remotePubkey = rs;
    this.finalize();
  }

  private finalize(): void {
    if (!this.hs) throw new Error("noise handshake state missing");
    const { tx, rx } = this.hs.splitTxRx();
    this.tx = tx;
    this.rx = rx;
    this.state = "established";
    this.hs = undefined;
  }

  encryptDatagram(data: DataPacket): Uint8Array {
    if (this.state !== "established" || !this.tx) throw new Error("FSP not established");
    const counter = this.txCounter++;
    const inner = encodeFspInner({
      timestamp: Math.floor(Date.now() / 1000),
      msgType: FSP_MSG_DATA,
      innerFlags: 0,
      payload: encodeDataPacket(data),
    });
    const aad = encodeFspEstablishedHeader({ flags: 0, counter }, inner.length);
    const ciphertext = chacha20poly1305(this.tx.getKey(), noiseNonce(counter), aad).encrypt(inner);
    return encodeFspEstablished({ flags: 0, counter, payloadLen: inner.length, ciphertext });
  }

  encryptEndpointData(payload: Uint8Array): Uint8Array {
    if (this.state !== "established" || !this.tx) throw new Error("FSP not established");
    const counter = this.txCounter++;
    const inner = encodeFspInner({
      timestamp: Math.floor(Date.now() / 1000),
      msgType: FSP_MSG_ENDPOINT_DATA,
      innerFlags: 0,
      payload,
    });
    const aad = encodeFspEstablishedHeader({ flags: 0, counter }, inner.length);
    const ciphertext = chacha20poly1305(this.tx.getKey(), noiseNonce(counter), aad).encrypt(inner);
    return encodeFspEstablished({ flags: 0, counter, payloadLen: inner.length, ciphertext });
  }

  encryptKeepalive(): Uint8Array {
    if (this.state !== "established" || !this.tx) throw new Error("FSP not established");
    const counter = this.txCounter++;
    const inner = encodeFspInner({
      timestamp: Math.floor(Date.now() / 1000),
      msgType: FSP_MSG_KEEPALIVE,
      innerFlags: 0,
      payload: new Uint8Array(0),
    });
    const aad = encodeFspEstablishedHeader({ flags: 0, counter }, inner.length);
    const ciphertext = chacha20poly1305(this.tx.getKey(), noiseNonce(counter), aad).encrypt(inner);
    return encodeFspEstablished({ flags: 0, counter, payloadLen: inner.length, ciphertext });
  }

  decryptIncoming(
    packet: Uint8Array,
  ): { msgType: number; data?: DataPacket; endpointData?: Uint8Array } {
    if (this.state !== "established" || !this.rx) throw new Error("FSP not established");
    const est = decodeFspEstablished(packet);
    if (!this.replay.accept(est.counter)) {
      throw new Error("FSP replay/duplicate counter");
    }
    const aad = encodeFspEstablishedHeader(
      { flags: est.flags, counter: est.counter },
      est.payloadLen,
    );
    const plaintext = chacha20poly1305(
      this.rx.getKey(),
      noiseNonce(est.counter),
      aad,
    ).decrypt(est.ciphertext);
    const inner = decodeFspInner(plaintext);
    if (inner.msgType === FSP_MSG_DATA) {
      return { msgType: inner.msgType, data: decodeDataPacket(inner.payload) };
    }
    if (inner.msgType === FSP_MSG_ENDPOINT_DATA) {
      return { msgType: inner.msgType, endpointData: inner.payload };
    }
    return { msgType: inner.msgType };
  }
}
