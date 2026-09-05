/**
 * FSP wire format (matches Rust crates/fips-core/src/node/session_wire.rs).
 *
 * Common prefix (same layout as FMP):
 *   byte 0: (version << 4) | phase
 *   byte 1: flags
 *   byte 2-3: payload_len (u16 LE)
 *
 * Phase 0x1 / 0x2 / 0x3: Noise_XK msg1/2/3 (33 / 57 / 73 bytes).
 * Phase 0x0 (Established): 4 prefix + 8 counter (u64 LE) + ciphertext+tag.
 *
 * Inner plaintext (after AEAD decrypt):
 *   4 byte timestamp + 1 byte msg_type + 1 byte inner_flags + payload
 */
import { BinaryReader } from "../codec/binary.js";
export declare const FSP_VERSION = 0;
export declare const FSP_PHASE_ESTABLISHED = 0;
export declare const FSP_PHASE_MSG1 = 1;
export declare const FSP_PHASE_MSG2 = 2;
export declare const FSP_PHASE_MSG3 = 3;
export declare const NOISE_XK_MSG1_LEN = 33;
export declare const NOISE_XK_MSG2_LEN = 57;
export declare const NOISE_XK_MSG3_LEN = 73;
export declare const FSP_ESTABLISHED_HEADER_LEN: number;
export declare const FSP_AEAD_TAG_LEN = 16;
export declare const FSP_INNER_HEADER_LEN: number;
export declare const FSP_FLAG_CP = 1;
export declare const FSP_FLAG_K = 2;
export declare const FSP_FLAG_U = 4;
export declare const FSP_FLAG_DIRECT_TRANSPORT = 8;
/** FSP inner msg types. */
export declare const FSP_MSG_KEEPALIVE = 0;
export declare const FSP_MSG_DATA = 16;
export declare const FSP_MSG_RECEIVER_REPORT = 18;
export declare const FSP_MSG_ENDPOINT_DATA = 21;
export interface FspCommonPrefix {
    version: number;
    phase: number;
    flags: number;
    payloadLen: number;
}
export declare function encodeFspCommonPrefix(p: FspCommonPrefix): Uint8Array;
export declare function decodeFspCommonPrefix(r: BinaryReader): FspCommonPrefix;
/** Rust carries adjacent established FSP records directly when this flag is set. */
export declare function isDirectFspEstablished(buf: Uint8Array): boolean;
export interface FspHandshakeFrame {
    phase: 1 | 2 | 3;
    noiseMsg: Uint8Array;
}
export declare function encodeFspHandshake(f: FspHandshakeFrame): Uint8Array;
export declare function decodeFspHandshake(buf: Uint8Array): FspHandshakeFrame;
export interface FspEstablishedHeader {
    flags: number;
    counter: bigint;
}
export interface FspEstablished extends FspEstablishedHeader {
    payloadLen: number;
    srcCoords?: Uint8Array[];
    destCoords?: Uint8Array[];
    ciphertext: Uint8Array;
}
export declare function encodeFspEstablishedHeader(h: FspEstablishedHeader, payloadLen: number): Uint8Array;
export declare function encodeFspEstablished(p: FspEstablished): Uint8Array;
export declare function decodeFspEstablished(buf: Uint8Array): FspEstablished;
export interface FspInnerPacket {
    timestamp: number;
    msgType: number;
    innerFlags: number;
    payload: Uint8Array;
}
export declare function encodeFspInner(p: FspInnerPacket): Uint8Array;
export declare function decodeFspInner(buf: Uint8Array): FspInnerPacket;
/** FSP DataPacket: src_port (u16 LE) + dst_port (u16 LE) + payload. */
export interface DataPacket {
    srcPort: number;
    dstPort: number;
    payload: Uint8Array;
}
export declare function encodeDataPacket(p: DataPacket): Uint8Array;
export declare function decodeDataPacket(buf: Uint8Array): DataPacket;
export declare function peekFspPhase(buf: Uint8Array): number;
//# sourceMappingURL=wire.d.ts.map