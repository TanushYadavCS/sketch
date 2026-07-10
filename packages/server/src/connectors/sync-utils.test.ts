import { describe, expect, it } from "vitest";
import { IN_CLAUSE_CHUNK_SIZE, chunk, streamWithConcurrency } from "./sync-utils";

describe("chunk", () => {
  it("returns no chunks for an empty array", () => {
    expect(chunk([], 500)).toEqual([]);
  });

  it("returns a single chunk when the input is smaller than the size", () => {
    expect(chunk([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
  });

  it("splits an exact multiple into equal full chunks with no trailing empty chunk", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("keeps the remainder in a final shorter chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("emits one chunk per item when the size is 1", () => {
    expect(chunk(["a", "b", "c"], 1)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("preserves order and covers every element across chunks", () => {
    const items = Array.from({ length: IN_CLAUSE_CHUNK_SIZE * 2 + 37 }, (_, i) => i);
    const chunks = chunk(items, IN_CLAUSE_CHUNK_SIZE);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(IN_CLAUSE_CHUNK_SIZE);
    expect(chunks[1]).toHaveLength(IN_CLAUSE_CHUNK_SIZE);
    expect(chunks[2]).toHaveLength(37);
    expect(chunks.flat()).toEqual(items);
  });

  it("rejects a non-positive or non-integer size", () => {
    expect(() => chunk([1], 0)).toThrow(/positive integer/);
    expect(() => chunk([1], -5)).toThrow(/positive integer/);
    expect(() => chunk([1], 1.5)).toThrow(/positive integer/);
  });
});

describe("streamWithConcurrency", () => {
  it("yields every worker result", async () => {
    const results = await drainAsync(streamWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10));
    expect([...results].sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
  });

  it("never runs more than `limit` workers at once", async () => {
    let active = 0;
    let peak = 0;
    await drainAsync(
      streamWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return n;
      }),
    );
    expect(peak).toBe(2);
  });

  it("streams a fast early result before a slow later worker settles", async () => {
    const order = await drainAsync(
      streamWithConcurrency(
        [
          { id: "slow", delay: 30 },
          { id: "fast", delay: 1 },
        ],
        2,
        async (item) => {
          await new Promise((resolve) => setTimeout(resolve, item.delay));
          return item.id;
        },
      ),
    );
    expect(order).toEqual(["fast", "slow"]);
  });

  it("propagates a worker rejection out of the generator", async () => {
    await expect(
      drainAsync(
        streamWithConcurrency([1, 2, 3], 1, async (n) => {
          if (n === 2) throw new Error("boom");
          return n;
        }),
      ),
    ).rejects.toThrow("boom");
  });

  it("returns immediately for an empty input", async () => {
    expect(await drainAsync(streamWithConcurrency([], 4, async (n: number) => n))).toEqual([]);
  });
});

async function drainAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
