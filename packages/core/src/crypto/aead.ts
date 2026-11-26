import { chacha20poly1305 } from "@noble/ciphers/chacha";

import { writeU64le } from "../codec/binary.js";

const scratchNonce = new Uint8Array(12);

function writeNonceInto(target: Uint8Array, counter: bigint): Uint8Array {
  if (typeof counter !== "bigint") throw new TypeError("u64le expects bigint");
  if (counter < 0n || counter > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`u64 out of range: ${counter}`);
  }
  writeU64le(target, 4, counter);
  return target;
}

/**
 * Build the 12-byte ChaCha20-Poly1305 nonce per FIPS spec:
 *   4 bytes zero || 8 bytes LE counter
 */
export function noiseNonce(counter: bigint): Uint8Array {
  return writeNonceInto(new Uint8Array(12), counter);
}

/** AEAD seal returning ciphertext || 16-byte tag. */
export function aeadSeal(
  key: Uint8Array,
  counter: bigint,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== 32) throw new Error("AEAD key must be 32 bytes");
  return chacha20poly1305(key, writeNonceInto(scratchNonce, counter), aad).encrypt(plaintext);
}

/** AEAD seal writing ciphertext || 16-byte tag directly into `output` (supports in-place). */
export function aeadSealInto(
  key: Uint8Array,
  counter: bigint,
  plaintext: Uint8Array,
  aad: Uint8Array,
  output: Uint8Array,
): void {
  if (key.length !== 32) throw new Error("AEAD key must be 32 bytes");
  chacha20poly1305(key, writeNonceInto(scratchNonce, counter), aad).encrypt(plaintext, output);
}

export function aeadOpen(
  key: Uint8Array,
  counter: bigint,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== 32) throw new Error("AEAD key must be 32 bytes");
  return chacha20poly1305(key, writeNonceInto(scratchNonce, counter), aad).decrypt(ciphertext);
}
