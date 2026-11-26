/**
 * Noise SymmetricState (h, ck, k, n) — RFC: https://noiseprotocol.org/noise.html
 *
 * Operates with SHA-256 (HASHLEN = 32, BLOCKLEN = 64) and ChaCha20-Poly1305
 * (KEYLEN = 32, TAGLEN = 16).
 */

import { sha256 } from "@noble/hashes/sha256";

import { concatBytes } from "../codec/hex.js";

import { CipherState } from "./cipherState.js";
import { noiseHkdf2, noiseHkdf3 } from "./hkdf.js";

const HASHLEN = 32;
const EMPTY_BYTES = new Uint8Array(0);
const textEncoder = new TextEncoder();
const protocolHashCache = new Map<string, Uint8Array>();

function initialHash(protocolName: string): Uint8Array {
  const cached = protocolHashCache.get(protocolName);
  if (cached) return cached.slice();
  const nameBytes = textEncoder.encode(protocolName);
  let h: Uint8Array;
  if (nameBytes.length <= HASHLEN) {
    h = new Uint8Array(HASHLEN);
    h.set(nameBytes, 0);
  } else {
    h = sha256(nameBytes);
  }
  if (protocolHashCache.size < 8) protocolHashCache.set(protocolName, h.slice());
  return h;
}

export class SymmetricState {
  private h: Uint8Array;
  private ck: Uint8Array;
  private cipher: CipherState;

  constructor(protocolName: string) {
    this.h = initialHash(protocolName);
    this.ck = this.h.slice();
    this.cipher = new CipherState();
  }

  clone(): SymmetricState {
    const copy = Object.create(SymmetricState.prototype) as SymmetricState;
    copy.h = this.h.slice();
    copy.ck = this.ck.slice();
    copy.cipher = this.cipher.clone();
    return copy;
  }

  /** h = HASH(h || data). */
  mixHash(data: Uint8Array): void {
    this.h = sha256(concatBytes(this.h, data));
  }

  /** (ck, temp_k) = HKDF(ck, ikm, 2); k = temp_k; n = 0. */
  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = noiseHkdf2(this.ck, ikm);
    this.ck = ck;
    this.cipher = CipherState.withKey(tempK);
  }

  /** (ck, temp_h, temp_k) = HKDF(ck, ikm, 3); MixHash(temp_h); k = temp_k. */
  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, tempK] = noiseHkdf3(this.ck, ikm);
    this.ck = ck;
    this.mixHash(tempH);
    this.cipher = CipherState.withKey(tempK);
  }

  getHandshakeHash(): Uint8Array {
    return this.h.slice();
  }

  /**
   * EncryptAndHash with **empty AAD**.
   *
   * Rust FIPS deviates from the Noise spec here: the spec says AAD = h, but
   * `fips-core::noise::SymmetricState::encrypt_and_hash` calls
   * `cipher.encrypt(plaintext)` which uses empty AAD. We match that for
   * byte-for-byte interop. Transcript integrity is still preserved by the
   * subsequent MixHash(ciphertext).
   */
  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cipher.encryptWithAd(EMPTY_BYTES, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cipher.decryptWithAd(EMPTY_BYTES, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  /** (k1, k2) = HKDF(ck, b"", 2). Returns two fresh CipherStates. */
  split(): [CipherState, CipherState] {
    const [k1, k2] = noiseHkdf2(this.ck, EMPTY_BYTES);
    return [CipherState.withKey(k1), CipherState.withKey(k2)];
  }

  cipherHasKey(): boolean {
    return this.cipher.hasKey();
  }
}
