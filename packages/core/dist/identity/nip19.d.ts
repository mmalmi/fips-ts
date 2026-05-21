/**
 * NIP-19 npub / nsec encoding (bech32 of 32-byte x-only pubkey / secret key).
 *
 * Matches Rust `fips-identity::encoding`:
 *   - HRP "npub" for public keys
 *   - HRP "nsec" for secret keys
 *   - data is 32 raw bytes converted to 5-bit groups (no extra prefix bytes)
 */
export declare class NpubError extends Error {
}
/** Encode a 32-byte x-only public key as NIP-19 npub. */
export declare function encodeNpub(xOnlyPubkey: Uint8Array): string;
/** Decode an npub to its 32-byte x-only public key. */
export declare function decodeNpub(npub: string): Uint8Array;
/** Encode a 32-byte secret key as NIP-19 nsec. */
export declare function encodeNsec(secretKey: Uint8Array): string;
/** Decode an nsec to its 32-byte secret key. */
export declare function decodeNsec(nsec: string): Uint8Array;
export declare function npubFromHex(hex: string): string;
export declare function npubToHex(npub: string): string;
//# sourceMappingURL=nip19.d.ts.map