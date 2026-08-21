/**
 * Per-connection hierarchy mapping picker (experimental). Lets the user choose what
 * each tracker level (e.g. ClickUp Workspace/Space/Folder/List) becomes in Sketch:
 * team, project, sprint, or ignore. The server re-normalizes and re-seeds on save,
 * so this picker is best-effort UX over an authoritative resolver.
 *
 * When container classification is enabled for the connector, the panel also shows
 * per-container proposals (LLM-classified) below the level mapping. Accepting or
 * overriding them saves through the same single scope PATCH as the level mapping,
 * writing the v2 `{levels, containers}` hierarchyMapping shape.
 */
import type { ContainerClassificationProposal, ContainerTarget, HierarchyLevel, HierarchyTarget } from "@/lib/api";
import { api } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { Label } from "@sketch/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const TARGET_LABELS: Record<HierarchyTarget, string> = {
  team: "Team",
  project: "Project",
  sprint: "Sprint",
  ignore: "Ignore",
};

const OFFERED_TARGETS: HierarchyTarget[] = ["team", "project", "sprint", "ignore"];

const CONTAINER_TARGET_LABELS: Record<ContainerTarget, string> = {
  team: "Team",
  project: "Project",
  program: "Program",
  cycle: "Cycle",
  register: "Register",
  person_queue: "Person queue",
  status: "Status",
  archive: "Archive",
  ignore: "Ignore",
};

const CONTAINER_TARGETS = Object.keys(CONTAINER_TARGET_LABELS) as ContainerTarget[];

type Mapping = Record<string, HierarchyTarget>;
type ContainerMapping = Record<string, ContainerTarget>;

export interface StoredHierarchyMapping {
  levels: Mapping;
  containers: ContainerMapping;
  isV2: boolean;
}

/**
 * The stored hierarchyMapping has two shapes: the legacy flat `{levelKey: target}`
 * record, and the v2 `{levels, containers}` object. Both must read to the same
 * normalized form so the picker and the save path never care which one is stored.
 */
export function readStoredHierarchyMapping(raw: unknown): StoredHierarchyMapping {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { levels: {}, containers: {}, isV2: false };
  const record = raw as Record<string, unknown>;
  const levelsValue = record.levels;
  if (levelsValue && typeof levelsValue === "object" && !Array.isArray(levelsValue)) {
    const containersValue = record.containers;
    const containers: ContainerMapping = {};
    if (containersValue && typeof containersValue === "object" && !Array.isArray(containersValue)) {
      for (const [key, value] of Object.entries(containersValue as Record<string, unknown>)) {
        if (CONTAINER_TARGETS.includes(value as ContainerTarget)) containers[key] = value as ContainerTarget;
      }
    }
    return { levels: levelsValue as Mapping, containers, isV2: true };
  }
  return { levels: record as Mapping, containers: {}, isV2: false };
}

/**
 * Writes the legacy flat shape unless the connector already stored v2 or the user
 * has container assignments to persist — so connectors without container
 * classification keep their stored config byte-identical.
 */
export function buildHierarchyMappingPayload(
  levels: Mapping,
  containers: ContainerMapping,
  storedWasV2: boolean,
): Mapping | { levels: Mapping; containers: ContainerMapping } {
  if (storedWasV2 || Object.keys(containers).length > 0) return { levels, containers };
  return levels;
}

function effectiveTarget(level: HierarchyLevel, stored: Mapping): HierarchyTarget {
  const value = stored[level.key];
  return value && OFFERED_TARGETS.includes(value) ? value : level.default;
}

/**
 * A target is selectable for a level only if it keeps the mapping coherent given the
 * other levels' current choices: at most one team, no project above a team, and no sprint without a project above it.
 */
export function isTargetSelectable(
  levels: HierarchyLevel[],
  mapping: Mapping,
  levelIndex: number,
  target: HierarchyTarget,
): boolean {
  if (target === "ignore") return true;
  if (target === "team") {
    const anotherTeam = levels.some((l, i) => i !== levelIndex && mapping[l.key] === "team");
    const shallowerProject = levels.some((l, i) => i < levelIndex && mapping[l.key] === "project");
    return !anotherTeam && !shallowerProject;
  }
  if (target === "project") {
    const deeperTeam = levels.some((l, i) => i > levelIndex && mapping[l.key] === "team");
    return !deeperTeam;
  }
  if (target === "sprint") {
    return levels.some((l, i) => i < levelIndex && mapping[l.key] === "project");
  }
  return true;
}

export function HierarchyMappingPanel({
  connectorId,
  levels,
  scopeConfig,
  containerClassificationEnabled = false,
}: {
  connectorId: string;
  levels: HierarchyLevel[];
  scopeConfig: Record<string, unknown>;
  containerClassificationEnabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const stored = useMemo(() => readStoredHierarchyMapping(scopeConfig.hierarchyMapping), [scopeConfig]);

  const baseline = useMemo<Mapping>(() => {
    const result: Mapping = {};
    for (const level of levels) result[level.key] = effectiveTarget(level, stored.levels);
    return result;
  }, [levels, stored]);

  const [mapping, setMapping] = useState<Mapping>(baseline);
  const [containerOverrides, setContainerOverrides] = useState<ContainerMapping>({});

  const proposalsQuery = useQuery({
    queryKey: ["container-classification", connectorId],
    queryFn: () => api.integrations.containerClassifications(connectorId),
    enabled: containerClassificationEnabled,
    retry: false,
  });
  const proposals = useMemo(
    () => (containerClassificationEnabled ? (proposalsQuery.data?.proposals ?? []) : []),
    [containerClassificationEnabled, proposalsQuery.data],
  );

  const containerAssignments = useMemo<ContainerMapping>(() => {
    const result: ContainerMapping = { ...stored.containers };
    for (const proposal of proposals) {
      result[proposal.containerId] =
        containerOverrides[proposal.containerId] ?? stored.containers[proposal.containerId] ?? proposal.proposedTarget;
    }
    return result;
  }, [proposals, containerOverrides, stored]);

  const proposalsByLevel = useMemo(() => {
    const groups = new Map<string, ContainerClassificationProposal[]>();
    for (const proposal of proposals) {
      const group = groups.get(proposal.level);
      if (group) group.push(proposal);
      else groups.set(proposal.level, [proposal]);
    }
    return groups;
  }, [proposals]);

  const levelsDirty = levels.some((level) => mapping[level.key] !== baseline[level.key]);
  const containersDirty = proposals.some(
    (proposal) => containerAssignments[proposal.containerId] !== stored.containers[proposal.containerId],
  );
  const dirty = levelsDirty || containersDirty;

  const mutation = useMutation({
    mutationFn: () =>
      api.integrations.updateScope(connectorId, {
        ...scopeConfig,
        hierarchyMapping: buildHierarchyMappingPayload(mapping, containerAssignments, stored.isV2),
      }),
    onSuccess: () => {
      toast.success("Hierarchy mapping updated — re-syncing.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({ queryKey: ["container-classification", connectorId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const classifyMutation = useMutation({
    mutationFn: () => api.integrations.classifyContainers(connectorId),
    onSuccess: (data) => {
      queryClient.setQueryData(["container-classification", connectorId], { proposals: data.proposals });
      toast.success(
        data.run.status === "unchanged" ? "Containers unchanged since last run." : "Containers classified.",
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Hierarchy</Label>
        <p className="text-[11px] text-muted-foreground">
          Choose what each level becomes in Sketch. A team owns people and cadence; a project is a unit of work; a
          sprint is a dated cycle that needs a project above it; ignore skips that level.
        </p>
      </div>

      <div className="space-y-2">
        {levels.map((level, index) => {
          const value = mapping[level.key];
          return (
            <div key={level.key} className="flex items-center justify-between gap-3">
              <Label htmlFor={`hierarchy-${level.key}`} className="text-xs font-medium text-foreground">
                {level.label}
              </Label>
              <Select
                value={value}
                onValueChange={(next) => setMapping((prev) => ({ ...prev, [level.key]: next as HierarchyTarget }))}
              >
                <SelectTrigger id={`hierarchy-${level.key}`} className="h-8 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {level.allowedTargets
                    .filter((target) => OFFERED_TARGETS.includes(target))
                    .map((target) => (
                      <SelectItem
                        key={target}
                        value={target}
                        disabled={!isTargetSelectable(levels, mapping, index, target)}
                        className="text-xs"
                      >
                        {TARGET_LABELS[target]}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>

      {containerClassificationEnabled && (
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Containers
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Classify each tracker container individually — a list can be a project, a sprint-like cycle, a bug
                register, or someone's personal queue. Saving accepts the targets shown below.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              onClick={() => classifyMutation.mutate()}
              disabled={classifyMutation.isPending}
            >
              {classifyMutation.isPending
                ? "Classifying…"
                : proposals.length > 0
                  ? "Re-classify"
                  : "Classify containers"}
            </Button>
          </div>

          {proposals.length === 0 && !classifyMutation.isPending && (
            <p className="text-[11px] text-muted-foreground">
              No container proposals yet. Run classification to get per-container suggestions.
            </p>
          )}

          {[...proposalsByLevel.entries()].map(([level, group]) => (
            <div key={level} className="space-y-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{level}</p>
              {group.map((proposal) => (
                <div key={proposal.containerId} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">{proposal.containerName}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {proposal.confidence} confidence — {proposal.reasoning}
                    </p>
                  </div>
                  <Select
                    value={containerAssignments[proposal.containerId]}
                    onValueChange={(next) =>
                      setContainerOverrides((prev) => ({ ...prev, [proposal.containerId]: next as ContainerTarget }))
                    }
                  >
                    <SelectTrigger
                      aria-label={`Target for ${proposal.containerName}`}
                      className="h-8 w-40 shrink-0 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTAINER_TARGETS.map((target) => (
                        <SelectItem key={target} value={target} className="text-xs">
                          {CONTAINER_TARGET_LABELS[target]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <Button
        size="sm"
        className="h-7 text-xs"
        onClick={() => mutation.mutate()}
        disabled={!dirty || mutation.isPending}
      >
        {mutation.isPending ? "Saving…" : "Save & re-sync"}
      </Button>
    </div>
  );
}
