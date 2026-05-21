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
import { BinaryReader } from "../codec/binary.js";
export declare const FMP_VERSION = 0;
export declare const FMP_PHASE_ESTABLISHED = 0;
export declare const FMP_PHASE_MSG1 = 1;
export declare const FMP_PHASE_MSG2 = 2;
export declare const NOISE_IK_MSG1_LEN = 106;
export declare const NOISE_IK_MSG2_LEN = 57;
export declare const FMP_MSG1_TOTAL_LEN: number;
export declare const FMP_MSG2_TOTAL_LEN: number;
export declare const FMP_ESTABLISHED_HEADER_LEN: number;
export declare const FMP_AEAD_TAG_LEN = 16;
/** Link-message types after the FMP timestamp header. */
export declare const FMP_INNER_DATA = 0;
export declare const FMP_INNER_KEEPALIVE = 81;
export interface FmpCommonPrefix {
    version: number;
    phase: number;
    flags: number;
    payloadLen: number;
}
export declare function encodeCommonPrefix(p: FmpCommonPrefix): Uint8Array;
export declare function decodeCommonPrefix(r: BinaryReader): FmpCommonPrefix;
export interface FmpMsg1 {
    senderIdx: number;
    noiseMsg1: Uint8Array;
}
export declare function encodeFmpMsg1(m: FmpMsg1): Uint8Array;
export declare function decodeFmpMsg1(buf: Uint8Array): FmpMsg1;
export interface FmpMsg2 {
    senderIdx: number;
    receiverIdx: number;
    noiseMsg2: Uint8Array;
}
export declare function encodeFmpMsg2(m: FmpMsg2): Uint8Array;
export declare function decodeFmpMsg2(buf: Uint8Array): FmpMsg2;
export interface FmpEstablishedHeader {
    flags: number;
    receiverIdx: number;
    counter: bigint;
}
export interface FmpEstablished extends FmpEstablishedHeader {
    payloadLen: number;
    ciphertext: Uint8Array;
}
export declare function encodeFmpEstablishedHeader(h: FmpEstablishedHeader, payloadLen: number): Uint8Array;
export declare function encodeFmpEstablished(p: FmpEstablished): Uint8Array;
export declare function decodeFmpEstablished(buf: Uint8Array): FmpEstablished;
export interface FmpInnerPacket {
    timestamp: number;
    msgType: number;
    payload: Uint8Array;
}
export declare function encodeFmpInner(p: FmpInnerPacket): Uint8Array;
export declare function decodeFmpInner(buf: Uint8Array): FmpInnerPacket;
export declare function peekFmpPhase(buf: Uint8Array): number;
//# sourceMappingURL=wire.d.ts.map