import { describe, expect, it } from "vitest";

import {
  decodeLookupRequest,
  decodeLookupResponse,
  encodeLookupRequestPayload,
  encodeLookupResponsePayload,
  nodeAddrFromSlice,
} from "../src/index.js";

function nodeAddr(fill: number) {
  return nodeAddrFromSlice(new Uint8Array(16).fill(fill));
}

describe("lookup discovery codec", () => {
  it("round-trips a LookupRequest payload", () => {
    const encoded = encodeLookupRequestPayload({
      requestId: 0x0102_0304_0506_0708n,
      target: nodeAddr(0x11),
      origin: nodeAddr(0x22),
      ttl: 7,
      minMtu: 1_200,
      originCoords: [nodeAddr(0x33), nodeAddr(0x44)],
    });

    expect(decodeLookupRequest(encoded)).toEqual({
      requestId: 0x0102_0304_0506_0708n,
      target: nodeAddr(0x11),
      origin: nodeAddr(0x22),
      ttl: 7,
      minMtu: 1_200,
      originCoords: [nodeAddr(0x33), nodeAddr(0x44)],
    });
  });

  it("round-trips a LookupResponse payload", () => {
    const proof = new Uint8Array(64).map((_, index) => index);
    const encoded = encodeLookupResponsePayload({
      requestId: 99n,
      target: nodeAddr(0x55),
      pathMtu: 1_180,
      targetCoords: [nodeAddr(0x66)],
      proof,
    });

    expect(decodeLookupResponse(encoded)).toEqual({
      requestId: 99n,
      target: nodeAddr(0x55),
      pathMtu: 1_180,
      targetCoords: [nodeAddr(0x66)],
      proof,
    });
  });

  it("rejects empty coordinates and trailing bytes", () => {
    expect(() => encodeLookupRequestPayload({
      requestId: 1n,
      target: nodeAddr(1),
      origin: nodeAddr(2),
      ttl: 1,
      minMtu: 0,
      originCoords: [],
    })).toThrow("coordinates");

    const response = encodeLookupResponsePayload({
      requestId: 2n,
      target: nodeAddr(3),
      pathMtu: 1_200,
      targetCoords: [nodeAddr(4)],
      proof: new Uint8Array(64),
    });
    const withTrailingByte = new Uint8Array(response.length + 1);
    withTrailingByte.set(response);
    expect(() => decodeLookupResponse(withTrailingByte)).toThrow("trailing");
  });
});
