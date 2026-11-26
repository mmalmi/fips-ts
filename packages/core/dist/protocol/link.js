/**
 * FMP link-layer message-type registry + small wire codecs.
 *
 * Mirrors Rust ~/src/fips/crates/fips-core/src/protocol/link.rs. This is the
 * msg_type byte that appears at the head of the FMP inner-plaintext payload
 * (after AEAD decrypt), distinguishing forwarded session datagrams from
 * link-control messages.
 */
import { readU16le, writeU16le } from "../codec/binary.js";
import { EXTENSION_LINK_MESSAGE_TYPE } from "./extensions.js";
export const HandshakeMessageType = {
    NoiseIKMsg1: 0x01,
    NoiseIKMsg2: 0x02,
};
export function handshakeMessageTypeFromByte(b) {
    if (b === 0x01 || b === 0x02)
        return b;
    return undefined;
}
export function isHandshakeMessageType(b) {
    return b === 0x01 || b === 0x02;
}
export const LinkMessageType = {
    // Forwarding (0x00-0x0F)
    SessionDatagram: 0x00,
    // MMP reports (0x01-0x02)
    SenderReport: 0x01,
    ReceiverReport: 0x02,
    // Tree protocol (0x10-0x1F)
    TreeAnnounce: 0x10,
    // Bloom filter (0x20-0x2F)
    FilterAnnounce: 0x20,
    // Discovery (0x30-0x3F)
    LookupRequest: 0x30,
    LookupResponse: 0x31,
    // Link Control (0x50-0x5F)
    Disconnect: 0x50,
    Heartbeat: 0x51,
    // Legacy private hints: require an authenticated empty ClientSupport first.
    ClientOnly: 0x52,
    ClientSupport: 0x53,
    Extension: EXTENSION_LINK_MESSAGE_TYPE,
};
const LINK_MESSAGE_TYPE_BYTES = new Set([
    LinkMessageType.SessionDatagram,
    LinkMessageType.SenderReport,
    LinkMessageType.ReceiverReport,
    LinkMessageType.TreeAnnounce,
    LinkMessageType.FilterAnnounce,
    LinkMessageType.LookupRequest,
    LinkMessageType.LookupResponse,
    LinkMessageType.Disconnect,
    LinkMessageType.Heartbeat,
    LinkMessageType.ClientOnly,
    LinkMessageType.ClientSupport,
    LinkMessageType.Extension,
]);
export function linkMessageTypeFromByte(b) {
    return LINK_MESSAGE_TYPE_BYTES.has(b) ? b : undefined;
}
export const DisconnectReason = {
    Shutdown: 0x00,
    Restart: 0x01,
    ProtocolError: 0x02,
    TransportFailure: 0x03,
    ResourceExhaustion: 0x04,
    SecurityViolation: 0x05,
    Other: 0xff,
};
const DISCONNECT_REASON_BYTES = new Set([
    DisconnectReason.Shutdown,
    DisconnectReason.Restart,
    DisconnectReason.ProtocolError,
    DisconnectReason.TransportFailure,
    DisconnectReason.ResourceExhaustion,
    DisconnectReason.SecurityViolation,
    DisconnectReason.Other,
]);
/** Returns a known reason byte or `Other` (0xff) for unknown bytes — matches Rust. */
export function disconnectReasonFromByte(b) {
    return DISCONNECT_REASON_BYTES.has(b) ? b : DisconnectReason.Other;
}
/** Encode a Disconnect message as the 2-byte link payload `[type=0x50][reason]`. */
export function encodeDisconnect(d) {
    return new Uint8Array([LinkMessageType.Disconnect, d.reason & 0xff]);
}
/**
 * Decode the *payload after the msg_type byte* (matching Rust's
 * `Disconnect::decode`).
 */
export function decodeDisconnect(payload) {
    if (payload.length < 1) {
        throw new Error("Disconnect payload must be at least 1 byte");
    }
    return { reason: disconnectReasonFromByte(payload[0]) };
}
export const SESSION_DATAGRAM_HEADER_SIZE = 36;
function writeSessionDatagramFields(out, offset, d) {
    if (d.srcAddr.length !== 16)
        throw new Error("src_addr must be 16 bytes");
    if (d.destAddr.length !== 16)
        throw new Error("dest_addr must be 16 bytes");
    out[offset] = d.ttl & 0xff;
    writeU16le(out, offset + 1, d.pathMtu);
    out.set(d.srcAddr, offset + 3);
    out.set(d.destAddr, offset + 19);
    out.set(d.payload, offset + 35);
    return out;
}
export function encodeSessionDatagramPayload(d) {
    return writeSessionDatagramFields(new Uint8Array(SESSION_DATAGRAM_HEADER_SIZE - 1 + d.payload.length), 0, d);
}
export function encodeSessionDatagram(d) {
    const out = new Uint8Array(SESSION_DATAGRAM_HEADER_SIZE + d.payload.length);
    out[0] = LinkMessageType.SessionDatagram;
    return writeSessionDatagramFields(out, 1, d);
}
/** Decode from a buffer that includes the leading msg_type byte. */
export function decodeSessionDatagram(buf) {
    if (buf.length < SESSION_DATAGRAM_HEADER_SIZE) {
        throw new Error(`SessionDatagram too short: ${buf.length} < ${SESSION_DATAGRAM_HEADER_SIZE}`);
    }
    const msgType = buf[0];
    if (msgType !== LinkMessageType.SessionDatagram) {
        throw new Error(`not a SessionDatagram (msg_type=0x${msgType.toString(16)})`);
    }
    return decodeSessionDatagramPayload(buf.subarray(1));
}
/** Zero-copy parser for internal routing hot paths. */
export function parseSessionDatagramPayload(buf) {
    if (buf.length < SESSION_DATAGRAM_HEADER_SIZE - 1) {
        throw new Error(`SessionDatagram payload too short: ${buf.length} < ${SESSION_DATAGRAM_HEADER_SIZE - 1}`);
    }
    return {
        ttl: buf[0],
        pathMtu: readU16le(buf, 1),
        srcAddr: buf.subarray(3, 19),
        destAddr: buf.subarray(19, 35),
        payload: buf.subarray(35),
    };
}
/** Decode the payload after the leading msg_type byte has already been consumed. */
export function decodeSessionDatagramPayload(buf) {
    const { ttl, pathMtu, srcAddr, destAddr, payload } = parseSessionDatagramPayload(buf);
    return { ttl, pathMtu, srcAddr: srcAddr.slice(), destAddr: destAddr.slice(), payload: payload.slice() };
}
/** Decrement TTL; returns false if it can no longer be forwarded. */
export function decrementTtl(d) {
    if (d.ttl <= 1) {
        d.ttl = 0;
        return false;
    }
    d.ttl -= 1;
    return true;
}
//# sourceMappingURL=link.js.map