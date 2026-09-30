import { describe, expect, it } from "vitest";

import { LearnedRouteTable } from "../src/node/LearnedRouteTable.js";

describe("Rust-compatible reply-learned route table", () => {
  it("reinforces successful paths and expires them after the configured TTL", () => {
    const table = new LearnedRouteTable();
    table.learn("dest", "slow", 1_000, 300, 4);
    table.learn("dest", "fast", 1_100, 300, 4);
    table.learn("dest", "fast", 1_200, 300, 4);

    expect(table.selectNextHop("dest", 1_300, () => true)).toBe("fast");
    expect(table.has("dest", 301_199)).toBe(true);
    expect(table.has("dest", 301_201)).toBe(false);
  });

  it("keeps at most four candidates and skips unsendable next hops", () => {
    const table = new LearnedRouteTable();
    for (let index = 0; index < 6; index += 1) {
      table.learn("dest", `hop-${index}`, 1_000 + index, 300, 4);
    }

    const selected = table.selectNextHop("dest", 2_000, (nextHop) => nextHop === "hop-5");
    expect(selected).toBe("hop-5");
  });

  it("retains each verified bottleneck without extending its lifetime on smaller replies", () => {
    const table = new LearnedRouteTable();
    table.learn("dest", "narrow", 1_000, 300, 4, 1280);
    table.learn("dest", "wide", 1_000, 300, 4, 4096);
    table.learn("dest", "narrow", 2_000, 300, 4);
    expect(table.pathMtu("dest", "narrow", 3_000)).toBe(1280);
    expect(table.pathMtu("dest", "wide", 3_000)).toBe(4096);
    expect(table.pathMtu("dest", "narrow", 301_001)).toBeUndefined();
    expect(table.has("dest", 301_001)).toBe(true);
    table.learn("dest", "narrow", 301_002, 300, 4, 1400);
    expect(table.pathMtu("dest", "narrow", 301_003)).toBe(1400);
  });

  it("decays failed paths so another live candidate wins", () => {
    const table = new LearnedRouteTable();
    table.learn("dest", "a", 1_000, 300, 4);
    table.learn("dest", "b", 1_000, 300, 4);
    table.recordFailure("dest", "a");

    expect(table.selectNextHop("dest", 2_000, () => true)).toBe("b");
  });
});
