import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const MAX_SERVICE_LINES = 600;

describe("agent run module size", () => {
  it("keeps every module within the readability limit", () => {
    const files = [
      join(import.meta.dirname, "../service.ts"),
      ...readdirSync(import.meta.dirname)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => join(import.meta.dirname, file)),
    ].sort();

    const oversized = files.flatMap((file) => {
      const lines = readFileSync(file, "utf8").split("\n").length;
      return lines > MAX_SERVICE_LINES ? [`${basename(file)}: ${lines}`] : [];
    });

    expect(oversized).toEqual([]);
  });
});
