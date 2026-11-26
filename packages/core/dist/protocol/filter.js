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
import { readU64le, writeU64le } from "../codec/binary.js";
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
function writeFilterAnnounceBody(out, offset, fa) {
    if (fa.filter.numBytes !== expectedFilterBytes(fa.sizeClass)) {
        throw new Error(`filter size ${fa.filter.numBytes} doesn't match size_class ${fa.sizeClass}`);
    }
    if (fa.hashCount !== fa.filter.hashCount) {
        throw new Error(`hash_count ${fa.hashCount} doesn't match filter.hashCount ${fa.filter.hashCount}`);
    }
    writeU64le(out, offset, fa.sequence);
    out[offset + 8] = fa.hashCount & 0xff;
    out[offset + 9] = fa.sizeClass & 0xff;
    fa.filter.copyInto(out, offset + 10);
}
/** Encode payload without the leading msg_type byte. */
export function encodeFilterAnnouncePayload(fa) {
    const out = new Uint8Array(FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE + fa.filter.numBytes);
    writeFilterAnnounceBody(out, 0, fa);
    return out;
}
/** Encode including the leading msg_type byte. */
export function encodeFilterAnnounce(fa) {
    const out = new Uint8Array(1 + FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE + fa.filter.numBytes);
    out[0] = LinkMessageType.FilterAnnounce;
    writeFilterAnnounceBody(out, 1, fa);
    return out;
}
/** Decode FilterAnnounce payload (without leading msg_type byte). */
export function decodeFilterAnnouncePayload(payload) {
    if (payload.length < FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE) {
        throw new Error(`FilterAnnounce too short: ${payload.length} < ${FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE}`);
    }
    const sequence = readU64le(payload, 0);
    const hashCount = payload[8];
    const sizeClass = payload[9];
    const filterLen = expectedFilterBytes(sizeClass);
    const remaining = payload.length - FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE;
    if (remaining < filterLen) {
        throw new Error(`FilterAnnounce truncated: need ${filterLen} filter bytes, have ${remaining}`);
    }
    const filter = BloomFilter.fromBytes(payload.subarray(FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE, FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE + filterLen), hashCount);
    return { filter, sequence, hashCount, sizeClass };
}
/**
 * Decode from a buffer that includes the leading msg_type byte. Rejects
 * unknown size_class or truncated payloads.
 */
export function decodeFilterAnnounce(buf) {
    if (buf.length < 1 + FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE) {
        throw new Error(`FilterAnnounce too short: ${buf.length} < ${1 + FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE}`);
    }
    if (buf[0] !== LinkMessageType.FilterAnnounce) {
        throw new Error(`not a FilterAnnounce (msg_type=0x${buf[0].toString(16)})`);
    }
    return decodeFilterAnnouncePayload(buf.subarray(1));
}
//# sourceMappingURL=filter.js.map