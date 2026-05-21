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
export declare const DEFAULT_FILTER_SIZE_BITS = 8192;
export declare const DEFAULT_HASH_COUNT = 5;
/** Rust SIZE_CLASS_BYTES: matches v1 fixed sizes [512, 1024, 2048, 4096]. */
export declare const SIZE_CLASS_BYTES: readonly [512, 1024, 2048, 4096];
export declare class BloomError extends Error {
}
export declare class BloomFilter {
    private readonly bits;
    readonly numBits: number;
    readonly hashCount: number;
    private constructor();
    /** New empty filter with default parameters (8192 bits, 5 hashes). */
    static empty(): BloomFilter;
    static withParams(numBits: number, hashCount: number): BloomFilter;
    /** Build a filter from existing wire bytes + the hash_count tag. */
    static fromBytes(bytes: Uint8Array, hashCount: number): BloomFilter;
    /** Insert raw bytes (e.g. a 16-byte NodeAddr). */
    insertBytes(data: Uint8Array): void;
    /** Probabilistic membership: false ⇒ definitely absent; true ⇒ probably present. */
    containsBytes(data: Uint8Array): boolean;
    /** In-place OR with another same-sized filter. */
    merge(other: BloomFilter): void;
    /** Return a fresh filter = self ∪ other. */
    union(other: BloomFilter): BloomFilter;
    clear(): void;
    countOnes(): number;
    fillRatio(): number;
    isEmpty(): boolean;
    asBytes(): Uint8Array;
    get numBytes(): number;
    /** Rust-compatible: h1 = LE u64 from SHA-256[0..8]; h2 = LE u64 from SHA-256[8..16]. */
    private hash;
    private setBit;
    private getBit;
}
//# sourceMappingURL=index.d.ts.map