import { describe, expect, it } from "vitest";

import {
  DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN,
  DirectFspTransportReassembler,
  FSP_FLAG_DIRECT_TRANSPORT,
  encodeFspEstablished,
  isDirectFspTransportFragment,
  segmentDirectFspTransportRecord,
} from "../src/index.js";

describe("direct FSP transport segmentation", () => {
  it("matches the bounded Rust DFP1 header and reassembles out of order", () => {
    const counter = 0x0102_0304_0506_0708n;
    const record = encodeFspEstablished({
      flags: FSP_FLAG_DIRECT_TRANSPORT,
      counter,
      payloadLen: 3_984,
      ciphertext: new Uint8Array(4_000).map((_, index) => index & 0xff),
    });
    const fragments = segmentDirectFspTransportRecord(record, 320);

    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.every((fragment) => fragment.length <= 320)).toBe(true);
    expect(fragments.every(isDirectFspTransportFragment)).toBe(true);
    expect([...fragments[0].slice(0, 4)]).toEqual([0x44, 0x46, 0x50, 0x31]);
    expect([...fragments[0].slice(4, 12)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(fragments[0].length).toBe(320);
    expect(fragments[0].length - DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN).toBe(300);

    const reassembler = new DirectFspTransportReassembler();
    let reassembled: Uint8Array | undefined;
    const reverse = [...fragments].reverse();
    for (let index = 0; index < reverse.length; index += 1) {
      const fragment = reverse[index];
      reassembled = reassembler.ingest("ethernet:peer", fragment, 100 + index);
      if (index === 0) {
        expect(reassembler.ingest("ethernet:peer", fragment, 100 + index)).toBeUndefined();
      }
    }
    expect(reassembled).toEqual(record);
  });

  it("rejects records requiring more than the Rust-compatible fragment bound", () => {
    const record = encodeFspEstablished({
      flags: FSP_FLAG_DIRECT_TRANSPORT,
      counter: 1n,
      payloadLen: 480,
      ciphertext: new Uint8Array(496),
    });
    expect(() => segmentDirectFspTransportRecord(record, 21)).toThrow(/too many fragments/);
  });
});
