import { sha256 } from "@noble/hashes/sha256";

import { toHex, fromHex } from "../codec/hex.js";

export const NODE_ADDR_LENGTH = 16;
export const X_ONLY_PUBKEY_LENGTH = 32;
export const COMPRESSED_PUBKEY_LENGTH = 33;

export type NodeAddr = Uint8Array;

/**
 * Derive a 16-byte FIPS NodeAddr from a secp256k1 public key.
 *
 * Compatible with Rust: SHA-256 of the 32-byte x-only public key,
 * truncated to 16 bytes.
 *
 * Accepts both compressed (33-byte, 0x02/0x03 prefix) and x-only (32-byte)
 * representations.
 */
export function deriveNodeAddr(pubkey: Uint8Array): NodeAddr {
  let xOnly: Uint8Array;
  if (pubkey.length === X_ONLY_PUBKEY_LENGTH) {
    xOnly = pubkey;
  } else if (pubkey.length === COMPRESSED_PUBKEY_LENGTH) {
    const prefix = pubkey[0];
    if (prefix !== 0x02 && prefix !== 0x03) {
      throw new Error(`invalid compressed pubkey prefix 0x${prefix.toString(16)}`);
    }
    xOnly = pubkey.subarray(1);
  } else {
    throw new Error(
      `expected 32-byte x-only or 33-byte compressed pubkey, got ${pubkey.length}`,
    );
  }
  const hash = sha256(xOnly);
  return hash.slice(0, NODE_ADDR_LENGTH);
}

export function nodeAddrToHex(addr: NodeAddr): string {
  if (addr.length !== NODE_ADDR_LENGTH) {
    throw new Error(`NodeAddr must be ${NODE_ADDR_LENGTH} bytes`);
  }
  return toHex(addr);
}

export function nodeAddrFromHex(hex: string): NodeAddr {
  const b = fromHex(hex);
  if (b.length !== NODE_ADDR_LENGTH) {
    throw new Error(`NodeAddr hex must decode to ${NODE_ADDR_LENGTH} bytes`);
  }
  return b;
}
