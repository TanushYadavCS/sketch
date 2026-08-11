import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

function exists(relativePath: string): boolean {
  return existsSync(resolve(ROOT, relativePath));
}

describe("feature entity type removal", () => {
  it("removes feature-producing modules and keeps project queue policy coverage under the project name", () => {
    expect(exists("src/entities/materialize-feature.ts")).toBe(false);
    expect(exists("src/entities/feature-archive-sweep.ts")).toBe(false);
    expect(exists("src/connectors/feature-name-filter.ts")).toBe(false);
    expect(exists("src/db/repositories/features.ts")).toBe(false);
    expect(exists("src/entities/feature-queue-policy.integration.test.ts")).toBe(false);
    expect(exists("src/entities/project-queue-policy.integration.test.ts")).toBe(true);
  });
});
