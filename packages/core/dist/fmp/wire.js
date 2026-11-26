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
import { readU16le, readU32le, readU64le, writeU16le, writeU32le, writeU64le, } from "../codec/binary.js";
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
function writeCommonPrefix(buf, p) {
    if (p.version < 0 || p.version > 0xf)
        throw new RangeError("version 4-bit");
    if (p.phase < 0 || p.phase > 0xf)
        throw new RangeError("phase 4-bit");
    if (!Number.isInteger(p.payloadLen) || p.payloadLen < 0 || p.payloadLen > 0xffff) {
        throw new RangeError(`u16 out of range: ${p.payloadLen}`);
    }
    buf[0] = ((p.version & 0xf) << 4) | (p.phase & 0xf);
    buf[1] = p.flags & 0xff;
    writeU16le(buf, 2, p.payloadLen);
}
export function encodeCommonPrefix(p) {
    const out = new Uint8Array(4);
    writeCommonPrefix(out, p);
    return out;
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
    const out = new Uint8Array(FMP_MSG1_TOTAL_LEN);
    writeCommonPrefix(out, {
        version: FMP_VERSION,
        phase: FMP_PHASE_MSG1,
        flags: 0,
        payloadLen: 4 + NOISE_IK_MSG1_LEN,
    });
    writeU32le(out, 4, m.senderIdx);
    out.set(m.noiseMsg1, 8);
    return out;
}
export function decodeFmpMsg1(buf) {
    if (buf.length !== FMP_MSG1_TOTAL_LEN) {
        throw new Error(`FMP Msg1 must be ${FMP_MSG1_TOTAL_LEN} bytes, got ${buf.length}`);
    }
    if ((buf[0] >>> 4) !== FMP_VERSION)
        throw new Error("bad FMP version");
    if ((buf[0] & 0xf) !== FMP_PHASE_MSG1)
        throw new Error("not FMP Msg1");
    if (buf[1] !== 0)
        throw new Error("FMP Msg1 flags must be zero");
    if (readU16le(buf, 2) !== 4 + NOISE_IK_MSG1_LEN) {
        throw new Error("bad FMP Msg1 payload_len");
    }
    return { senderIdx: readU32le(buf, 4), noiseMsg1: buf.slice(8) };
}
export function encodeFmpMsg2(m) {
    if (m.noiseMsg2.length !== NOISE_IK_MSG2_LEN) {
        throw new Error(`noise msg2 must be ${NOISE_IK_MSG2_LEN} bytes`);
    }
    const out = new Uint8Array(FMP_MSG2_TOTAL_LEN);
    writeCommonPrefix(out, {
        version: FMP_VERSION,
        phase: FMP_PHASE_MSG2,
        flags: 0,
        payloadLen: 4 + 4 + NOISE_IK_MSG2_LEN,
    });
    writeU32le(out, 4, m.senderIdx);
    writeU32le(out, 8, m.receiverIdx);
    out.set(m.noiseMsg2, 12);
    return out;
}
export function decodeFmpMsg2(buf) {
    if (buf.length !== FMP_MSG2_TOTAL_LEN) {
        throw new Error(`FMP Msg2 must be ${FMP_MSG2_TOTAL_LEN} bytes, got ${buf.length}`);
    }
    if ((buf[0] >>> 4) !== FMP_VERSION)
        throw new Error("bad FMP version");
    if ((buf[0] & 0xf) !== FMP_PHASE_MSG2)
        throw new Error("not FMP Msg2");
    if (buf[1] !== 0)
        throw new Error("FMP Msg2 flags must be zero");
    if (readU16le(buf, 2) !== 4 + 4 + NOISE_IK_MSG2_LEN) {
        throw new Error("bad FMP Msg2 payload_len");
    }
    return {
        senderIdx: readU32le(buf, 4),
        receiverIdx: readU32le(buf, 8),
        noiseMsg2: buf.slice(12),
    };
}
export function writeFmpEstablishedHeader(buf, h, payloadLen) {
    writeCommonPrefix(buf, { version: FMP_VERSION, phase: FMP_PHASE_ESTABLISHED, flags: h.flags, payloadLen });
    writeU32le(buf, 4, h.receiverIdx);
    writeU64le(buf, 8, h.counter);
}
export function encodeFmpEstablishedHeader(h, payloadLen) {
    const out = new Uint8Array(FMP_ESTABLISHED_HEADER_LEN);
    writeFmpEstablishedHeader(out, h, payloadLen);
    return out;
}
export function encodeFmpEstablished(p) {
    const out = new Uint8Array(FMP_ESTABLISHED_HEADER_LEN + p.ciphertext.length);
    writeFmpEstablishedHeader(out, p, p.payloadLen);
    out.set(p.ciphertext, FMP_ESTABLISHED_HEADER_LEN);
    return out;
}
/** Zero-copy established frame parser for internal hot paths. */
export function parseFmpEstablished(buf) {
    if (buf.length < FMP_ESTABLISHED_HEADER_LEN + FMP_AEAD_TAG_LEN) {
        throw new Error(`FMP Established too short: ${buf.length} < ${FMP_ESTABLISHED_HEADER_LEN + FMP_AEAD_TAG_LEN}`);
    }
    if ((buf[0] >>> 4) !== FMP_VERSION)
        throw new Error("bad FMP version");
    if ((buf[0] & 0xf) !== FMP_PHASE_ESTABLISHED)
        throw new Error("not FMP Established");
    const payloadLen = readU16le(buf, 2);
    const ciphertext = buf.subarray(FMP_ESTABLISHED_HEADER_LEN);
    if (ciphertext.length !== payloadLen + FMP_AEAD_TAG_LEN) {
        throw new Error(`payload_len mismatch: header=${payloadLen}+tag actual=${ciphertext.length}`);
    }
    return {
        flags: buf[1],
        receiverIdx: readU32le(buf, 4),
        counter: readU64le(buf, 8),
        payloadLen,
        aad: buf.subarray(0, FMP_ESTABLISHED_HEADER_LEN),
        ciphertext,
    };
}
export function decodeFmpEstablished(buf) {
    const { flags, receiverIdx, counter, payloadLen, ciphertext } = parseFmpEstablished(buf);
    return { flags, receiverIdx, counter, payloadLen, ciphertext: ciphertext.slice() };
}
export function encodeFmpInner(p) {
    const out = new Uint8Array(5 + p.payload.length);
    writeU32le(out, 0, p.timestamp);
    out[4] = p.msgType & 0xff;
    out.set(p.payload, 5);
    return out;
}
export function decodeFmpInner(buf) {
    if (buf.length < 5)
        throw new Error("FMP inner packet too short");
    return {
        timestamp: readU32le(buf, 0),
        msgType: buf[4],
        payload: buf.slice(5),
    };
}
export function peekFmpPhase(buf) {
    if (buf.length < 1)
        throw new Error("empty FMP packet");
    return buf[0] & 0xf;
}
//# sourceMappingURL=wire.js.map