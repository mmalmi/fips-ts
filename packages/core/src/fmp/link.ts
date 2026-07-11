/**
 * FMP link state machine — adjacent-peer encrypted channel.
 *
 * Wire frames match Rust FIPS byte layout (FMP Msg1/Msg2/Established with
 * 4-byte common prefix and fixed Noise IK payload sizes 106/57). The inner
 * handshake is the real Noise_IK_secp256k1_ChaChaPoly_SHA256 pattern with an
 * 8-byte epoch payload (currently zero; in Rust this is a u64 LE epoch).
 *
 * The link's job:
 *   - Noise IK handshake (msg1/msg2)
 *   - frame keep-alive and data packets with the split CipherStates
 *   - enforce replay window on the receive side
 */

import { ReplayWindow } from "../crypto/replay.js";
import { bytesEqual } from "../codec/hex.js";
import type { FipsIdentity } from "../identity/index.js";
import { CipherState, NoiseHandshake } from "../noise/index.js";

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
  /** Optional deterministic ephemeral for vectors/tests. */
  ephemeralOverride?: Uint8Array;
}

export interface FmpHandshakeOutbound {
  packet: Uint8Array;
}

export interface FmpHandshakeResult {
  reply?: Uint8Array;
  established: boolean;
  remotePubkey: Uint8Array;
}

/** 8-byte epoch payload carried inside each FMP handshake step. */
const EPOCH_PAYLOAD_LEN = 8;

function epochPayload(): Uint8Array {
  // The Rust implementation carries a u64-LE epoch here; for now we emit
  // zeros to match the byte length. Wire layout is preserved.
  return new Uint8Array(EPOCH_PAYLOAD_LEN);
}

export class FmpLink {
  readonly role: FmpRole;
  readonly localSessionIdx: number;
  readonly identity: FipsIdentity;

  remotePubkey?: Uint8Array;
  remoteSessionIdx?: number;

  private hs?: NoiseHandshake;
  private tx?: CipherState;
  private rx?: CipherState;
  private establishedMsg1?: Uint8Array;
  private establishedMsg2?: Uint8Array;
  private txCounter = 0n;
  private rxReplay = new ReplayWindow();

  state: "init" | "handshaking" | "established" | "closed" = "init";

  constructor(init: FmpLinkInit) {
    this.identity = init.identity;
    this.role = init.role;
    this.localSessionIdx = init.sessionIdx;
    if (init.remotePubkey) this.remotePubkey = init.remotePubkey;
    this.hs = new NoiseHandshake({
      pattern: "IK",
      role: init.role,
      identity: init.identity,
      remoteStatic: init.remotePubkey,
      ephemeralOverride: init.ephemeralOverride,
    });
  }

  buildMsg1(_rand: (n: number) => Uint8Array): FmpHandshakeOutbound {
    if (this.role !== "initiator") throw new Error("only initiator builds Msg1");
    if (!this.remotePubkey) throw new Error("initiator needs remote pubkey");
    if (!this.hs) throw new Error("noise handshake state missing");
    this.state = "handshaking";
    const noiseMsg1 = this.hs.writeMessage(epochPayload());
    if (noiseMsg1.length !== NOISE_IK_MSG1_LEN) {
      throw new Error(`noise IK msg1 size ${noiseMsg1.length} != ${NOISE_IK_MSG1_LEN}`);
    }
    const packet = encodeFmpMsg1({
      senderIdx: this.localSessionIdx,
      noiseMsg1,
    });
    return { packet };
  }

  handleMsg1(
    packet: Uint8Array,
    _rand: (n: number) => Uint8Array,
  ): FmpHandshakeResult {
    if (this.role !== "responder") throw new Error("only responder handles Msg1");
    if (this.state === "established") {
      if (
        this.establishedMsg1
        && this.establishedMsg2
        && bytesEqual(packet, this.establishedMsg1)
        && this.remotePubkey
      ) {
        return {
          reply: new Uint8Array(this.establishedMsg2),
          established: true,
          remotePubkey: this.remotePubkey,
        };
      }
      throw new Error("unexpected FMP Msg1 after establishment");
    }
    if (!this.hs) throw new Error("noise handshake state missing");
    const msg1 = decodeFmpMsg1(packet);
    const payload = this.hs.readMessage(msg1.noiseMsg1);
    if (payload.length !== EPOCH_PAYLOAD_LEN) {
      throw new Error("noise IK msg1 inner payload must be 8 bytes");
    }
    this.remoteSessionIdx = msg1.senderIdx;
    const rs = this.hs.getRemoteStatic();
    if (!rs) throw new Error("noise IK responder did not capture remote static");
    this.remotePubkey = rs;
    const noiseMsg2 = this.hs.writeMessage(epochPayload());
    if (noiseMsg2.length !== NOISE_IK_MSG2_LEN) {
      throw new Error(`noise IK msg2 size ${noiseMsg2.length} != ${NOISE_IK_MSG2_LEN}`);
    }
    const reply = encodeFmpMsg2({
      senderIdx: this.localSessionIdx,
      receiverIdx: msg1.senderIdx,
      noiseMsg2,
    });
    this.establishedMsg1 = new Uint8Array(packet);
    this.establishedMsg2 = new Uint8Array(reply);
    this.finalize();
    return { reply, established: true, remotePubkey: rs };
  }

  handleMsg2(packet: Uint8Array): FmpHandshakeResult {
    if (this.role !== "initiator") throw new Error("only initiator handles Msg2");
    if (this.state === "established") {
      if (this.establishedMsg2 && bytesEqual(packet, this.establishedMsg2)) {
        return { established: true, remotePubkey: this.remotePubkey! };
      }
      throw new Error("unexpected FMP Msg2 after establishment");
    }
    if (!this.hs) throw new Error("noise handshake state missing");
    const msg2 = decodeFmpMsg2(packet);
    if (msg2.receiverIdx !== this.localSessionIdx) {
      throw new Error("FMP Msg2 receiver_idx mismatch");
    }
    const payload = this.hs.readMessage(msg2.noiseMsg2);
    if (payload.length !== EPOCH_PAYLOAD_LEN) {
      throw new Error("noise IK msg2 inner payload must be 8 bytes");
    }
    this.remoteSessionIdx = msg2.senderIdx;
    this.establishedMsg2 = new Uint8Array(packet);
    this.finalize();
    return { established: true, remotePubkey: this.remotePubkey! };
  }

  private finalize(): void {
    if (!this.hs) throw new Error("noise handshake state missing");
    const { tx, rx } = this.hs.splitTxRx();
    this.tx = tx;
    this.rx = rx;
    this.state = "established";
    this.hs = undefined;
  }

  encryptOutgoing(payload: Uint8Array, msgType = FMP_INNER_DATA): Uint8Array {
    if (this.state !== "established" || !this.tx || this.remoteSessionIdx === undefined) {
      throw new Error("FMP link not established");
    }
    const counter = this.txCounter++;
    const inner = encodeFmpInner({
      timestamp: Math.floor(Date.now() / 1000),
      msgType,
      payload,
    });
    const aad = encodeFmpEstablishedHeader(
      { flags: 0, receiverIdx: this.remoteSessionIdx, counter },
      inner.length,
    );
    // CipherState manages its own monotonic nonce, but FIPS Established uses
    // the explicit u64 counter from the frame header. We bypass CipherState's
    // internal counter and use the AEAD primitive with the frame counter so
    // both endpoints derive the same 12-byte nonce.
    const ciphertext = aeadWithCounter(this.tx, counter, aad, inner);
    return encodeFmpEstablished({
      flags: 0,
      receiverIdx: this.remoteSessionIdx,
      counter,
      payloadLen: inner.length,
      ciphertext,
    });
  }

  encryptKeepalive(): Uint8Array {
    return this.encryptOutgoing(new Uint8Array(0), FMP_INNER_KEEPALIVE);
  }

  decryptIncoming(packet: Uint8Array): { msgType: number; payload: Uint8Array } {
    if (this.state !== "established" || !this.rx) {
      throw new Error("FMP link not established");
    }
    const est = decodeFmpEstablished(packet);
    if (est.receiverIdx !== this.localSessionIdx) {
      throw new Error("FMP Established receiver_idx mismatch");
    }
    if (!this.rxReplay.check(est.counter)) {
      throw new Error("FMP replay/duplicate counter");
    }
    const aad = encodeFmpEstablishedHeader(
      { flags: est.flags, receiverIdx: est.receiverIdx, counter: est.counter },
      est.payloadLen,
    );
    const plaintext = openWithCounter(this.rx, est.counter, aad, est.ciphertext);
    this.rxReplay.accept(est.counter);
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

// --- AEAD helpers that use an explicit u64 counter for the FIPS Established
// header counter, bypassing CipherState's internal monotonic counter ---

import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { noiseNonce } from "../crypto/aead.js";

function aeadWithCounter(
  cs: CipherState,
  counter: bigint,
  aad: Uint8Array,
  pt: Uint8Array,
): Uint8Array {
  return chacha20poly1305(cs.getKey(), noiseNonce(counter), aad).encrypt(pt);
}

function openWithCounter(
  cs: CipherState,
  counter: bigint,
  aad: Uint8Array,
  ct: Uint8Array,
): Uint8Array {
  return chacha20poly1305(cs.getKey(), noiseNonce(counter), aad).decrypt(ct);
}
