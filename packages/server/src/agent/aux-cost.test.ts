import { describe, expect, it } from "vitest";
import { AuxCostCollector, type AuxLlmCall, sumAuxCost } from "./aux-cost";

function call(overrides: Partial<AuxLlmCall> = {}): AuxLlmCall {
  return { op: "transcription", model: "whisper", costUsd: 0.01, source: "openrouter", ...overrides };
}

describe("AuxCostCollector", () => {
  it("collects records and returns them on drain", () => {
    const collector = new AuxCostCollector();
    collector.collect(call({ costUsd: 0.01 }));
    collector.collect(call({ op: "vision", costUsd: 0.02 }));
    expect(collector.drain()).toEqual([
      expect.objectContaining({ op: "transcription", costUsd: 0.01 }),
      expect.objectContaining({ op: "vision", costUsd: 0.02 }),
    ]);
  });

  it("empties after draining", () => {
    const collector = new AuxCostCollector();
    collector.collect(call());
    collector.drain();
    expect(collector.drain()).toEqual([]);
  });
});

describe("sumAuxCost", () => {
  it("sums every call's cost", () => {
    expect(sumAuxCost([call({ costUsd: 0.01 }), call({ costUsd: 0.02 }), call({ costUsd: 0.03 })])).toBeCloseTo(0.06);
  });

  it("treats non-finite costs as zero", () => {
    expect(sumAuxCost([call({ costUsd: Number.NaN }), call({ costUsd: 0.05 })])).toBe(0.05);
  });

  it("is zero for no calls", () => {
    expect(sumAuxCost([])).toBe(0);
  });
});
