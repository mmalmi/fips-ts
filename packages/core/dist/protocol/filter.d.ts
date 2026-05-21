/**
 * FilterAnnounce — link-layer bloom-filter advertisement.
 *
 * Mirrors Rust `~/src/fips/crates/fips-core/src/protocol/filter.rs`.
 *
 * Wire format (after the leading `msg_type=0x20` byte):
 *   [sequence:8 LE][hash_count:1][size_class:1][filter_bytes:N]
 *
 * `size_class=1` (V1) ⇒ N = 1024 bytes filter (= 8192 bits).
 */
import { BloomFilter } from "../bloom/index.js";
export declare const V1_SIZE_CLASS = 1;
/** Payload bytes between msg_type and filter_bits = sequence(8) + hash_count(1) + size_class(1). */
export declare const FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE = 10;
export interface FilterAnnounce {
    filter: BloomFilter;
    sequence: bigint;
    hashCount: number;
    sizeClass: number;
}
/**
 * Build a v1 FilterAnnounce wrapping `filter`. The filter MUST have the v1
 * size (1024 bytes / 8192 bits).
 */
export declare function buildFilterAnnounce(filter: BloomFilter, sequence: bigint): FilterAnnounce;
/** Encode including the leading msg_type byte. */
export declare function encodeFilterAnnounce(fa: FilterAnnounce): Uint8Array;
/**
 * Decode from a buffer that includes the leading msg_type byte. Rejects
 * unknown size_class or truncated payloads.
 */
export declare function decodeFilterAnnounce(buf: Uint8Array): FilterAnnounce;
//# sourceMappingURL=filter.d.ts.map