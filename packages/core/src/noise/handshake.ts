/**
 * Noise HandshakeState for the two patterns FIPS uses:
 *
 *   Noise_IK_secp256k1_ChaChaPoly_SHA256
 *     <- s
 *     ...
 *     -> e, es, s, ss
 *     <- e, ee, se
 *
 *   Noise_XK_secp256k1_ChaChaPoly_SHA256
 *     <- s
 *     ...
 *     -> e
 *     <- e, ee
 *     -> s, se
 *
 * DH function: secp256k1 ECDH. Public keys are 33-byte compressed; the
 * shared-secret material is the 32-byte x-coordinate.
 *
 * AEAD: ChaCha20-Poly1305; nonce = 4×0 || u64 LE counter (matches Rust FIPS).
 * HASH: SHA-256.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { randomBytes } from "@noble/hashes/utils";

import { concatBytes } from "../codec/hex.js";
import { ecdh, type FipsIdentity } from "../identity/index.js";

import type { CipherState } from "./cipherState.js";
import { SymmetricState } from "./symmetricState.js";

const DHLEN = 33; // compressed pubkey size in our wire format
const HASHLEN = 32;
const TAGLEN = 16;

export type NoisePattern = "IK" | "XK";
export type NoiseRole = "initiator" | "responder";

export interface NoiseHandshakeInit {
  pattern: NoisePattern;
  role: NoiseRole;
  identity: FipsIdentity;
  /** Required for IK initiator and XK initiator: responder's static pubkey (33 bytes compressed). */
  remoteStatic?: Uint8Array;
  /** Required for IK responder and XK responder: empty since their own static is the identity. */
  /** Optional deterministic ephemeral private key (32 bytes); for tests/vectors. */
  ephemeralOverride?: Uint8Array;
}

interface KeyPair {
  priv: Uint8Array;
  pub: Uint8Array; // 33-byte compressed
}

const PROTOCOL_NAMES: Record<NoisePattern, string> = {
  IK: "Noise_IK_secp256k1_ChaChaPoly_SHA256",
  XK: "Noise_XK_secp256k1_ChaChaPoly_SHA256",
};

function deriveKeyPair(priv: Uint8Array): KeyPair {
  return { priv, pub: secp256k1.getPublicKey(priv, true) };
}

function genKeyPair(override?: Uint8Array): KeyPair {
  if (override) {
    if (override.length !== 32) throw new Error("ephemeral override must be 32 bytes");
    return deriveKeyPair(override);
  }
  return deriveKeyPair(randomBytes(32));
}

/**
 * NoiseHandshake state machine. `writeMessage` and `readMessage` advance one
 * pattern step at a time. Call `split()` after the final step to obtain a pair
 * of CipherStates `(initiatorTx, responderTx)`.
 */
export class NoiseHandshake {
  readonly pattern: NoisePattern;
  readonly role: NoiseRole;
  private readonly ss: SymmetricState;
  private readonly s: KeyPair; // local static
  private e?: KeyPair;          // local ephemeral
  private rs?: Uint8Array;      // remote static (33)
  private re?: Uint8Array;      // remote ephemeral (33)
  private readonly ephemeralOverride?: Uint8Array;
  private step = 0;

  constructor(init: NoiseHandshakeInit) {
    this.pattern = init.pattern;
    this.role = init.role;
    this.s = deriveKeyPair(init.identity.secretKey);
    this.rs = init.remoteStatic;
    this.ephemeralOverride = init.ephemeralOverride;

    const protocol = PROTOCOL_NAMES[init.pattern];
    this.ss = new SymmetricState(protocol);

    // Pre-message: `<- s` means the responder's static is known to both before
    // the handshake. Both sides MixHash(responder_static).
    //
    // FIPS-specific: normalize the parity byte to 0x02 before hashing. The
    // initiator may only have the x-only key (e.g., from an npub) and not
    // know the responder's true parity, so both sides hash the same bytes
    // regardless of parity. This does NOT affect ECDH (which already hashes
    // only the x-coordinate) or `e`/`s` bytes on the wire.
    const responderStatic =
      this.role === "responder" ? this.s.pub : this.rs;
    if (!responderStatic) {
      throw new Error("noise IK/XK initiator must know responder's static pubkey");
    }
    const normalized = new Uint8Array(responderStatic);
    normalized[0] = 0x02;
    this.ss.mixHash(normalized);
  }

  /** Returns the running handshake hash for diagnostics. */
  getHandshakeHash(): Uint8Array {
    return this.ss.getHandshakeHash();
  }

  /** Build the next outbound handshake message, encrypting the given payload. */
  writeMessage(payload: Uint8Array): Uint8Array {
    const tokens = this.tokensForStep(this.step);
    if (!this.isSenderForStep(this.step)) {
      throw new Error(`not our turn to write at step ${this.step}`);
    }
    let out: Uint8Array = new Uint8Array(0);
    for (const tok of tokens) {
      switch (tok) {
        case "e": {
          this.e = genKeyPair(this.ephemeralOverride);
          out = concatBytes(out, this.e.pub);
          this.ss.mixHash(this.e.pub);
          break;
        }
        case "s": {
          const enc = this.ss.encryptAndHash(this.s.pub);
          out = concatBytes(out, enc);
          break;
        }
        case "ee":
          this.dh("ee");
          break;
        case "es":
          this.dh("es");
          break;
        case "se":
          this.dh("se");
          break;
        case "ss":
          this.dh("ss");
          break;
        default:
          throw new Error(`unknown token ${tok}`);
      }
    }
    // FIPS-specific: skip the trailing payload AEAD entirely when there's no
    // payload to carry (matches Rust write_xk_message_1, which emits a
    // 33-byte msg without the 16-byte empty-payload tag the Noise spec would
    // otherwise produce). All other handshake steps carry an 8-byte epoch.
    if (payload.length > 0) {
      const encPayload = this.ss.encryptAndHash(payload);
      out = concatBytes(out, encPayload);
    }
    this.step += 1;
    return out;
  }

  /** Consume an inbound handshake message; returns the plaintext payload. */
  readMessage(message: Uint8Array): Uint8Array {
    const tokens = this.tokensForStep(this.step);
    if (this.isSenderForStep(this.step)) {
      throw new Error(`not our turn to read at step ${this.step}`);
    }
    let off = 0;
    for (const tok of tokens) {
      switch (tok) {
        case "e": {
          if (message.length - off < DHLEN) {
            throw new Error("noise: short message reading e");
          }
          this.re = message.subarray(off, off + DHLEN);
          off += DHLEN;
          this.ss.mixHash(this.re);
          break;
        }
        case "s": {
          const encLen = this.ss.cipherHasKey() ? DHLEN + TAGLEN : DHLEN;
          if (message.length - off < encLen) {
            throw new Error("noise: short message reading s");
          }
          const encS = message.subarray(off, off + encLen);
          off += encLen;
          this.rs = this.ss.decryptAndHash(encS);
          if (this.rs.length !== DHLEN) {
            throw new Error("noise: decrypted s is wrong length");
          }
          break;
        }
        case "ee":
          this.dh("ee");
          break;
        case "es":
          this.dh("es");
          break;
        case "se":
          this.dh("se");
          break;
        case "ss":
          this.dh("ss");
          break;
        default:
          throw new Error(`unknown token ${tok}`);
      }
    }
    const remaining = message.subarray(off);
    // Symmetric to writeMessage: skip decrypt_and_hash when the message has
    // no trailing AEAD bytes (Rust read_xk_message_1 does not call
    // decrypt_and_hash either).
    const payload =
      remaining.length > 0 ? this.ss.decryptAndHash(remaining) : new Uint8Array(0);
    this.step += 1;
    return payload;
  }

  /** Returns `(tx, rx)` where `tx` is for sending from our role. */
  splitTxRx(): { tx: CipherState; rx: CipherState } {
    const [c1, c2] = this.ss.split();
    if (this.role === "initiator") return { tx: c1, rx: c2 };
    return { tx: c2, rx: c1 };
  }

  /** Remote static, captured during the handshake (for IK responder etc.). */
  getRemoteStatic(): Uint8Array | undefined {
    return this.rs?.slice();
  }

  private tokensForStep(step: number): string[] {
    if (this.pattern === "IK") {
      if (step === 0) return ["e", "es", "s", "ss"];
      if (step === 1) return ["e", "ee", "se"];
    } else if (this.pattern === "XK") {
      // Standard Noise XK:  -> e, es    <- e, ee    -> s, se
      if (step === 0) return ["e", "es"];
      if (step === 1) return ["e", "ee"];
      if (step === 2) return ["s", "se"];
    }
    throw new Error(`no tokens for ${this.pattern} step ${step}`);
  }

  private isSenderForStep(step: number): boolean {
    // Both IK and XK alternate initiator/responder starting with initiator at step 0.
    return (step % 2 === 0) === (this.role === "initiator");
  }

  private dh(token: "ee" | "es" | "se" | "ss"): void {
    let priv: Uint8Array;
    let pub: Uint8Array;
    switch (token) {
      case "ee":
        priv = this.e!.priv;
        pub = this.re!;
        break;
      case "es":
        if (this.role === "initiator") {
          priv = this.e!.priv;
          pub = this.rs!;
        } else {
          priv = this.s.priv;
          pub = this.re!;
        }
        break;
      case "se":
        // Rust FIPS deviates from Noise spec for `se` in IK msg2: it
        // computes DH(e_initiator, s_responder) — same operands as `es`,
        // mixed in a second time. For Rust interop on the IK pattern we
        // match that behavior. XK msg3 `se` uses the standard Noise
        // semantics (DH between initiator's static and responder's
        // ephemeral). See ~/src/fips/crates/fips-core/src/noise/handshake.rs
        // write_message_2 / read_message_2.
        if (this.pattern === "IK") {
          if (this.role === "initiator") {
            priv = this.e!.priv;
            pub = this.rs!;
          } else {
            priv = this.s.priv;
            pub = this.re!;
          }
        } else if (this.role === "initiator") {
          priv = this.s.priv;
          pub = this.re!;
        } else {
          priv = this.e!.priv;
          pub = this.rs!;
        }
        break;
      case "ss":
        priv = this.s.priv;
        pub = this.rs!;
        break;
    }
    const shared = ecdh(priv, pub); // 32-byte x-coordinate
    if (shared.length !== HASHLEN) {
      throw new Error("noise DH must produce 32-byte output");
    }
    this.ss.mixKey(shared);
  }
}
