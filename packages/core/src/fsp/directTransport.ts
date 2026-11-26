import {
  readU16le,
  readU32le,
  readU64le,
  writeU16le,
  writeU32le,
  writeU64le,
} from "../codec/binary.js";
import { FSP_FLAG_DIRECT_TRANSPORT, parseFspEstablished } from "./wire.js";

export const DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN = 20;
export const DIRECT_FSP_TRANSPORT_MAX_REASSEMBLED_LEN = 72 * 1024;
export const DIRECT_FSP_TRANSPORT_MAX_FRAGMENTS = 128;

const FRAGMENT_MAGIC = Uint8Array.of(0x44, 0x46, 0x50, 0x31); // DFP1
const REASSEMBLY_TTL_MS = 2_000;
const MAX_REASSEMBLY_RECORDS = 512;
const PRUNE_INTERVAL_MS = 500;

interface Reassembly {
  createdAtMs: number;
  totalLen: number;
  receivedBytes: number;
  missingFragments: number;
  fragments: Array<Uint8Array | undefined>;
}

interface FragmentHeader {
  recordId: bigint;
  totalLen: number;
  fragmentIndex: number;
  fragmentCount: number;
}

export function isDirectFspTransportFragment(data: Uint8Array): boolean {
  return data.length >= 4
    && data[0] === 0x44 && data[1] === 0x46 && data[2] === 0x50 && data[3] === 0x31;
}

function parseFragmentHeader(fragment: Uint8Array): FragmentHeader | undefined {
  if (fragment.length <= DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN) return undefined;
  const recordId = readU64le(fragment, 4);
  const totalLen = readU32le(fragment, 12);
  const fragmentIndex = readU16le(fragment, 16);
  const fragmentCount = readU16le(fragment, 18);
  if (
    totalLen <= 0 || totalLen > DIRECT_FSP_TRANSPORT_MAX_REASSEMBLED_LEN
    || fragmentCount <= 1 || fragmentCount > DIRECT_FSP_TRANSPORT_MAX_FRAGMENTS
    || fragmentCount > totalLen || fragmentIndex >= fragmentCount
  ) {
    return undefined;
  }
  return { recordId, totalLen, fragmentIndex, fragmentCount };
}

export function segmentDirectFspTransportRecord(record: Uint8Array, pathMtu: number): Uint8Array[] {
  if (!Number.isSafeInteger(pathMtu) || pathMtu <= 0) {
    throw new RangeError("direct FSP path MTU must be a positive safe integer");
  }
  if (record.length <= pathMtu) return [record];
  if (record.length > DIRECT_FSP_TRANSPORT_MAX_REASSEMBLED_LEN) {
    throw new Error("direct FSP record exceeds reassembly limit");
  }
  const established = parseFspEstablished(record, false);
  if ((established.flags & FSP_FLAG_DIRECT_TRANSPORT) === 0) {
    throw new Error("segmented FSP record must use direct transport");
  }
  const maxPayload = pathMtu - DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN;
  if (maxPayload <= 0) throw new Error("direct FSP path MTU is too small for fragments");
  const fragmentCount = Math.ceil(record.length / maxPayload);
  if (fragmentCount <= 1 || fragmentCount > DIRECT_FSP_TRANSPORT_MAX_FRAGMENTS) {
    throw new Error("direct FSP record requires too many fragments");
  }

  const fragments: Uint8Array[] = new Array(fragmentCount);
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
    fragments[index] = fragment;
  }
  return fragments;
}

export class DirectFspTransportReassembler {
  private readonly entries = new Map<string, Reassembly>();
  private lastPruneMs = -Infinity;

  ingest(source: string, fragment: Uint8Array, nowMs: number): Uint8Array | undefined {
    if (!isDirectFspTransportFragment(fragment)) {
      throw new Error("packet is not a direct FSP transport fragment");
    }
    const header = parseFragmentHeader(fragment);
    if (!header) return undefined;
    if (this.entries.size > 0 && (nowMs - this.lastPruneMs >= PRUNE_INTERVAL_MS || nowMs < this.lastPruneMs)) {
      this.prune(nowMs);
    }
    const key = `${source}:${header.recordId.toString(16)}`;
    const entry = this.getOrResetEntry(key, header, nowMs);
    if (!entry.fragments[header.fragmentIndex]) {
      const payload = fragment.slice(DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN);
      if (entry.receivedBytes + payload.length > header.totalLen) {
        this.entries.delete(key);
        return undefined;
      }
      entry.fragments[header.fragmentIndex] = payload;
      entry.receivedBytes += payload.length;
      entry.missingFragments -= 1;
    }
    if (entry.missingFragments !== 0 || entry.receivedBytes !== header.totalLen) return undefined;
    const record = new Uint8Array(header.totalLen);
    let offset = 0;
    for (const part of entry.fragments) {
      record.set(part!, offset);
      offset += part!.length;
    }
    this.entries.delete(key);
    return offset === header.totalLen ? record : undefined;
  }

  clear(): void {
    this.entries.clear();
    this.lastPruneMs = -Infinity;
  }

  private getOrResetEntry(key: string, header: FragmentHeader, nowMs: number): Reassembly {
    const existing = this.entries.get(key);
    if (
      existing
      && nowMs - existing.createdAtMs <= REASSEMBLY_TTL_MS
      && existing.totalLen === header.totalLen
      && existing.fragments.length === header.fragmentCount
    ) {
      return existing;
    }
    if (existing) this.entries.delete(key);
    this.reserveEntry(nowMs);
    const entry: Reassembly = {
      createdAtMs: nowMs,
      totalLen: header.totalLen,
      receivedBytes: 0,
      missingFragments: header.fragmentCount,
      fragments: new Array<Uint8Array | undefined>(header.fragmentCount),
    };
    this.entries.set(key, entry);
    return entry;
  }

  private prune(nowMs: number): void {
    this.lastPruneMs = nowMs;
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.createdAtMs > REASSEMBLY_TTL_MS) this.entries.delete(key);
    }
  }

  private reserveEntry(nowMs: number): void {
    if (this.entries.size < MAX_REASSEMBLY_RECORDS) return;
    this.prune(nowMs);
    if (this.entries.size < MAX_REASSEMBLY_RECORDS) return;
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.createdAtMs < oldestTime) {
        oldestTime = entry.createdAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}
