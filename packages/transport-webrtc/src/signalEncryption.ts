/**
 * Encryption envelope for FIPS signaling content.
 *
 * The format chosen here is binary-safe and conveys: (1) the sender's
 * ephemeral perception of the recipient, (2) the ciphertext, (3) the AEAD
 * tag, (4) a fresh nonce.
 *
 *   base64( nonce(12) || ciphertext_and_tag )
 *
 * Key derivation: HKDF-SHA256 over secp256k1 ECDH(x-only) with a fixed info
 * string "fips/signaling/v1" and zero salt. Recipient identity is implied by
 * the outer event `["p", recipient_xonly_hex]` tag.
 *
 * This is not strictly NIP-44 (NIP-44 uses HMAC + padding). v2 task: swap in
 * a NIP-44 v2 implementation to interop with general Nostr clients.
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/hashes/utils";

import { concatBytes, ecdh, fromHex, hkdfDerive, toHex, type FipsIdentity } from "@fips/core";

const INFO = new TextEncoder().encode("fips/signaling/v1");

function deriveSymKey(
  identity: FipsIdentity,
  remoteXOnlyPubkeyHex: string,
): Uint8Array {
  if (remoteXOnlyPubkeyHex.length !== 64) {
    throw new Error("remote pubkey must be 32-byte x-only hex");
  }
  // Build a compressed 0x02|x pubkey to feed ECDH (we lose the parity bit
  // since x-only is what Nostr uses; both endpoints reconstruct the same
  // x-coord, which is what ECDH compresses to anyway).
  const remoteCompressed = concatBytes(new Uint8Array([0x02]), fromHex(remoteXOnlyPubkeyHex));
  const shared = ecdh(identity.secretKey, remoteCompressed);
  return hkdfDerive(shared, new Uint8Array(0), INFO, 32);
}

export function encryptSignalContent(
  identity: FipsIdentity,
  recipientXOnlyPubkeyHex: string,
  plaintext: string,
): string {
  const key = deriveSymKey(identity, recipientXOnlyPubkeyHex);
  const nonce = randomBytes(12);
  const ct = chacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(plaintext));
  return base64Encode(concatBytes(nonce, ct));
}

export function decryptSignalContent(
  identity: FipsIdentity,
  senderXOnlyPubkeyHex: string,
  content: string,
): string {
  const key = deriveSymKey(identity, senderXOnlyPubkeyHex);
  const decoded = base64Decode(content);
  if (decoded.length < 12 + 16) throw new Error("ciphertext too short");
  const nonce = decoded.slice(0, 12);
  const ct = decoded.slice(12);
  const plaintext = chacha20poly1305(key, nonce).decrypt(ct);
  return new TextDecoder().decode(plaintext);
}

function base64Encode(b: Uint8Array): string {
  if (typeof btoa === "function") {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  return Buffer.from(b).toString("base64");
}

function base64Decode(s: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

void toHex; // keep import available
