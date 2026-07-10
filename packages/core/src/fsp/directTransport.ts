import { decodeFspEstablished, FSP_FLAG_DIRECT_TRANSPORT } from "./wire.js";

export const DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN = 20;
export const DIRECT_FSP_TRANSPORT_MAX_REASSEMBLED_LEN = 72 * 1024;
export const DIRECT_FSP_TRANSPORT_MAX_FRAGMENTS = 128;

const FRAGMENT_MAGIC = Uint8Array.of(0x44, 0x46, 0x50, 0x31); // DFP1
const REASSEMBLY_TTL_MS = 2_000;
const MAX_REASSEMBLY_RECORDS = 512;

interface Reassembly {
  createdAtMs: number;
  totalLen: number;
  receivedBytes: number;
  fragments: Array<Uint8Array | undefined>;
}

export function isDirectFspTransportFragment(data: Uint8Array): boolean {
  return data.length >= FRAGMENT_MAGIC.length
    && FRAGMENT_MAGIC.every((byte, index) => data[index] === byte);
}

export function segmentDirectFspTransportRecord(
  record: Uint8Array,
  pathMtu: number,
): Uint8Array[] {
  if (!Number.isSafeInteger(pathMtu) || pathMtu <= 0) {
    throw new RangeError("direct FSP path MTU must be a positive safe integer");
  }
  if (record.length <= pathMtu) return [record];
  if (record.length > DIRECT_FSP_TRANSPORT_MAX_REASSEMBLED_LEN) {
    throw new Error("direct FSP record exceeds reassembly limit");
  }
  const established = decodeFspEstablished(record);
  if ((established.flags & FSP_FLAG_DIRECT_TRANSPORT) === 0) {
    throw new Error("segmented FSP record must use direct transport");
  }
  const maxPayload = pathMtu - DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN;
  if (maxPayload <= 0) throw new Error("direct FSP path MTU is too small for fragments");
  const fragmentCount = Math.ceil(record.length / maxPayload);
  if (fragmentCount <= 1 || fragmentCount > DIRECT_FSP_TRANSPORT_MAX_FRAGMENTS) {
    throw new Error("direct FSP record requires too many fragments");
  }

  const fragments: Uint8Array[] = [];
  for (let index = 0; index < fragmentCount; index += 1) {
    const start = index * maxPayload;
    const payload = record.subarray(start, Math.min(start + maxPayload, record.length));
    const fragment = new Uint8Array(DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN + payload.length);
    fragment.set(FRAGMENT_MAGIC, 0);
    writeU64le(fragment, 4, established.counter);
    writeU32le(fragment, 12, record.length);
    writeU16le(fragment, 16, index);
    writeU16le(fragment, 18, fragmentCount);
    fragment.set(payload, DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN);
    fragments.push(fragment);
  }
  return fragments;
}

export class DirectFspTransportReassembler {
  private readonly entries = new Map<string, Reassembly>();

  ingest(source: string, fragment: Uint8Array, nowMs: number): Uint8Array | undefined {
    if (!isDirectFspTransportFragment(fragment)) {
      throw new Error("packet is not a direct FSP transport fragment");
    }
    if (fragment.length <= DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN) return undefined;
    const recordId = readU64le(fragment, 4);
    const totalLen = readU32le(fragment, 12);
    const fragmentIndex = readU16le(fragment, 16);
    const fragmentCount = readU16le(fragment, 18);
    if (
      totalLen <= 0
      || totalLen > DIRECT_FSP_TRANSPORT_MAX_REASSEMBLED_LEN
      || fragmentCount <= 1
      || fragmentCount > DIRECT_FSP_TRANSPORT_MAX_FRAGMENTS
      || fragmentCount > totalLen
      || fragmentIndex >= fragmentCount
    ) {
      return undefined;
    }

    this.prune(nowMs);
    const key = `${source}:${recordId.toString(16)}`;
    let entry = this.entries.get(key);
    if (
      !entry
      || nowMs - entry.createdAtMs > REASSEMBLY_TTL_MS
      || entry.totalLen !== totalLen
      || entry.fragments.length !== fragmentCount
    ) {
      this.reserveEntry();
      entry = {
        createdAtMs: nowMs,
        totalLen,
        receivedBytes: 0,
        fragments: new Array<Uint8Array | undefined>(fragmentCount).fill(undefined),
      };
      this.entries.set(key, entry);
    }

    if (!entry.fragments[fragmentIndex]) {
      const payload = fragment.slice(DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN);
      if (entry.receivedBytes + payload.length > totalLen) {
        this.entries.delete(key);
        return undefined;
      }
      entry.fragments[fragmentIndex] = payload;
      entry.receivedBytes += payload.length;
    }
    if (entry.receivedBytes !== totalLen || entry.fragments.some((part) => !part)) {
      return undefined;
    }

    const record = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of entry.fragments) {
      if (!part) return undefined;
      record.set(part, offset);
      offset += part.length;
    }
    this.entries.delete(key);
    return offset === totalLen ? record : undefined;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.createdAtMs > REASSEMBLY_TTL_MS) this.entries.delete(key);
    }
  }

  private reserveEntry(): void {
    if (this.entries.size < MAX_REASSEMBLY_RECORDS) return;
    const oldest = [...this.entries.entries()].reduce((candidate, current) =>
      current[1].createdAtMs < candidate[1].createdAtMs ? current : candidate
    );
    this.entries.delete(oldest[0]);
  }
}

function writeU16le(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32le(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64le(target: Uint8Array, offset: number, value: bigint): void {
  for (let index = 0; index < 8; index += 1) {
    target[offset + index] = Number((value >> BigInt(index * 8)) & 0xffn);
  }
}

function readU16le(source: Uint8Array, offset: number): number {
  return source[offset] | (source[offset + 1] << 8);
}

function readU32le(source: Uint8Array, offset: number): number {
  return (
    source[offset]
    | (source[offset + 1] << 8)
    | (source[offset + 2] << 16)
    | (source[offset + 3] << 24)
  ) >>> 0;
}

function readU64le(source: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(source[offset + index]) << BigInt(index * 8);
  }
  return value;
}
