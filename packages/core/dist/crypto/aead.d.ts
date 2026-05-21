/**
 * Build the 12-byte ChaCha20-Poly1305 nonce per FIPS spec:
 *   4 bytes zero || 8 bytes LE counter
 */
export declare function noiseNonce(counter: bigint): Uint8Array;
/** AEAD seal returning ciphertext || 16-byte tag. */
export declare function aeadSeal(key: Uint8Array, counter: bigint, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
export declare function aeadOpen(key: Uint8Array, counter: bigint, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;
//# sourceMappingURL=aead.d.ts.map