import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MAX_SERVICE_LINES = 600;

describe("agent service module size", () => {
  it("keeps each production service module within the readability limit", () => {
    const files = readdirSync(import.meta.dirname)
      .filter((file) => file.startsWith("service") && file.endsWith(".ts"))
      .sort();

    const oversized = files.flatMap((file) => {
      const lines = readFileSync(join(import.meta.dirname, file), "utf8").split("\n").length;
      return lines > MAX_SERVICE_LINES ? [`${file}: ${lines}`] : [];
    });

    expect(oversized).toEqual([]);
  });
});
