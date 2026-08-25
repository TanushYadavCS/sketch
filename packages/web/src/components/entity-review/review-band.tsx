import { EntryList, SectionCard, SectionLabel, SourceTag } from "@/components/entity-drawer/drawer-kit";
/**
 * Shared entity-review band + reconcile sheet.
 *
 * Extracted from Files → Entities so the same reconcile UI is reused verbatim
 * on the Your Org surface. Two consumers:
 *   - {@link GhostReviewRow} + {@link ReviewDetailSheet} — the explorer renders
 *     ghost rows inline inside its own table, then opens the sheet.
 *   - {@link ReviewBand} — a self-contained band (used by Your Org) that fetches
 *     a type-scoped slice of the queue, splits it into "Confirm new" (no
 *     candidate) vs "Possible duplicates" (a match was suggested), and owns the
 *     sheet.
 *
 * Clicking a row opens a reconcile drawer with two side-by-side columns —
 * Proposed | Suggested existing — and inline ✓/✗ icon-buttons on the candidate
 * card. ✗ flips the right column to a "What instead?" chooser (search +
 * create-as-new). Orphan rows (no suggested candidate) open directly in chooser
 * mode.
 */
import { EntityPicker } from "@/components/entity-picker";
import { detailKey, useReviewMutations } from "@/components/review-actions";
import type {
  ChildTask,
  EntityListItem,
  EntityMention,
  EntityReviewEvidenceRow,
  EntityReviewQueueRow,
} from "@/lib/api";
import { api } from "@/lib/api";
import { EntityAvatar, entityAccent } from "@/lib/entity-ui";
import { formatRelativeTime } from "@/routes/files/file-list";
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ArrowsLeftRightIcon,
  CheckIcon,
  CubeIcon,
  PlugsConnectedIcon,
  PlusIcon,
  SparkleIcon,
  UserIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { birthOrigin, entityEmail, humanSourceType, isWeeklyPassProjectRow } from "./entity-format";

/**
 * Self-contained review band scoped to a set of entity types. Fetches the
 * type-scoped queue slice, partitions it into births vs possible-duplicates,
 * and owns the reconcile sheet. Renders nothing when the scoped queue is empty.
 */
export function ReviewBand({ types, title = "Needs your review" }: { types: string[]; title?: string }) {
  const queryClient = useQueryClient();
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [inspectBirthId, setInspectBirthId] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["entity-review", "band", types.join(",")],
    queryFn: () => api.entityReview.list({ limit: 200, types }),
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? rows.length;

  /**
   * Births resolve inline, so refreshing the band, sidebar badge, and Files
   * band together means invalidating the whole `["entity-review"]` prefix: the
   * band key is NOT under `LIST_KEY`, so the mutation hook's list-scoped
   * invalidation alone would miss it.
   */
  const refreshAfterResolve = () => {
    queryClient.invalidateQueries({ queryKey: ["entity-review"] });
    queryClient.invalidateQueries({ queryKey: ["entities"] });
  };

  if (rows.length === 0) return null;

  const births = rows.filter((r) => !hasReviewCandidate(r));
  const duplicates = rows.filter(hasReviewCandidate);

  return (
    <section className="mb-9 overflow-hidden rounded-xl border border-amber-300/60 bg-amber-50/40 dark:border-amber-700/50 dark:bg-amber-950/20">
      <div className="flex items-baseline justify-between border-b border-amber-300/50 px-3 py-2 dark:border-amber-700/40">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
          {title} · {total}
        </span>
      </div>
      {births.length > 0 ? (
        <>
          <GroupHeader label="Confirm new" count={births.length} />
          {births.map((row) => (
            <BirthRow
              key={`review-${row.id}`}
              row={row}
              onResolved={refreshAfterResolve}
              onInspect={setInspectBirthId}
            />
          ))}
        </>
      ) : null}
      {duplicates.length > 0 ? (
        <>
          <GroupHeader label="Possible duplicates" count={duplicates.length} />
          {duplicates.map((row) => (
            <GhostReviewRow key={`review-${row.id}`} row={row} onSelect={setSelectedReviewId} />
          ))}
        </>
      ) : null}
      <ReviewDetailSheet reviewId={selectedReviewId} onClose={() => setSelectedReviewId(null)} />
      <BirthInspectSheet
        reviewId={inspectBirthId}
        onResolved={refreshAfterResolve}
        onClose={() => setInspectBirthId(null)}
      />
    </section>
  );
}

function hasReviewCandidate(row: EntityReviewQueueRow): boolean {
  return Boolean(row.candidate || (row.candidates?.length ?? 0) > 0);
}

function reviewCandidateNames(row: EntityReviewQueueRow): string[] {
  const candidates = row.candidates ?? (row.candidate ? [row.candidate] : []);
  return candidates.map((candidate) => candidate.name);
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="border-b border-amber-300/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-amber-700/80 dark:border-amber-700/30 dark:text-amber-400/70">
      {label} · {count}
    </div>
  );
}

/**
 * A small chip naming where a birth row came from: a tracker pull (ClickUp /
 * Linear) or an AI extraction from a connector's documents (Fireflies / Gmail).
 */
function OriginChip({ row }: { row: EntityReviewQueueRow }) {
  const origin = birthOrigin(row);
  if (!origin) return null;
  return (
    <Badge
      variant="outline"
      className={
        origin.kind === "ai"
          ? "gap-1 border-violet-300 text-[9px] text-violet-700 dark:border-violet-700 dark:text-violet-300"
          : "gap-1 text-[9px]"
      }
    >
      {origin.kind === "ai" ? <SparkleIcon size={9} weight="fill" /> : <PlugsConnectedIcon size={9} />}
      {origin.label}
    </Badge>
  );
}

/**
 * A birth row (proposed entity with no candidate match). It resolves inline —
 * Confirm creates the entity from its seed, Dismiss drops it without creating
 * anything, Merge opens a search-only picker for the "actually a duplicate"
 * escape hatch. The actions only appear on hover/focus to keep the list calm;
 * clicking the row body opens a read-only inspect sheet (origin + linked files).
 * No reconcile drawer: a birth is not a merge, so there's nothing to compare.
 */
function BirthRow({
  row,
  onResolved,
  onInspect,
}: {
  row: EntityReviewQueueRow;
  onResolved: () => void;
  onInspect: (id: string) => void;
}) {
  const isPerson = row.entity_type === "person";
  const [mergeOpen, setMergeOpen] = useState(false);
  const mutations = useReviewMutations(row, onResolved);

  return (
    <div
      className="group border-b border-border bg-amber-50/40 last:border-b-0 dark:bg-amber-950/20"
      data-testid={`review-row-${row.id}`}
    >
      <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
        <button
          type="button"
          onClick={() => onInspect(row.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-80"
          data-testid="birth-inspect"
        >
          {isPerson ? (
            <UserIcon size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <CubeIcon size={14} className="shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{row.proposed_name}</p>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <Badge variant="outline" className="text-[9px]">
                {humanSourceType(row.entity_type)}
              </Badge>
              <OriginChip row={row} />
              {row.evidenceCount > 0 ? <span>· {row.evidenceCount} linked</span> : null}
            </span>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button
            size="sm"
            variant="outline"
            onClick={() => mutations.confirm()}
            disabled={mutations.isPending}
            className="h-7 gap-1 border-emerald-400 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:border-emerald-600 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
            data-testid="birth-confirm"
          >
            <CheckIcon size={13} weight="bold" />
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMergeOpen(true)}
            disabled={mutations.isPending}
            className="h-7 gap-1"
            data-testid="birth-merge"
          >
            <ArrowsLeftRightIcon size={12} />
            Merge
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => mutations.dismiss()}
            disabled={mutations.isPending}
            className="h-7 gap-1 text-muted-foreground hover:text-foreground"
            data-testid="birth-dismiss"
          >
            <XIcon size={13} />
            Dismiss
          </Button>
        </div>
      </div>

      {mutations.errorCopy ? (
        <p className="px-3 pb-2 text-[11px] text-destructive">{mutations.errorCopy.message}</p>
      ) : null}

      <MergePickerDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        row={row}
        onPick={(entityId) => {
          setMergeOpen(false);
          mutations.mergeInto(entityId);
        }}
      />
    </div>
  );
}

/** Muted one-liner for the inspect Summary card (mirrors the drawer's activity line). */
function inspectActivityLine(childTaskCount: number, fileCount: number): string {
  const parts: string[] = [];
  if (childTaskCount > 0) parts.push(`${childTaskCount} ${childTaskCount === 1 ? "task" : "tasks"} under it`);
  if (fileCount > 0) parts.push(`${fileCount} linked ${fileCount === 1 ? "file" : "files"}`);
  if (parts.length === 0) return "Not yet in your org.";
  return `${parts.join(" · ")}. Not yet in your org.`;
}

/**
 * Read-only inspect sheet for a birth row, styled to match {@link EntityDrawer}
 * so a proposed entity reads like a real one: accent top-stripe header, avatar,
 * serif name, and `font-mono` section labels in accent-tinted cards. Shows
 * where the proposal came from + the tasks/files behind it, plus the same
 * Confirm / Merge / Dismiss actions. One column — a birth has no candidate to
 * compare against, so the reconcile layout doesn't apply.
 */
export function BirthInspectSheet({
  reviewId,
  onResolved,
  onClose,
}: {
  reviewId: string | null;
  onResolved: () => void;
  onClose: () => void;
}) {
  const { data: detail, isLoading } = useQuery({
    queryKey: reviewId ? detailKey(reviewId) : ["entity-review", "detail", "none"],
    queryFn: () => api.entityReview.get(reviewId as string),
    enabled: !!reviewId,
  });
  const row = detail?.row;
  const evidence: EntityReviewEvidenceRow[] = detail?.evidence ?? [];
  const childTasks: ChildTask[] = detail?.childTasks ?? [];
  const childTaskCount = detail?.childTaskCount ?? 0;

  return (
    <Sheet open={!!reviewId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[720px]">
        <SheetTitle className="sr-only">{row ? `Review: ${row.proposed_name}` : "Review"}</SheetTitle>
        <SheetDescription className="sr-only">
          Inspect where this proposed entity came from and which tasks and files are linked to it.
        </SheetDescription>
        {isLoading ? (
          <div className="space-y-4 p-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !row ? (
          <div className="p-6 text-sm text-muted-foreground">Review row not found.</div>
        ) : (
          <BirthInspectBody
            key={row.id}
            row={row}
            evidence={evidence}
            childTasks={childTasks}
            childTaskCount={childTaskCount}
            onClose={onClose}
            onResolved={() => {
              onResolved();
              onClose();
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function BirthInspectBody({
  row,
  evidence,
  childTasks,
  childTaskCount,
  onClose,
  onResolved,
}: {
  row: EntityReviewQueueRow;
  evidence: EntityReviewEvidenceRow[];
  childTasks: ChildTask[];
  childTaskCount: number;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [mergeOpen, setMergeOpen] = useState(false);
  const [name, setName] = useState(row.proposed_name);
  const mutations = useReviewMutations(row, onResolved);
  const dismissClosesOnly = row.entity_type === "person";
  const origin = birthOrigin(row);
  const trimmedName = name.trim();
  const nameOverride = trimmedName && trimmedName !== row.proposed_name ? trimmedName : undefined;
  const identity = { id: row.id, name: row.proposed_name, sourceType: row.entity_type };
  const accent = entityAccent(identity);

  return (
    <>
      <div
        className="sticky top-0 z-10 border-b bg-background px-6 pb-4 pt-5"
        style={{ borderTopColor: accent, borderTopWidth: 3 }}
      >
        <div className="flex items-start gap-3">
          <EntityAvatar entity={identity} size="lg" />
          <div className="min-w-0 flex-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={mutations.isPending}
              aria-label="Name"
              placeholder="Name"
              className="w-full rounded-sm bg-transparent font-serif text-[20px] leading-tight outline-none placeholder:text-muted-foreground/40 focus:bg-muted/40"
              data-testid="birth-name-input"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                {humanSourceType(row.entity_type)}
              </Badge>
              <OriginChip row={row} />
              <Badge variant="secondary" className="text-[10px]">
                new
              </Badge>
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
        <SectionCard accent={accent} label="Summary">
          <div className="space-y-1 text-sm leading-snug">
            <p>
              New {humanSourceType(row.entity_type).toLowerCase()}
              {origin ? ` from ${origin.label}` : ""}.
            </p>
            <p className="text-muted-foreground">{inspectActivityLine(childTaskCount, evidence.length)}</p>
          </div>
        </SectionCard>

        {childTaskCount > 0 ? (
          <div className="flex flex-col">
            <SectionLabel className="mb-1.5 font-medium">Tasks under this ({childTaskCount})</SectionLabel>
            <EntryList>
              {childTasks.map((t) => (
                <li key={t.indexedFileId}>
                  <div className="flex w-full items-center gap-2 px-3 py-2">
                    <SourceTag>{t.source}</SourceTag>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</span>
                    {t.providerUrl ? (
                      <a
                        href={t.providerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <ArrowSquareOutIcon size={12} />
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
              {childTaskCount > childTasks.length ? (
                <li className="px-3 py-2 text-[10px] text-muted-foreground">
                  + {childTaskCount - childTasks.length} more
                </li>
              ) : null}
            </EntryList>
          </div>
        ) : null}

        {evidence.length > 0 || childTaskCount === 0 ? (
          <div className="flex flex-col">
            <SectionLabel className="mb-1.5 font-medium">Linked files ({evidence.length})</SectionLabel>
            {evidence.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {origin?.kind === "tracker"
                  ? "Pulled from the connector's structure — no document evidence."
                  : "No linked files."}
              </p>
            ) : (
              <EntryList>
                {evidence.map((e) => (
                  <li key={e.id}>
                    <div className="flex w-full flex-col gap-1 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <SourceTag>{e.source}</SourceTag>
                          <span className="truncate text-sm font-medium">{e.file.name}</span>
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
                        <p className="line-clamp-2 text-[11px] text-muted-foreground">{e.file.sourcePath}</p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </EntryList>
            )}
          </div>
        ) : null}

        {mutations.errorCopy ? <p className="text-xs text-destructive">{mutations.errorCopy.message}</p> : null}
      </div>

      <div className="flex items-center gap-2 border-t bg-background px-6 py-3">
        {isWeeklyPassProjectRow(row) ? (
          <span className="text-[11px] text-muted-foreground">
            Projects are only created by the weekly mint pass — merge, dismiss, or leave it pooling.
          </span>
        ) : (
          <Button
            size="sm"
            onClick={() => mutations.confirm({ nameOverride })}
            disabled={mutations.isPending || trimmedName.length === 0}
            className="h-7 gap-1 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700"
            data-testid="birth-inspect-confirm"
          >
            <CheckIcon size={12} weight="bold" />
            Confirm new
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMergeOpen(true)}
          disabled={mutations.isPending}
          className="h-7 gap-1 text-[11px]"
          data-testid="birth-inspect-merge"
        >
          <ArrowsLeftRightIcon size={12} />
          Merge
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => (dismissClosesOnly ? onClose() : mutations.dismiss())}
          disabled={mutations.isPending}
          className="ml-auto h-7 gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          data-testid="birth-inspect-dismiss"
        >
          <XIcon size={12} />
          Dismiss
        </Button>
      </div>

      <MergePickerDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        row={row}
        onPick={(entityId) => {
          setMergeOpen(false);
          mutations.mergeInto(entityId);
        }}
      />
    </>
  );
}

/**
 * Search-only picker for the birth-row "Merge" escape hatch. Wraps the shared
 * {@link EntityPicker} scoped to the row's type. Deliberately NOT the full
 * reconcile sheet — a birth merge only needs a target, no evidence compare.
 */
function MergePickerDialog({
  open,
  onOpenChange,
  row,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: EntityReviewQueueRow;
  onPick: (entityId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Merge "{row.proposed_name}" into…</DialogTitle>
          <DialogDescription>
            Pick an existing {humanSourceType(row.entity_type).toLowerCase()} this is a duplicate of. No new entity is
            created.
          </DialogDescription>
        </DialogHeader>
        <EntityPicker entityType={row.entity_type} onPick={onPick} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Ghost" row representing a pending entity_review_queue row. Subtle styling
 * (amber tint + Under-review label). Click opens the reconcile drawer.
 */
export function GhostReviewRow({ row, onSelect }: { row: EntityReviewQueueRow; onSelect: (id: string) => void }) {
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
              {hasReviewCandidate(row) ? (
                <> · suggests {reviewCandidateNames(row).join(", ")}</>
              ) : (
                <> · no suggested match</>
              )}
            </p>
          </div>
        </div>

        <div className="flex w-32 items-center justify-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {humanSourceType(row.entity_type)}
          </Badge>
        </div>

        <span className="w-16 text-center font-mono text-xs text-muted-foreground">
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

export function ReviewDetailSheet({ reviewId, onClose }: { reviewId: string | null; onClose: () => void }) {
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
          <SheetDescription className="sr-only">
            Compare the proposed entity against suggested existing matches, then confirm or reject the reconciliation.
          </SheetDescription>
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
    queryClient.invalidateQueries({ queryKey: ["entity-review"] });
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
          suggestedCandidates={row.candidates ?? []}
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
  suggestedCandidates,
  isPending,
  errorMessage,
  canBackToCandidate,
  onBack,
  onPick,
  onCreateNew,
}: {
  row: EntityReviewQueueRow;
  suggestedCandidates: Array<{ id: string; name: string; email: string | null }>;
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
        {suggestedCandidates.length > 0 ? (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Possible matches</p>
            <div className="mt-2 space-y-1.5">
              {suggestedCandidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => onPick(candidate.id)}
                  className="flex w-full items-center justify-between rounded-md border border-border px-2.5 py-2 text-left hover:bg-muted"
                  data-testid={`suggested-candidate-${candidate.id}`}
                >
                  <span className="truncate text-sm font-medium">{candidate.name}</span>
                  {candidate.email ? (
                    <span className="ml-2 truncate text-[11px] text-muted-foreground">{candidate.email}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
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
        {isWeeklyPassProjectRow(row) ? (
          <p className="text-[11px] text-muted-foreground">
            Projects are only created by the weekly mint pass — link or merge into an existing one, or leave it pooling.
          </p>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
