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

import { BinaryReader, BinaryWriter } from "../codec/binary.js";

export const FSP_VERSION = 1;

export const FSP_PHASE_ESTABLISHED = 0x0;
export const FSP_PHASE_MSG1 = 0x1;
export const FSP_PHASE_MSG2 = 0x2;
export const FSP_PHASE_MSG3 = 0x3;

export const NOISE_XK_MSG1_LEN = 33;
export const NOISE_XK_MSG2_LEN = 57;
export const NOISE_XK_MSG3_LEN = 73;

export const FSP_ESTABLISHED_HEADER_LEN = 4 + 8; // 12
export const FSP_AEAD_TAG_LEN = 16;
export const FSP_INNER_HEADER_LEN = 4 + 1 + 1; // 6

/** FSP inner msg types. */
export const FSP_MSG_KEEPALIVE = 0x00;
export const FSP_MSG_DATA = 0x10;        // DataPacket: src_port + dst_port + payload

export interface FspCommonPrefix {
  version: number;
  phase: number;
  flags: number;
  payloadLen: number;
}

export function encodeFspCommonPrefix(p: FspCommonPrefix): Uint8Array {
  if (p.version < 0 || p.version > 0xf) throw new RangeError("version 4-bit");
  if (p.phase < 0 || p.phase > 0xf) throw new RangeError("phase 4-bit");
  const w = new BinaryWriter();
  w.u8(((p.version & 0xf) << 4) | (p.phase & 0xf));
  w.u8(p.flags & 0xff);
  w.u16le(p.payloadLen);
  return w.toBytes();
}

export function decodeFspCommonPrefix(r: BinaryReader): FspCommonPrefix {
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

export interface FspHandshakeFrame {
  phase: 1 | 2 | 3;
  noiseMsg: Uint8Array;
}

const XK_MSG_LEN = {
  1: NOISE_XK_MSG1_LEN,
  2: NOISE_XK_MSG2_LEN,
  3: NOISE_XK_MSG3_LEN,
} as const;

export function encodeFspHandshake(f: FspHandshakeFrame): Uint8Array {
  const expectedLen = XK_MSG_LEN[f.phase];
  if (f.noiseMsg.length !== expectedLen) {
    throw new Error(
      `XK msg${f.phase} must be ${expectedLen} bytes, got ${f.noiseMsg.length}`,
    );
  }
  const w = new BinaryWriter();
  w.bytes(
    encodeFspCommonPrefix({
      version: FSP_VERSION,
      phase: f.phase,
      flags: 0,
      payloadLen: expectedLen,
    }),
  );
  w.bytes(f.noiseMsg);
  return w.toBytes();
}

export function decodeFspHandshake(buf: Uint8Array): FspHandshakeFrame {
  const r = new BinaryReader(buf);
  const prefix = decodeFspCommonPrefix(r);
  if (prefix.version !== FSP_VERSION) throw new Error("bad FSP version");
  if (prefix.phase !== 1 && prefix.phase !== 2 && prefix.phase !== 3) {
    throw new Error(`not an FSP handshake phase: ${prefix.phase}`);
  }
  if (prefix.flags !== 0) throw new Error("FSP handshake flags must be zero");
  const phase = prefix.phase as 1 | 2 | 3;
  const expectedLen = XK_MSG_LEN[phase];
  if (prefix.payloadLen !== expectedLen) {
    throw new Error(
      `FSP msg${phase} payload_len ${prefix.payloadLen} != ${expectedLen}`,
    );
  }
  const noiseMsg = r.bytes(expectedLen);
  return { phase, noiseMsg };
}

export interface FspEstablishedHeader {
  flags: number;
  counter: bigint;
}

export interface FspEstablished extends FspEstablishedHeader {
  ciphertext: Uint8Array; // includes 16-byte AEAD tag at end
}

export function encodeFspEstablishedHeader(
  h: FspEstablishedHeader,
  payloadLen: number,
): Uint8Array {
  const w = new BinaryWriter();
  w.bytes(
    encodeFspCommonPrefix({
      version: FSP_VERSION,
      phase: FSP_PHASE_ESTABLISHED,
      flags: h.flags,
      payloadLen,
    }),
  );
  w.u64le(h.counter);
  return w.toBytes();
}

export function encodeFspEstablished(p: FspEstablished): Uint8Array {
  const header = encodeFspEstablishedHeader(p, p.ciphertext.length);
  const w = new BinaryWriter();
  w.bytes(header);
  w.bytes(p.ciphertext);
  return w.toBytes();
}

export function decodeFspEstablished(buf: Uint8Array): FspEstablished {
  if (buf.length < FSP_ESTABLISHED_HEADER_LEN + FSP_AEAD_TAG_LEN) {
    throw new Error(
      `FSP Established too short: ${buf.length} < ${FSP_ESTABLISHED_HEADER_LEN + FSP_AEAD_TAG_LEN}`,
    );
  }
  const r = new BinaryReader(buf);
  const prefix = decodeFspCommonPrefix(r);
  if (prefix.version !== FSP_VERSION) throw new Error("bad FSP version");
  if (prefix.phase !== FSP_PHASE_ESTABLISHED) throw new Error("not FSP Established");
  const counter = r.u64le();
  const ciphertext = r.rest();
  if (ciphertext.length !== prefix.payloadLen) {
    throw new Error(
      `FSP payload_len mismatch: header=${prefix.payloadLen} actual=${ciphertext.length}`,
    );
  }
  return { flags: prefix.flags, counter, ciphertext };
}

export interface FspInnerPacket {
  timestamp: number; // u32 LE seconds
  msgType: number; // u8
  innerFlags: number; // u8
  payload: Uint8Array;
}

export function encodeFspInner(p: FspInnerPacket): Uint8Array {
  const w = new BinaryWriter();
  w.u32le(p.timestamp);
  w.u8(p.msgType);
  w.u8(p.innerFlags);
  w.bytes(p.payload);
  return w.toBytes();
}

export function decodeFspInner(buf: Uint8Array): FspInnerPacket {
  if (buf.length < FSP_INNER_HEADER_LEN) {
    throw new Error("FSP inner packet too short");
  }
  const r = new BinaryReader(buf);
  return {
    timestamp: r.u32le(),
    msgType: r.u8(),
    innerFlags: r.u8(),
    payload: r.rest(),
  };
}

/** FSP DataPacket: src_port (u16 LE) + dst_port (u16 LE) + payload. */
export interface DataPacket {
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

export function encodeDataPacket(p: DataPacket): Uint8Array {
  const w = new BinaryWriter();
  w.u16le(p.srcPort);
  w.u16le(p.dstPort);
  w.bytes(p.payload);
  return w.toBytes();
}

export function decodeDataPacket(buf: Uint8Array): DataPacket {
  if (buf.length < 4) throw new Error("DataPacket too short");
  const r = new BinaryReader(buf);
  return {
    srcPort: r.u16le(),
    dstPort: r.u16le(),
    payload: r.rest(),
  };
}

export function peekFspPhase(buf: Uint8Array): number {
  if (buf.length < 1) throw new Error("empty FSP packet");
  return buf[0] & 0xf;
}
