import { describe, expect, it, vi } from "vitest";
import { type FactBatchCursor, forEachFactCandidatePage } from "./fact-batches";

interface Candidate {
  id: string;
  created_at: string;
}

interface Payload {
  id: string;
  created_at: string;
  raw: string;
}

/**
 * Build a keyset-paginating candidate source over an in-memory corpus already
 * sorted by `(created_at, id)`. Mirrors the DB contract `forEachFactCandidatePage`
 * relies on: strictly-greater-than the cursor, ordered, capped at `limit`.
 */
function candidateSource(corpus: Candidate[]) {
  return (cursor: FactBatchCursor, limit: number): Promise<Candidate[]> => {
    const after = corpus.filter(
      (c) => c.created_at > cursor.createdAt || (c.created_at === cursor.createdAt && c.id > cursor.id),
    );
    return Promise.resolve(after.slice(0, limit));
  };
}

describe("forEachFactCandidatePage", () => {
  it("loads payload once per page and restores candidate order", async () => {
    const corpus: Candidate[] = [
      { id: "a", created_at: "t1" },
      { id: "b", created_at: "t1" },
      { id: "c", created_at: "t2" },
      { id: "d", created_at: "t3" },
      { id: "e", created_at: "t4" },
    ];
    const createdAtById = new Map(corpus.map((c) => [c.id, c.created_at]));
    /** Returns rows reversed to prove the handler restores candidate order. */
    const fetchPayload = vi.fn((ids: string[]): Promise<Payload[]> => {
      const rows = ids.map((id) => ({ id, created_at: createdAtById.get(id) ?? "", raw: `raw-${id}` }));
      return Promise.resolve([...rows].reverse());
    });
    const seen: string[] = [];

    await forEachFactCandidatePage(
      candidateSource(corpus),
      fetchPayload,
      async (rows) => {
        for (const row of rows) seen.push(row.id);
      },
      2,
    );

    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    /** 5 rows at batchSize 2 page as [a,b],[c,d],[e]: exactly three payload loads. */
    expect(fetchPayload).toHaveBeenCalledTimes(3);
    expect(fetchPayload.mock.calls.map((call) => call[0])).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("pages cleanly when the corpus is an exact multiple of the batch size", async () => {
    const corpus: Candidate[] = Array.from({ length: 6 }, (_, i) => ({
      id: `id-${i}`,
      created_at: `t-${String(i).padStart(2, "0")}`,
    }));
    const fetchPayload = vi.fn(
      (ids: string[]): Promise<Payload[]> => Promise.resolve(ids.map((id) => ({ id, created_at: "", raw: id }))),
    );
    const seen: string[] = [];

    await forEachFactCandidatePage(
      candidateSource(corpus),
      fetchPayload,
      async (rows) => {
        for (const row of rows) seen.push(row.id);
      },
      3,
    );

    expect(seen).toEqual(corpus.map((c) => c.id));
    /**
     * 6 rows / batch 3 fill two exact pages; the paginator stops on the first
     * short (here empty) page rather than issuing a needless third payload load.
     */
    expect(fetchPayload).toHaveBeenCalledTimes(2);
  });

  it("advances the cursor across ties on created_at", async () => {
    const corpus: Candidate[] = [
      { id: "a", created_at: "same" },
      { id: "b", created_at: "same" },
      { id: "c", created_at: "same" },
      { id: "d", created_at: "same" },
    ];
    const seen: string[] = [];

    await forEachFactCandidatePage(
      candidateSource(corpus),
      (ids) => Promise.resolve(ids.map((id) => ({ id, created_at: "same", raw: id }))),
      async (rows) => {
        for (const row of rows) seen.push(row.id);
      },
      2,
    );

    expect(seen).toEqual(["a", "b", "c", "d"]);
  });

  it("drops candidates whose payload row is absent between phases", async () => {
    const corpus: Candidate[] = [
      { id: "keep-1", created_at: "t1" },
      { id: "gone", created_at: "t2" },
      { id: "keep-2", created_at: "t3" },
    ];
    const seen: string[] = [];

    await forEachFactCandidatePage(
      candidateSource(corpus),
      (ids) => Promise.resolve(ids.filter((id) => id !== "gone").map((id) => ({ id, created_at: "", raw: id }))),
      async (rows) => {
        for (const row of rows) seen.push(row.id);
      },
      10,
    );

    expect(seen).toEqual(["keep-1", "keep-2"]);
  });

  it("skips the payload load for an empty page", async () => {
    const fetchPayload = vi.fn(
      (ids: string[]): Promise<Payload[]> => Promise.resolve(ids.map((id) => ({ id, created_at: "", raw: id }))),
    );

    await forEachFactCandidatePage(candidateSource([]), fetchPayload, async () => {}, 5);

    expect(fetchPayload).not.toHaveBeenCalled();
  });
});
