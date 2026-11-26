/**
 * BloomFilter tests ported from Rust
 * ~/src/fips/crates/fips-core/src/bloom/tests.rs.
 */

import { sha256 } from "@noble/hashes/sha256";
import { describe, expect, it } from "vitest";

import {
  BloomError,
  BloomFilter,
  DEFAULT_FILTER_SIZE_BITS,
  DEFAULT_HASH_COUNT,
  bytesEqual,
} from "../src/index.js";

function makeNodeAddr(val: number): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes[0] = val;
  return bytes;
}

describe("BloomFilter (Rust bloom/tests.rs)", () => {
  it("test_bloom_filter_new: default params, empty", () => {
    const f = BloomFilter.empty();
    expect(f.numBits).toBe(DEFAULT_FILTER_SIZE_BITS);
    expect(f.hashCount).toBe(DEFAULT_HASH_COUNT);
    expect(f.countOnes()).toBe(0);
    expect(f.isEmpty()).toBe(true);
  });

  it("test_bloom_filter_insert_contains: insert one, query both", () => {
    const f = BloomFilter.empty();
    const a = makeNodeAddr(1);
    const b = makeNodeAddr(2);

    expect(f.containsBytes(a)).toBe(false);
    expect(f.containsBytes(b)).toBe(false);

    f.insertBytes(a);
    expect(f.containsBytes(a)).toBe(true);
    expect(f.isEmpty()).toBe(false);
  });

  it("test_bloom_filter_multiple_inserts: 100 inserts all retrievable, fill ratio sensible", () => {
    const f = BloomFilter.empty();
    for (let i = 0; i < 100; i++) f.insertBytes(makeNodeAddr(i));
    for (let i = 0; i < 100; i++) {
      expect(f.containsBytes(makeNodeAddr(i))).toBe(true);
    }
    const fr = f.fillRatio();
    expect(fr).toBeGreaterThan(0);
    expect(fr).toBeLessThan(0.5);
  });

  it("test_bloom_filter_merge: in-place union", () => {
    const f1 = BloomFilter.empty();
    const f2 = BloomFilter.empty();
    f1.insertBytes(makeNodeAddr(1));
    f2.insertBytes(makeNodeAddr(2));
    f1.merge(f2);
    expect(f1.containsBytes(makeNodeAddr(1))).toBe(true);
    expect(f1.containsBytes(makeNodeAddr(2))).toBe(true);
  });

  it("test_bloom_filter_union: produces fresh filter, originals unchanged", () => {
    const f1 = BloomFilter.empty();
    const f2 = BloomFilter.empty();
    f1.insertBytes(makeNodeAddr(1));
    f2.insertBytes(makeNodeAddr(2));
    const u = f1.union(f2);
    expect(u.containsBytes(makeNodeAddr(1))).toBe(true);
    expect(u.containsBytes(makeNodeAddr(2))).toBe(true);
    expect(f1.containsBytes(makeNodeAddr(2))).toBe(false);
    expect(f2.containsBytes(makeNodeAddr(1))).toBe(false);
  });

  it("test_bloom_filter_clear: cleared filter is empty", () => {
    const f = BloomFilter.empty();
    const n = makeNodeAddr(1);
    f.insertBytes(n);
    expect(f.isEmpty()).toBe(false);
    f.clear();
    expect(f.isEmpty()).toBe(true);
    expect(f.countOnes()).toBe(0);
    expect(f.containsBytes(n)).toBe(false);
  });

  it("test_bloom_filter_merge_size_mismatch: differing num_bits rejected", () => {
    const f1 = BloomFilter.withParams(1024, 7);
    const f2 = BloomFilter.withParams(2048, 7);
    expect(() => f1.merge(f2)).toThrow(BloomError);
  });

  it("test_bloom_filter_custom_params: with_params honors sizes", () => {
    const f = BloomFilter.withParams(1024, 5);
    expect(f.numBits).toBe(1024);
    expect(f.numBytes).toBe(128);
    expect(f.hashCount).toBe(5);
  });

  it("test_bloom_filter_invalid_params: rejects bad sizes / zero hash count", () => {
    expect(() => BloomFilter.withParams(1001, 7)).toThrow(BloomError);
    expect(() => BloomFilter.withParams(0, 7)).toThrow(BloomError);
    expect(() => BloomFilter.withParams(1024, 0)).toThrow(BloomError);
  });

  it("test_bloom_filter_from_bytes: round-trips equal bytes/hashCount", () => {
    const original = BloomFilter.empty();
    original.insertBytes(makeNodeAddr(42));
    const restored = BloomFilter.fromBytes(original.asBytes(), original.hashCount);
    expect(restored.numBits).toBe(original.numBits);
    expect(restored.hashCount).toBe(original.hashCount);
    expect(bytesEqual(restored.asBytes(), original.asBytes())).toBe(true);
    expect(restored.containsBytes(makeNodeAddr(42))).toBe(true);
  });

  it("test_bloom_filter_from_bytes_empty: empty bytes rejected", () => {
    expect(() => BloomFilter.fromBytes(new Uint8Array(0), 5)).toThrow(BloomError);
  });

  it("test_bloom_filter_from_bytes_zero_hash_count: zero hashCount rejected", () => {
    expect(() => BloomFilter.fromBytes(new Uint8Array(128), 0)).toThrow(BloomError);
  });

  it("no false negatives across a wider keyset", () => {
    const f = BloomFilter.empty();
    const keys: Uint8Array[] = [];
    for (let i = 0; i < 200; i++) {
      const k = new Uint8Array(16);
      // Spread the entropy so different keys don't collide trivially.
      k[0] = i & 0xff;
      k[1] = (i * 17) & 0xff;
      k[15] = (i * 31) & 0xff;
      f.insertBytes(k);
      keys.push(k);
    }
    for (const k of keys) {
      expect(f.containsBytes(k)).toBe(true);
    }
  });

  it("matches reference SHA-256 double-hashing for power-of-two and non-power-of-two sizes", () => {
    const referenceBits = (data: Uint8Array, numBits: number, hashCount: number): Uint8Array => {
      const digest = sha256(data);
      const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
      const h1 = view.getBigUint64(0, true);
      const h2 = view.getBigUint64(8, true);
      const out = new Uint8Array(numBits / 8);
      for (let i = 0n; i < BigInt(hashCount); i++) {
        const bit = Number(((h1 + i * h2) & 0xffff_ffff_ffff_ffffn) % BigInt(numBits));
        out[bit >>> 3] = (out[bit >>> 3]! | (1 << (bit & 7))) & 0xff;
      }
      return out;
    };

    for (const numBits of [DEFAULT_FILTER_SIZE_BITS, 240]) {
      const f = BloomFilter.withParams(numBits, 5);
      const key = makeNodeAddr(0xa5);
      key[15] = 0x5a;
      f.insertBytes(key);
      expect(bytesEqual(f.asBytes(), referenceBits(key, numBits, 5))).toBe(true);
      expect(f.containsBytes(key)).toBe(true);
    }
  });

  it("compares filters accurately with equals()", () => {
    const a = BloomFilter.empty();
    const b = BloomFilter.empty();
    expect(a.equals(b)).toBe(true);
    a.insertBytes(makeNodeAddr(7));
    expect(a.equals(b)).toBe(false);
    b.insertBytes(makeNodeAddr(7));
    expect(a.equals(b)).toBe(true);
    expect(a.equals(BloomFilter.withParams(1024, DEFAULT_HASH_COUNT))).toBe(false);
    expect(a.equals(BloomFilter.withParams(DEFAULT_FILTER_SIZE_BITS, 3))).toBe(false);
  });

  it("supports precomputed SHA-256 digests and zero-allocation copyInto()", () => {
    for (const numBits of [DEFAULT_FILTER_SIZE_BITS, 240]) {
      const f = BloomFilter.withParams(numBits, 5);
      const present = makeNodeAddr(0x11);
      const absent = makeNodeAddr(0x22);
      f.insertBytes(present);
      expect(f.containsDigest(sha256(present))).toBe(true);
      expect(f.containsDigest(sha256(absent))).toBe(false);
      const dest = new Uint8Array(f.numBytes + 6).fill(0xee);
      f.copyInto(dest, 3);
      expect(bytesEqual(dest.subarray(3, 3 + f.numBytes), f.asBytes())).toBe(true);
      expect(dest[2]).toBe(0xee);
      expect(dest[3 + f.numBytes]).toBe(0xee);
    }
  });
});
