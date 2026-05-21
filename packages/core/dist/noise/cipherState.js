/**
 * Noise CipherState — ChaCha20-Poly1305 with the FIPS nonce convention
 * (4 zero bytes || u64 LE counter). Empty key disables encryption (passthrough).
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { noiseNonce } from "../crypto/aead.js";
export class CipherState {
    key = null;
    n = 0n;
    static withKey(key) {
        if (key.length !== 32)
            throw new Error("ChaChaPoly key must be 32 bytes");
        const cs = new CipherState();
        cs.key = key;
        cs.n = 0n;
        return cs;
    }
    hasKey() {
        return this.key !== null;
    }
    /** Encrypt with AEAD; advance nonce. */
    encryptWithAd(ad, plaintext) {
        if (!this.key)
            return plaintext;
        const ct = chacha20poly1305(this.key, noiseNonce(this.n), ad).encrypt(plaintext);
        this.n += 1n;
        return ct;
    }
    decryptWithAd(ad, ciphertext) {
        if (!this.key)
            return ciphertext;
        const pt = chacha20poly1305(this.key, noiseNonce(this.n), ad).decrypt(ciphertext);
        this.n += 1n;
        return pt;
    }
    rekey() {
        if (!this.key)
            return;
        // Noise rekey: encrypt 32 zero bytes with max nonce, take first 32 bytes.
        const maxNonce = new Uint8Array(12).fill(0xff);
        const cipher = chacha20poly1305(this.key, maxNonce, new Uint8Array());
        const out = cipher.encrypt(new Uint8Array(32));
        this.key = out.subarray(0, 32);
    }
    get nonce() {
        return this.n;
    }
    /**
     * Return the 32-byte cipher key. FIPS Established frames index AEAD nonces
     * by an explicit u64 counter (carried in the frame header) rather than the
     * Noise-spec monotonic nonce, so the transport layer reaches for the key
     * directly.
     */
    getKey() {
        if (!this.key)
            throw new Error("CipherState has no key");
        return this.key;
    }
}
//# sourceMappingURL=cipherState.js.map