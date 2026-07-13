import { describe, expect, it } from "vitest";
import { heapStats, heapUsedMb } from "./heap";

describe("heap", () => {
  it("heapUsedMb returns a positive rounded megabyte value", () => {
    const value = heapUsedMb();
    expect(value).toBeGreaterThan(0);
    expect(value).toBe(Math.round(value * 10) / 10);
  });

  it("heapStats reports usage, delta from the start sample, and rss", () => {
    const stats = heapStats(1);
    expect(stats.heapUsedMb).toBeGreaterThan(0);
    expect(stats.rssMb).toBeGreaterThan(stats.heapUsedMb / 10);
    expect(stats.heapDeltaMb).toBeCloseTo(stats.heapUsedMb - 1, 1);
  });

  it("heapStats delta can be negative after a large start sample", () => {
    const stats = heapStats(1_000_000);
    expect(stats.heapDeltaMb).toBeLessThan(0);
  });
});
