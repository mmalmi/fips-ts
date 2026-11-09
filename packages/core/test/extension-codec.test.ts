import { describe, expect, it } from "vitest";

import {
  decodeExtensionCapabilities,
  decodeLinkExtension,
  encodeExtensionCapabilities,
  encodeExtensionClientOnly,
} from "../src/protocol/extensions.js";

const prefix = [0x46, 0x49, 0x50, 0x53, 0x2d, 0x45, 0x58, 0x54, 1];

describe("authenticated extension wire contract", () => {
  it("uses the exact FSP request and FMP response wire vectors", () => {
    expect([...encodeExtensionCapabilities(1, 1)]).toEqual([...prefix, 1, 1, 0]);
    expect([...encodeExtensionCapabilities(2, 2)]).toEqual([...prefix, 2, 2, 0]);
    expect(decodeExtensionCapabilities(new Uint8Array([...prefix, 2, 1, 0])))
      .toEqual({ kind: 2, capabilities: 1 });
  });

  it("decodes capability bits without giving unknown bits a meaning", () => {
    expect(decodeExtensionCapabilities(new Uint8Array([...prefix, 1, 2, 0x80])))
      .toEqual({ kind: 1, capabilities: 0x8002 });
  });

  it("rejects truncated, extended, wrong magic, version and kind messages", () => {
    const valid = new Uint8Array([...prefix, 1, 1, 0]);
    for (let size = 0; size < valid.length; size++) {
      expect(decodeExtensionCapabilities(valid.subarray(0, size))).toBeUndefined();
    }
    expect(decodeExtensionCapabilities(new Uint8Array([...valid, 0]))).toBeUndefined();
    for (const [index, value] of [[0, 0], [8, 2], [9, 0], [9, 3], [9, 255]]) {
      const invalid = valid.slice();
      invalid[index!] = value!;
      expect(decodeExtensionCapabilities(invalid)).toBeUndefined();
    }
  });

  it("uses an exact little-endian u64 for a namespaced client role", () => {
    const bytes = new Uint8Array([...prefix, 3, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect([...encodeExtensionClientOnly(0x0102030405060708n)]).toEqual([...bytes]);
    expect(decodeLinkExtension(bytes)).toEqual({ kind: 3, sequence: 0x0102030405060708n });
    expect(decodeLinkExtension(bytes.subarray(0, 17))).toBeUndefined();
    expect(decodeLinkExtension(new Uint8Array([...bytes, 0]))).toBeUndefined();
  });

  it("ignores listener messages and unknown namespaced kinds", () => {
    expect(decodeLinkExtension(new Uint8Array([...prefix, 4, 1, 1, 1]))).toBeUndefined();
    expect(decodeLinkExtension(new Uint8Array([...prefix, 255]))).toBeUndefined();
    expect(decodeLinkExtension(new Uint8Array([...prefix.slice(0, 8), 2, 1, 2, 0])))
      .toBeUndefined();
  });
});
