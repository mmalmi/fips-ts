/**
 * NIP-19 npub / nsec encoding (bech32 of 32-byte x-only pubkey / secret key).
 *
 * Matches Rust `fips-identity::encoding`:
 *   - HRP "npub" for public keys
 *   - HRP "nsec" for secret keys
 *   - data is 32 raw bytes converted to 5-bit groups (no extra prefix bytes)
 */

import { bech32 } from "@scure/base";

import { fromHex, toHex } from "../codec/hex.js";

const NPUB_HRP = "npub";
const NSEC_HRP = "nsec";

export class NpubError extends Error {}

function encodeBytes(hrp: string, bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new NpubError(`expected 32-byte payload, got ${bytes.length}`);
  }
  const words = bech32.toWords(bytes);
  return bech32.encode(hrp, words, 1023);
}

function decodeBytes(hrp: string, encoded: string): Uint8Array {
  const decoded = bech32.decode(encoded as `${string}1${string}`, 1023);
  if (decoded.prefix !== hrp) {
    throw new NpubError(`expected HRP "${hrp}", got "${decoded.prefix}"`);
  }
  const bytes = bech32.fromWords(decoded.words);
  if (bytes.length !== 32) {
    throw new NpubError(`expected 32 bytes, decoded ${bytes.length}`);
  }
  return new Uint8Array(bytes);
}

/** Encode a 32-byte x-only public key as NIP-19 npub. */
export function encodeNpub(xOnlyPubkey: Uint8Array): string {
  return encodeBytes(NPUB_HRP, xOnlyPubkey);
}

/** Decode an npub to its 32-byte x-only public key. */
export function decodeNpub(npub: string): Uint8Array {
  return decodeBytes(NPUB_HRP, npub);
}

/** Encode a 32-byte secret key as NIP-19 nsec. */
export function encodeNsec(secretKey: Uint8Array): string {
  return encodeBytes(NSEC_HRP, secretKey);
}

/** Decode an nsec to its 32-byte secret key. */
export function decodeNsec(nsec: string): Uint8Array {
  return decodeBytes(NSEC_HRP, nsec);
}

// Convenience: accept x-only as hex or bytes.
export function npubFromHex(hex: string): string {
  return encodeNpub(fromHex(hex));
}

export function npubToHex(npub: string): string {
  return toHex(decodeNpub(npub));
}
