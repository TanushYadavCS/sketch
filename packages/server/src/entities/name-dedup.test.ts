import { describe, expect, it } from "vitest";
import {
  buildCandidatePool,
  findDedupCandidates,
  findFuzzyMatch,
  jaccard,
  lshBands,
  minhashSignature,
  shingles,
} from "./name-dedup";

describe("name-dedup", () => {
  it("strict-normalizes whitespace, casing, and punctuation", () => {
    const pool = buildCandidatePool([{ entityId: "redseer", valueKind: "name", value: "Redseer Consulting" }]);

    expect(findFuzzyMatch("RedseerConsulting", pool)).toMatchObject({ entityId: "redseer", score: 1 });
    expect(findFuzzyMatch("REDSEER consulting", pool)).toMatchObject({ entityId: "redseer", score: 1 });
    expect(findFuzzyMatch("Redseer  Consulting", pool)).toMatchObject({ entityId: "redseer", score: 1 });
  });

  it("uses spaces-in, no-padding 3-grams for the typo acceptance case", () => {
    const existing = shingles("Apperture Technologies");
    const proposed = shingles("Aperture Technologies");
    const score = jaccard(existing, proposed);

    expect(score).toBeCloseTo(18 / 21, 6);

    const existingBands = new Set(lshBands(minhashSignature(existing)));
    const proposedBands = lshBands(minhashSignature(proposed));
    expect(proposedBands.some((band) => existingBands.has(band))).toBe(true);
    const pinnedSharedBand = "2:012805ecd75c9f08:05afe1752c9b0fe1:1709b7f28c96be6d:117d40be1d2ccf14";
    expect(existingBands.has(pinnedSharedBand)).toBe(true);
    expect(proposedBands).toContain(pinnedSharedBand);

    const pool = buildCandidatePool([{ entityId: "apperture", valueKind: "name", value: "Apperture Technologies" }]);
    expect(findDedupCandidates("Aperture Technologies", pool, { threshold: 0.85 })).toEqual([
      { entityId: "apperture", score, valueKind: "name", value: "Apperture Technologies" },
    ]);
  });

  it("does not collide short or low-entropy names", () => {
    const sarahPool = buildCandidatePool([{ entityId: "saran", valueKind: "name", value: "Saran" }]);
    const initialsPool = buildCandidatePool([{ entityId: "kp", valueKind: "name", value: "KP" }]);

    expect(findFuzzyMatch("Sarah", sarahPool)).toBeNull();
    expect(findFuzzyMatch("KT", initialsPool)).toBeNull();
  });
});
