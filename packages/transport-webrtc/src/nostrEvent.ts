/**
 * Lightweight Nostr event builder and verifier for adverts and relay datagrams.
 * Signs with BIP-340 Schnorr. The event id is SHA-256 of the canonical
 * serialization (NIP-01).
 */

import { sha256 } from "@noble/hashes/sha256";
import { schnorr } from "@noble/curves/secp256k1";

import { toHex, type FipsIdentity } from "@fips/core";

import type { NostrEvent } from "./NostrRelayClient.js";

export interface UnsignedEvent {
  pubkey: string;       // hex x-only (32 bytes hex = 64 chars)
  created_at: number;   // unix seconds
  kind: number;
  tags: string[][];
  content: string;
}

export function serializeForId(e: UnsignedEvent): Uint8Array {
  // NIP-01: [0, pubkey, created_at, kind, tags, content]
  return new TextEncoder().encode(
    JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]),
  );
}

export function computeEventId(e: UnsignedEvent): string {
  return toHex(sha256(serializeForId(e)));
}

export function signEvent(
  identity: FipsIdentity,
  e: Omit<UnsignedEvent, "pubkey">,
): NostrEvent {
  const pubkey = toHex(identity.xOnlyPubkey);
  const unsigned: UnsignedEvent = { pubkey, ...e };
  const id = computeEventId(unsigned);
  const sig = toHex(schnorr.sign(id, identity.secretKey));
  return { id, sig, ...unsigned };
}

export function verifyEvent(e: NostrEvent): boolean {
  const id = computeEventId(e);
  if (id !== e.id) return false;
  try {
    return schnorr.verify(e.sig, e.id, e.pubkey);
  } catch {
    return false;
  }
}
