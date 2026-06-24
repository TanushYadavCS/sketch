import type { Logger } from "pino";
import type { HierarchyLevelDeclaration, HierarchyTarget } from "./types";

export type HierarchyMapping = Record<string, HierarchyTarget>;

export interface HierarchyNode {
  levelKey: string;
  id: string;
  name: string;
  hasDates?: boolean;
}

interface HierarchyLevelContext {
  key: string;
  hasDates?: boolean;
}

interface StructureAwareDefaultInput {
  hasFolders?: boolean;
  hasFolderlessLists?: boolean;
}

const REAL_TARGETS = new Set<HierarchyTarget>(["team", "project", "sprint"]);
const CHAIN_INDEX: Record<Exclude<HierarchyTarget, "ignore">, number> = {
  team: 0,
  project: 1,
  sprint: 2,
};

function isHierarchyTarget(value: unknown): value is HierarchyTarget {
  return value === "team" || value === "project" || value === "sprint" || value === "ignore";
}

function levelHasDates(level: HierarchyLevelDeclaration, context?: HierarchyLevelContext): boolean {
  return context?.key === level.key && context.hasDates === true;
}

function logNormalization(logger: Pick<Logger, "warn"> | undefined, details: Record<string, unknown>): void {
  logger?.warn(details, "Normalized connector hierarchy mapping");
}

/**
 * Normalization order is: coerce unknown/disallowed targets to the level default, demote undated sprint levels,
 * keep the first team only, then walk top-down and demote any real target that would move backward in
 * `team -> project -> sprint`.
 */
export function resolveHierarchyMapping(
  levels: HierarchyLevelDeclaration[],
  stored: unknown,
  opts: { levelContexts?: HierarchyLevelContext[]; logger?: Pick<Logger, "warn"> } = {},
): HierarchyMapping {
  const storedRecord =
    stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const levelContexts = opts.levelContexts ?? [];
  const mapping: HierarchyMapping = {};

  for (const level of levels) {
    const rawTarget = storedRecord[level.key];
    const coercedTarget =
      isHierarchyTarget(rawTarget) && level.allowedTargets.includes(rawTarget) ? rawTarget : level.default;
    mapping[level.key] = coercedTarget;

    if (rawTarget !== undefined && rawTarget !== coercedTarget) {
      logNormalization(opts.logger, {
        level: level.key,
        requestedTarget: rawTarget,
        normalizedTarget: coercedTarget,
        reason: "target_not_allowed",
      });
    }
  }

  for (const level of levels) {
    if (mapping[level.key] !== "sprint") continue;
    const context = levelContexts.find((candidate) => candidate.key === level.key);
    if (!levelHasDates(level, context)) {
      mapping[level.key] = "ignore";
      logNormalization(opts.logger, {
        level: level.key,
        requestedTarget: "sprint",
        normalizedTarget: "ignore",
        reason: "sprint_requires_dates",
      });
    }
  }

  let teamSeen = false;
  for (const level of levels) {
    if (mapping[level.key] !== "team") continue;
    if (teamSeen) {
      mapping[level.key] = "ignore";
      logNormalization(opts.logger, {
        level: level.key,
        requestedTarget: "team",
        normalizedTarget: "ignore",
        reason: "duplicate_team",
      });
      continue;
    }
    teamSeen = true;
  }

  let deepestChainIndex = -1;
  for (const level of levels) {
    const target = mapping[level.key];
    if (target === "ignore") continue;
    const chainIndex = CHAIN_INDEX[target];
    if (chainIndex < deepestChainIndex) {
      mapping[level.key] = "ignore";
      logNormalization(opts.logger, {
        level: level.key,
        requestedTarget: target,
        normalizedTarget: "ignore",
        reason: "chain_order",
      });
      continue;
    }
    deepestChainIndex = chainIndex;
  }

  return mapping;
}

export function computeStructureAwareDefault(
  levels: HierarchyLevelDeclaration[],
  structure: StructureAwareDefaultInput = {},
): HierarchyMapping {
  const mapping = Object.fromEntries(levels.map((level) => [level.key, level.default])) as HierarchyMapping;

  if ("workspace" in mapping) mapping.workspace = "ignore";
  if ("space" in mapping) mapping.space = structure.hasFolders ? "ignore" : "project";
  if ("folder" in mapping) mapping.folder = structure.hasFolders ? "project" : "ignore";
  if ("list" in mapping) mapping.list = "ignore";

  if (!structure.hasFolders && !structure.hasFolderlessLists && "space" in mapping) {
    mapping.space = "ignore";
  }

  return mapping;
}

export function nearestMappedAncestor(
  nodes: HierarchyNode[],
  mapping: HierarchyMapping,
  targets: HierarchyTarget[] = ["team", "project", "sprint"],
): (HierarchyNode & { target: HierarchyTarget }) | undefined {
  const allowedTargets = new Set(targets);
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    const target = mapping[node.levelKey] ?? "ignore";
    if (REAL_TARGETS.has(target) && allowedTargets.has(target)) {
      return { ...node, target };
    }
  }
  return undefined;
}

export function mappedAncestors(
  nodes: HierarchyNode[],
  mapping: HierarchyMapping,
): Array<HierarchyNode & { target: HierarchyTarget }> {
  return nodes
    .map((node) => ({ ...node, target: mapping[node.levelKey] ?? "ignore" }))
    .filter((node) => node.target === "team" || node.target === "project");
}
