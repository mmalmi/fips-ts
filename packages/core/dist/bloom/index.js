/**
 * Probabilistic-set-membership Bloom filter.
 *
 * Wire-compatible with Rust `~/src/fips/crates/fips-core/src/bloom/filter.rs`.
 * Identical SHA-256 double-hashing: take the first 16 bytes of SHA-256(data)
 * as `h1 || h2` (each 8 bytes little-endian u64) and probe the bit array at
 * `(h1 + k * h2) mod num_bits` for `k ∈ [0, hash_count)`. The byte storage
 * is identical, so `Uint8Array` payloads can be exchanged with Rust nodes
 * 1:1 with a `hashCount` tag alongside.
 */
import { sha256 } from "@noble/hashes/sha256";
import { BinaryReader } from "../codec/binary.js";
export const DEFAULT_FILTER_SIZE_BITS = 8192;
export const DEFAULT_HASH_COUNT = 5;
/** Rust SIZE_CLASS_BYTES: matches v1 fixed sizes [512, 1024, 2048, 4096]. */
export const SIZE_CLASS_BYTES = [512, 1024, 2048, 4096];
export class BloomError extends Error {
}
export class BloomFilter {
    bits;
    numBits;
    hashCount;
    constructor(bits, numBits, hashCount) {
        this.bits = bits;
        this.numBits = numBits;
        this.hashCount = hashCount;
    }
    /** New empty filter with default parameters (8192 bits, 5 hashes). */
    static empty() {
        return BloomFilter.withParams(DEFAULT_FILTER_SIZE_BITS, DEFAULT_HASH_COUNT);
    }
    static withParams(numBits, hashCount) {
        if (numBits === 0 || numBits % 8 !== 0) {
            throw new BloomError(`numBits must be a positive multiple of 8 (got ${numBits})`);
        }
        if (hashCount <= 0 || hashCount > 0xff) {
            throw new BloomError(`hashCount must be in [1, 255] (got ${hashCount})`);
        }
        return new BloomFilter(new Uint8Array(numBits / 8), numBits, hashCount);
    }
    /** Build a filter from existing wire bytes + the hash_count tag. */
    static fromBytes(bytes, hashCount) {
        if (hashCount <= 0 || hashCount > 0xff) {
            throw new BloomError(`hashCount must be in [1, 255] (got ${hashCount})`);
        }
        if (bytes.length === 0) {
            throw new BloomError("filter bytes must be non-empty");
        }
        return new BloomFilter(new Uint8Array(bytes), bytes.length * 8, hashCount);
    }
    /** Insert raw bytes (e.g. a 16-byte NodeAddr). */
    insertBytes(data) {
        for (let k = 0; k < this.hashCount; k++) {
            this.setBit(this.hash(data, k));
        }
    }
    /** Probabilistic membership: false ⇒ definitely absent; true ⇒ probably present. */
    containsBytes(data) {
        for (let k = 0; k < this.hashCount; k++) {
            if (!this.getBit(this.hash(data, k)))
                return false;
        }
        return true;
    }
    /** In-place OR with another same-sized filter. */
    merge(other) {
        if (this.numBits !== other.numBits) {
            throw new BloomError(`filter size mismatch: ${this.numBits} vs ${other.numBits}`);
        }
        for (let i = 0; i < this.bits.length; i++)
            this.bits[i] |= other.bits[i];
    }
    /** Return a fresh filter = self ∪ other. */
    union(other) {
        const out = BloomFilter.withParams(this.numBits, this.hashCount);
        for (let i = 0; i < this.bits.length; i++) {
            out.bits[i] = this.bits[i] | other.bits[i];
        }
        return out;
    }
    clear() {
        this.bits.fill(0);
    }
    countOnes() {
        let count = 0;
        for (let i = 0; i < this.bits.length; i++) {
            let b = this.bits[i];
            while (b !== 0) {
                b &= b - 1;
                count++;
            }
        }
        return count;
    }
    fillRatio() {
        return this.countOnes() / this.numBits;
    }
    isEmpty() {
        for (let i = 0; i < this.bits.length; i++) {
            if (this.bits[i] !== 0)
                return false;
        }
        return true;
    }
    asBytes() {
        return new Uint8Array(this.bits);
    }
    get numBytes() {
        return this.bits.length;
    }
    // ---- internal hashing ----
    /** Rust-compatible: h1 = LE u64 from SHA-256[0..8]; h2 = LE u64 from SHA-256[8..16]. */
    hash(data, k) {
        const digest = sha256(data);
        const r = new BinaryReader(digest);
        const h1 = r.u64le();
        const h2 = r.u64le();
        const combined = (h1 + BigInt(k) * h2) & 0xffffffffffffffffn;
        return Number(combined % BigInt(this.numBits));
    }
    setBit(index) {
        this.bits[index >>> 3] |= 1 << (index & 7);
    }
    getBit(index) {
        return (this.bits[index >>> 3] & (1 << (index & 7))) !== 0;
    }
}
//# sourceMappingURL=index.js.map