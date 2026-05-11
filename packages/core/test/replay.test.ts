import { describe, expect, it } from "vitest";

import { ReplayWindow } from "../src/index.js";

describe("ReplayWindow", () => {
  it("accepts strictly-increasing counters", () => {
    const w = new ReplayWindow();
    expect(w.accept(0n)).toBe(true);
    expect(w.accept(1n)).toBe(true);
    expect(w.accept(2n)).toBe(true);
    expect(w.accept(100n)).toBe(true);
  });

  it("rejects duplicates within window", () => {
    const w = new ReplayWindow();
    expect(w.accept(5n)).toBe(true);
    expect(w.accept(5n)).toBe(false);
  });

  it("rejects counters far below window", () => {
    const w = new ReplayWindow();
    expect(w.accept(5000n)).toBe(true);
    expect(w.accept(0n)).toBe(false);
  });

  it("accepts out-of-order but still inside window", () => {
    const w = new ReplayWindow();
    expect(w.accept(100n)).toBe(true);
    expect(w.accept(95n)).toBe(true);
    expect(w.accept(95n)).toBe(false);
  });
});
