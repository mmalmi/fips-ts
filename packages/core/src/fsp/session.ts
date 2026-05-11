/**
 * FSP end-to-end session — same simplification as FmpLink: wire layout
 * matches Rust XK frame sizes (33/57/73 + Established with 12-byte header).
 * Inner crypto uses static-DH key agreement with a different HKDF info string.
 */

import { aeadOpen, aeadSeal } from "../crypto/aead.js";
import { deriveSessionKeys } from "../crypto/kdf.js";
import { ReplayWindow } from "../crypto/replay.js";
import { bytesEqual, concatBytes } from "../codec/hex.js";
import { ecdh, type FipsIdentity } from "../identity/index.js";

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
  FSP_MSG_KEEPALIVE,
  NOISE_XK_MSG2_LEN,
  NOISE_XK_MSG3_LEN,
  type DataPacket,
} from "./wire.js";

export type FspRole = "initiator" | "responder";

export interface FspSessionInit {
  identity: FipsIdentity;
  remotePubkey?: Uint8Array; // 33 compressed; initiator must supply
  role: FspRole;
}

export class FspSession {
  readonly identity: FipsIdentity;
  readonly role: FspRole;
  remotePubkey?: Uint8Array;

  private txKey?: Uint8Array;
  private rxKey?: Uint8Array;
  private txCounter = 0n;
  private replay = new ReplayWindow();

  state: "init" | "handshaking" | "established" | "closed" = "init";

  constructor(init: FspSessionInit) {
    this.identity = init.identity;
    this.role = init.role;
    if (init.remotePubkey) this.remotePubkey = init.remotePubkey;
  }

  buildMsg1(rand: (n: number) => Uint8Array): Uint8Array {
    if (this.role !== "initiator") throw new Error("only initiator builds XK msg1");
    if (!this.remotePubkey) throw new Error("initiator needs remote pubkey");
    this.state = "handshaking";
    // XK msg1 is 33 bytes; we put the initiator's static pubkey there. Real
    // Noise XK puts an ephemeral; matching that is the v2 task.
    return encodeFspHandshake({ phase: 1, noiseMsg: this.identity.publicKey });
    void rand;
  }

  handleMsg1(packet: Uint8Array, rand: (n: number) => Uint8Array): Uint8Array {
    if (this.role !== "responder") throw new Error("only responder handles XK msg1");
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 1) throw new Error("expected XK msg1");
    this.remotePubkey = frame.noiseMsg;
    if (this.remotePubkey.length !== 33) throw new Error("XK msg1 must carry 33-byte static");
    // Echo random bytes (57) for XK msg2 — wire-shape compat.
    return encodeFspHandshake({ phase: 2, noiseMsg: rand(NOISE_XK_MSG2_LEN) });
  }

  handleMsg2(packet: Uint8Array, rand: (n: number) => Uint8Array): Uint8Array {
    if (this.role !== "initiator") throw new Error("only initiator handles XK msg2");
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 2) throw new Error("expected XK msg2");
    if (frame.noiseMsg.length !== NOISE_XK_MSG2_LEN) throw new Error("bad XK msg2 length");
    // XK msg3 carries the initiator's static pubkey (33) + 40 bytes of padding
    // for wire shape (73 total).
    const msg3 = concatBytes(this.identity.publicKey, rand(NOISE_XK_MSG3_LEN - 33));
    this.deriveKeys();
    this.state = "established";
    return encodeFspHandshake({ phase: 3, noiseMsg: msg3 });
  }

  handleMsg3(packet: Uint8Array): void {
    if (this.role !== "responder") throw new Error("only responder handles XK msg3");
    const frame = decodeFspHandshake(packet);
    if (frame.phase !== 3) throw new Error("expected XK msg3");
    if (frame.noiseMsg.length !== NOISE_XK_MSG3_LEN) throw new Error("bad XK msg3 length");
    const initiatorStatic = frame.noiseMsg.slice(0, 33);
    if (!this.remotePubkey || !bytesEqual(this.remotePubkey, initiatorStatic)) {
      throw new Error("XK msg3 initiator static mismatch");
    }
    this.deriveKeys();
    this.state = "established";
  }

  private deriveKeys(): void {
    if (!this.remotePubkey) throw new Error("missing remote pubkey for FSP key derivation");
    const shared = ecdh(this.identity.secretKey, this.remotePubkey);
    const initiatorPub =
      this.role === "initiator" ? this.identity.xOnlyPubkey : this.remotePubkey.slice(1);
    const responderPub =
      this.role === "responder" ? this.identity.xOnlyPubkey : this.remotePubkey.slice(1);
    const { initiatorTx, responderTx } = deriveSessionKeys(
      shared,
      initiatorPub,
      responderPub,
      "fips/fsp/v1",
    );
    if (this.role === "initiator") {
      this.txKey = initiatorTx;
      this.rxKey = responderTx;
    } else {
      this.txKey = responderTx;
      this.rxKey = initiatorTx;
    }
  }

  encryptDatagram(data: DataPacket): Uint8Array {
    if (this.state !== "established" || !this.txKey) throw new Error("FSP not established");
    const counter = this.txCounter++;
    const inner = encodeFspInner({
      timestamp: Math.floor(Date.now() / 1000),
      msgType: FSP_MSG_DATA,
      innerFlags: 0,
      payload: encodeDataPacket(data),
    });
    const ciphertextLen = inner.length + 16;
    const aad = encodeFspEstablishedHeader({ flags: 0, counter }, ciphertextLen);
    const ciphertext = aeadSeal(this.txKey, counter, inner, aad);
    return encodeFspEstablished({ flags: 0, counter, ciphertext });
  }

  encryptKeepalive(): Uint8Array {
    if (this.state !== "established" || !this.txKey) throw new Error("FSP not established");
    const counter = this.txCounter++;
    const inner = encodeFspInner({
      timestamp: Math.floor(Date.now() / 1000),
      msgType: FSP_MSG_KEEPALIVE,
      innerFlags: 0,
      payload: new Uint8Array(0),
    });
    const ciphertextLen = inner.length + 16;
    const aad = encodeFspEstablishedHeader({ flags: 0, counter }, ciphertextLen);
    const ciphertext = aeadSeal(this.txKey, counter, inner, aad);
    return encodeFspEstablished({ flags: 0, counter, ciphertext });
  }

  decryptIncoming(
    packet: Uint8Array,
  ): { msgType: number; data?: DataPacket } {
    if (this.state !== "established" || !this.rxKey) throw new Error("FSP not established");
    const est = decodeFspEstablished(packet);
    if (!this.replay.accept(est.counter)) {
      throw new Error("FSP replay/duplicate counter");
    }
    const aad = encodeFspEstablishedHeader(
      { flags: est.flags, counter: est.counter },
      est.ciphertext.length,
    );
    const plaintext = aeadOpen(this.rxKey, est.counter, est.ciphertext, aad);
    const inner = decodeFspInner(plaintext);
    if (inner.msgType === FSP_MSG_DATA) {
      return { msgType: inner.msgType, data: decodeDataPacket(inner.payload) };
    }
    return { msgType: inner.msgType };
  }
}
