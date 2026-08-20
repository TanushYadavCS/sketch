/**
 * The vector-stage display selection.
 *
 * Two bugs shipped in this logic while it lived inline in `search.ts`, both only
 * reachable through a Postgres integration test with dozens of seeded rows. The
 * randomised case below asserts the invariants over hundreds of shapes at once, so the
 * next one fails here rather than in a screenshot.
 */
import { describe, expect, it } from "vitest";
import type { VectorHitSource } from "./enrichment-stage-report";
import {
  type ScoredVector,
  VECTOR_HIT_DISPLAY_CAP,
  VECTOR_HIT_SOURCE_QUOTA,
  assertVectorTraceInvariants,
  rankVectorHits,
  selectVectorHitsForDisplay,
} from "./vector-trace-hits";

const SOURCES: VectorHitSource[] = ["content", "file_name", "summary", "image"];

/** Deterministic pseudo-randomness — a failure has to be reproducible from its seed. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function makeScored(seed: number, count: number, fileCount: number): ScoredVector[] {
  const random = makeRandom(seed);
  return Array.from({ length: count }, () => ({
    fileId: `file-${Math.floor(random() * fileCount)}`,
    source: SOURCES[Math.floor(random() * SOURCES.length)] as VectorHitSource,
    preview: "text",
    distance: Math.round(random() * 10000) / 10000,
  }));
}

describe("rankVectorHits", () => {
  it("ranks by ascending distance and credits one vector per file", () => {
    const ranked = rankVectorHits([
      { fileId: "a", source: "content", preview: "chunk", distance: 0.5 },
      { fileId: "a", source: "summary", preview: "summary", distance: 0.1 },
      { fileId: "b", source: "file_name", preview: "name", distance: 0.3 },
    ]);

    expect(ranked.map((hit) => [hit.rank, hit.source, hit.bestForFile])).toEqual([
      [1, "summary", true],
      [2, "file_name", true],
      [3, "content", false],
    ]);
  });

  it("credits exactly one vector when two of a file's vectors tie at the same distance", () => {
    const ranked = rankVectorHits([
      { fileId: "a", source: "content", preview: "chunk", distance: 0.25 },
      { fileId: "a", source: "summary", preview: "summary", distance: 0.25 },
    ]);

    expect(ranked.filter((hit) => hit.bestForFile)).toHaveLength(1);
  });
});

describe("selectVectorHitsForDisplay", () => {
  it("keeps a source that scored, even when another source could fill the cap alone", () => {
    const templatedNames: ScoredVector[] = Array.from({ length: 200 }, (_, index) => ({
      fileId: `name-${index}`,
      source: "file_name",
      preview: `WhatsApp: Internal OW - ${index}`,
      distance: 0.4 + index * 0.0001,
    }));
    const oneSummary: ScoredVector = { fileId: "s", source: "summary", preview: "far", distance: 0.9 };

    const shown = selectVectorHitsForDisplay(rankVectorHits([...templatedNames, oneSummary]));

    expect(shown.filter((hit) => hit.source === "summary")).toHaveLength(1);
    expect(shown.find((hit) => hit.source === "summary")?.rank).toBe(201);
  });

  it("never shows a file only through a vector that lost it", () => {
    /** One file reachable solely by a name vector ranked below every other name. */
    const winners: ScoredVector[] = Array.from({ length: 60 }, (_, index) => ({
      fileId: `f-${index}`,
      source: "content",
      preview: "body",
      distance: 0.1 + index * 0.001,
    }));
    const losers: ScoredVector[] = Array.from({ length: 20 }, (_, index) => ({
      fileId: `f-${index}`,
      source: "file_name",
      preview: "name",
      distance: 0.5 + index * 0.001,
    }));
    const onlyByName: ScoredVector = { fileId: "f-lonely", source: "file_name", preview: "name", distance: 0.9 };

    const shown = selectVectorHitsForDisplay(rankVectorHits([...winners, ...losers, onlyByName]));

    expect(shown.some((hit) => hit.fileId === "f-lonely" && hit.bestForFile)).toBe(true);
  });

  it("fills the slots left after the quotas with the best remaining ranks", () => {
    /**
     * Source A owns ranks 1-15 and 36-40, source B owns 16-35, every row its own file so
     * all are representatives. Both quotas fill, leaving two slots. Those must go to
     * ranks 31 and 32 — the best rows still unshown — not to source A's leftovers at 36
     * and 37, which is what happens if the remainder keeps its per-source grouping
     * instead of being put back into global order.
     */
    const sourceFor = (rank: number): VectorHitSource => (rank <= 15 || rank >= 36 ? "content" : "file_name");
    const scored: ScoredVector[] = Array.from({ length: 40 }, (_, index) => ({
      fileId: `f-${index}`,
      source: sourceFor(index + 1),
      preview: "text",
      distance: (index + 1) * 0.001,
    }));

    const shown = selectVectorHitsForDisplay(rankVectorHits(scored), 32, 15);

    expect(shown).toHaveLength(32);
    const ranks = shown.map((hit) => hit.rank);
    expect(ranks).toContain(31);
    expect(ranks).toContain(32);
    expect(ranks).not.toContain(36);
  });

  it("never lets a source's quota strand a winner in another source", () => {
    /**
     * The cross-source form of the same bug: `summary` fills its quota with z, `content`
     * fills its quota with y's losing vector, the cap is reached, and y's winning summary
     * vector — better ranked than the loser that displaced it — is dropped.
     */
    const shown = selectVectorHitsForDisplay(
      rankVectorHits([
        { fileId: "z", source: "summary", preview: "", distance: 0.1 },
        { fileId: "y", source: "summary", preview: "", distance: 0.2 },
        { fileId: "y", source: "content", preview: "", distance: 0.3 },
      ]),
      2,
      1,
    );

    expect(shown.map((hit) => hit.rank)).toEqual([1, 2]);
    expect(shown.every((hit) => hit.bestForFile)).toBe(true);
  });

  it("holds every invariant across randomised shapes", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const count = 1 + (seed % 240);
      const fileCount = 1 + (seed % 40);
      const ranked = rankVectorHits(makeScored(seed, count, fileCount));

      /** Small caps and quotas are where the starvation cases live. */
      const cap = 1 + (seed % VECTOR_HIT_DISPLAY_CAP);
      const quota = 1 + (seed % VECTOR_HIT_SOURCE_QUOTA);
      for (const [thisCap, thisQuota] of [
        [VECTOR_HIT_DISPLAY_CAP, VECTOR_HIT_SOURCE_QUOTA],
        [cap, quota],
      ] as const) {
        const shown = selectVectorHitsForDisplay(ranked, thisCap, thisQuota);
        const broken = assertVectorTraceInvariants(ranked, shown, thisCap, thisQuota);
        expect({ seed, thisCap, thisQuota, broken }).toEqual({ seed, thisCap, thisQuota, broken: [] });
      }
    }
  });

  it("shows everything when there is less than a capful", () => {
    const ranked = rankVectorHits(makeScored(7, 12, 12));
    expect(selectVectorHitsForDisplay(ranked)).toHaveLength(12);
  });

  it("returns nothing for nothing", () => {
    expect(selectVectorHitsForDisplay(rankVectorHits([]))).toEqual([]);
  });

  it("gives a lone source the whole cap rather than only its quota", () => {
    const ranked = rankVectorHits(
      Array.from({ length: 200 }, (_, index) => ({
        fileId: `f-${index}`,
        source: "content" as VectorHitSource,
        preview: "body",
        distance: index * 0.001,
      })),
    );
    const shown = selectVectorHitsForDisplay(ranked);

    expect(shown).toHaveLength(VECTOR_HIT_DISPLAY_CAP);
    expect(VECTOR_HIT_SOURCE_QUOTA).toBeLessThan(VECTOR_HIT_DISPLAY_CAP);
  });
});
