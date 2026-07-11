/**
 * NIP-44 v2 wrapper for FIPS WebRTC signaling content.
 *
 * NIP-44 v2 (https://github.com/nostr-protocol/nips/blob/master/44.md):
 *   conversation_key = HKDF-SHA256(shared_x, salt="nip44-v2", info=null)[..32]
 *   payload          = base64(0x02 || nonce(32) || ciphertext || hmac(32))
 *   cipher           = ChaCha20 (no Poly), MAC = HMAC-SHA256 over nonce||ct
 *
 * We use `nostr-tools/nip44` for the implementation, which matches the
 * reference vectors. The conversation key is derived once per (us, peer) and
 * cached for the lifetime of the transport.
 *
 * The Nostr `pubkey` argument is the 32-byte x-only hex (not the 33-byte
 * compressed key FIPS uses internally).
 */

import { v2 as nip44v2 } from "nostr-tools/nip44";

import type { FipsIdentity } from "@fips/core";

const conversationKeyCache = new WeakMap<FipsIdentity, Map<string, Uint8Array>>();

function getConversationKey(
  identity: FipsIdentity,
  peerXOnlyHex: string,
): Uint8Array {
  let cache = conversationKeyCache.get(identity);
  if (!cache) {
    cache = new Map();
    conversationKeyCache.set(identity, cache);
  }
  const cached = cache.get(peerXOnlyHex);
  if (cached) return cached;
  if (peerXOnlyHex.length !== 64) {
    throw new Error("NIP-44 peer pubkey must be 32-byte x-only hex");
  }
  const ck = nip44v2.utils.getConversationKey(identity.secretKey, peerXOnlyHex);
  cache.set(peerXOnlyHex, ck);
  return ck;
}

export function encryptSignalContent(
  identity: FipsIdentity,
  recipientXOnlyHex: string,
  plaintext: string,
): string {
  const ck = getConversationKey(identity, recipientXOnlyHex);
  return nip44v2.encrypt(plaintext, ck);
}

export function decryptSignalContent(
  identity: FipsIdentity,
  senderXOnlyHex: string,
  content: string,
): string {
  const ck = getConversationKey(identity, senderXOnlyHex);
  return nip44v2.decrypt(content, ck);
}
