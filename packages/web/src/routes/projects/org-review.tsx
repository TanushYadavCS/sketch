/**
 * The review surface for Your Org: each type tab's band, expanding in place
 * to the full type-scoped list (the standalone Review tab is gone — triage
 * keeps its type context). Rows render as {@link ReviewRowCompact} — a single
 * line with quiet text actions, because the band sits above a directory and
 * must not read as a second queue.
 *
 * Row-body clicks open the existing reconcile sheet
 * ({@link ReviewDetailSheet}) for rows with a suggested match or the birth
 * inspect sheet ({@link BirthInspectSheet}) for rows without one — evidence,
 * match reason, and pick-a-different-existing all live there.
 */
import { isWeeklyPassProjectRow } from "@/components/entity-review/entity-format";
import { BirthInspectSheet, ReviewDetailSheet } from "@/components/entity-review/review-band";
import {
  WhatsAppIdentityDrawer,
  WhatsAppIdentityRow,
  useWhatsAppIdentityReview,
} from "@/components/entity-review/whatsapp-identity-review";
import { ProjectSuggestionsSection } from "@/components/project-suggestions";
import { useReviewMutations } from "@/components/review-actions";
import type { EntityReviewQueueRow } from "@/lib/api";
import { api } from "@/lib/api";
import { EntityAvatar } from "@/lib/entity-ui";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";

/** Shared 300ms debounce for the org search inputs (band + tab lists). */
export function useDebouncedSearch(delay = 300) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const ref = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(() => setDebounced(search.trim()), delay);
    return () => {
      if (ref.current) clearTimeout(ref.current);
    };
  }, [search, delay]);
  return { search, setSearch, debounced };
}

/**
 * Manages the two review sheets (reconcile vs birth inspect) for a list of
 * rows and exposes an `openRow` that routes each row to the right one. Also
 * hands back a `refresh` that clears the whole `entity-review` query prefix
 * (bands + tabs live outside `LIST_KEY`, so the mutation hook's own
 * invalidation would miss them).
 */
export function useReviewRowSheets() {
  const queryClient = useQueryClient();
  const [reconcileId, setReconcileId] = useState<string | null>(null);
  const [birthId, setBirthId] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["entity-review"] });
    queryClient.invalidateQueries({ queryKey: ["entities"] });
  };

  const openRow = (row: EntityReviewQueueRow) => {
    if (row.candidate || (row.candidates?.length ?? 0) > 0) setReconcileId(row.id);
    else setBirthId(row.id);
  };

  const sheets = (
    <>
      <ReviewDetailSheet reviewId={reconcileId} onClose={() => setReconcileId(null)} />
      <BirthInspectSheet reviewId={birthId} onResolved={refresh} onClose={() => setBirthId(null)} />
    </>
  );

  return { openRow, sheets, refresh };
}

function CompactAction({
  label,
  emphasis,
  disabled,
  onClick,
}: {
  label: string;
  emphasis?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "px-1.5 py-0.5 text-[11px] disabled:opacity-40",
        emphasis ? "font-medium text-foreground hover:underline" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * One-line review row: name, muted suggested-match, quiet Confirm/Dismiss
 * text actions. Everything else (evidence detail, match reason, pick
 * existing) is one click away in the sheet. `detail` adds the candidate email
 * and a per-source evidence summary — the Review tab turns it on; the capped
 * bands stay tightest.
 */
export function ReviewRowCompact({
  row,
  onOpen,
  onResolved,
  detail,
}: {
  row: EntityReviewQueueRow;
  onOpen: (row: EntityReviewQueueRow) => void;
  onResolved: () => void;
  detail?: boolean;
}) {
  const mutations = useReviewMutations(row, onResolved);
  const candidates = row.candidates ?? (row.candidate ? [row.candidate] : []);
  const hasCandidate = row.candidate_entity_id !== null || candidates.length > 0;
  const suggestion = hasCandidate
    ? `→ ${candidates.map((candidate) => `${candidate.name}${detail && candidate.email ? ` · ${candidate.email}` : ""}`).join(", ")}`
    : "new — no suggested match";
  const evidence =
    detail && row.sourceBreakdown.length > 0
      ? row.sourceBreakdown.map((b) => `${b.count}× ${b.source}`).join(", ")
      : null;
  /**
   * Project rows born from file evidence never get inline confirm/dismiss:
   * a one-click confirm would birth a bare section-less entity (the server
   * refuses it too), and dismiss is terminal — it silently starves future
   * sub-project minting. The only safe one-click action is linking to the
   * single suggested entity; everything else lives in the sheet. Structural
   * connector rows keep the standard actions.
   */
  const guardedProject = isWeeklyPassProjectRow(row);
  const linkOnly = guardedProject && row.candidate_entity_id !== null;
  const sheetOnly = guardedProject && row.candidate_entity_id === null;
  return (
    <div className="border-b border-border/60 last:border-b-0" data-testid={`org-review-row-${row.id}`}>
      <div className="flex w-full items-center transition-colors hover:bg-foreground/10">
        <button
          type="button"
          onClick={() => onOpen(row)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
        >
          <EntityAvatar entity={{ id: row.id, name: row.proposed_name, sourceType: row.entity_type }} size="sm" />
          <span className="shrink-0 truncate text-[12.5px] font-medium">{row.proposed_name}</span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{suggestion}</span>
          {evidence ? (
            <span className="hidden shrink-0 text-[10.5px] text-muted-foreground/70 sm:inline">{evidence}</span>
          ) : null}
        </button>
        {sheetOnly ? null : (
          <span className="flex shrink-0 items-center gap-0.5 pr-3">
            <CompactAction
              label={linkOnly ? "Link" : hasCandidate ? "Confirm" : "Add"}
              emphasis
              disabled={mutations.isPending}
              onClick={() => mutations.confirm()}
            />
            {linkOnly ? null : (
              <>
                <span className="text-muted-foreground/40">·</span>
                <CompactAction label="Dismiss" disabled={mutations.isPending} onClick={() => mutations.dismiss()} />
              </>
            )}
          </span>
        )}
      </div>
      {mutations.errorCopy ? (
        <p className="px-3 pb-1.5 text-[11px] text-destructive">{mutations.errorCopy.message}</p>
      ) : null}
    </div>
  );
}

/** Label for the next natural weekly pass — the Monday after today. */
function nextPassLabel(): string {
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  return next.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Candidate-less, seed-less project rows are not individually actionable —
 * they pool for the weekly mint pass. Collapsed they are one summary line;
 * expanded they list read-only for transparency. "Run now" (admin) forces
 * this week's pass early, behind a warning: re-judging previously skipped
 * groups is where measured LLM variance re-mints junk.
 */
function PoolingSummary({
  rows,
  expanded,
  isAdmin,
  onRunStarted,
}: {
  rows: EntityReviewQueueRow[];
  expanded: boolean;
  isAdmin: boolean;
  onRunStarted: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const run = useMutation({
    mutationFn: () => api.projectMinting.runNow(),
    onSuccess: () => {
      setConfirmOpen(false);
      setStarted(true);
      onRunStarted();
    },
  });

  if (rows.length === 0) return null;

  return (
    <div className="border-t border-amber-300/40 dark:border-amber-700/30" data-testid="review-band-pooling">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
          {rows.length} new {rows.length === 1 ? "name" : "names"} pooling for the weekly pass · next pass{" "}
          {nextPassLabel()}
        </span>
        {isAdmin ? (
          started ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">pass running — check back shortly</span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="shrink-0 px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:underline"
              data-testid="review-band-run-now"
            >
              Run now
            </button>
          )
        ) : null}
      </div>
      {run.isError ? (
        <p className="px-3 pb-1.5 text-[11px] text-destructive">
          {run.error instanceof Error && run.error.message.includes("already")
            ? "A pass is already running."
            : "Could not start the pass. Try again shortly."}
        </p>
      ) : null}
      {expanded ? (
        <div className="border-t border-amber-300/30 dark:border-amber-700/20">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 last:border-b-0"
              data-testid={`review-band-pooling-row-${row.id}`}
            >
              <EntityAvatar entity={{ id: row.id, name: row.proposed_name, sourceType: row.entity_type }} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[12px]">{row.proposed_name}</span>
              <span className="shrink-0 text-[10.5px] text-muted-foreground/70">seen {row.occurrence_count}×</span>
            </div>
          ))}
        </div>
      ) : null}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Run the mint pass now?</DialogTitle>
            <DialogDescription>
              This re-judges groups the last pass skipped — occasional model variance can re-mint junk, which lands in
              the dossier for you to strike. Companies with a dossier already awaiting review are left untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={run.isPending}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending} data-testid="run-now-confirm">
              {run.isPending ? "Starting…" : "Run now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Type-scoped review band — the only review surface now that the Review tab
 * is gone. Collapsed: header count + first 3 rows. Expanded (in place):
 * search + the full type-scoped list in a capped scroll region, so the
 * directory below stays reachable. Projects additionally get the pending
 * mint dossiers first (admin) and the pooling summary last. `null` when
 * there is nothing to review keeps the entity list flush to the top.
 */
export function ReviewBandCapped({
  types,
  isAdmin = false,
  expanded,
  onExpandedChange,
}: {
  types: string[];
  isAdmin?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isExpanded = expanded ?? internalExpanded;
  const setExpanded = onExpandedChange ?? setInternalExpanded;
  const { search, setSearch, debounced } = useDebouncedSearch();
  const activeSearch = isExpanded ? debounced : "";

  const { data } = useQuery({
    queryKey: ["entity-review", "band-capped", types.join(","), activeSearch],
    queryFn: () => api.entityReview.list({ limit: 200, types, search: activeSearch || undefined }),
    refetchInterval: 30000,
  });
  const queryClient = useQueryClient();
  const rows = data?.rows ?? [];
  const realTotal = data?.total ?? rows.length;
  const { openRow, sheets, refresh } = useReviewRowSheets();

  const isProjectBand = types.includes("project");
  const verdictsQuery = useQuery({
    queryKey: ["project-minting", "verdicts"],
    queryFn: () => api.projectMinting.listVerdicts(),
    enabled: isAdmin && isProjectBand,
    retry: false,
    refetchInterval: 30000,
  });
  const verdicts = isAdmin && isProjectBand ? (verdictsQuery.data?.verdicts ?? []) : [];

  const poolingRows = isProjectBand
    ? rows.filter(
        (row) => isWeeklyPassProjectRow(row) && row.candidate_entity_id === null && (row.candidates?.length ?? 0) === 0,
      )
    : [];
  const poolingIds = new Set(poolingRows.map((row) => row.id));
  const actionableRows = rows.filter((row) => !poolingIds.has(row.id));

  const wa = useWhatsAppIdentityReview(types);
  const [waSelected, setWaSelected] = useState<string | null>(null);

  if (rows.length === 0 && wa.items.length === 0 && verdicts.length === 0 && !activeSearch) return null;

  const visibleRows = isExpanded ? actionableRows : actionableRows.slice(0, 3);
  const hiddenCount = actionableRows.length - visibleRows.length;
  const headerCount = realTotal + wa.items.length + verdicts.length;

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-amber-300/60 bg-amber-50/40 dark:border-amber-700/50 dark:bg-amber-950/20">
      <div className="flex items-baseline justify-between border-b border-amber-300/50 px-3 py-2 dark:border-amber-700/40">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
          Needs your review · {headerCount}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(!isExpanded)}
          className="font-mono text-[10px] uppercase tracking-[0.08em] text-amber-700/80 hover:text-amber-800 dark:text-amber-400/80 dark:hover:text-amber-300"
          data-testid="review-band-toggle"
        >
          {isExpanded ? "Collapse ▴" : "Show all ▾"}
        </button>
      </div>
      {verdicts.length > 0 ? <ProjectSuggestionsSection verdicts={verdicts} /> : null}
      {isExpanded ? (
        <div className="relative border-b border-amber-300/40 px-3 py-2 dark:border-amber-700/30">
          <MagnifyingGlassIcon size={14} className="absolute left-5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            placeholder="Search pending reviews…"
            className="h-8 pl-8 text-[12.5px]"
            data-testid="review-band-search"
          />
        </div>
      ) : null}
      <div className={cn(isExpanded && "max-h-[60vh] overflow-y-auto")}>
        {activeSearch && actionableRows.length === 0 ? (
          <p className="px-3 py-3 text-[11.5px] text-muted-foreground">No pending reviews match your search.</p>
        ) : null}
        {visibleRows.map((row) => (
          <ReviewRowCompact key={row.id} row={row} onOpen={openRow} onResolved={refresh} detail={isExpanded} />
        ))}
        {wa.items.map((item) => (
          <WhatsAppIdentityRow
            key={item.id}
            item={item}
            onOpen={() => setWaSelected(item.id)}
            onResolve={(message) => wa.resolve(item.id, message)}
          />
        ))}
        {isExpanded && realTotal > rows.length ? (
          <p className="border-t border-amber-300/40 px-3 py-2 text-[10.5px] text-muted-foreground dark:border-amber-700/30">
            Showing {rows.length} of {realTotal}. Search to narrow the rest.
          </p>
        ) : null}
      </div>
      <PoolingSummary
        rows={poolingRows}
        expanded={isExpanded}
        isAdmin={isAdmin}
        onRunStarted={() => {
          queryClient.invalidateQueries({ queryKey: ["project-minting"] });
          queryClient.invalidateQueries({ queryKey: ["entity-review"] });
        }}
      />
      {!isExpanded && hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-amber-300/40 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-amber-700/70 hover:text-amber-800 dark:border-amber-700/30 dark:text-amber-400/70"
        >
          {hiddenCount} more — show all ▾
        </button>
      ) : null}
      {sheets}
      <WhatsAppIdentityDrawer
        item={wa.items.find((item) => item.id === waSelected) ?? null}
        onClose={() => setWaSelected(null)}
        onResolve={wa.resolve}
      />
    </section>
  );
}

/** Shared empty/teach frame for a review surface. */
export function ReviewEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border py-10 text-center text-[12.5px] text-muted-foreground">
      {children}
    </p>
  );
}
