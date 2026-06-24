/**
 * Per-connection hierarchy mapping picker (experimental). Lets the user choose what
 * each tracker level (e.g. ClickUp Workspace/Space/Folder/List) becomes in Sketch:
 * team, project, sprint, or ignore. The server re-normalizes and re-seeds on save,
 * so this picker is best-effort UX over an authoritative resolver.
 */
import type { HierarchyLevel, HierarchyTarget } from "@/lib/api";
import { api } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { Label } from "@sketch/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const TARGET_LABELS: Record<HierarchyTarget, string> = {
  team: "Team",
  project: "Project",
  sprint: "Sprint",
  ignore: "Ignore",
};

const OFFERED_TARGETS: HierarchyTarget[] = ["team", "project", "sprint", "ignore"];

type Mapping = Record<string, HierarchyTarget>;

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
}: {
  connectorId: string;
  levels: HierarchyLevel[];
  scopeConfig: Record<string, unknown>;
}) {
  const queryClient = useQueryClient();
  const stored = useMemo<Mapping>(() => {
    const raw = scopeConfig.hierarchyMapping;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Mapping) : {};
  }, [scopeConfig]);

  const baseline = useMemo<Mapping>(() => {
    const result: Mapping = {};
    for (const level of levels) result[level.key] = effectiveTarget(level, stored);
    return result;
  }, [levels, stored]);

  const [mapping, setMapping] = useState<Mapping>(baseline);

  const dirty = levels.some((level) => mapping[level.key] !== baseline[level.key]);

  const mutation = useMutation({
    mutationFn: () => api.integrations.updateScope(connectorId, { ...scopeConfig, hierarchyMapping: mapping }),
    onSuccess: () => {
      toast.success("Hierarchy mapping updated — re-syncing.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
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
