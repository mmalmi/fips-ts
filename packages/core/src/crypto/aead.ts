import { chacha20poly1305 } from "@noble/ciphers/chacha";

import { BinaryWriter } from "../codec/binary.js";

/**
 * Build the 12-byte ChaCha20-Poly1305 nonce per FIPS spec:
 *   4 bytes zero || 8 bytes LE counter
 */
export function noiseNonce(counter: bigint): Uint8Array {
  const w = new BinaryWriter();
  w.bytes(new Uint8Array(4));
  w.u64le(counter);
  return w.toBytes();
}

/** AEAD seal returning ciphertext || 16-byte tag. */
export function aeadSeal(
  key: Uint8Array,
  counter: bigint,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== 32) throw new Error("AEAD key must be 32 bytes");
  return chacha20poly1305(key, noiseNonce(counter), aad).encrypt(plaintext);
}

export function aeadOpen(
  key: Uint8Array,
  counter: bigint,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== 32) throw new Error("AEAD key must be 32 bytes");
  return chacha20poly1305(key, noiseNonce(counter), aad).decrypt(ciphertext);
}
