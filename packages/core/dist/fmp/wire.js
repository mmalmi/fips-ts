/**
 * FMP wire format (matches Rust crates/fips-core/src/node/wire.rs).
 *
 * Every FMP packet starts with a 4-byte common prefix:
 *
 *   byte 0: (version << 4) | phase  (version=0, phase in {0,1,2})
 *   byte 1: flags                   (0 during handshake)
 *   byte 2-3: payload_len (u16 LE)
 *
 * Phase 0x1 (Msg1): 4 prefix + 4 sender_idx (u32 LE) + 106 noise_msg1 = 114, payload_len=110
 * Phase 0x2 (Msg2): 4 prefix + 4 sender_idx + 4 receiver_idx + 57 noise_msg2 = 69, payload_len=65
 * Phase 0x0 (Established): 4 prefix + 4 receiver_idx + 8 counter (u64 LE) + ciphertext+tag,
 * with payload_len set to the plaintext length used in AEAD AAD.
 *
 * Inner plaintext (after AEAD decrypt):
 *   4 byte timestamp (u32 LE) + 1 byte msg_type + payload
 */
import { BinaryReader, BinaryWriter } from "../codec/binary.js";
export const FMP_VERSION = 0;
export const FMP_PHASE_ESTABLISHED = 0x0;
export const FMP_PHASE_MSG1 = 0x1;
export const FMP_PHASE_MSG2 = 0x2;
export const NOISE_IK_MSG1_LEN = 106;
export const NOISE_IK_MSG2_LEN = 57;
export const FMP_MSG1_TOTAL_LEN = 4 + 4 + NOISE_IK_MSG1_LEN; // 114
export const FMP_MSG2_TOTAL_LEN = 4 + 4 + 4 + NOISE_IK_MSG2_LEN; // 69
export const FMP_ESTABLISHED_HEADER_LEN = 4 + 4 + 8; // 16
export const FMP_AEAD_TAG_LEN = 16;
/** Link-message types after the FMP timestamp header. */
export const FMP_INNER_DATA = 0x00; // LinkMessageType.SessionDatagram
export const FMP_INNER_KEEPALIVE = 0x51; // LinkMessageType.Heartbeat
export function encodeCommonPrefix(p) {
    if (p.version < 0 || p.version > 0xf)
        throw new RangeError("version 4-bit");
    if (p.phase < 0 || p.phase > 0xf)
        throw new RangeError("phase 4-bit");
    const w = new BinaryWriter();
    w.u8(((p.version & 0xf) << 4) | (p.phase & 0xf));
    w.u8(p.flags & 0xff);
    w.u16le(p.payloadLen);
    return w.toBytes();
}
export function decodeCommonPrefix(r) {
    const versionAndPhase = r.u8();
    const flags = r.u8();
    const payloadLen = r.u16le();
    return {
        version: (versionAndPhase >>> 4) & 0xf,
        phase: versionAndPhase & 0xf,
        flags,
        payloadLen,
    };
}
export function encodeFmpMsg1(m) {
    if (m.noiseMsg1.length !== NOISE_IK_MSG1_LEN) {
        throw new Error(`noise msg1 must be ${NOISE_IK_MSG1_LEN} bytes`);
    }
    const w = new BinaryWriter();
    w.bytes(encodeCommonPrefix({
        version: FMP_VERSION,
        phase: FMP_PHASE_MSG1,
        flags: 0,
        payloadLen: 4 + NOISE_IK_MSG1_LEN,
    }));
    w.u32le(m.senderIdx);
    w.bytes(m.noiseMsg1);
    return w.toBytes();
}
export function decodeFmpMsg1(buf) {
    if (buf.length !== FMP_MSG1_TOTAL_LEN) {
        throw new Error(`FMP Msg1 must be ${FMP_MSG1_TOTAL_LEN} bytes, got ${buf.length}`);
    }
    const r = new BinaryReader(buf);
    const prefix = decodeCommonPrefix(r);
    if (prefix.version !== FMP_VERSION)
        throw new Error("bad FMP version");
    if (prefix.phase !== FMP_PHASE_MSG1)
        throw new Error("not FMP Msg1");
    if (prefix.flags !== 0)
        throw new Error("FMP Msg1 flags must be zero");
    if (prefix.payloadLen !== 4 + NOISE_IK_MSG1_LEN) {
        throw new Error("bad FMP Msg1 payload_len");
    }
    const senderIdx = r.u32le();
    const noiseMsg1 = r.bytes(NOISE_IK_MSG1_LEN);
    return { senderIdx, noiseMsg1 };
}
export function encodeFmpMsg2(m) {
    if (m.noiseMsg2.length !== NOISE_IK_MSG2_LEN) {
        throw new Error(`noise msg2 must be ${NOISE_IK_MSG2_LEN} bytes`);
    }
    const w = new BinaryWriter();
    w.bytes(encodeCommonPrefix({
        version: FMP_VERSION,
        phase: FMP_PHASE_MSG2,
        flags: 0,
        payloadLen: 4 + 4 + NOISE_IK_MSG2_LEN,
    }));
    w.u32le(m.senderIdx);
    w.u32le(m.receiverIdx);
    w.bytes(m.noiseMsg2);
    return w.toBytes();
}
export function decodeFmpMsg2(buf) {
    if (buf.length !== FMP_MSG2_TOTAL_LEN) {
        throw new Error(`FMP Msg2 must be ${FMP_MSG2_TOTAL_LEN} bytes, got ${buf.length}`);
    }
    const r = new BinaryReader(buf);
    const prefix = decodeCommonPrefix(r);
    if (prefix.version !== FMP_VERSION)
        throw new Error("bad FMP version");
    if (prefix.phase !== FMP_PHASE_MSG2)
        throw new Error("not FMP Msg2");
    if (prefix.flags !== 0)
        throw new Error("FMP Msg2 flags must be zero");
    if (prefix.payloadLen !== 4 + 4 + NOISE_IK_MSG2_LEN) {
        throw new Error("bad FMP Msg2 payload_len");
    }
    const senderIdx = r.u32le();
    const receiverIdx = r.u32le();
    const noiseMsg2 = r.bytes(NOISE_IK_MSG2_LEN);
    return { senderIdx, receiverIdx, noiseMsg2 };
}
export function encodeFmpEstablishedHeader(h, payloadLen) {
    const w = new BinaryWriter();
    w.bytes(encodeCommonPrefix({
        version: FMP_VERSION,
        phase: FMP_PHASE_ESTABLISHED,
        flags: h.flags,
        payloadLen,
    }));
    w.u32le(h.receiverIdx);
    w.u64le(h.counter);
    return w.toBytes();
}
export function encodeFmpEstablished(p) {
    const header = encodeFmpEstablishedHeader(p, p.payloadLen);
    const w = new BinaryWriter();
    w.bytes(header);
    w.bytes(p.ciphertext);
    return w.toBytes();
}
export function decodeFmpEstablished(buf) {
    if (buf.length < FMP_ESTABLISHED_HEADER_LEN + FMP_AEAD_TAG_LEN) {
        throw new Error(`FMP Established too short: ${buf.length} < ${FMP_ESTABLISHED_HEADER_LEN + FMP_AEAD_TAG_LEN}`);
    }
    const r = new BinaryReader(buf);
    const prefix = decodeCommonPrefix(r);
    if (prefix.version !== FMP_VERSION)
        throw new Error("bad FMP version");
    if (prefix.phase !== FMP_PHASE_ESTABLISHED)
        throw new Error("not FMP Established");
    const receiverIdx = r.u32le();
    const counter = r.u64le();
    const ciphertext = r.rest();
    if (ciphertext.length !== prefix.payloadLen + FMP_AEAD_TAG_LEN) {
        throw new Error(`payload_len mismatch: header=${prefix.payloadLen}+tag actual=${ciphertext.length}`);
    }
    return { flags: prefix.flags, receiverIdx, counter, payloadLen: prefix.payloadLen, ciphertext };
}
export function encodeFmpInner(p) {
    const w = new BinaryWriter();
    w.u32le(p.timestamp);
    w.u8(p.msgType);
    w.bytes(p.payload);
    return w.toBytes();
}
export function decodeFmpInner(buf) {
    if (buf.length < 5)
        throw new Error("FMP inner packet too short");
    const r = new BinaryReader(buf);
    return {
        timestamp: r.u32le(),
        msgType: r.u8(),
        payload: r.rest(),
    };
}
export function peekFmpPhase(buf) {
    if (buf.length < 1)
        throw new Error("empty FMP packet");
    return buf[0] & 0xf;
}
//# sourceMappingURL=wire.js.map