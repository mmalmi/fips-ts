/**
 * Noise SymmetricState (h, ck, k, n) — RFC: https://noiseprotocol.org/noise.html
 *
 * Operates with SHA-256 (HASHLEN = 32, BLOCKLEN = 64) and ChaCha20-Poly1305
 * (KEYLEN = 32, TAGLEN = 16).
 */
import { CipherState } from "./cipherState.js";
export declare class SymmetricState {
    private h;
    private ck;
    private cipher;
    constructor(protocolName: string);
    /** h = HASH(h || data). */
    mixHash(data: Uint8Array): void;
    /** (ck, temp_k) = HKDF(ck, ikm, 2); k = temp_k; n = 0. */
    mixKey(ikm: Uint8Array): void;
    /** (ck, temp_h, temp_k) = HKDF(ck, ikm, 3); MixHash(temp_h); k = temp_k. */
    mixKeyAndHash(ikm: Uint8Array): void;
    getHandshakeHash(): Uint8Array;
    /**
     * EncryptAndHash with **empty AAD**.
     *
     * Rust FIPS deviates from the Noise spec here: the spec says AAD = h, but
     * `fips-core::noise::SymmetricState::encrypt_and_hash` calls
     * `cipher.encrypt(plaintext)` which uses empty AAD. We match that for
     * byte-for-byte interop. Transcript integrity is still preserved by the
     * subsequent MixHash(ciphertext).
     */
    encryptAndHash(plaintext: Uint8Array): Uint8Array;
    decryptAndHash(ciphertext: Uint8Array): Uint8Array;
    /** (k1, k2) = HKDF(ck, b"", 2). Returns two fresh CipherStates. */
    split(): [CipherState, CipherState];
    cipherHasKey(): boolean;
}
//# sourceMappingURL=symmetricState.d.ts.map