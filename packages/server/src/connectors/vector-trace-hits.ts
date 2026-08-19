/**
 * Ranking and display selection for the vector stage of a search trace.
 *
 * Pure, and separate from `search.ts` on purpose. This logic decides what a developer
 * sees when they ask why a file ranked where it did, and both bugs found in it so far
 * were only reachable through a Postgres integration test with dozens of seeded rows —
 * expensive enough to write that the cases went untested. Here it is a plain function
 * over plain data, so the invariants below can be asserted directly.
 *
 * The invariants, which `assertVectorTraceInvariants` checks and the tests enforce:
 *  1. Ranks are global over every scored vector, so a row held back still shows how far
 *     down it really was.
 *  2. No file appears only through a vector that lost it. Showing a red row whose green
 *     counterpart is off the page misreports the one comparison the stage exists to make.
 *  3. Every source that scored anything is represented, up to its quota.
 *  4. Output is capped, deduplicated, and in ascending rank order.
 */
import type { VectorChunkHit, VectorHitSource } from "./enrichment-stage-report";

/** Rows the trace will show. */
export const VECTOR_HIT_DISPLAY_CAP = 60;

/**
 * Display slots each source is guaranteed before the cap is filled by global rank.
 * Four sources at 15 exactly fills the cap in the worst case.
 */
export const VECTOR_HIT_SOURCE_QUOTA = 15;

export interface ScoredVector {
  fileId: string;
  source: VectorHitSource;
  preview: string;
  distance: number;
}

/**
 * Ranks every scored vector globally and marks the one that carried each file.
 *
 * Ascending distance means the first vector seen for a file is its representative, so a
 * claim set beats comparing floats and stays correct when two vectors of the same file
 * tie at exactly the same distance.
 */
export function rankVectorHits(scored: ScoredVector[]): VectorChunkHit[] {
  const ordered = [...scored].sort((a, b) => a.distance - b.distance);
  const claimed = new Set<string>();
  return ordered.map((hit, index) => {
    const bestForFile = !claimed.has(hit.fileId);
    claimed.add(hit.fileId);
    return {
      rank: index + 1,
      fileId: hit.fileId,
      source: hit.source,
      chunkPreview: hit.preview,
      distance: hit.distance,
      similarity: Math.max(0, 1 - hit.distance),
      bestForFile,
    };
  });
}

/**
 * Picks the rows to display from the full ranked list.
 *
 * A flat top-N is unreadable on a corpus with templated file names: names like
 * `WhatsApp: Internal OW - <timestamp>` differ only in the timestamp, so their vectors
 * sit ~0.13 apart on average and a name-shaped query pulls all of them into one tight
 * band that fills the cap. The stage then shows zero summary rows while the summary arm
 * was scoring normally — an artefact that reads exactly like a broken feature.
 *
 * Hence a per-source quota. And within a source the representatives take the slots
 * first: filling by global rank alone lets a source spend all of its slots on rows that
 * lost their file and then drop the row that won it.
 */
export function selectVectorHitsForDisplay(
  ranked: VectorChunkHit[],
  cap: number = VECTOR_HIT_DISPLAY_CAP,
  quotaPerSource: number = VECTOR_HIT_SOURCE_QUOTA,
): VectorChunkHit[] {
  /** Ranks are unique across the whole list, so they key the chosen set. */
  const chosen = new Map<number, VectorChunkHit>();
  const winnerShownFor = new Set<string>();

  /**
   * Pass one seats winners only, each source up to its quota, in global rank order. Every
   * source that won a file therefore appears, and no source can spend its quota on rows
   * that lost.
   */
  const usedBySource = new Map<VectorHitSource, number>();
  for (const hit of ranked) {
    if (chosen.size >= cap) break;
    if (!hit.bestForFile) continue;
    const used = usedBySource.get(hit.source) ?? 0;
    if (used >= quotaPerSource) continue;
    usedBySource.set(hit.source, used + 1);
    chosen.set(hit.rank, hit);
    winnerShownFor.add(hit.fileId);
  }

  /**
   * Pass two fills what is left by global rank. A row that lost may only take a slot when
   * the row it lost to is already on the page — otherwise the file shows up represented
   * by its worse vector while the better one is invisible, under a caption saying it
   * "lost to a closer vector of the same file".
   */
  for (const hit of ranked) {
    if (chosen.size >= cap) break;
    if (chosen.has(hit.rank)) continue;
    if (!hit.bestForFile && !winnerShownFor.has(hit.fileId)) continue;
    chosen.set(hit.rank, hit);
    if (hit.bestForFile) winnerShownFor.add(hit.fileId);
  }

  return [...chosen.values()].sort((a, b) => a.rank - b.rank);
}

/**
 * Returns the invariants the selection broke, or an empty array.
 *
 * Exported so tests can assert the whole class of failure rather than one seeded case at
 * a time. Not called in the hot path — a trace that is slightly wrong is worth less than
 * a search that is slow.
 */
export function assertVectorTraceInvariants(
  ranked: VectorChunkHit[],
  shown: VectorChunkHit[],
  cap: number,
  quotaPerSource: number = VECTOR_HIT_SOURCE_QUOTA,
): string[] {
  const broken: string[] = [];

  if (shown.length > cap) broken.push(`shown ${shown.length} exceeds cap ${cap}`);

  const seen = new Set<string>();
  for (const hit of shown) {
    const key = `${hit.fileId}:${hit.rank}`;
    if (seen.has(key)) broken.push(`duplicate row ${key}`);
    seen.add(key);
  }

  for (let i = 1; i < shown.length; i++) {
    const previous = shown[i - 1];
    const current = shown[i];
    if (previous && current && previous.rank >= current.rank) {
      broken.push(`rank order broken at ${i}: ${previous.rank} then ${current.rank}`);
    }
  }

  const winnerShown = new Set(shown.filter((hit) => hit.bestForFile).map((hit) => hit.fileId));
  for (const hit of shown) {
    if (!winnerShown.has(hit.fileId)) {
      broken.push(`file ${hit.fileId} is shown only through a vector that lost it`);
    }
  }

  /**
   * The guarantee is over winners, not over every row: a source's job in the trace is to
   * show the files it carried. It is only checkable when the cap can seat every source's
   * full quota — below that the cap itself is the binding constraint, not the selection.
   */
  const winnersBySource = new Map<VectorHitSource, number>();
  for (const hit of ranked) {
    if (hit.bestForFile) winnersBySource.set(hit.source, (winnersBySource.get(hit.source) ?? 0) + 1);
  }
  const shownBySource = new Map<VectorHitSource, number>();
  for (const hit of shown) shownBySource.set(hit.source, (shownBySource.get(hit.source) ?? 0) + 1);
  if (winnersBySource.size * quotaPerSource <= cap) {
    for (const [source, winners] of winnersBySource) {
      const expected = Math.min(winners, quotaPerSource);
      if ((shownBySource.get(source) ?? 0) < expected) {
        broken.push(`source ${source} shows ${shownBySource.get(source) ?? 0}, below its guaranteed ${expected}`);
      }
    }
  }

  return [...new Set(broken)];
}
