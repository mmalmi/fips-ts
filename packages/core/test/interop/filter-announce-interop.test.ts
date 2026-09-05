/**
 * Live byte-equality interop: TS FilterAnnounce wire bytes match Rust's
 * `FilterAnnounce::encode` output for the same inputs.
 *
 * The Rust bridge has a `filter-announce <sequence> [key-hex ...]` mode that
 * builds a v1 FilterAnnounce (8192-bit / 5-hash filter) and prints the full
 * encoded bytes as hex.
 *
 * Skipped if the bridge binary isn't built.
 */

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  BloomFilter,
  DEFAULT_FILTER_SIZE_BITS,
  DEFAULT_HASH_COUNT,
  buildFilterAnnounce,
  decodeFilterAnnounce,
  encodeFilterAnnounce,
  fromHex,
  toHex,
} from "../../src/index.js";
import { bridgeAvailable, BRIDGE_BIN as BRIDGE } from "./bridge.js";

const itIf = bridgeAvailable() ? it : it.skip;

function rustFilterAnnounce(sequence: bigint, keys: string[]): Uint8Array {
  const out = execFileSync(
    BRIDGE,
    ["filter-announce", sequence.toString(), ...keys],
    { encoding: "utf8" },
  ).trim();
  return fromHex(out);
}

function tsFilterAnnounce(sequence: bigint, keys: string[]): Uint8Array {
  const filter = BloomFilter.withParams(DEFAULT_FILTER_SIZE_BITS, DEFAULT_HASH_COUNT);
  for (const k of keys) filter.insertBytes(fromHex(k));
  return encodeFilterAnnounce(buildFilterAnnounce(filter, sequence));
}

describe("FilterAnnounce interop: TS wire bytes == Rust wire bytes", () => {
  itIf("empty filter (sequence=42) matches byte-for-byte", () => {
    const rust = rustFilterAnnounce(42n, []);
    const ts = tsFilterAnnounce(42n, []);
    expect(toHex(ts)).toBe(toHex(rust));
    // Sanity: TS decode roundtrips.
    const back = decodeFilterAnnounce(ts);
    expect(back.sequence).toBe(42n);
    expect(back.hashCount).toBe(DEFAULT_HASH_COUNT);
  });

  itIf("two-key insert at sequence=7", () => {
    const keys = ["deadbeef", "cafebabe"];
    const rust = rustFilterAnnounce(7n, keys);
    const ts = tsFilterAnnounce(7n, keys);
    expect(toHex(ts)).toBe(toHex(rust));
  });

  itIf("100-key insert at sequence=0x0102030405060708", () => {
    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      const k = new Uint8Array(16);
      k[0] = i & 0xff;
      k[1] = (i * 17) & 0xff;
      k[15] = (i * 31) & 0xff;
      keys.push(toHex(k));
    }
    const seq = 0x0102030405060708n;
    const rust = rustFilterAnnounce(seq, keys);
    const ts = tsFilterAnnounce(seq, keys);
    expect(toHex(ts)).toBe(toHex(rust));

    // And TS can decode the Rust output to recover the same filter.
    const decoded = decodeFilterAnnounce(rust);
    expect(decoded.sequence).toBe(seq);
    for (const k of keys) {
      expect(decoded.filter.containsBytes(fromHex(k))).toBe(true);
    }
  });
});
