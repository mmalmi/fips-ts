/**
 * FMP link state machine — adjacent-peer encrypted channel.
 *
 * Wire frames match Rust FIPS byte layout (FMP Msg1/Msg2/Established with
 * 4-byte common prefix and fixed Noise IK payload sizes 106/57). The inner
 * handshake currently uses a simplified static-DH key agreement rather than
 * the full Noise_IK pattern; this is documented in docs/rust-compat.md and
 * is the v2 interop task.
 *
 * The link's job:
 *   - exchange long-term static pubkeys
 *   - derive a pair of symmetric AEAD keys with HKDF
 *   - frame keep-alive and data packets with ChaCha20-Poly1305
 *   - enforce replay window
 */

import { aeadOpen, aeadSeal } from "../crypto/aead.js";
import { deriveSessionKeys } from "../crypto/kdf.js";
import { ReplayWindow } from "../crypto/replay.js";
import { bytesEqual, concatBytes } from "../codec/hex.js";
import { ecdh, type FipsIdentity } from "../identity/index.js";

import {
  decodeFmpEstablished,
  decodeFmpInner,
  decodeFmpMsg1,
  decodeFmpMsg2,
  encodeFmpEstablished,
  encodeFmpEstablishedHeader,
  encodeFmpInner,
  encodeFmpMsg1,
  encodeFmpMsg2,
  FMP_INNER_DATA,
  FMP_INNER_KEEPALIVE,
  FMP_PHASE_ESTABLISHED,
  FMP_PHASE_MSG1,
  FMP_PHASE_MSG2,
  NOISE_IK_MSG1_LEN,
  NOISE_IK_MSG2_LEN,
} from "./wire.js";

export type FmpRole = "initiator" | "responder";

export interface FmpLinkInit {
  identity: FipsIdentity;
  remotePubkey?: Uint8Array; // 33 compressed; initiator needs this
  role: FmpRole;
  sessionIdx: number; // local SessionIndex
}

export interface FmpHandshakeOutbound {
  packet: Uint8Array;
}

export interface FmpHandshakeResult {
  reply?: Uint8Array;
  established: boolean;
  remotePubkey: Uint8Array;
}

export interface FmpDataOutbound {
  packet: Uint8Array; // outer FMP Established frame
}

interface NoiseIkMsg1 {
  initiatorStatic: Uint8Array; // 33 bytes compressed
  payload: Uint8Array;         // remaining 73 bytes (random / future use)
}

interface NoiseIkMsg2 {
  payload: Uint8Array; // 57 bytes (random / future use)
}

function encodeNoiseMsg1(m: NoiseIkMsg1): Uint8Array {
  if (m.initiatorStatic.length !== 33) throw new Error("static must be 33 bytes");
  if (m.payload.length !== NOISE_IK_MSG1_LEN - 33) {
    throw new Error(`msg1 payload must be ${NOISE_IK_MSG1_LEN - 33} bytes`);
  }
  return concatBytes(m.initiatorStatic, m.payload);
}

function decodeNoiseMsg1(buf: Uint8Array): NoiseIkMsg1 {
  if (buf.length !== NOISE_IK_MSG1_LEN) throw new Error("bad noise msg1 length");
  return {
    initiatorStatic: buf.slice(0, 33),
    payload: buf.slice(33),
  };
}

function encodeNoiseMsg2(m: NoiseIkMsg2): Uint8Array {
  if (m.payload.length !== NOISE_IK_MSG2_LEN) {
    throw new Error(`msg2 payload must be ${NOISE_IK_MSG2_LEN} bytes`);
  }
  return m.payload;
}

export class FmpLink {
  readonly role: FmpRole;
  readonly localSessionIdx: number;
  readonly identity: FipsIdentity;

  remotePubkey?: Uint8Array; // 33 compressed
  remoteSessionIdx?: number;

  private txKey?: Uint8Array;
  private rxKey?: Uint8Array;
  private txCounter = 0n;
  private rxReplay = new ReplayWindow();

  state: "init" | "handshaking" | "established" | "closed" = "init";

  constructor(init: FmpLinkInit) {
    this.identity = init.identity;
    this.role = init.role;
    this.localSessionIdx = init.sessionIdx;
    if (init.remotePubkey) this.remotePubkey = init.remotePubkey;
  }

  /** Initiator-only: build FMP Msg1 to send. */
  buildMsg1(rand: (n: number) => Uint8Array): FmpHandshakeOutbound {
    if (this.role !== "initiator") throw new Error("only initiator builds Msg1");
    if (!this.remotePubkey) throw new Error("initiator needs remote pubkey");
    this.state = "handshaking";
    const noiseMsg1 = encodeNoiseMsg1({
      initiatorStatic: this.identity.publicKey,
      payload: rand(NOISE_IK_MSG1_LEN - 33),
    });
    const packet = encodeFmpMsg1({
      senderIdx: this.localSessionIdx,
      noiseMsg1,
    });
    return { packet };
  }

  /** Responder receives Msg1, derives keys, replies with Msg2. */
  handleMsg1(
    packet: Uint8Array,
    rand: (n: number) => Uint8Array,
  ): FmpHandshakeResult {
    if (this.role !== "responder") throw new Error("only responder handles Msg1");
    const msg1 = decodeFmpMsg1(packet);
    const inner = decodeNoiseMsg1(msg1.noiseMsg1);
    this.remoteSessionIdx = msg1.senderIdx;
    this.remotePubkey = inner.initiatorStatic;
    this.deriveKeys();
    this.state = "established";
    const reply = encodeFmpMsg2({
      senderIdx: this.localSessionIdx,
      receiverIdx: msg1.senderIdx,
      noiseMsg2: encodeNoiseMsg2({ payload: rand(NOISE_IK_MSG2_LEN) }),
    });
    return { reply, established: true, remotePubkey: inner.initiatorStatic };
  }

  /** Initiator receives Msg2 and finalizes. */
  handleMsg2(packet: Uint8Array): FmpHandshakeResult {
    if (this.role !== "initiator") throw new Error("only initiator handles Msg2");
    const msg2 = decodeFmpMsg2(packet);
    if (msg2.receiverIdx !== this.localSessionIdx) {
      throw new Error("FMP Msg2 receiver_idx mismatch");
    }
    this.remoteSessionIdx = msg2.senderIdx;
    this.deriveKeys();
    this.state = "established";
    return { established: true, remotePubkey: this.remotePubkey! };
  }

  private deriveKeys(): void {
    if (!this.remotePubkey) throw new Error("missing remote pubkey for key derivation");
    const shared = ecdh(this.identity.secretKey, this.remotePubkey);
    const initiatorPub =
      this.role === "initiator" ? this.identity.xOnlyPubkey : this.remotePubkey.slice(1);
    const responderPub =
      this.role === "responder" ? this.identity.xOnlyPubkey : this.remotePubkey.slice(1);
    const { initiatorTx, responderTx } = deriveSessionKeys(
      shared,
      initiatorPub,
      responderPub,
      "fips/fmp/v1",
    );
    if (this.role === "initiator") {
      this.txKey = initiatorTx;
      this.rxKey = responderTx;
    } else {
      this.txKey = responderTx;
      this.rxKey = initiatorTx;
    }
  }

  /** Send application bytes through this established FMP link. */
  encryptOutgoing(payload: Uint8Array, msgType = FMP_INNER_DATA): Uint8Array {
    if (this.state !== "established" || !this.txKey || this.remoteSessionIdx === undefined) {
      throw new Error("FMP link not established");
    }
    const counter = this.txCounter++;
    const inner = encodeFmpInner({
      timestamp: Math.floor(Date.now() / 1000),
      msgType,
      payload,
    });
    const ciphertextLen = inner.length + 16;
    const aad = encodeFmpEstablishedHeader(
      { flags: 0, receiverIdx: this.remoteSessionIdx, counter },
      ciphertextLen,
    );
    const ciphertext = aeadSeal(this.txKey, counter, inner, aad);
    return encodeFmpEstablished({
      flags: 0,
      receiverIdx: this.remoteSessionIdx,
      counter,
      ciphertext,
    });
  }

  encryptKeepalive(): Uint8Array {
    return this.encryptOutgoing(new Uint8Array(0), FMP_INNER_KEEPALIVE);
  }

  /** Decrypt an incoming FMP Established frame; returns the inner payload. */
  decryptIncoming(packet: Uint8Array): { msgType: number; payload: Uint8Array } {
    if (this.state !== "established" || !this.rxKey) {
      throw new Error("FMP link not established");
    }
    const est = decodeFmpEstablished(packet);
    if (est.receiverIdx !== this.localSessionIdx) {
      throw new Error("FMP Established receiver_idx mismatch");
    }
    if (!this.rxReplay.accept(est.counter)) {
      throw new Error("FMP replay/duplicate counter");
    }
    const aad = encodeFmpEstablishedHeader(
      { flags: est.flags, receiverIdx: est.receiverIdx, counter: est.counter },
      est.ciphertext.length,
    );
    const plaintext = aeadOpen(this.rxKey, est.counter, est.ciphertext, aad);
    const inner = decodeFmpInner(plaintext);
    return { msgType: inner.msgType, payload: inner.payload };
  }

  close(): void {
    this.state = "closed";
  }
}

export { FMP_PHASE_ESTABLISHED, FMP_PHASE_MSG1, FMP_PHASE_MSG2 };

export function isEqualPubkey(a: Uint8Array, b: Uint8Array): boolean {
  return bytesEqual(a, b);
}
