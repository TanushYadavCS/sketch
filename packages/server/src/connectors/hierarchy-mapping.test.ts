import { describe, expect, it, vi } from "vitest";
import { resolveHierarchyMapping } from "./hierarchy-mapping";
import type { HierarchyLevelDeclaration } from "./types";

const TEST_LEVELS: HierarchyLevelDeclaration[] = [
  { key: "workspace", label: "Workspace", allowedTargets: ["team", "project", "ignore"], default: "ignore" },
  { key: "space", label: "Space", allowedTargets: ["team", "project", "ignore"], default: "ignore" },
  { key: "folder", label: "Folder", allowedTargets: ["team", "project", "ignore"], default: "ignore" },
  { key: "list", label: "List", allowedTargets: ["project", "sprint", "ignore"], default: "ignore" },
];

describe("resolveHierarchyMapping", () => {
  it("normalizes duplicate teams and project-above-team chains deterministically", () => {
    const logger = { warn: vi.fn() };

    const mapping = resolveHierarchyMapping(
      TEST_LEVELS,
      {
        workspace: "project",
        space: "team",
        folder: "team",
        list: "project",
      },
      { logger },
    );

    expect(mapping).toEqual({
      workspace: "project",
      space: "ignore",
      folder: "ignore",
      list: "project",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ level: "space", reason: "chain_order" }),
      "Normalized connector hierarchy mapping",
    );
  });

  it("falls sprint mappings on undated lists back to ignore and logs the normalization", () => {
    const logger = { warn: vi.fn() };

    const mapping = resolveHierarchyMapping(TEST_LEVELS, { list: "sprint" }, { logger });

    expect(mapping.list).toBe("ignore");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ level: "list", reason: "sprint_requires_dates", normalizedTarget: "ignore" }),
      "Normalized connector hierarchy mapping",
    );
  });
});
