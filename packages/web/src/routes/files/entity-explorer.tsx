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
import { AddEntityDialog } from "@/components/entity-review/add-entity-dialog";
import { humanSourceType } from "@/components/entity-review/entity-format";
import { GhostReviewRow, ReviewDetailSheet } from "@/components/entity-review/review-band";
import { GraphRebuildDialog, type GraphRebuildDialogPrefill } from "@/components/graph-rebuild-dialog";
import { RebuildBanner } from "@/components/rebuild-banner";
import { countKey, listKey } from "@/components/review-actions";
import { useRebuildJob } from "@/hooks/use-rebuild-job";
import type { EntityListItem, EntityReviewQueueRow } from "@/lib/api";
import { api } from "@/lib/api";
import { useEntityUi } from "@/lib/entity-ui";
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
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

/** Derive the connector source from entity sourceType (e.g., "clickup_space" → "clickup"). */
function sourceFromType(sourceType: string): string | null {
  if (sourceType.startsWith("clickup_")) return "clickup";
  if (sourceType.startsWith("notion_")) return "notion";
  if (sourceType.startsWith("linear_")) return "linear";
  if (sourceType.startsWith("google_drive")) return "google_drive";
  return null;
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
  const [showSystem, setShowSystem] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const { openEntity } = useEntityUi();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showRebuildDialog, setShowRebuildDialog] = useState(false);
  const [rebuildPrefill, setRebuildPrefill] = useState<GraphRebuildDialogPrefill | null>(null);

  const rebuildState = useRebuildJob({ enabled: isAdmin });
  const overlayRebuilding =
    rebuildState.activeJob !== null &&
    (rebuildState.activeJob.job.phase === "resetting" || rebuildState.activeJob.job.phase === "wiping");

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
    queryKey: ["entities", typeFilter, debouncedSearch, showSystem],
    queryFn: () =>
      api.entities.list({
        type: typeFilter ?? undefined,
        search: debouncedSearch || undefined,
        sort: "hotness",
        limit: 200,
        includeSystem: showSystem,
      }),
    refetchInterval: 30000,
  });

  const entities = data?.entities ?? [];
  const total = data?.total ?? 0;
  const tentativeCount = entities.filter((e) => e.status === "tentative").length;

  // When the experimental Your Org surface is live it owns the org-taxonomy
  // spine (product/project/team), so this band narrows to person/company to
  // avoid a row appearing in two places. Flag off → unchanged (all types here).
  const { data: setupStatus } = useQuery({ queryKey: ["setup", "status"], queryFn: () => api.setup.status() });
  const reviewTypes = setupStatus?.experimentalFlag ? ["person", "company"] : undefined;
  const reviewScope = reviewTypes?.join(",") ?? "all";

  // ECR-03B inline review surface — two-stage fetch:
  // the cheap count probe gates the (heavier) list query.
  const { data: reviewCount } = useQuery({
    queryKey: [...countKey(debouncedSearch), reviewScope],
    queryFn: () => api.entityReview.list({ limit: 0, search: debouncedSearch || undefined, types: reviewTypes }),
    refetchInterval: 30000,
  });
  const reviewTotal = reviewCount?.total ?? 0;
  const hasPendingReviews = reviewTotal > 0;

  const { data: reviewList } = useQuery({
    queryKey: [...listKey(debouncedSearch), reviewScope],
    queryFn: () => api.entityReview.list({ limit: 200, search: debouncedSearch || undefined, types: reviewTypes }),
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

        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setShowSystem((v) => !v)}
          data-testid="show-system-entities-toggle"
        >
          {showSystem ? "Hide system entities" : "Show system entities"}
        </Button>

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
              <EntityRow key={entity.id} entity={entity} onSelect={(id) => openEntity(id)} />
            ))}
          </div>
        )}
      </div>

      <AddEntityDialog open={showAddDialog} onOpenChange={setShowAddDialog} defaultType="company" />

      <GraphRebuildDialog
        open={showRebuildDialog}
        onOpenChange={setShowRebuildDialog}
        prefill={rebuildPrefill}
        onSubmitted={() => {
          rebuildState.refetch();
        }}
      />

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
