import type { HierarchyLevel } from "@/lib/api";
/**
 * Coherence rules for the hierarchy mapping picker: at most one team, a project may
 * not sit above a team, and a sprint requires a project above it. Tested directly on the pure selectability predicate the
 * picker uses to disable invalid options (the server re-normalizes authoritatively).
 */
import { describe, expect, it } from "vitest";
import { isTargetSelectable } from "./hierarchy-mapping-panel";

const LEVELS: HierarchyLevel[] = [
  { key: "workspace", label: "Workspace", allowedTargets: ["team", "ignore"], default: "ignore" },
  { key: "space", label: "Space", allowedTargets: ["team", "project", "ignore"], default: "ignore" },
  { key: "folder", label: "Folder", allowedTargets: ["project", "ignore"], default: "ignore" },
  { key: "list", label: "List", allowedTargets: ["project", "sprint", "ignore"], default: "ignore" },
];

describe("isTargetSelectable", () => {
  it("forbids a second team when another level is already a team", () => {
    expect(isTargetSelectable(LEVELS, { workspace: "team" }, 1, "team")).toBe(false);
    expect(isTargetSelectable(LEVELS, { space: "team" }, 0, "team")).toBe(false);
  });

  it("forbids a project above a team (deeper level is a team)", () => {
    expect(isTargetSelectable(LEVELS, { space: "team" }, 0, "project")).toBe(false);
  });

  it("allows a coherent chain — a project under a team, and ignore anywhere", () => {
    expect(isTargetSelectable(LEVELS, { space: "team" }, 2, "project")).toBe(true);
    expect(isTargetSelectable(LEVELS, { workspace: "team", space: "team" }, 3, "ignore")).toBe(true);
  });

  it("requires a project above a sprint", () => {
    expect(isTargetSelectable(LEVELS, { space: "project" }, 3, "sprint")).toBe(true);
    expect(isTargetSelectable(LEVELS, { workspace: "team", space: "ignore", folder: "ignore" }, 3, "sprint")).toBe(
      false,
    );
  });
});
