import { describe, expect, it } from "vitest";

import { BinaryReader, BinaryWriter, fromHex, toHex } from "../src/index.js";

describe("BinaryWriter / BinaryReader (little-endian)", () => {
  it("hex decoding rejects incomplete bytes and partially valid pairs", () => {
    for (const malformed of ["0", "gg", "1g", "g1", " 1", "1 ", "+1", "-1", "0x"]) {
      expect(() => fromHex(malformed), malformed).toThrow();
    }
    expect(toHex(fromHex("00aAfF"))).toBe("00aaff");
    expect(fromHex("")).toEqual(new Uint8Array());
  });

  it("u8 round-trip", () => {
    const w = new BinaryWriter();
    w.u8(0x12);
    w.u8(0xff);
    w.u8(0x00);
    const buf = w.toBytes();
    expect(toHex(buf)).toBe("12ff00");
    const r = new BinaryReader(buf);
    expect(r.u8()).toBe(0x12);
    expect(r.u8()).toBe(0xff);
    expect(r.u8()).toBe(0x00);
  });

  it("u16le writes little-endian", () => {
    const w = new BinaryWriter();
    w.u16le(0x1234);
    expect(toHex(w.toBytes())).toBe("3412");
    expect(new BinaryReader(w.toBytes()).u16le()).toBe(0x1234);
  });

  it("u32le writes little-endian", () => {
    const w = new BinaryWriter();
    w.u32le(0xdeadbeef);
    expect(toHex(w.toBytes())).toBe("efbeadde");
    expect(new BinaryReader(w.toBytes()).u32le()).toBe(0xdeadbeef);
  });

  it("u64le writes little-endian", () => {
    const w = new BinaryWriter();
    w.u64le(0x0123456789abcdefn);
    expect(toHex(w.toBytes())).toBe("efcdab8967452301");
    expect(new BinaryReader(w.toBytes()).u64le()).toBe(0x0123456789abcdefn);
  });

  it("rejects out-of-range integers", () => {
    const w = new BinaryWriter();
    expect(() => w.u8(256)).toThrow();
    expect(() => w.u8(-1)).toThrow();
    expect(() => w.u16le(0x10000)).toThrow();
    expect(() => w.u32le(-1)).toThrow();
    expect(() => w.u64le(-1n)).toThrow();
  });

  it("BinaryReader rejects out-of-bounds reads", () => {
    const r = new BinaryReader(fromHex("01"));
    expect(() => r.u16le()).toThrow(/need 2/);
  });

  it("bytes() copies through", () => {
    const w = new BinaryWriter();
    w.u8(0xaa);
    w.bytes(fromHex("00112233"));
    w.u8(0xbb);
    expect(toHex(w.toBytes())).toBe("aa00112233bb");
  });
});
