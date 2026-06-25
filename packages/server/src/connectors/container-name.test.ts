import { describe, expect, it } from "vitest";
import { qualifyContainerName } from "./container-name";

describe("qualifyContainerName", () => {
  it("qualifies with a determinate scope and keeps already-contained names unchanged", () => {
    expect(qualifyContainerName("Platform", "Sketch")).toBe("Sketch Platform");
    expect(qualifyContainerName("Sketch OSS", "Sketch")).toBe("Sketch OSS");
    expect(qualifyContainerName("Sketch, OSS", "sketch")).toBe("Sketch, OSS");
  });

  it("leaves names unchanged without a qualifier", () => {
    expect(qualifyContainerName("Platform", null)).toBe("Platform");
    expect(qualifyContainerName("Platform", " ")).toBe("Platform");
  });
});
