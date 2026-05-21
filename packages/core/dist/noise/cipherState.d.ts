/**
 * Noise CipherState — ChaCha20-Poly1305 with the FIPS nonce convention
 * (4 zero bytes || u64 LE counter). Empty key disables encryption (passthrough).
 */
export declare class CipherState {
    private key;
    private n;
    static withKey(key: Uint8Array): CipherState;
    hasKey(): boolean;
    /** Encrypt with AEAD; advance nonce. */
    encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
    decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
    rekey(): void;
    get nonce(): bigint;
    /**
     * Return the 32-byte cipher key. FIPS Established frames index AEAD nonces
     * by an explicit u64 counter (carried in the frame header) rather than the
     * Noise-spec monotonic nonce, so the transport layer reaches for the key
     * directly.
     */
    getKey(): Uint8Array;
}
//# sourceMappingURL=cipherState.d.ts.map