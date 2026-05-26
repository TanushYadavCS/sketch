import { ConnectorLogo } from "@/components/connector-logos";
/**
 * EntityExplorer — entity list for Files → Entities.
 *
 * ECR-03B: when the experimental flag is on, pending entity_review_queue
 * rows render as "ghost rows" inside the same table under a "To review · N"
 * section band (newest first by last_seen_at). Confirmed entities live
 * below an "Existing · N" band. Clicking a ghost row opens a reconcile
 * drawer with two side-by-side columns — Proposed | Suggested existing —
 * and inline ✓/✗ icon-buttons on the candidate card. ✗ flips the right
 * column to a "What instead?" chooser (search + create-as-new). Orphan
 * rows (no suggested candidate) open directly in chooser mode.
 */
import { EntityPicker } from "@/components/entity-picker";
import { GraphRebuildDialog, type GraphRebuildDialogPrefill } from "@/components/graph-rebuild-dialog";
import { RebuildBanner } from "@/components/rebuild-banner";
import { countKey, detailKey, listKey, useReviewMutations } from "@/components/review-actions";
import { useRebuildJob } from "@/hooks/use-rebuild-job";
import type { EntityListItem, EntityMention, EntityReviewEvidenceRow, EntityReviewQueueRow } from "@/lib/api";
import { api } from "@/lib/api";
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CheckIcon,
  CubeIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UserIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Input } from "@sketch/ui/components/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardAuth } from "../dashboard";
import { formatRelativeTime } from "./file-list";

const TYPE_GROUPS: { label: string; types: string[] }[] = [
  { label: "Projects", types: ["clickup_space", "clickup_folder", "linear_project", "project"] },
  { label: "People", types: ["person"] },
  { label: "Companies", types: ["company"] },
  { label: "Products", types: ["product"] },
  { label: "Teams", types: ["team"] },
  { label: "Databases", types: ["notion_database"] },
  { label: "Pages", types: ["notion_page"] },
];

function humanSourceType(sourceType: string): string {
  const map: Record<string, string> = {
    clickup_space: "Space",
    clickup_folder: "Folder",
    clickup_workspace: "Workspace",
    linear_project: "Project",
    notion_database: "Database",
    notion_page: "Page",
    person: "Person",
    project: "Project",
    company: "Company",
    product: "Product",
    team: "Team",
    other: "Other",
  };
  return map[sourceType] ?? sourceType;
}

/** Derive the connector source from entity sourceType (e.g., "clickup_space" → "clickup"). */
function sourceFromType(sourceType: string): string | null {
  if (sourceType.startsWith("clickup_")) return "clickup";
  if (sourceType.startsWith("notion_")) return "notion";
  if (sourceType.startsWith("linear_")) return "linear";
  if (sourceType.startsWith("google_drive")) return "google_drive";
  return null;
}

function entityEmail(entity: EntityListItem | null): string | null {
  const value = entity?.metadata?.email;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function entityContext(entity: EntityListItem): string | null {
  const m = entity.metadata;
  if (!m) return null;
  if (m.workspaceName) {
    if (m.spaceName) return `${m.workspaceName} / ${m.spaceName}`;
    return m.workspaceName as string;
  }
  if (entity.sourceType === "clickup_workspace") return null;
  if (m.path) return m.path as string;
  if (m.parentPage) return m.parentPage as string;
  if (entity.sourceType === "person" && entity.subtype) {
    return entity.subtype === "internal" ? "Internal" : "External";
  }
  return null;
}

function isAiDiscovered(entity: EntityListItem): boolean {
  return entity.metadata?.origin === "ai";
}

export function EntityExplorer() {
  const queryClient = useQueryClient();
  const { role } = useDashboardAuth();
  const isAdmin = role === "admin";
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showRebuildDialog, setShowRebuildDialog] = useState(false);
  const [rebuildPrefill, setRebuildPrefill] = useState<GraphRebuildDialogPrefill | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("company");

  const rebuildState = useRebuildJob({ enabled: isAdmin });
  const overlayRebuilding =
    rebuildState.activeJob !== null &&
    (rebuildState.activeJob.job.phase === "resetting" || rebuildState.activeJob.job.phase === "wiping");

  const createMutation = useMutation({
    mutationFn: () => api.entities.create({ name: newName.trim(), sourceType: newType }),
    onSuccess: () => {
      toast.success(`Entity "${newName.trim()}" created.`);
      setShowAddDialog(false);
      setNewName("");
      setNewType("company");
      queryClient.invalidateQueries({ queryKey: ["entities"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const cleanupMutation = useMutation({
    mutationFn: () => api.entities.deleteTentative(),
    onSuccess: (result) => {
      toast.success(`Removed ${result.count} tentative entities.`);
      queryClient.invalidateQueries({ queryKey: ["entities"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const latestJobId = rebuildState.latestJob?.job.id ?? null;
  const latestJobPhase = rebuildState.latestJob?.job.phase ?? null;
  useEffect(() => {
    if (latestJobPhase === "done" && latestJobId !== null) {
      queryClient.invalidateQueries({ queryKey: ["entities"] });
    }
  }, [latestJobId, latestJobPhase, queryClient]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ["entities", typeFilter, debouncedSearch],
    queryFn: () =>
      api.entities.list({
        type: typeFilter ?? undefined,
        search: debouncedSearch || undefined,
        sort: "hotness",
        limit: 200,
      }),
    refetchInterval: 30000,
  });

  const entities = data?.entities ?? [];
  const total = data?.total ?? 0;
  const tentativeCount = entities.filter((e) => e.status === "tentative").length;

  // ECR-03B inline review surface — gated, two-stage fetch:
  // the cheap count probe gates the (heavier) list query.
  const { data: setupStatus } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => api.setup.status(),
  });
  const experimentalEnabled = setupStatus?.experimentalFlag === true;

  const { data: reviewCount } = useQuery({
    queryKey: countKey(debouncedSearch),
    queryFn: () => api.entityReview.list({ limit: 0, search: debouncedSearch || undefined }),
    enabled: experimentalEnabled,
    refetchInterval: experimentalEnabled ? 30000 : false,
  });
  const reviewTotal = reviewCount?.total ?? 0;
  const hasPendingReviews = experimentalEnabled && reviewTotal > 0;

  const { data: reviewList } = useQuery({
    queryKey: listKey(debouncedSearch),
    queryFn: () => api.entityReview.list({ limit: 200, search: debouncedSearch || undefined }),
    enabled: hasPendingReviews,
  });

  const queueRows: EntityReviewQueueRow[] = reviewList?.rows ?? [];

  const typeLabel = TYPE_GROUPS.find((g) => g.types.join(",") === typeFilter)?.label ?? null;

  return (
    <div>
      {isAdmin ? (
        <RebuildBanner
          state={rebuildState}
          onRetry={(prefill) => {
            setRebuildPrefill(prefill);
            setShowRebuildDialog(true);
          }}
        />
      ) : null}
      {/* Toolbar */}
      <div className="mt-4 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlassIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            placeholder="Search entities..."
            className="pl-9 text-sm"
          />
        </div>

        {typeLabel ? (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setTypeFilter(null)}>
            {typeLabel}
            <XIcon size={10} className="text-muted-foreground" />
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
                Type
                <CaretDownIcon size={12} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {TYPE_GROUPS.map((group) => (
                <DropdownMenuItem key={group.label} onClick={() => setTypeFilter(group.types.join(","))}>
                  {group.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setShowAddDialog(true)}>
          <PlusIcon size={12} />
          Add Entity
        </Button>

        {isAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label="Entity admin actions"
                data-testid="entity-admin-menu"
              >
                <DotsThreeIcon size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  setRebuildPrefill(null);
                  setShowRebuildDialog(true);
                }}
                data-testid="rebuild-entities-menu-item"
              >
                <ArrowClockwiseIcon size={14} className="mr-1.5" />
                Rebuild entities…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {isAdmin && tentativeCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs text-destructive"
            onClick={() => cleanupMutation.mutate()}
            disabled={cleanupMutation.isPending}
          >
            {cleanupMutation.isPending ? "Cleaning..." : `Clear ${tentativeCount} tentative`}
          </Button>
        )}
      </div>

      {/* Stats */}
      {!isLoading && (
        <p className="mt-3 text-xs text-muted-foreground">
          {total} entit{total === 1 ? "y" : "ies"}
        </p>
      )}

      {/* Table */}
      <div className="relative mt-2">
        {overlayRebuilding ? (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/60 text-xs text-muted-foreground backdrop-blur-sm"
            data-testid="rebuild-overlay"
          >
            Rebuilding — entities will reappear shortly.
          </div>
        ) : null}
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((key) => (
              <Skeleton key={key} className="h-10 rounded-lg" />
            ))}
          </div>
        ) : entities.length === 0 && queueRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
            <CubeIcon size={32} className="text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">
              {debouncedSearch || typeFilter ? "No entities match your filters" : "No entities yet"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {debouncedSearch || typeFilter
                ? "Try adjusting your search or filters"
                : "Entities are created during sync from connected sources"}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border" data-testid="entities-table">
            {/* Single shared column header */}
            <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <span className="min-w-0 flex-1">Name</span>
              <span className="w-32 text-center">Type</span>
              <span className="w-16 text-center">Mentions</span>
              <span className="w-20 text-center">Status</span>
              <span className="w-24 text-right">Last Active</span>
            </div>

            {/* Review section band + ghost rows */}
            {hasPendingReviews ? (
              <>
                <div
                  className="border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                  data-testid="pending-reviews-badge"
                >
                  To review · {reviewTotal}
                </div>
                {queueRows.map((row) => (
                  <GhostReviewRow key={`review-${row.id}`} row={row} onSelect={setSelectedReviewId} />
                ))}
              </>
            ) : null}

            {/* Entities section band — only shown when both sections coexist */}
            {hasPendingReviews && entities.length > 0 ? (
              <div className="border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Existing · {total}
              </div>
            ) : null}

            {entities.map((entity) => (
              <EntityRow key={entity.id} entity={entity} onSelect={setSelectedEntityId} />
            ))}
          </div>
        )}
      </div>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Entity</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Name</p>
              <Input
                value={newName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
                className="mt-1 text-sm"
                placeholder="e.g. CanvasX, Epik, Product Alpha"
              />
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Type</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {["company", "product", "client", "project", "team", "person"].map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    variant={newType === t ? "default" : "outline"}
                    className="h-7 text-xs"
                    onClick={() => setNewType(t)}
                  >
                    {t}
                  </Button>
                ))}
              </div>
            </div>
            <Button
              className="w-full text-xs"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !newName.trim()}
            >
              {createMutation.isPending ? "Creating..." : "Create Entity"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <GraphRebuildDialog
        open={showRebuildDialog}
        onOpenChange={setShowRebuildDialog}
        prefill={rebuildPrefill}
        onSubmitted={() => {
          rebuildState.refetch();
        }}
      />

      <EntityDetailSheet entityId={selectedEntityId} onClose={() => setSelectedEntityId(null)} />
      <ReviewDetailSheet reviewId={selectedReviewId} onClose={() => setSelectedReviewId(null)} />
    </div>
  );
}

function EntityRow({ entity, onSelect }: { entity: EntityListItem; onSelect: (id: string) => void }) {
  const isPerson = entity.sourceType === "person";
  const source = sourceFromType(entity.sourceType);
  const context = entityContext(entity);

  return (
    <div className="border-b border-border last:border-b-0" data-testid={`entity-row-${entity.id}`}>
      <button
        type="button"
        onClick={() => onSelect(entity.id)}
        className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/30"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isPerson ? (
            <UserIcon size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <CubeIcon size={14} className="shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{entity.name}</p>
            {context ? (
              <p className="truncate text-[11px] text-muted-foreground">{context}</p>
            ) : (
              entity.aliases.length > 0 && (
                <p className="truncate text-[11px] text-muted-foreground">aka {entity.aliases.join(", ")}</p>
              )
            )}
          </div>
        </div>

        <div className="flex w-32 items-center justify-center gap-1.5">
          {source && <ConnectorLogo type={source} size={14} className="shrink-0 text-muted-foreground" />}
          <Badge variant="outline" className="text-[10px]">
            {humanSourceType(entity.sourceType)}
          </Badge>
          {isAiDiscovered(entity) && (
            <Badge
              variant="secondary"
              className="text-[9px] px-1 py-0 bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300"
            >
              AI
            </Badge>
          )}
        </div>

        <span className="w-16 text-center text-xs font-mono text-muted-foreground">
          {entity.mentionCount > 0 ? entity.mentionCount : "-"}
        </span>

        <div className="flex w-20 items-center justify-center gap-1">
          <Badge
            variant={
              entity.status === "confirmed" ? "secondary" : entity.status === "tentative" ? "outline" : "destructive"
            }
            className="text-[10px]"
          >
            {entity.status}
          </Badge>
        </div>

        <div className="w-24 text-right">
          <span className="text-xs text-muted-foreground">
            {entity.lastMentionAt ? formatRelativeTime(entity.lastMentionAt) : "-"}
          </span>
        </div>
      </button>
    </div>
  );
}

/**
 * "Ghost" row representing a pending entity_review_queue row sitting at
 * the top of the entities table. Same columns as a real row, but with
 * subtle styling (dashed left border + amber tint + Under-review label).
 * Click opens the drawer in review mode.
 */
function GhostReviewRow({ row, onSelect }: { row: EntityReviewQueueRow; onSelect: (id: string) => void }) {
  const isPerson = row.entity_type === "person";
  return (
    <div className="border-b border-border last:border-b-0" data-testid={`review-row-${row.id}`}>
      <button
        type="button"
        onClick={() => onSelect(row.id)}
        className="flex w-full cursor-pointer items-center gap-3 bg-amber-50/40 px-3 py-2.5 text-left text-sm hover:bg-amber-50 dark:bg-amber-950/20 dark:hover:bg-amber-950/30"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isPerson ? (
            <UserIcon size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <CubeIcon size={14} className="shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{row.proposed_name}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              <span className="font-medium text-amber-700 dark:text-amber-400">Under review</span>
              {row.candidate?.name ? <> · suggests {row.candidate.name}</> : <> · no suggested match</>}
            </p>
          </div>
        </div>

        <div className="flex w-32 items-center justify-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {humanSourceType(row.entity_type)}
          </Badge>
        </div>

        <span className="w-16 text-center text-xs font-mono text-muted-foreground">
          {row.evidenceCount > 0 ? row.evidenceCount : "-"}
        </span>

        <div className="flex w-20 items-center justify-center gap-1">
          <Badge
            variant="outline"
            className="border-amber-300 text-[10px] text-amber-700 dark:border-amber-700 dark:text-amber-400"
          >
            review
          </Badge>
        </div>

        <div className="w-24 text-right">
          <span className="text-xs text-muted-foreground">{formatRelativeTime(row.last_seen_at)}</span>
        </div>
      </button>
    </div>
  );
}

function EntityDetailSheet({ entityId, onClose }: { entityId: string | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { role } = useDashboardAuth();
  const isAdmin = role === "admin";
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState("");

  const { data: entityData, isLoading: isLoadingEntity } = useQuery({
    queryKey: ["entity-detail", entityId],
    queryFn: () => api.entities.get(entityId as string),
    enabled: !!entityId,
  });

  const { data: mentionsData, isLoading: isLoadingMentions } = useQuery({
    queryKey: ["entity-mentions", entityId, { limit: 50 }],
    queryFn: () => api.entities.mentions(entityId as string, { limit: 50 }),
    enabled: !!entityData,
  });

  const entity = entityData?.entity;
  const mentions = mentionsData?.mentions ?? [];
  const totalMentions = mentionsData?.total ?? 0;
  const hiddenMentions = mentionsData?.hiddenCount ?? 0;

  const updateMutation = useMutation({
    mutationFn: (data: { name?: string; sourceType?: string }) => api.entities.update(entityId as string, data),
    onSuccess: () => {
      toast.success("Entity updated.");
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ["entity-detail", entityId] });
      queryClient.invalidateQueries({ queryKey: ["entities"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.entities.remove(entityId as string),
    onSuccess: () => {
      toast.success("Entity deleted.");
      queryClient.invalidateQueries({ queryKey: ["entities"] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const startEditing = () => {
    if (entity) {
      setEditName(entity.name);
      setEditType(entity.sourceType);
      setIsEditing(true);
    }
  };

  const sourceCounts = mentions.reduce(
    (acc, m) => {
      const src = m.file.source;
      acc[src] = (acc[src] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <Sheet open={!!entityId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-base">{isLoadingEntity ? "Loading..." : (entity?.name ?? "Entity")}</SheetTitle>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {isLoadingEntity ? (
            <div className="space-y-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-24 rounded-lg" />
            </div>
          ) : entity ? (
            <div className="space-y-4">
              {isEditing ? (
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Name</p>
                    <Input
                      value={editName}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Type</p>
                    <Input
                      value={editType}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditType(e.target.value)}
                      className="mt-1 text-sm"
                      placeholder="e.g. person, clickup_space, company, product"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="text-xs"
                      onClick={() => updateMutation.mutate({ name: editName, sourceType: editType })}
                      disabled={updateMutation.isPending || !editName.trim()}
                    >
                      {updateMutation.isPending ? "Saving..." : "Save"}
                    </Button>
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => setIsEditing(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {humanSourceType(entity.sourceType)}
                      </Badge>
                      <Badge variant={entity.status === "confirmed" ? "secondary" : "outline"} className="text-[10px]">
                        {entity.status}
                      </Badge>
                      {entity.subtype && (
                        <Badge variant="secondary" className="text-[10px]">
                          {entity.subtype}
                        </Badge>
                      )}
                    </div>
                    <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={startEditing}>
                      Edit
                    </Button>
                  </div>
                </>
              )}

              {entity.aliases.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Aliases</p>
                  <p className="mt-1 text-xs text-muted-foreground">{entity.aliases.join(", ")}</p>
                </div>
              )}

              {Object.keys(sourceCounts).length > 0 && (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Sources ({totalMentions} mentions)
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {Object.entries(sourceCounts).map(([source, count]) => (
                      <Badge key={source} variant="secondary" className="text-[10px]">
                        {source} ({count})
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Mention Timeline
                </p>

                {isLoadingMentions ? (
                  <div className="mt-2 space-y-2">
                    {[1, 2, 3].map((k) => (
                      <Skeleton key={k} className="h-16 rounded-lg" />
                    ))}
                  </div>
                ) : mentions.length === 0 ? (
                  hiddenMentions > 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {hiddenMentions} {hiddenMentions === 1 ? "mention" : "mentions"} in files you don't have access
                      to.
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      No mentions yet. Run enrichment or backfill to populate.
                    </p>
                  )
                ) : (
                  <div className="mt-2 space-y-1">
                    {hiddenMentions > 0 && (
                      <p className="px-1 pb-1 text-[10px] text-muted-foreground/70">
                        +{hiddenMentions} {hiddenMentions === 1 ? "mention" : "mentions"} in files you don't have access
                        to
                      </p>
                    )}
                    {mentions.map((mention) => (
                      <MentionItem key={mention.id} mention={mention} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Entity not found.</p>
          )}
        </div>

        {entity && isAdmin && (
          <div className="border-t border-border px-4 py-3">
            <Button
              size="sm"
              variant="outline"
              className="w-full gap-1.5 text-xs text-destructive hover:bg-destructive/10"
              onClick={() => {
                if (window.confirm(`Delete "${entity.name}" and all its mentions?`)) {
                  deleteMutation.mutate();
                }
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Entity"}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function MentionItem({ mention }: { mention: EntityMention }) {
  return (
    <div className="rounded-lg border border-border p-3 text-xs hover:bg-muted/30">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Badge variant="outline" className="shrink-0 text-[9px]">
            {mention.file.source}
          </Badge>
          <span className="truncate font-medium">{mention.file.fileName}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className="text-muted-foreground">{formatRelativeTime(mention.sourceDate)}</span>
          {mention.file.providerUrl && (
            <a
              href={mention.file.providerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowSquareOutIcon size={12} />
            </a>
          )}
        </div>
      </div>
      {mention.contextSnippet && <p className="mt-1.5 text-muted-foreground line-clamp-2">{mention.contextSnippet}</p>}
      {mention.file.sourcePath && (
        <p className="mt-1 text-[10px] text-muted-foreground/60">{mention.file.sourcePath}</p>
      )}
    </div>
  );
}

/**
 * Review-mode drawer — opens when a ghost row is clicked.
 *
 * The right column has two states driven from `<ReconcileBody>`:
 *  - **candidate**: show a candidate card (original suggestion OR a picked
 *    one) with ✓ (confirm merge) and ✗ (flip to chooser) icon-buttons in
 *    the header.
 *  - **chooser**: show a search box + "Create as new" button. Picking from
 *    search returns to candidate mode previewing the picked entity;
 *    Create-as-new fires the reject mutation.
 *
 * Orphan rows (no `candidate_entity_id`) open directly in chooser mode —
 * there's nothing to confirm against, so showing a ✓ would be misleading.
 */
function ReviewDetailSheet({ reviewId, onClose }: { reviewId: string | null; onClose: () => void }) {
  const { data: detail, isLoading } = useQuery({
    queryKey: reviewId ? detailKey(reviewId) : ["entity-review", "detail", "none"],
    queryFn: () => api.entityReview.get(reviewId as string),
    enabled: !!reviewId,
  });

  const row = detail?.row;
  const evidence: EntityReviewEvidenceRow[] = detail?.evidence ?? [];

  return (
    <Sheet open={!!reviewId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="text-base">
            {isLoading ? "Loading..." : row ? `Reconcile: ${row.proposed_name}` : "Review"}
          </SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-40 rounded-lg" />
            </div>
          ) : !row ? (
            <p className="text-sm text-muted-foreground">Review row not found.</p>
          ) : (
            <ReconcileBody key={row.id} row={row} evidence={evidence} onClose={onClose} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ReconcileBody({
  row,
  evidence,
  onClose,
}: {
  row: EntityReviewQueueRow;
  evidence: EntityReviewEvidenceRow[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // Initial mode: chooser for orphans (nothing to confirm), candidate otherwise.
  const hasOriginalCandidate = !!row.candidate_entity_id;
  const [mode, setMode] = useState<"candidate" | "chooser">(hasOriginalCandidate ? "candidate" : "chooser");
  // When set, the candidate card previews a picked entity instead of the row's default suggestion.
  const [pickedEntityId, setPickedEntityId] = useState<string | null>(null);

  const mutations = useReviewMutations(row, () => {
    queryClient.invalidateQueries({ queryKey: ["entities"] });
    onClose();
  });

  const activeCandidateId = mode === "candidate" ? (pickedEntityId ?? row.candidate_entity_id ?? null) : null;

  const { data: candidateEntity } = useQuery({
    queryKey: ["entity-detail", activeCandidateId],
    queryFn: () => api.entities.get(activeCandidateId as string),
    enabled: !!activeCandidateId,
  });

  const { data: candidateMentionsData } = useQuery({
    queryKey: ["entity-mentions", activeCandidateId, { limit: 20 }],
    queryFn: () => api.entities.mentions(activeCandidateId as string, { limit: 20 }),
    enabled: !!activeCandidateId,
  });

  const candidate = candidateEntity?.entity ?? null;
  const candidateMentions = candidateMentionsData?.mentions ?? [];
  const isPickedPreview = pickedEntityId !== null;

  return (
    <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-3 md:grid-cols-2">
      <ReconcileColumn
        title="Proposed"
        toneClass="border-amber-400 bg-amber-50/40 dark:border-amber-400/60 dark:bg-amber-950/20"
        name={row.proposed_name}
        typeLabel={humanSourceType(row.entity_type)}
        email={row.proposed_email}
        evidence={evidence}
      />
      {mode === "candidate" ? (
        <CandidateView
          row={row}
          candidateEntity={candidate}
          candidateMentions={candidateMentions}
          isPickedPreview={isPickedPreview}
          isPending={mutations.isPending}
          errorMessage={mutations.errorCopy?.message ?? null}
          onConfirm={() => {
            if (pickedEntityId) mutations.mergeInto(pickedEntityId);
            else mutations.confirm();
          }}
          onReject={() => {
            mutations.clearError();
            setMode("chooser");
          }}
        />
      ) : (
        <ChooserView
          row={row}
          isPending={mutations.isPending}
          errorMessage={mutations.errorCopy?.message ?? null}
          canBackToCandidate={hasOriginalCandidate && !isPickedPreview}
          onBack={() => {
            mutations.clearError();
            setMode("candidate");
          }}
          onPick={(entityId) => {
            mutations.clearError();
            setPickedEntityId(entityId);
            setMode("candidate");
          }}
          onCreateNew={() => mutations.reject()}
        />
      )}
    </div>
  );
}

function ReconcileColumn({
  title,
  toneClass,
  name,
  typeLabel,
  email,
  evidence,
}: {
  title: string;
  toneClass: string;
  name: string;
  typeLabel: string;
  email: string | null;
  evidence: EntityReviewEvidenceRow[];
}) {
  return (
    <div className={`flex min-h-0 flex-col rounded-lg border ${toneClass}`} data-testid="reconcile-proposed">
      <div className="border-b border-current/10 px-3 py-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="mt-0.5 truncate text-sm font-semibold">{name}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {typeLabel}
          </Badge>
          {email ? <span className="text-[11px] text-muted-foreground">{email}</span> : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Evidence ({evidence.length})
        </p>
        {evidence.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No evidence rows.</p>
        ) : (
          <ul className="mt-1 flex-1 space-y-1 overflow-y-auto">
            {evidence.map((e) => (
              <li key={e.id} className="rounded-md border border-border bg-background p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline" className="shrink-0 text-[9px]">
                      {e.source}
                    </Badge>
                    <span className="truncate font-medium">{e.file.name}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">{formatRelativeTime(e.seen_at)}</span>
                    {e.file.providerUrl ? (
                      <a
                        href={e.file.providerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ArrowSquareOutIcon size={12} />
                      </a>
                    ) : null}
                  </div>
                </div>
                {e.file.sourcePath ? (
                  <p className="mt-1 text-[10px] text-muted-foreground/60">{e.file.sourcePath}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Right column when the reconcile body is showing a candidate (the original
 * suggestion OR a picked one). Header carries the candidate name + ✓/✗
 * icon-buttons; body shows recent mentions.
 *
 * When `isPickedPreview` is true the column is tinted emerald and the title
 * reads "PICKED — CONFIRM TO MERGE" so the user knows the ✓ will merge into
 * the picked target instead of the row's original suggestion.
 */
function CandidateView({
  row,
  candidateEntity,
  candidateMentions,
  isPickedPreview,
  isPending,
  errorMessage,
  onConfirm,
  onReject,
}: {
  row: EntityReviewQueueRow;
  candidateEntity: EntityListItem | null;
  candidateMentions: EntityMention[];
  isPickedPreview: boolean;
  isPending: boolean;
  errorMessage: string | null;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const sectionTitle = isPickedPreview ? "Picked — confirm to merge" : "Suggested existing";
  const email = entityEmail(candidateEntity) ?? (isPickedPreview ? null : row.candidate?.email);
  return (
    <div
      className={`flex min-h-0 flex-col rounded-lg border bg-muted/20 ${
        isPickedPreview ? "border-emerald-400 dark:border-emerald-600" : "border-border"
      }`}
      data-testid="reconcile-candidate"
    >
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p
            className={`text-[10px] font-medium uppercase tracking-wider ${
              isPickedPreview ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"
            }`}
          >
            {sectionTitle}
          </p>
          <p className="mt-0.5 truncate text-sm font-semibold">{candidateEntity?.name ?? row.candidate?.name ?? "…"}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {candidateEntity ? (
              <Badge variant="outline" className="text-[10px]">
                {humanSourceType(candidateEntity.sourceType)}
              </Badge>
            ) : null}
            {email ? <span className="text-[11px] text-muted-foreground">{email}</span> : null}
            {row.candidate_reason && !isPickedPreview ? (
              <span className="text-[11px] text-muted-foreground">· {row.candidate_reason}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            aria-label="Confirm merge"
            data-testid="confirm-merge"
            className="rounded-md border border-emerald-400 bg-emerald-50 p-1.5 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70"
          >
            <CheckIcon size={14} weight="bold" />
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={isPending}
            aria-label="Reject this match"
            data-testid="reject-match"
            className="rounded-md border border-foreground/25 bg-background p-1.5 text-foreground/80 hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <XIcon size={14} weight="bold" />
          </button>
        </div>
      </div>
      {errorMessage ? (
        <div className="border-b border-border px-3 py-2 text-xs text-destructive">{errorMessage}</div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Recent mentions ({candidateMentions.length})
        </p>
        {candidateMentions.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No mentions yet.</p>
        ) : (
          <ul className="mt-1 flex-1 space-y-1 overflow-y-auto">
            {candidateMentions.map((m) => (
              <li key={m.id} className="rounded-md border border-border bg-background p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline" className="shrink-0 text-[9px]">
                      {m.file.source}
                    </Badge>
                    <span className="truncate font-medium">{m.file.fileName}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">{formatRelativeTime(m.sourceDate)}</span>
                    {m.file.providerUrl ? (
                      <a
                        href={m.file.providerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ArrowSquareOutIcon size={12} />
                      </a>
                    ) : null}
                  </div>
                </div>
                {m.file.sourcePath ? (
                  <p className="mt-1 text-[10px] text-muted-foreground/60">{m.file.sourcePath}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Right column when the reconcile body is in chooser mode — either because
 * the row is an orphan (no original candidate) or the user clicked ✗ on a
 * candidate. Shows a search box for picking an existing entity + a
 * "Create as new" fallback button.
 *
 * When the row HAS an original candidate to return to, a back arrow next
 * to the title brings the user back to the candidate view.
 */
function ChooserView({
  row,
  isPending,
  errorMessage,
  canBackToCandidate,
  onBack,
  onPick,
  onCreateNew,
}: {
  row: EntityReviewQueueRow;
  isPending: boolean;
  errorMessage: string | null;
  canBackToCandidate: boolean;
  onBack: () => void;
  onPick: (entityId: string) => void;
  onCreateNew: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-border" data-testid="reconcile-candidate">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {canBackToCandidate ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to suggested candidate"
            className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeftIcon size={14} />
          </button>
        ) : null}
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">What instead?</p>
      </div>
      {errorMessage ? (
        <div className="border-b border-border px-3 py-2 text-xs text-destructive">{errorMessage}</div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Search for a match</p>
          <div className="mt-2">
            <EntityPicker
              entityType={row.entity_type}
              excludeEntityId={row.candidate_entity_id ?? undefined}
              onPick={onPick}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onCreateNew}
          disabled={isPending}
          className="gap-1.5"
          data-testid="create-new"
        >
          <PlusIcon size={14} />
          Create as new {row.entity_type}
        </Button>
      </div>
    </div>
  );
}
