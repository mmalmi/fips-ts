/**
 * Live interop test: TS BloomFilter ↔ Rust BloomFilter byte equality.
 *
 * The Rust bridge has a `bloom <numBits> <hashCount> [key-hex ...]` mode
 * that builds the filter and prints its `as_bytes()` as hex on stdout.
 * We build the equivalent filter in TS and compare byte arrays directly.
 *
 * Skipped if the bridge binary isn't built.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BloomFilter, bytesEqual, fromHex, toHex } from "../../src/index.js";

const BRIDGE = resolve(
  __dirname,
  "../../../../interop/rust-bridge/target/release/fips-rust-bridge",
);
const has = existsSync(BRIDGE);
const itIf = has ? it : it.skip;

function rustBloom(
  numBits: number,
  hashCount: number,
  keys: string[],
): Uint8Array {
  const out = execFileSync(
    BRIDGE,
    ["bloom", String(numBits), String(hashCount), ...keys],
    { encoding: "utf8" },
  ).trim();
  return fromHex(out);
}

describe("BloomFilter interop: TS bytes equal Rust bytes (live)", () => {
  itIf("empty filter at 256/4 matches byte-for-byte", () => {
    const rust = rustBloom(256, 4, []);
    const ts = BloomFilter.withParams(256, 4);
    expect(toHex(ts.asBytes())).toBe(toHex(rust));
  });

  itIf("two inserts at 256/4 match Rust bit positions", () => {
    const keys = ["deadbeef", "cafebabe"];
    const rust = rustBloom(256, 4, keys);
    const ts = BloomFilter.withParams(256, 4);
    for (const k of keys) ts.insertBytes(fromHex(k));
    expect(toHex(ts.asBytes())).toBe(toHex(rust));
    expect(bytesEqual(ts.asBytes(), rust)).toBe(true);
  });

  itIf("100 inserts at 1024/5 match byte-for-byte; both queries hit", () => {
    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      // Spread bits across the key so collisions don't trivialize the test.
      const k = new Uint8Array(16);
      k[0] = i & 0xff;
      k[1] = (i * 17) & 0xff;
      k[15] = (i * 31) & 0xff;
      keys.push(toHex(k));
    }
    const rust = rustBloom(1024, 5, keys);
    const ts = BloomFilter.withParams(1024, 5);
    for (const k of keys) ts.insertBytes(fromHex(k));
    expect(toHex(ts.asBytes())).toBe(toHex(rust));

    // And the TS filter can re-load the Rust bytes and still answer "contains".
    const reloaded = BloomFilter.fromBytes(rust, 5);
    for (const k of keys) {
      expect(reloaded.containsBytes(fromHex(k))).toBe(true);
    }
  });

  itIf("default-sized filter (8192 bits, 5 hashes) matches at 50 inserts", () => {
    const keys = Array.from({ length: 50 }, (_, i) => {
      const k = new Uint8Array(16);
      k[0] = i + 1;
      return toHex(k);
    });
    const rust = rustBloom(8192, 5, keys);
    const ts = BloomFilter.withParams(8192, 5);
    for (const k of keys) ts.insertBytes(fromHex(k));
    expect(toHex(ts.asBytes())).toBe(toHex(rust));
  });
});
