/**
 * Noise-spec HKDF chain (RFC 5869 with chained HMAC outputs).
 *
 *   temp_key = HMAC-HASH(chaining_key, input_key_material)   // PRK
 *   output1  = HMAC-HASH(temp_key, 0x01)
 *   output2  = HMAC-HASH(temp_key, output1 || 0x02)
 *   output3  = HMAC-HASH(temp_key, output2 || 0x03)
 *
 * Returns 2 or 3 outputs depending on `numOutputs`.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

import { concatBytes } from "../codec/hex.js";

export function noiseHkdf2(
  chainingKey: Uint8Array,
  ikm: Uint8Array,
): [Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, chainingKey, ikm);
  const out1 = hmac(sha256, tempKey, new Uint8Array([0x01]));
  const out2 = hmac(sha256, tempKey, concatBytes(out1, new Uint8Array([0x02])));
  return [out1, out2];
}

export function noiseHkdf3(
  chainingKey: Uint8Array,
  ikm: Uint8Array,
): [Uint8Array, Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, chainingKey, ikm);
  const out1 = hmac(sha256, tempKey, new Uint8Array([0x01]));
  const out2 = hmac(sha256, tempKey, concatBytes(out1, new Uint8Array([0x02])));
  const out3 = hmac(sha256, tempKey, concatBytes(out2, new Uint8Array([0x03])));
  return [out1, out2, out3];
}
