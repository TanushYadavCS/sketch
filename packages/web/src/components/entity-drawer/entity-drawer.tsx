/**
 * EntityDrawer — the universal provenance/audit surface for one entity.
 *
 * Layout:
 *   1. Header — name + type badge + identity chips (domains / email+role /
 *      aliases) inline; last seen right-aligned.
 *   2. Summary block — Gemini narrative + up to 3 top learned-fact bullets.
 *      Falls back to the deterministic WHAT line when the brief is cold and
 *      there are no facts yet.
 *   3. Tabs — Timeline (default) | Relationships.
 *
 * Driven by EntityUiProvider's stack. Each level renders independently —
 * pushing a related entity pushes a new id onto the stack; Back chip pops.
 */
import { EntityMergeDialog } from "@/components/entity-merge-dialog";
import { EntityShareDialog } from "@/components/entity-share-dialog";
import type { EntityDetail, EntityRelationEvidenceRow, EntityRelationView, EntityRelationsResponse } from "@/lib/api";
import { api } from "@/lib/api";
import { EntityAvatar, EntityChip, entityAccent, useEntityUi } from "@/lib/entity-ui";
import {
  ArrowLeftIcon,
  ArrowsLeftRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  GlobeIcon,
  ShareNetworkIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ScopePanel } from "./scope-panel";
import { TimelineStrip } from "./timeline-strip";

const CONFIDENCE_LABEL: Record<string, string> = {
  EXTRACTED: "EXTRACTED",
  INFERRED: "INFERRED",
  AMBIGUOUS: "AMBIGUOUS",
};

function formatRelationVerb(type: string): string {
  return type.replace(/_/g, " ");
}

function formatRelative(iso: string | null): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function EntityDrawer() {
  const ui = useEntityUi();
  const open = ui.stack.length > 0 && ui.mode === "drawer";
  const currentId = ui.stack[ui.stack.length - 1];
  const previousName = useDrawerPreviousName(ui.stack);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) ui.closeAll();
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[720px]">
        <SheetTitle className="sr-only">Entity drawer</SheetTitle>
        <SheetDescription className="sr-only">
          Provenance and audit view for the selected entity, with identity flags, summary, timeline, and relationships.
        </SheetDescription>
        {currentId ? (
          <EntityDrawerBody
            key={currentId}
            entityId={currentId}
            stackDepth={ui.stack.length}
            previousName={previousName}
            onBack={ui.popEntity}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function useDrawerPreviousName(stack: string[]): string | null {
  const prevId = stack.length > 1 ? stack[stack.length - 2] : null;
  const { data } = useQuery({
    queryKey: ["entity-drawer", "header-name", prevId],
    queryFn: () => api.entities.get(prevId as string),
    enabled: !!prevId,
  });
  return data?.entity.name ?? null;
}

interface EntityDrawerBodyProps {
  entityId: string;
  stackDepth: number;
  previousName: string | null;
  onBack: () => void;
}

function EntityDrawerBody({ entityId, stackDepth, previousName, onBack }: EntityDrawerBodyProps) {
  const profileQuery = useQuery({
    queryKey: ["entity-drawer", "profile", entityId],
    queryFn: () => api.entities.get(entityId),
  });
  const relationsQuery = useQuery({
    queryKey: ["entity-drawer", "relations", entityId],
    queryFn: () => api.entities.relations(entityId),
    enabled: !!profileQuery.data,
  });

  if (profileQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (!profileQuery.data) {
    return <div className="p-6 text-sm text-muted-foreground">Entity not found.</div>;
  }

  const { entity } = profileQuery.data;
  const accent = entityAccent({ id: entity.id, name: entity.name, sourceType: entity.sourceType });

  return (
    <>
      <DrawerHeader
        entity={entity}
        stackDepth={stackDepth}
        previousName={previousName}
        onBack={onBack}
        accent={accent}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <SummaryBlock entity={entity} accent={accent} />
        <DrawerTabs
          entityId={entity.id}
          sourceType={entity.sourceType}
          relations={relationsQuery.data}
          relationsLoading={relationsQuery.isLoading}
        />
      </div>
    </>
  );
}

interface DrawerHeaderProps {
  entity: EntityDetail;
  stackDepth: number;
  previousName: string | null;
  onBack: () => void;
  accent: string;
}

function DrawerHeader({ entity, stackDepth, previousName, onBack, accent }: DrawerHeaderProps) {
  const ui = useEntityUi();
  const lastSeen = entity.profile.lastSeenAt;
  // EntityDrawer mounts at root (outside the dashboard route context), so the
  // route-context auth hook is not available here — query the session directly.
  const sessionQuery = useQuery({
    queryKey: ["auth-session"],
    queryFn: () => api.auth.session(),
    staleTime: 60_000,
  });
  const isAdmin = sessionQuery.data?.role === "admin";
  const [shareOpen, setShareOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div
      className="sticky top-0 z-10 border-b bg-background px-6 pb-4 pt-5"
      style={{ borderTopColor: accent, borderTopWidth: 3 }}
    >
      {stackDepth > 1 && previousName ? (
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          <span>Back to {previousName}</span>
        </button>
      ) : null}
      <div className="flex items-start gap-3">
        <EntityAvatar entity={entity} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 flex-1 truncate font-serif text-[20px] leading-tight">{entity.name}</h2>
            <div className="flex shrink-0 items-center gap-2">
              {entity.shareWithEveryone ? (
                <Badge variant="outline" className="gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <GlobeIcon size={10} />
                  Anyone in org
                </Badge>
              ) : null}
              {lastSeen ? (
                <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Last seen {formatRelative(lastSeen)}
                </span>
              ) : null}
              {isAdmin ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-[11px]"
                    onClick={() => setMergeOpen(true)}
                  >
                    <ArrowsLeftRightIcon size={12} />
                    Merge
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-[11px]"
                    onClick={() => setShareOpen(true)}
                  >
                    <ShareNetworkIcon size={12} />
                    Share
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-[11px] text-destructive hover:text-destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <TrashIcon size={12} />
                    Delete
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {entity.profile.entityType}
            </Badge>
            <IdentityChips entity={entity} />
            {entity.status !== "confirmed" ? (
              <Badge variant="secondary" className="text-[10px]">
                {entity.status}
              </Badge>
            ) : null}
            {(entity.manualShares?.length ?? 0) > 0 ? (
              <Badge variant="secondary" className="text-[10px]">
                Shared with {entity.manualShares?.length ?? 0}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>
      {isAdmin ? (
        <>
          <EntityShareDialog
            entityId={entity.id}
            entityName={entity.name}
            open={shareOpen}
            onOpenChange={setShareOpen}
          />
          <EntityMergeDialog
            entityId={entity.id}
            entityName={entity.name}
            sourceType={entity.sourceType}
            open={mergeOpen}
            onOpenChange={setMergeOpen}
            onMerged={(survivorId) => {
              if (survivorId !== entity.id) ui.openEntity(survivorId);
            }}
          />
          <DeleteEntityDialog
            entityId={entity.id}
            entityName={entity.name}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Admin-only soft delete. The entity is tombstoned server-side (hidden from the
 * graph, recoverable by an admin) and its name is suppressed so the LLM
 * enrichment paths don't re-mint it. On success the drawer closes and every
 * surface that could still show the entity is invalidated.
 */
function DeleteEntityDialog({
  entityId,
  entityName,
  open,
  onOpenChange,
}: {
  entityId: string;
  entityName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ui = useEntityUi();
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: () => api.entities.remove(entityId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entity-drawer"] });
      queryClient.invalidateQueries({ queryKey: ["entities"] });
      queryClient.invalidateQueries({ queryKey: ["entity-graph"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`${entityName} deleted`);
      onOpenChange(false);
      ui.closeAll();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {entityName}?</AlertDialogTitle>
          <AlertDialogDescription>
            It will be hidden from the graph and won't be recreated automatically. An admin can restore it later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              deleteMutation.mutate();
            }}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Identity flags rendered inline in the header. Person → email + role.
 * Company/product → domains (primary first). All types → aliases as a muted
 * trailing line.
 */
function IdentityChips({ entity }: { entity: EntityDetail }) {
  const meta = entity.metadata ?? {};
  const email = typeof meta.email === "string" ? meta.email : null;
  const role = typeof meta.role === "string" ? meta.role : null;
  const domains = entity.profile.domainsForCompany;
  const aliases = entity.aliases;

  return (
    <>
      {role ? (
        <Badge variant="outline" className="text-[10px]">
          {role}
        </Badge>
      ) : null}
      {email ? (
        <Badge variant="secondary" className="font-mono text-[10px] normal-case tracking-normal">
          {email}
        </Badge>
      ) : null}
      {domains.map((d) => (
        <Badge
          key={d.domain}
          variant={d.isPrimary ? "secondary" : "outline"}
          className="font-mono text-[10px] normal-case tracking-normal"
        >
          {d.domain}
          {d.isPrimary ? " · primary" : null}
        </Badge>
      ))}
      {aliases.length > 0 ? (
        <span className="text-[11px] text-muted-foreground">Also: {aliases.join(", ")}</span>
      ) : null}
    </>
  );
}

/**
 * Summary block — deterministic prose built server-side from relationships +
 * activity aggregates. No LLM, no shimmer. Two short paragraphs: identity
 * (type / role / employer / engagements) and activity (file count, mention
 * count, distinct days active, most-frequent collaborators).
 */
function SummaryBlock({ entity, accent }: { entity: EntityDetail; accent: string }) {
  const { identity, activity } = entity.profile.summary;
  const crmBrief = entity.profile.crmActivityBrief;
  const hasContent = identity.length > 0 || activity.length > 0 || Boolean(crmBrief);
  return (
    <section aria-label="Summary" className="rounded-lg border p-4" style={{ borderColor: `${accent}33` }}>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Summary</div>
      {hasContent ? (
        <div className="space-y-2 text-sm leading-snug">
          {identity ? <p>{identity}</p> : null}
          {activity ? <p className="text-muted-foreground">{activity}</p> : null}
          {crmBrief ? (
            <div className="border-t pt-2">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                CRM Activity
              </div>
              <p>{crmBrief.summary}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {crmBrief.activityCount} {crmBrief.activityCount === 1 ? "activity" : "activities"} · updated{" "}
                {formatShortDate(crmBrief.updatedAt)}
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No summary yet.</p>
      )}
    </section>
  );
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface DrawerTabsProps {
  entityId: string;
  sourceType: string;
  relations: EntityRelationsResponse | undefined;
  relationsLoading: boolean;
}

function DrawerTabs({ entityId, sourceType, relations, relationsLoading }: DrawerTabsProps) {
  const isProject = sourceType === "project";
  const [tab, setTab] = useState<"timeline" | "relationships" | "scope">("timeline");
  const timelineQuery = useQuery({
    queryKey: ["entity-drawer", "timeline", entityId],
    queryFn: () => api.entities.timeline(entityId),
  });

  const timelineCount = timelineQuery.data?.totalCount ?? 0;
  const timelineHint = timelineQuery.data?.truncated
    ? `${timelineCount}+`
    : timelineCount > 0
      ? `${timelineCount}`
      : null;
  const relationsCount = relations?.totalCount ?? 0;
  const relationsHint = relations?.truncated ? `${relationsCount}+` : relationsCount > 0 ? `${relationsCount}` : null;

  return (
    <div className="mt-5">
      <div className="mb-3 inline-flex rounded-lg border-[0.5px] border-border bg-card p-0.5 dark:bg-[#111110]">
        <TabButton
          active={tab === "timeline"}
          onClick={() => setTab("timeline")}
          label="Timeline"
          hint={timelineHint}
        />
        <TabButton
          active={tab === "relationships"}
          onClick={() => setTab("relationships")}
          label="Relationships"
          hint={relationsHint}
        />
        {isProject ? (
          <TabButton active={tab === "scope"} onClick={() => setTab("scope")} label="Scope" hint={null} />
        ) : null}
      </div>
      {tab === "scope" && isProject ? (
        <ScopePanel entityId={entityId} />
      ) : tab === "timeline" ? (
        <TimelinePanel timelineQuery={timelineQuery} />
      ) : (
        <RelationshipsPanel relations={relations} isLoading={relationsLoading} entityId={entityId} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-1 text-xs transition-colors",
        active
          ? "bg-accent font-medium text-foreground dark:bg-[#1C1C1A]"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {hint ? <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{hint}</span> : null}
    </button>
  );
}

interface TimelinePanelProps {
  timelineQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.entities.timeline>>>>;
}

function TimelinePanel({ timelineQuery }: TimelinePanelProps) {
  if (timelineQuery.isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }
  const groups = timelineQuery.data?.groups ?? [];
  if (groups.length === 0) {
    return <p className="text-xs text-muted-foreground">No file mentions yet.</p>;
  }
  return <TimelineStrip groups={groups} />;
}

interface RelationshipsPanelProps {
  relations: EntityRelationsResponse | undefined;
  isLoading: boolean;
  entityId: string;
}

function RelationshipsPanel({ relations, isLoading, entityId }: RelationshipsPanelProps) {
  if (isLoading) {
    return <Skeleton className="h-20 w-full" />;
  }
  if (!relations || (relations.outgoing.length === 0 && relations.incoming.length === 0)) {
    return <p className="text-xs text-muted-foreground">No relationships yet.</p>;
  }

  // AMBIGUOUS pinned across both directions
  const all: Array<EntityRelationView & { direction: "outgoing" | "incoming" }> = [
    ...relations.outgoing.map((r) => ({ ...r, direction: "outgoing" as const })),
    ...relations.incoming.map((r) => ({ ...r, direction: "incoming" as const })),
  ];
  const ambiguous = all.filter((r) => r.confidence === "AMBIGUOUS");
  const rest = all.filter((r) => r.confidence !== "AMBIGUOUS");

  return (
    <>
      {ambiguous.length > 0 ? (
        <div className="mb-3 rounded-lg border border-amber-300/50 bg-amber-50/40 p-2 dark:bg-amber-950/20">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-500">
            <WarningIcon className="h-3 w-3" />
            <span>Needs review</span>
          </div>
          <div className="flex flex-col">
            {ambiguous.map((r) => (
              <RelationshipRow key={r.id} relation={r} entityId={entityId} />
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col">
        {rest.map((r) => (
          <RelationshipRow key={r.id} relation={r} entityId={entityId} />
        ))}
      </div>
    </>
  );
}

interface RelationshipRowProps {
  relation: EntityRelationView & { direction: "outgoing" | "incoming" };
  entityId: string;
}

function RelationshipRow({ relation, entityId }: RelationshipRowProps) {
  const [expanded, setExpanded] = useState(false);
  const ui = useEntityUi();
  const otherAccent = entityAccent({
    id: relation.other.id,
    name: relation.other.name,
    sourceType: relation.other.sourceType,
  });
  return (
    <div className="border-b py-2 last:border-b-0">
      <div className="flex w-full items-center gap-2 hover:bg-muted/50">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex items-center gap-2 text-left">
          {expanded ? <CaretDownIcon className="h-3 w-3 shrink-0" /> : <CaretRightIcon className="h-3 w-3 shrink-0" />}
          <span className="text-xs lowercase text-muted-foreground">
            {relation.direction === "outgoing"
              ? formatRelationVerb(relation.relationshipType)
              : `← ${formatRelationVerb(relation.relationshipType)}`}
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            ui.pushEntity(relation.other.id);
          }}
          className="inline-flex items-center gap-1 truncate rounded px-1 py-0.5 text-xs font-medium hover:bg-muted"
          style={{ color: otherAccent }}
        >
          {relation.other.name}
        </button>
        <ConfidenceChip confidence={relation.confidence} score={relation.confidenceScore} />
        <span className="ml-auto text-[10px] text-muted-foreground">
          {relation.evidenceCount} {relation.evidenceCount === 1 ? "file" : "files"}
        </span>
      </div>
      {expanded ? <RelationshipExpanded relation={relation} entityId={entityId} /> : null}
    </div>
  );
}

function ConfidenceChip({ confidence, score }: { confidence: string; score: number }) {
  const className =
    confidence === "EXTRACTED"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
      : confidence === "INFERRED"
        ? "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400"
        : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-500";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium", className)}>
      <span>{CONFIDENCE_LABEL[confidence] ?? confidence}</span>
      {confidence !== "AMBIGUOUS" ? <span className="font-mono opacity-70">{score.toFixed(2)}</span> : null}
    </span>
  );
}

function RelationshipExpanded({
  relation,
  entityId,
}: {
  relation: EntityRelationView;
  entityId: string;
}) {
  const evidenceQuery = useQuery({
    queryKey: ["entity-drawer", "relation-evidence", entityId, relation.id],
    queryFn: () => api.entities.relationEvidence(entityId, relation.id),
  });
  return (
    <div className="ml-5 mt-1 space-y-2 rounded-md bg-muted/40 p-2 text-xs">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Evidence</div>
      {evidenceQuery.isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : !evidenceQuery.data || evidenceQuery.data.rows.length === 0 ? (
        evidenceQuery.data && evidenceQuery.data.totalCount > 0 ? (
          <p className="text-muted-foreground">
            {evidenceQuery.data.totalCount} {evidenceQuery.data.totalCount === 1 ? "file" : "files"} not visible to you.
          </p>
        ) : (
          <p className="text-muted-foreground">No evidence rows.</p>
        )
      ) : (
        <>
          <ul className="space-y-1">
            {evidenceQuery.data.rows.map((row) => (
              <EvidenceItem key={`${row.fileId}:${row.chunkIndex ?? "n"}`} row={row} />
            ))}
          </ul>
          {evidenceQuery.data.visibleCount < evidenceQuery.data.totalCount ? (
            <p className="text-[10px] text-muted-foreground">
              +{evidenceQuery.data.totalCount - evidenceQuery.data.visibleCount} not visible to you
            </p>
          ) : null}
        </>
      )}
      {relation.reviewId ? (
        <a
          className="text-[11px] text-primary underline-offset-2 hover:underline"
          href={`/files?review=${relation.reviewId}`}
        >
          Review this →
        </a>
      ) : null}
    </div>
  );
}

function EvidenceItem({ row }: { row: EntityRelationEvidenceRow }) {
  return (
    <li className="flex flex-col gap-0.5 rounded border bg-background p-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{row.fileName}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelative(row.occurredAt)}</span>
      </div>
      {row.contextSnippet ? (
        <p className="line-clamp-2 text-[11px] text-muted-foreground">{row.contextSnippet}</p>
      ) : null}
    </li>
  );
}

/** Convenience re-export so callers can pull both the provider mount and the drawer from one place. */
export { EntityChip };
