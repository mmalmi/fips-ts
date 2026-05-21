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
import { BinaryReader, BinaryWriter } from "../codec/binary.js";
import { BloomFilter, SIZE_CLASS_BYTES } from "../bloom/index.js";
import { LinkMessageType } from "./link.js";
export const V1_SIZE_CLASS = 1;
/** Payload bytes between msg_type and filter_bits = sequence(8) + hash_count(1) + size_class(1). */
export const FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE = 10;
function expectedFilterBytes(sizeClass) {
    if (sizeClass !== V1_SIZE_CLASS) {
        throw new Error(`unsupported size_class ${sizeClass}; v1 requires ${V1_SIZE_CLASS}`);
    }
    return SIZE_CLASS_BYTES[sizeClass];
}
/**
 * Build a v1 FilterAnnounce wrapping `filter`. The filter MUST have the v1
 * size (1024 bytes / 8192 bits).
 */
export function buildFilterAnnounce(filter, sequence) {
    if (filter.numBytes !== expectedFilterBytes(V1_SIZE_CLASS)) {
        throw new Error(`v1 FilterAnnounce requires ${expectedFilterBytes(V1_SIZE_CLASS)}-byte filter (got ${filter.numBytes})`);
    }
    return {
        filter,
        sequence,
        hashCount: filter.hashCount,
        sizeClass: V1_SIZE_CLASS,
    };
}
/** Encode including the leading msg_type byte. */
export function encodeFilterAnnounce(fa) {
    if (fa.filter.numBytes !== expectedFilterBytes(fa.sizeClass)) {
        throw new Error(`filter size ${fa.filter.numBytes} doesn't match size_class ${fa.sizeClass}`);
    }
    if (fa.hashCount !== fa.filter.hashCount) {
        throw new Error(`hash_count ${fa.hashCount} doesn't match filter.hashCount ${fa.filter.hashCount}`);
    }
    const w = new BinaryWriter();
    w.u8(LinkMessageType.FilterAnnounce);
    w.u64le(fa.sequence);
    w.u8(fa.hashCount);
    w.u8(fa.sizeClass);
    w.bytes(fa.filter.asBytes());
    return w.toBytes();
}
/**
 * Decode from a buffer that includes the leading msg_type byte. Rejects
 * unknown size_class or truncated payloads.
 */
export function decodeFilterAnnounce(buf) {
    if (buf.length < 1 + FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE) {
        throw new Error(`FilterAnnounce too short: ${buf.length} < ${1 + FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE}`);
    }
    const r = new BinaryReader(buf);
    const msgType = r.u8();
    if (msgType !== LinkMessageType.FilterAnnounce) {
        throw new Error(`not a FilterAnnounce (msg_type=0x${msgType.toString(16)})`);
    }
    const sequence = r.u64le();
    const hashCount = r.u8();
    const sizeClass = r.u8();
    const filterLen = expectedFilterBytes(sizeClass);
    if (r.remaining < filterLen) {
        throw new Error(`FilterAnnounce truncated: need ${filterLen} filter bytes, have ${r.remaining}`);
    }
    const filterBytes = r.bytes(filterLen);
    const filter = BloomFilter.fromBytes(filterBytes, hashCount);
    return { filter, sequence, hashCount, sizeClass };
}
//# sourceMappingURL=filter.js.map