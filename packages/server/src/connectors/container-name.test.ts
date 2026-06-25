import { describe, expect, it } from "vitest";
import { deriveQualifiedSeedName, qualifyContainerName } from "./container-name";

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

describe("deriveQualifiedSeedName", () => {
  it("qualifies a legacy bare fact from its raw metadata (durable replay)", () => {
    expect(
      deriveQualifiedSeedName({
        source: "linear",
        subjectName: "Platform",
        raw: { name: "Platform", metadata: { teams: ["Sketch"] } },
      }),
    ).toEqual({ name: "Sketch Platform", aliases: ["Platform"] });

    expect(
      deriveQualifiedSeedName({
        source: "clickup",
        subjectName: "Content Engine",
        raw: { name: "Content Engine", metadata: { spaceName: "Marketing" } },
      }),
    ).toEqual({ name: "Marketing Content Engine", aliases: ["Content Engine"] });
  });

  it("is idempotent on an already-qualified fact and leaves multi-team seeds bare", () => {
    expect(
      deriveQualifiedSeedName({
        source: "linear",
        subjectName: "Sketch Platform",
        raw: { name: "Sketch Platform", aliases: ["Platform"], metadata: { teams: ["Sketch"] } },
      }),
    ).toEqual({ name: "Sketch Platform", aliases: ["Platform"] });

    expect(
      deriveQualifiedSeedName({
        source: "linear",
        subjectName: "Platform",
        raw: { name: "Platform", metadata: { teams: ["Sketch", "Canvas"] } },
      }),
    ).toEqual({ name: "Platform", aliases: [] });
  });
});
