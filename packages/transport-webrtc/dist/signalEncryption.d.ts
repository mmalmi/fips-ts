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
import { type FipsIdentity } from "@fips/core";
export declare function encryptSignalContent(identity: FipsIdentity, recipientXOnlyHex: string, plaintext: string): string;
export declare function decryptSignalContent(identity: FipsIdentity, senderXOnlyHex: string, content: string): string;
//# sourceMappingURL=signalEncryption.d.ts.map