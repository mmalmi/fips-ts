import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

import { concatBytes } from "../codec/hex.js";

/** HKDF-SHA256 with one-byte info, returning `len` bytes. */
export function hkdfDerive(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  len: number,
): Uint8Array {
  return hkdf(sha256, ikm, salt, info, len);
}

/**
 * Symmetric, deterministic derivation of (initiator_key, responder_key) given
 * a shared secret. Both peers MUST compute the same byte order for "initiator
 * pubkey" so that the order of inputs is canonical.
 *
 * - `sharedSecret`: 32 bytes (ECDH x-coord).
 * - `initiatorPub`, `responderPub`: 32-byte x-only pubkeys (BIP-340 form).
 * - `info`: context string distinguishing "fmp" vs "fsp" usage.
 */
export function deriveSessionKeys(
  sharedSecret: Uint8Array,
  initiatorPub: Uint8Array,
  responderPub: Uint8Array,
  info: string,
): { initiatorTx: Uint8Array; responderTx: Uint8Array } {
  const salt = concatBytes(initiatorPub, responderPub);
  const out = hkdfDerive(sharedSecret, salt, new TextEncoder().encode(info), 64);
  return {
    initiatorTx: out.subarray(0, 32),
    responderTx: out.subarray(32, 64),
  };
}
