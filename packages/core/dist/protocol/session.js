import { BinaryReader, BinaryWriter } from "../codec/binary.js";
import { FSP_PHASE_MSG1, FSP_PHASE_MSG2, FSP_PHASE_MSG3, FSP_VERSION } from "../fsp/wire.js";
/** Both endpoints may carry established FSP records directly on a transport. */
export const SESSION_FLAG_DIRECT_FSP_TRANSPORT = 0x04;
export const encodeSessionSetup = (msg) => encodeSessionCoordsFrame(FSP_PHASE_MSG1, msg);
export const decodeSessionSetup = (frame) => decodeSessionCoordsFrame(frame, FSP_PHASE_MSG1);
export const encodeSessionAck = (msg) => encodeSessionCoordsFrame(FSP_PHASE_MSG2, msg);
export const decodeSessionAck = (frame) => decodeSessionCoordsFrame(frame, FSP_PHASE_MSG2);
export function encodeSessionMsg3(msg) {
    const body = new BinaryWriter(3 + msg.handshakePayload.length);
    body.u8(msg.flags & 0xff);
    body.u16le(msg.handshakePayload.length);
    body.bytes(msg.handshakePayload);
    return encodeSessionHandshakeFrame(FSP_PHASE_MSG3, body.toBytes());
}
export function decodeSessionMsg3(frame) {
    const r = new BinaryReader(decodeSessionHandshakeFrame(frame, FSP_PHASE_MSG3));
    const flags = r.u8();
    return { flags, handshakePayload: r.bytes(r.u16le()) };
}
function encodeSessionCoordsFrame(phase, msg) {
    const body = new BinaryWriter(7 + (msg.srcCoords.length + msg.destCoords.length) * 16 + msg.handshakePayload.length);
    body.u8(msg.flags & 0xff);
    encodeCoords(msg.srcCoords, body);
    encodeCoords(msg.destCoords, body);
    body.u16le(msg.handshakePayload.length);
    body.bytes(msg.handshakePayload);
    return encodeSessionHandshakeFrame(phase, body.toBytes());
}
function decodeSessionCoordsFrame(frame, expectedPhase) {
    const r = new BinaryReader(decodeSessionHandshakeFrame(frame, expectedPhase));
    const flags = r.u8();
    const srcCoords = decodeCoords(r);
    const destCoords = decodeCoords(r);
    return { srcCoords, destCoords, flags, handshakePayload: r.bytes(r.u16le()) };
}
function encodeSessionHandshakeFrame(phase, body) {
    const w = new BinaryWriter(4 + body.length);
    w.u8(((FSP_VERSION & 0xf) << 4) | (phase & 0xf));
    w.u8(0);
    w.u16le(body.length);
    w.bytes(body);
    return w.toBytes();
}
function decodeSessionHandshakeFrame(frame, expectedPhase) {
    const r = new BinaryReader(frame);
    const versionAndPhase = r.u8();
    const version = (versionAndPhase >>> 4) & 0xf;
    const phase = versionAndPhase & 0xf;
    const flags = r.u8();
    const payloadLen = r.u16le();
    if (version !== FSP_VERSION)
        throw new Error("bad FSP version");
    if (phase !== expectedPhase)
        throw new Error(`expected FSP phase ${expectedPhase}, got ${phase}`);
    if (flags !== 0)
        throw new Error("FSP handshake flags must be zero");
    const body = r.bytes(payloadLen);
    if (r.remaining !== 0)
        throw new Error("trailing bytes after FSP handshake frame");
    return body;
}
function encodeCoords(coords, w) {
    w.u16le(coords.length);
    for (const addr of coords) {
        if (addr.length !== 16)
            throw new Error("coord NodeAddr must be 16 bytes");
        w.bytes(addr);
    }
}
function decodeCoords(r) {
    const count = r.u16le();
    const coords = [];
    for (let i = 0; i < count; i++)
        coords.push(r.bytes(16));
    return coords;
}
//# sourceMappingURL=session.js.map