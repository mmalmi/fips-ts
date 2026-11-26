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

import {
  BinaryReader,
  readU16le,
  readU32le,
  readU64le,
  writeU16le,
  writeU32le,
  writeU64le,
} from "../codec/binary.js";

export const FSP_VERSION = 0;

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

export const FSP_FLAG_CP = 0x01;
export const FSP_FLAG_K = 0x02;
export const FSP_FLAG_U = 0x04;
export const FSP_FLAG_DIRECT_TRANSPORT = 0x08;

/** FSP inner msg types. */
export const FSP_MSG_KEEPALIVE = 0x00;
export const FSP_MSG_DATA = 0x10;        // DataPacket: src_port + dst_port + payload
export const FSP_MSG_RECEIVER_REPORT = 0x12;
export const FSP_MSG_COORDS_WARMUP = 0x14;
export const FSP_MSG_ENDPOINT_DATA = 0x15; // App endpoint payload without service ports
export const FSP_MSG_TRAVERSAL_OFFER = 0x16;
export const FSP_MSG_TRAVERSAL_ANSWER = 0x17;

export interface FspCommonPrefix {
  version: number;
  phase: number;
  flags: number;
  payloadLen: number;
}

function writeFspPrefix(buf: Uint8Array, p: FspCommonPrefix): void {
  if (p.version < 0 || p.version > 0xf) throw new RangeError("version 4-bit");
  if (p.phase < 0 || p.phase > 0xf) throw new RangeError("phase 4-bit");
  if (!Number.isInteger(p.payloadLen) || p.payloadLen < 0 || p.payloadLen > 0xffff) {
    throw new RangeError(`u16 out of range: ${p.payloadLen}`);
  }
  buf[0] = ((p.version & 0xf) << 4) | (p.phase & 0xf);
  buf[1] = p.flags & 0xff;
  writeU16le(buf, 2, p.payloadLen);
}

export function encodeFspCommonPrefix(p: FspCommonPrefix): Uint8Array {
  const out = new Uint8Array(4);
  writeFspPrefix(out, p);
  return out;
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

/** Rust carries adjacent established FSP records directly when this flag is set. */
export function isDirectFspEstablished(buf: Uint8Array): boolean {
  return buf.length >= FSP_ESTABLISHED_HEADER_LEN
    && (buf[0]! >>> 4) === FSP_VERSION
    && (buf[0]! & 0x0f) === FSP_PHASE_ESTABLISHED
    && (buf[1]! & FSP_FLAG_DIRECT_TRANSPORT) !== 0;
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
    throw new Error(`XK msg${f.phase} must be ${expectedLen} bytes, got ${f.noiseMsg.length}`);
  }
  const out = new Uint8Array(4 + expectedLen);
  writeFspPrefix(out, { version: FSP_VERSION, phase: f.phase, flags: 0, payloadLen: expectedLen });
  out.set(f.noiseMsg, 4);
  return out;
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
    throw new Error(`FSP msg${phase} payload_len ${prefix.payloadLen} != ${expectedLen}`);
  }
  return { phase, noiseMsg: r.bytes(expectedLen) };
}

export interface FspEstablishedHeader {
  flags: number;
  counter: bigint;
}

export interface FspEstablished extends FspEstablishedHeader {
  payloadLen: number;
  srcCoords?: Uint8Array[];
  destCoords?: Uint8Array[];
  ciphertext: Uint8Array; // includes 16-byte AEAD tag at end
}

export function encodeFspEstablishedHeader(
  h: FspEstablishedHeader,
  payloadLen: number,
): Uint8Array {
  const out = new Uint8Array(FSP_ESTABLISHED_HEADER_LEN);
  writeFspPrefix(out, {
    version: FSP_VERSION,
    phase: FSP_PHASE_ESTABLISHED,
    flags: h.flags,
    payloadLen,
  });
  writeU64le(out, 4, h.counter);
  return out;
}

export function allocateFspEstablishedFrame(
  h: FspEstablishedHeader,
  payloadLen: number,
  coords?: Pick<FspEstablished, "srcCoords" | "destCoords">,
): { frame: Uint8Array; payloadOffset: number } {
  const hasCoords = (h.flags & FSP_FLAG_CP) !== 0;
  const srcCount = hasCoords ? (coords?.srcCoords?.length ?? 0) : 0;
  const destCount = hasCoords ? (coords?.destCoords?.length ?? 0) : 0;
  if (srcCount > 0xffff || destCount > 0xffff) throw new Error("too many coordinate entries");
  const payloadOffset = FSP_ESTABLISHED_HEADER_LEN + (hasCoords ? 4 + (srcCount + destCount) * 16 : 0);
  const frame = new Uint8Array(payloadOffset + payloadLen + FSP_AEAD_TAG_LEN);
  writeFspPrefix(frame, { version: FSP_VERSION, phase: FSP_PHASE_ESTABLISHED, flags: h.flags, payloadLen });
  writeU64le(frame, 4, h.counter);
  if (hasCoords) {
    const off = writeOptionalCoords(frame, FSP_ESTABLISHED_HEADER_LEN, coords?.srcCoords);
    writeOptionalCoords(frame, off, coords?.destCoords);
  }
  return { frame, payloadOffset };
}

export function encodeFspEstablished(p: FspEstablished): Uint8Array {
  if (p.ciphertext.length !== p.payloadLen + FSP_AEAD_TAG_LEN) {
    throw new Error(
      `ciphertext length ${p.ciphertext.length} != payload_len ${p.payloadLen}+tag`,
    );
  }
  const { frame, payloadOffset } = allocateFspEstablishedFrame(p, p.payloadLen, p);
  frame.set(p.ciphertext, payloadOffset);
  return frame;
}

export interface ParsedFspEstablished extends FspEstablished {
  aad: Uint8Array;
}

/** Zero-copy FSP established frame parser for internal hot paths. */
export function parseFspEstablished(
  buf: Uint8Array,
  includeCoords = true,
): ParsedFspEstablished {
  if (buf.length < FSP_ESTABLISHED_HEADER_LEN + FSP_AEAD_TAG_LEN) {
    throw new Error(
      `FSP Established too short: ${buf.length} < ${FSP_ESTABLISHED_HEADER_LEN + FSP_AEAD_TAG_LEN}`,
    );
  }
  if ((buf[0]! >>> 4) !== FSP_VERSION) throw new Error("bad FSP version");
  if ((buf[0]! & 0xf) !== FSP_PHASE_ESTABLISHED) throw new Error("not FSP Established");
  const flags = buf[1]!;
  if ((flags & FSP_FLAG_U) !== 0) {
    throw new Error("plaintext FSP error frames are not supported here");
  }
  const payloadLen = readU16le(buf, 2);
  const counter = readU64le(buf, 4);
  let off = FSP_ESTABLISHED_HEADER_LEN;
  let srcCoords: Uint8Array[] | undefined;
  let destCoords: Uint8Array[] | undefined;
  if ((flags & FSP_FLAG_CP) !== 0) {
    const src = decodeOptionalCoords(buf, off, includeCoords);
    off += src.bytesRead;
    const dest = decodeOptionalCoords(buf, off, includeCoords);
    off += dest.bytesRead;
    srcCoords = src.coords;
    destCoords = dest.coords;
  }
  const ciphertext = buf.subarray(off);
  if (ciphertext.length !== payloadLen + FSP_AEAD_TAG_LEN) {
    throw new Error(
      `FSP payload_len mismatch: header=${payloadLen}+tag actual=${ciphertext.length}`,
    );
  }
  return {
    flags,
    counter,
    payloadLen,
    srcCoords,
    destCoords,
    aad: buf.subarray(0, FSP_ESTABLISHED_HEADER_LEN),
    ciphertext,
  };
}

export function decodeFspEstablished(buf: Uint8Array): FspEstablished {
  const { flags, counter, payloadLen, srcCoords, destCoords, ciphertext } = parseFspEstablished(buf, true);
  return { flags, counter, payloadLen, srcCoords, destCoords, ciphertext: ciphertext.slice() };
}

export interface FspInnerPacket {
  timestamp: number; // u32 LE session-relative milliseconds
  msgType: number; // u8
  innerFlags: number; // u8
  payload: Uint8Array;
}

export function encodeFspInner(p: FspInnerPacket): Uint8Array {
  const out = new Uint8Array(FSP_INNER_HEADER_LEN + p.payload.length);
  writeU32le(out, 0, p.timestamp);
  out[4] = p.msgType & 0xff;
  out[5] = p.innerFlags & 0xff;
  out.set(p.payload, FSP_INNER_HEADER_LEN);
  return out;
}

export function decodeFspInner(buf: Uint8Array): FspInnerPacket {
  if (buf.length < FSP_INNER_HEADER_LEN) {
    throw new Error("FSP inner packet too short");
  }
  return {
    timestamp: readU32le(buf, 0),
    msgType: buf[4]!,
    innerFlags: buf[5]!,
    payload: buf.slice(FSP_INNER_HEADER_LEN),
  };
}

/** FSP DataPacket: src_port (u16 LE) + dst_port (u16 LE) + payload. */
export interface DataPacket {
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

export function encodeDataPacket(p: DataPacket): Uint8Array {
  if (!Number.isInteger(p.srcPort) || p.srcPort < 0 || p.srcPort > 0xffff) {
    throw new RangeError(`u16 out of range: ${p.srcPort}`);
  }
  if (!Number.isInteger(p.dstPort) || p.dstPort < 0 || p.dstPort > 0xffff) {
    throw new RangeError(`u16 out of range: ${p.dstPort}`);
  }
  const out = new Uint8Array(4 + p.payload.length);
  writeU16le(out, 0, p.srcPort);
  writeU16le(out, 2, p.dstPort);
  out.set(p.payload, 4);
  return out;
}

export function decodeDataPacket(buf: Uint8Array): DataPacket {
  if (buf.length < 4) throw new Error("DataPacket too short");
  return {
    srcPort: readU16le(buf, 0),
    dstPort: readU16le(buf, 2),
    payload: buf.slice(4),
  };
}

export function peekFspPhase(buf: Uint8Array): number {
  if (buf.length < 1) throw new Error("empty FSP packet");
  return buf[0]! & 0xf;
}

function writeOptionalCoords(out: Uint8Array, offset: number, coords: Uint8Array[] | undefined): number {
  const count = coords?.length ?? 0;
  writeU16le(out, offset, count);
  let off = offset + 2;
  for (const addr of coords ?? []) {
    if (addr.length !== 16) throw new Error("coordinate NodeAddr must be 16 bytes");
    out.set(addr, off);
    off += 16;
  }
  return off;
}

function decodeOptionalCoords(
  buf: Uint8Array,
  offset: number,
  copy: boolean,
): { coords?: Uint8Array[]; bytesRead: number } {
  if (buf.length < offset + 2) {
    throw new Error("FSP coordinate field too short");
  }
  const count = readU16le(buf, offset);
  const len = 2 + count * 16;
  if (buf.length < offset + len) {
    throw new Error("FSP coordinate entries truncated");
  }
  if (count === 0 || !copy) return { bytesRead: len };
  const coords: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const start = offset + 2 + i * 16;
    coords.push(buf.slice(start, start + 16));
  }
  return { coords, bytesRead: len };
}
