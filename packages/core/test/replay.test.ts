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

  // Ported from Rust ~/src/fips/crates/fips-core/src/noise/tests.rs.
  const WINDOW = ReplayWindow.WINDOW;

  it("test_replay_window_large_jump", () => {
    const w = new ReplayWindow();
    expect(w.accept(0n)).toBe(true);
    expect(w.accept(WINDOW + 100n)).toBe(true);
    // Old counters now outside the window.
    expect(w.check(0n)).toBe(false);
    expect(w.check(50n)).toBe(false);
    // Counters within the new window still acceptable.
    expect(w.check(WINDOW + 99n)).toBe(true);
    expect(w.check(WINDOW + 50n)).toBe(true);
  });

  it("test_replay_window_boundary", () => {
    const w = new ReplayWindow();
    expect(w.accept(WINDOW - 1n)).toBe(true);
    // Counter 0 is exactly at the edge of the window.
    expect(w.check(0n)).toBe(true);
    expect(w.accept(0n)).toBe(true);
    // Move window forward by 1.
    expect(w.accept(WINDOW)).toBe(true);
    // Counter 0 now outside.
    expect(w.check(0n)).toBe(false);
    // Counter 1 still in window.
    expect(w.check(1n)).toBe(true);
  });

  it("test_replay_window_sequential", () => {
    const w = new ReplayWindow();
    for (let i = 0; i < 1000; i++) {
      expect(w.check(BigInt(i))).toBe(true);
      expect(w.accept(BigInt(i))).toBe(true);
    }
    for (let i = 0; i < 1000; i++) {
      expect(w.check(BigInt(i))).toBe(false);
    }
    expect(w.highest).toBe(999n);
  });

  it("test_replay_window_reset", () => {
    const w = new ReplayWindow();
    expect(w.accept(100n)).toBe(true);
    expect(w.highest).toBe(100n);
    expect(w.check(100n)).toBe(false);
    w.reset();
    expect(w.highest).toBe(0n);
    expect(w.check(100n)).toBe(true);
  });
});
