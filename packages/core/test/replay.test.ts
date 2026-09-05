import { describe, expect, it } from "vitest";

import { ReplayWindow } from "../src/index.js";

describe("ReplayWindow", () => {
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

  it("matches a reference model across ring wrap, reordering and full-width jumps", () => {
    const w = new ReplayWindow();
    const seen = new Set<bigint>();
    let highest = 0n;
    const verify = (counter: bigint) => {
      const expected = counter >= 0n && counter < 0xffff_ffff_ffff_ffffn
        && highest - counter < WINDOW && !seen.has(counter);
      if (w.check(counter) !== expected || w.check(counter) !== expected
        || w.accept(counter) !== expected) {
        throw new Error(`replay mismatch at ${counter}, highest ${highest}`);
      }
      if (expected) {
        seen.add(counter);
        if (counter > highest) highest = counter;
      }
    };
    for (const start of [0n, 1n << 32n, 1n << 53n, 0xffff_ffff_ffff_ffffn - WINDOW * 3n]) {
      for (let offset = 0n; offset < WINDOW * 2n; offset += 1n) {
        verify(start + offset);
        verify(start + offset - WINDOW);
        verify(start + offset - 1n);
      }
      // Out-of-order packets on both sides of the retained-window boundary.
      verify(start + WINDOW * 3n);
      verify(start + WINDOW * 2n + 1n);
      verify(start + WINDOW * 2n);
    }
    verify(-1n);
    verify(0xffff_ffff_ffff_fffen);
    verify(0xffff_ffff_ffff_fffen);
    verify(0xffff_ffff_ffff_ffffn);
    verify(1n << 64n);
    expect(w.highest).toBe(highest);
  });

  it("test_replay_window_reset", () => {
    const w = new ReplayWindow();
    expect(w.accept(100n)).toBe(true);
    expect(w.highest).toBe(100n);
    expect(w.check(100n)).toBe(false);
    w.reset();
    expect(w.highest).toBe(0n);
    expect(w.check(100n)).toBe(true);
    expect(w.accept(100n)).toBe(true);
  });
});
