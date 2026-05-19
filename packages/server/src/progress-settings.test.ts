import { describe, expect, it } from "vitest";
import { resolveToolProgress } from "./progress-settings";

describe("resolveToolProgress", () => {
  it("keeps supported values", () => {
    expect(resolveToolProgress("off")).toBe("off");
    expect(resolveToolProgress("friendly")).toBe("friendly");
    expect(resolveToolProgress("technical")).toBe("technical");
  });

  it("resolves unsupported stored values to the safe default", () => {
    expect(resolveToolProgress("concise")).toBe("friendly");
    expect(resolveToolProgress("verbose")).toBe("friendly");
    expect(resolveToolProgress(null)).toBe("friendly");
  });
});
