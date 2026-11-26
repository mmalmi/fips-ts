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
import { readU32le, readU64le } from "../codec/binary.js";
import { bytesEqual } from "../codec/hex.js";
export const DEFAULT_FILTER_SIZE_BITS = 8192;
export const DEFAULT_HASH_COUNT = 5;
/** Rust SIZE_CLASS_BYTES: matches v1 fixed sizes [512, 1024, 2048, 4096]. */
export const SIZE_CLASS_BYTES = [512, 1024, 2048, 4096];
export class BloomError extends Error {
}
export class BloomFilter {
    bits;
    bitMask;
    numBits;
    hashCount;
    constructor(bits, numBits, hashCount) {
        this.bits = bits;
        this.numBits = numBits;
        this.hashCount = hashCount;
        this.bitMask = (numBits & (numBits - 1)) === 0 && numBits <= 0x4000_0000 ? numBits - 1 : 0;
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
        this.probe(data, true);
    }
    /** Probabilistic membership: false ⇒ definitely absent; true ⇒ probably present. */
    containsBytes(data) {
        return this.probe(data, false);
    }
    /** In-place OR with another same-sized filter. */
    merge(other) {
        if (this.numBits !== other.numBits) {
            throw new BloomError(`filter size mismatch: ${this.numBits} vs ${other.numBits}`);
        }
        if ((this.bits.length & 3) === 0 && (this.bits.byteOffset & 3) === 0 && (other.bits.byteOffset & 3) === 0) {
            const a = new Uint32Array(this.bits.buffer, this.bits.byteOffset, this.bits.length >>> 2);
            const b = new Uint32Array(other.bits.buffer, other.bits.byteOffset, other.bits.length >>> 2);
            for (let i = 0; i < a.length; i++)
                a[i] |= b[i];
            return;
        }
        for (let i = 0; i < this.bits.length; i++)
            this.bits[i] |= other.bits[i];
    }
    /** Return a fresh copy of this filter. */
    clone() {
        return new BloomFilter(new Uint8Array(this.bits), this.numBits, this.hashCount);
    }
    /** Return a fresh filter = self ∪ other. */
    union(other) {
        const out = this.clone();
        out.merge(other);
        return out;
    }
    equals(other) {
        return this.hashCount === other.hashCount && bytesEqual(this.bits, other.bits);
    }
    clear() {
        this.bits.fill(0);
    }
    countOnes() {
        let count = 0;
        if ((this.bits.length & 3) === 0 && (this.bits.byteOffset & 3) === 0) {
            const words = new Uint32Array(this.bits.buffer, this.bits.byteOffset, this.bits.length >>> 2);
            for (let i = 0; i < words.length; i++) {
                let v = words[i];
                if (v === 0)
                    continue;
                v -= (v >>> 1) & 0x55555555;
                v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
                count += Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
            }
            return count;
        }
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
    /** Rust-compatible: h1 = LE u64 from SHA-256[0..8]; h2 = LE u64 from SHA-256[8..16]. */
    probe(data, insert) {
        const digest = sha256(data);
        if (this.bitMask !== 0) {
            const mask = this.bitMask;
            let idx = readU32le(digest, 0) & mask;
            const step = readU32le(digest, 8) & mask;
            for (let k = 0; k < this.hashCount; k++) {
                if (insert)
                    this.bits[idx >>> 3] |= 1 << (idx & 7);
                else if ((this.bits[idx >>> 3] & (1 << (idx & 7))) === 0)
                    return false;
                idx = (idx + step) & mask;
            }
            return true;
        }
        let h = readU64le(digest, 0);
        const h2 = readU64le(digest, 8);
        const mod = BigInt(this.numBits);
        for (let k = 0; k < this.hashCount; k++) {
            const idx = Number(h % mod);
            if (insert)
                this.bits[idx >>> 3] |= 1 << (idx & 7);
            else if ((this.bits[idx >>> 3] & (1 << (idx & 7))) === 0)
                return false;
            h = (h + h2) & 0xffffffffffffffffn;
        }
        return true;
    }
}
//# sourceMappingURL=index.js.map