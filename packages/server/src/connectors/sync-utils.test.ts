import { describe, expect, it } from "vitest";
import { IN_CLAUSE_CHUNK_SIZE, chunk } from "./sync-utils";

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
