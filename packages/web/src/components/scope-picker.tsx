/**
 * Shared scope picker primitives + generic scope editor.
 *
 * Primitives (ScopeCheckbox, ScopeList, ScopeItem, etc.) provide unified
 * visual style. GenericScopePicker renders any BrowseResult (flat/nested/tree).
 * GenericScopeEditor handles the full manage-dialog lifecycle: fetch → pick → save.
 *
 * New connectors get scope selection for free — just implement browse() on
 * the connector interface and set scopeType in the integration registry.
 */
import type { BrowseResult } from "@/lib/api";
import { api } from "@/lib/api";
import { ArrowsClockwiseIcon, CaretRightIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

export function ScopeCheckbox({ checked, size = "md" }: { checked: boolean; size?: "sm" | "md" }) {
  const sizeClass = size === "sm" ? "size-3.5" : "size-4";
  const svgClass = size === "sm" ? "size-2.5" : "size-3";

  return (
    <span
      className={`inline-flex ${sizeClass} shrink-0 items-center justify-center rounded border ${
        checked ? "border-primary bg-primary" : "border-border"
      }`}
    >
      {checked && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`${svgClass} text-primary-foreground`}
          role="img"
          aria-label="Selected"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

export function ScopeSelectAll({
  allSelected,
  totalCount,
  onToggle,
  disabled,
  noun = "items",
}: {
  allSelected: boolean;
  totalCount: number;
  onToggle: () => void;
  disabled?: boolean;
  noun?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className="flex w-full items-center gap-2 px-1 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      <span className="inline-flex size-4 items-center justify-center rounded border border-border">
        {allSelected && <span className="size-2 rounded-sm bg-foreground" />}
      </span>
      {allSelected ? "Deselect all" : "Select all"} ({totalCount} {noun})
    </button>
  );
}

export function ScopeList({ children }: { children: ReactNode }) {
  return <div className="max-h-80 space-y-0.5 overflow-y-auto rounded-lg border border-border">{children}</div>;
}

export function ScopeItem({
  checked,
  label,
  sublabel,
  icon,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  sublabel?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50 disabled:opacity-50 ${
        checked ? "bg-muted/30" : ""
      }`}
    >
      <ScopeCheckbox checked={checked} />
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {sublabel && <span className="shrink-0 text-[10px] text-muted-foreground">{sublabel}</span>}
    </button>
  );
}

export function ScopeGroup({
  checked,
  label,
  sublabel,
  disabled,
  onToggle,
  children,
  defaultExpanded = false,
}: {
  checked: boolean;
  label: string;
  sublabel?: string;
  disabled?: boolean;
  onToggle: () => void;
  children?: ReactNode;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded || checked);

  return (
    <div className="border-b border-border/30 last:border-0">
      <div
        className={`flex w-full items-center gap-1 px-1 py-2 text-left text-sm transition-colors hover:bg-muted/50 ${
          checked ? "bg-muted/30" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex shrink-0 items-center justify-center size-6 rounded hover:bg-muted/80 text-muted-foreground"
        >
          <CaretRightIcon size={12} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          className="flex flex-1 items-center gap-2.5 disabled:opacity-50"
        >
          <ScopeCheckbox checked={checked} />
          <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
          {sublabel && <span className="shrink-0 text-[10px] text-muted-foreground">{sublabel}</span>}
        </button>
      </div>
      {expanded && children && <div className="border-t border-border/30 bg-muted/10 px-2 py-1">{children}</div>}
    </div>
  );
}

export function ScopeSubItem({
  checked,
  label,
  sublabel,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  sublabel?: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50 disabled:opacity-50 ${
        checked ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      <ScopeCheckbox checked={checked} size="sm" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {sublabel && <span className="shrink-0 text-[10px] text-muted-foreground/60">{sublabel}</span>}
    </button>
  );
}

export function ScopeCount({
  selected,
  total,
  noun = "items",
}: {
  selected: number;
  total: number;
  noun?: string;
}) {
  return (
    <p className="text-[11px] text-muted-foreground">
      {selected} of {total} {noun} selected
    </p>
  );
}

// ── Generic scope picker ──────────────────────────────────────────────────────

/**
 * Renders any BrowseResult as a selectable list.
 * Works for flat (Notion pages), nested (ClickUp workspaces → spaces),
 * and tree (Google Drive drives + folders).
 */
export function GenericScopePicker({
  data,
  selectedIds,
  onToggle,
  disabled,
  noun = "items",
}: {
  data: BrowseResult;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  disabled?: boolean;
  noun?: string;
}) {
  const allItems = getAllItemIds(data);
  const allSelected = allItems.length > 0 && allItems.every((id) => selectedIds.has(id));

  const toggleAll = () => {
    for (const id of allItems) {
      if (allSelected === selectedIds.has(id)) onToggle(id);
    }
  };

  return (
    <div className="space-y-1.5">
      <ScopeSelectAll
        allSelected={allSelected}
        totalCount={allItems.length}
        onToggle={toggleAll}
        disabled={disabled}
        noun={noun}
      />
      <ScopeList>
        {data.type === "flat" &&
          data.items.map((item) => (
            <ScopeItem
              key={item.id}
              checked={selectedIds.has(item.id)}
              label={item.name}
              onToggle={() => onToggle(item.id)}
              disabled={disabled}
            />
          ))}
        {data.type === "nested" &&
          data.groups.map((group) => (
            <ScopeGroup
              key={group.id}
              checked={group.items.some((i) => selectedIds.has(i.id))}
              label={group.name}
              sublabel={`${group.items.length} ${noun}`}
              onToggle={() => {
                const groupItemIds = group.items.map((i) => i.id);
                const allGroupSelected = groupItemIds.every((id) => selectedIds.has(id));
                for (const id of groupItemIds) {
                  if (allGroupSelected === selectedIds.has(id)) onToggle(id);
                }
              }}
              disabled={disabled}
              defaultExpanded={group.items.some((i) => selectedIds.has(i.id))}
            >
              {group.items.map((item) => (
                <ScopeSubItem
                  key={item.id}
                  checked={selectedIds.has(item.id)}
                  label={item.name}
                  onToggle={() => onToggle(item.id)}
                  disabled={disabled}
                />
              ))}
            </ScopeGroup>
          ))}
        {data.type === "tree" && (
          <>
            {data.groups?.map((group) => (
              <ScopeGroup
                key={group.id}
                checked={group.items.some((i) => selectedIds.has(i.id))}
                label={group.name}
                onToggle={() => {
                  const ids = group.items.map((i) => i.id);
                  const allSel = ids.every((id) => selectedIds.has(id));
                  for (const id of ids) {
                    if (allSel === selectedIds.has(id)) onToggle(id);
                  }
                }}
                disabled={disabled}
                defaultExpanded
              >
                {group.items.map((item) => (
                  <ScopeSubItem
                    key={item.id}
                    checked={selectedIds.has(item.id)}
                    label={item.name}
                    onToggle={() => onToggle(item.id)}
                    disabled={disabled}
                  />
                ))}
              </ScopeGroup>
            ))}
            {data.items.map((item) => (
              <ScopeItem
                key={item.id}
                checked={selectedIds.has(item.id)}
                label={item.name}
                onToggle={() => onToggle(item.id)}
                disabled={disabled}
              />
            ))}
          </>
        )}
      </ScopeList>
      <ScopeCount selected={selectedIds.size} total={allItems.length} noun={noun} />
    </div>
  );
}

export function getAllItemIds(data: BrowseResult): string[] {
  switch (data.type) {
    case "flat":
      return data.items.map((i) => i.id);
    case "nested":
      return data.groups.flatMap((g) => g.items.map((i) => i.id));
    case "tree":
      return [...(data.groups?.flatMap((g) => g.items.map((i) => i.id)) ?? []), ...data.items.map((i) => i.id)];
  }
}

// ── Generic scope editor (manage dialog) ──────────────────────────────────────

/**
 * Full scope editor for the manage connector dialog.
 * Fetches browse data via the generic API, renders a picker, and saves scope changes.
 * Replaces per-connector scope editors (GoogleDriveScopeEditor, NotionScopeEditor, etc.).
 */
export function GenericScopeEditor({
  connectorId,
  scopeConfig,
  scopeConfigKey,
  noun = "items",
  onBrowsingChange,
}: {
  connectorId: string;
  scopeConfig: Record<string, unknown>;
  scopeConfigKey?: string;
  noun?: string;
  onBrowsingChange?: (browsing: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const { data: browseData, isLoading } = useQuery({
    queryKey: ["generic-browse", connectorId],
    queryFn: () => api.integrations.browseExisting(connectorId),
  });

  const isCached = browseData && "cached" in browseData && browseData.cached === true;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await api.integrations.browseExisting(connectorId, true);
      queryClient.setQueryData(["generic-browse", connectorId], fresh);
    } catch {
      toast.error("Failed to refresh scope items");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    onBrowsingChange?.(isLoading && !browseData);
  }, [isLoading, browseData, onBrowsingChange]);

  // Compute initially selected IDs from the stored scope + browse response
  const initialSelectedIds = useCallback((): Set<string> => {
    if (!browseData || browseData.type === "async") return new Set();
    const stored = browseData.scopeConfig ?? scopeConfig;
    return computeSelectedFromScope(browseData, stored, scopeConfigKey);
  }, [browseData, scopeConfig, scopeConfigKey]);

  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const effectiveIds = selectedIds ?? initialSelectedIds();

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const base = prev ?? new Set(initialSelectedIds());
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const initIds = initialSelectedIds();
  const hasChanges =
    selectedIds !== null && (effectiveIds.size !== initIds.size || [...effectiveIds].some((id) => !initIds.has(id)));

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!browseData || browseData.type === "async") throw new Error("No browse data");
      const newScope = buildScopeFromSelection(browseData, effectiveIds, scopeConfigKey);
      return api.integrations.updateScope(connectorId, newScope);
    },
    onSuccess: () => {
      toast.success("Scope updated. Re-sync started.");
      setSelectedIds(null);
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({ queryKey: ["sync-progress"] });
      queryClient.invalidateQueries({ queryKey: ["file-counts-by-source"] });
      queryClient.invalidateQueries({ queryKey: ["all-files"] });
      queryClient.invalidateQueries({ queryKey: ["hybrid-search"] });
      queryClient.invalidateQueries({ queryKey: ["generic-browse", connectorId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
        <SpinnerGapIcon size={14} className="animate-spin" />
        Loading...
      </div>
    );
  }

  if (!browseData || browseData.type === "async") {
    return <p className="text-xs text-muted-foreground">Scope browsing not available for this connector.</p>;
  }

  const allItems = getAllItemIds(browseData);
  if (allItems.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-3 py-3">
        <p className="text-xs font-medium">No {noun} found</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Check that the connected account has accessible content.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Sync scope</p>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          title="Refresh scope items from provider"
        >
          <ArrowsClockwiseIcon size={12} className={refreshing ? "animate-spin" : ""} />
          {isCached ? "Refresh" : ""}
        </button>
      </div>
      <GenericScopePicker
        data={browseData}
        selectedIds={effectiveIds}
        onToggle={toggle}
        disabled={saveMutation.isPending || refreshing}
        noun={noun}
      />
      {hasChanges && (
        <Button
          size="sm"
          className="h-7 w-full gap-1.5 text-xs"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || effectiveIds.size === 0}
        >
          {saveMutation.isPending ? (
            <>
              <SpinnerGapIcon size={12} className="animate-spin" />
              Saving...
            </>
          ) : (
            `Save & re-sync (${effectiveIds.size} ${noun})`
          )}
        </Button>
      )}
    </div>
  );
}

/**
 * Derive selected IDs from stored scope config + browse result shape.
 * Each browse type maps scope keys differently:
 * - flat: scopeConfig.rootPages / scopeConfig.items → item IDs
 * - nested: scopeConfig.spaces / group item IDs
 * - tree: scopeConfig.sharedDrives + scopeConfig.folders / scopeConfig.items
 */
export function computeSelectedFromScope(
  data: BrowseResult,
  scope: Record<string, unknown>,
  flatScopeKey?: string,
): Set<string> {
  const ids = new Set<string>();

  if (data.type === "flat" && flatScopeKey && Object.prototype.hasOwnProperty.call(scope, flatScopeKey)) {
    const scopedIds = new Set((Array.isArray(scope[flatScopeKey]) ? scope[flatScopeKey] : []).filter(isString));
    for (const id of getAllItemIds(data)) {
      if (scopedIds.has(id)) ids.add(id);
    }
    return ids;
  }

  // Collect all string[] values from scope config as potential selected IDs
  const allScopeIds = new Set<string>();
  for (const value of Object.values(scope)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "string") allScopeIds.add(v);
      }
    }
  }

  // If no scope config at all, select everything (no filtering = sync all)
  if (allScopeIds.size === 0) {
    for (const id of getAllItemIds(data)) ids.add(id);
    return ids;
  }

  // Match scope IDs against browse items
  for (const id of getAllItemIds(data)) {
    if (allScopeIds.has(id)) ids.add(id);
  }

  return ids;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Build scope config from selected IDs + browse result shape.
 * Preserves the key names expected by each connector's sync().
 */
export function buildScopeFromSelection(
  data: BrowseResult,
  selectedIds: Set<string>,
  flatScopeKey = "rootPages",
): Record<string, unknown> {
  switch (data.type) {
    case "flat":
      return { [flatScopeKey]: [...selectedIds] };
    case "nested": {
      const groupIds = new Set<string>();
      const itemIds = new Set<string>();
      for (const group of data.groups) {
        const selectedItems = group.items.filter((i) => selectedIds.has(i.id));
        if (selectedItems.length > 0) {
          groupIds.add(group.id);
          for (const item of selectedItems) itemIds.add(item.id);
        }
      }
      return { workspaces: [...groupIds], spaces: [...itemIds] };
    }
    case "tree": {
      const driveIds: string[] = [];
      const folderIds: string[] = [];
      for (const group of data.groups ?? []) {
        for (const item of group.items) {
          if (selectedIds.has(item.id)) driveIds.push(item.id);
        }
      }
      for (const item of data.items) {
        if (selectedIds.has(item.id)) folderIds.push(item.id);
      }
      return { sharedDrives: driveIds, folders: folderIds };
    }
  }
}
