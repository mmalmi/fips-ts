import { describe, expect, it } from "vitest";

import {
  COMPRESSED_PUBKEY_LENGTH,
  NODE_ADDR_LENGTH,
  deriveNodeAddr,
  fromHex,
  generateIdentity,
  toHex,
} from "../src/index.js";

describe("NodeAddr derivation (16-byte truncated SHA-256 of x-only pubkey)", () => {
  it("matches the SHA-256 prefix of the x-only pubkey", async () => {
    const id = await generateIdentity();
    expect(id.publicKey.length).toBe(COMPRESSED_PUBKEY_LENGTH);
    expect(id.nodeAddr.length).toBe(NODE_ADDR_LENGTH);
    // Verify deterministically: SHA-256(xOnly) starts with nodeAddr.
    const reDerived = deriveNodeAddr(id.xOnlyPubkey);
    expect(toHex(reDerived)).toBe(toHex(id.nodeAddr));
  });

  it("accepts compressed (33 bytes) and x-only (32 bytes) input", async () => {
    const id = await generateIdentity();
    const fromCompressed = deriveNodeAddr(id.publicKey);
    const fromXOnly = deriveNodeAddr(id.xOnlyPubkey);
    expect(toHex(fromCompressed)).toBe(toHex(fromXOnly));
  });

  it("rejects bad lengths and bad compressed prefix", () => {
    expect(() => deriveNodeAddr(new Uint8Array(31))).toThrow();
    expect(() => deriveNodeAddr(new Uint8Array(34))).toThrow();
    // 33 bytes but invalid prefix (must be 0x02 or 0x03):
    const bad = new Uint8Array(33);
    bad[0] = 0x04;
    expect(() => deriveNodeAddr(bad)).toThrow();
  });

  it("test_node_addr_from_slice: 16 bytes accepted; wrong length rejected", async () => {
    const { nodeAddrFromSlice } = await import("../src/index.js");
    const addr = nodeAddrFromSlice(new Uint8Array(NODE_ADDR_LENGTH));
    expect(addr.length).toBe(NODE_ADDR_LENGTH);
    expect(() => nodeAddrFromSlice(new Uint8Array(8))).toThrow();
    expect(() => nodeAddrFromSlice(new Uint8Array(20))).toThrow();
  });

  it("test_node_addr_ordering: NodeAddrs are comparable lexicographically", async () => {
    const { compareNodeAddr, generateIdentity } = await import("../src/index.js");
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const c = compareNodeAddr(id1.nodeAddr, id2.nodeAddr);
    expect([-1, 0, 1]).toContain(c);
    // A NodeAddr compares equal to itself.
    expect(compareNodeAddr(id1.nodeAddr, id1.nodeAddr)).toBe(0);
    // Mirror Rust's Ord: smaller-byte-first beats larger-byte-first.
    const lo = new Uint8Array(16);
    const hi = new Uint8Array(16);
    hi[0] = 1;
    expect(compareNodeAddr(lo, hi)).toBe(-1);
    expect(compareNodeAddr(hi, lo)).toBe(1);
  });

  it("vector: known x-only key derives expected nodeAddr", () => {
    // Test vector: x = sha256("test"); use as if it were an x-coord (this is
    // just a fixed 32-byte string for codec validation, not a real point).
    const xOnly = fromHex(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
    const addr = deriveNodeAddr(xOnly);
    // SHA-256 of that 32-byte string starts with these 16 bytes.
    // Verified independently with:
    //   echo -n <hex> | xxd -r -p | shasum -a 256
    expect(toHex(addr)).toBe("954d5a49fd70d9b8bcdb35d252267829");
  });
});
