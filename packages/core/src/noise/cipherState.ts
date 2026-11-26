/**
 * Noise CipherState — ChaCha20-Poly1305 with the FIPS nonce convention
 * (4 zero bytes || u64 LE counter). Empty key disables encryption (passthrough).
 */

import { aeadOpen, aeadSeal } from "../crypto/aead.js";

const EMPTY_AAD = new Uint8Array(0);
const ZERO_32 = new Uint8Array(32);

export class CipherState {
  private key: Uint8Array | null = null;
  private n = 0n;

  static withKey(key: Uint8Array): CipherState {
    if (key.length !== 32) throw new Error("ChaChaPoly key must be 32 bytes");
    const cs = new CipherState();
    cs.key = key;
    return cs;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  clone(): CipherState {
    const copy = new CipherState();
    copy.key = this.key?.slice() ?? null;
    copy.n = this.n;
    return copy;
  }

  /** Encrypt with AEAD; advance nonce. */
  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    if (this.n >= 0xffff_ffff_ffff_ffffn) throw new Error("Noise nonce exhausted");
    const ct = aeadSeal(this.key, this.n, plaintext, ad);
    this.n += 1n;
    return ct;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    if (this.n >= 0xffff_ffff_ffff_ffffn) throw new Error("Noise nonce exhausted");
    const pt = aeadOpen(this.key, this.n, ciphertext, ad);
    this.n += 1n;
    return pt;
  }

  rekey(): void {
    if (!this.key) return;
    // Noise rekey: encrypt 32 zero bytes with max nonce, take first 32 bytes.
    this.key = aeadSeal(this.key, 0xffff_ffff_ffff_ffffn, ZERO_32, EMPTY_AAD).subarray(0, 32);
  }

  get nonce(): bigint {
    return this.n;
  }

  /**
   * Return the 32-byte cipher key. FIPS Established frames index AEAD nonces
   * by an explicit u64 counter (carried in the frame header) rather than the
   * Noise-spec monotonic nonce, so the transport layer reaches for the key
   * directly.
   */
  getKey(): Uint8Array {
    if (!this.key) throw new Error("CipherState has no key");
    return this.key;
  }
}
