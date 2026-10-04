import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { randomId } from "../src/WebRtcTransportSupport.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WebRTC session IDs", () => {
  it.each([true, false])("uses secure randomness with global crypto available: %s", (hasGlobalCrypto) => {
    if (!hasGlobalCrypto) vi.stubGlobal("crypto", undefined);
    const secureRandom = vi.spyOn(webcrypto, "getRandomValues");
    const insecureRandom = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const id = randomId();

    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(secureRandom).toHaveBeenCalledOnce();
    expect(secureRandom.mock.calls[0]?.[0]?.byteLength).toBe(16);
    expect(insecureRandom).not.toHaveBeenCalled();
  });

  it.each([true, false])("fails on entropy errors with global crypto available: %s", (hasGlobalCrypto) => {
    if (!hasGlobalCrypto) vi.stubGlobal("crypto", undefined);
    const failure = new Error("secure entropy unavailable");
    vi.spyOn(webcrypto, "getRandomValues").mockImplementation(() => { throw failure; });
    const insecureRandom = vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(() => randomId()).toThrow(failure);
    expect(insecureRandom).not.toHaveBeenCalled();
  });
});
