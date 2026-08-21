/**
 * The graph-verdict approval surface. Agents propose curation actions through
 * the MCP tool; the rows land here for a human to approve, apply, and — if it
 * went wrong — undo. The decision sheet fetches a server dry run before Apply
 * is enabled, so the human always approves what the server says will happen,
 * never what the proposal claimed. The read/decide endpoints are
 * dev-tools-gated on the server; this panel is their only consumer.
 */
import { ApiRequestError, type GraphVerdict, type GraphVerdictRun, type GraphVerdictStatus, api } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const ACTION_LABELS: Record<string, string> = {
  keep: "keep",
  merge_into: "merge into",
  nest_under: "nest under",
  archive: "archive",
};

const STATUS_TONES: Record<GraphVerdictStatus, string> = {
  awaiting_human: "text-amber-600 dark:text-amber-500",
  approved: "text-foreground",
  applied: "text-emerald-600 dark:text-emerald-500",
  bounced: "text-muted-foreground",
  rejected: "text-muted-foreground",
  reverted: "text-muted-foreground",
};

export function GraphVerdicts() {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [openVerdict, setOpenVerdict] = useState<GraphVerdict | null>(null);

  const runsQuery = useQuery({
    queryKey: ["graph-verdicts", "runs"],
    queryFn: () => api.graphVerdicts.listRuns(),
    retry: false,
  });

  if (runsQuery.isLoading) {
    return (
      <div className="mt-4 space-y-2">
        {[1, 2].map((k) => (
          <Skeleton key={k} className="h-11 rounded-md" />
        ))}
      </div>
    );
  }
  if (runsQuery.isError) {
    return (
      <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
        Could not load verdict runs: {String(runsQuery.error)}
      </p>
    );
  }

  const runs = runsQuery.data?.runs ?? [];

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Graph verdict runs · {runs.length}
      </h2>
      <p className="mb-2 text-[12px] text-muted-foreground">
        Curation actions proposed by agents. Expand a run, open a verdict to see its evidence and a live dry run of what
        applying will do, then approve, apply, or undo.
      </p>

      {runs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-6 text-center">
          <p className="text-[13px] text-muted-foreground">
            No proposals yet — runs appear when an agent calls propose_graph_verdicts.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              expanded={expandedRunId === run.id}
              onToggle={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
              onOpenVerdict={setOpenVerdict}
            />
          ))}
        </div>
      )}

      <VerdictSheet verdict={openVerdict} onClose={() => setOpenVerdict(null)} />
    </section>
  );
}

function rollupSummary(run: GraphVerdictRun): string {
  const parts: string[] = [];
  for (const status of ["awaiting_human", "approved", "applied", "reverted", "rejected", "bounced"] as const) {
    const count = run.rollups?.[status] ?? 0;
    if (count > 0) parts.push(`${count} ${status === "awaiting_human" ? "awaiting" : status}`);
  }
  return parts.length > 0 ? parts.join(" · ") : `${run.verdictsProposed} proposed`;
}

function RunRow({
  run,
  expanded,
  onToggle,
  onOpenVerdict,
}: {
  run: GraphVerdictRun;
  expanded: boolean;
  onToggle: () => void;
  onOpenVerdict: (verdict: GraphVerdict) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        data-testid="graph-verdict-run-row"
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/40"
      >
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{expanded ? "▾" : "▸"}</span>
        <span className="shrink-0 font-mono text-[11px] text-foreground">{run.id.slice(0, 8)}</span>
        <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{run.source}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
          {run.note ? `${run.note} · ` : ""}
          {rollupSummary(run)}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{run.createdAt.slice(0, 10)}</span>
      </button>
      {expanded ? <RunVerdicts runId={run.id} onOpenVerdict={onOpenVerdict} /> : null}
    </div>
  );
}

function RunVerdicts({ runId, onOpenVerdict }: { runId: string; onOpenVerdict: (verdict: GraphVerdict) => void }) {
  const verdictsQuery = useQuery({
    queryKey: ["graph-verdicts", "runs", runId, "verdicts"],
    queryFn: () => api.graphVerdicts.listRunVerdicts(runId),
    retry: false,
  });

  if (verdictsQuery.isLoading) return <Skeleton className="mx-3 mb-2 h-8 rounded-md" />;
  if (verdictsQuery.isError) {
    return (
      <p className="px-3 pb-2 text-[12px] text-destructive">Could not load verdicts: {String(verdictsQuery.error)}</p>
    );
  }

  const verdicts = verdictsQuery.data?.verdicts ?? [];
  if (verdicts.length === 0) {
    return <p className="px-3 pb-2 text-[12px] text-muted-foreground">No verdicts stored for this run.</p>;
  }

  return (
    <div className="mx-3 mb-2 divide-y divide-border rounded-md border border-border bg-muted/20">
      {verdicts.map((verdict) => (
        <button
          key={verdict.id}
          type="button"
          data-testid="graph-verdict-row"
          onClick={() => onOpenVerdict(verdict)}
          className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-muted/40"
        >
          <span className="shrink-0 font-mono text-[10.5px] uppercase text-muted-foreground">
            {ACTION_LABELS[verdict.action] ?? verdict.action}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
            {verdict.subjectName ?? verdict.subjectEntityId}
            {verdict.targetEntityId ? ` → ${verdict.targetName ?? verdict.targetEntityId}` : ""}
          </span>
          <span className={`shrink-0 font-mono text-[10px] uppercase ${STATUS_TONES[verdict.status]}`}>
            {verdict.status === "awaiting_human" ? "awaiting" : verdict.status}
          </span>
        </button>
      ))}
    </div>
  );
}

function isStaleError(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.code === "STALE_VERDICT" || err.code === "PLAN_DRIFT");
}

/**
 * The server allows a dry run for awaiting and approved rows only; anything
 * later already happened, so the sheet shows the recorded ledger ref instead.
 */
function canPreview(status: GraphVerdictStatus): boolean {
  return status === "awaiting_human" || status === "approved";
}

function VerdictSheet({ verdict, onClose }: { verdict: GraphVerdict | null; onClose: () => void }) {
  return (
    <Sheet open={!!verdict} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-[560px]">
        <SheetTitle className="text-[14px]">
          {verdict ? `${ACTION_LABELS[verdict.action] ?? verdict.action} · ${verdict.subjectName ?? "verdict"}` : ""}
        </SheetTitle>
        <SheetDescription className="sr-only">
          The proposal's reason and evidence, a server dry run of applying it, and the decision buttons.
        </SheetDescription>
        {verdict ? <VerdictDetail key={verdict.id} verdict={verdict} onDone={onClose} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function VerdictDetail({ verdict, onDone }: { verdict: GraphVerdict; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<unknown>(null);

  function settle() {
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: ["graph-verdicts"] });
    onDone();
  }

  const previewQuery = useQuery({
    queryKey: ["graph-verdicts", "preview", verdict.id],
    queryFn: () => api.graphVerdicts.apply(verdict.id, { dryRun: true }),
    enabled: canPreview(verdict.status),
    retry: false,
  });

  const approve = useMutation({
    mutationFn: () => api.graphVerdicts.approve(verdict.id),
    onSuccess: settle,
    onError: setActionError,
  });
  const reject = useMutation({
    mutationFn: () => api.graphVerdicts.reject(verdict.id),
    onSuccess: settle,
    onError: setActionError,
  });
  const apply = useMutation({
    mutationFn: () => api.graphVerdicts.apply(verdict.id),
    onSuccess: settle,
    onError: setActionError,
  });
  const revert = useMutation({
    mutationFn: () => api.graphVerdicts.revert(verdict.id),
    onSuccess: settle,
    onError: setActionError,
  });

  const busy = approve.isPending || reject.isPending || apply.isPending || revert.isPending;
  const previewStale = previewQuery.isError && isStaleError(previewQuery.error);
  const actionStale = isStaleError(actionError);
  const evidence = parseEvidence(verdict.evidence);
  const wouldChange = previewQuery.data?.application.wouldChange ?? asCounts(verdict.wouldChange);

  return (
    <div className="mt-3 flex flex-1 flex-col gap-4 text-[13px]">
      <dl className="space-y-1.5">
        <DetailRow
          label="Subject"
          value={`${verdict.subjectName ?? verdict.subjectEntityId}`}
          mono={!verdict.subjectName}
        />
        {verdict.targetEntityId ? (
          <DetailRow
            label="Target"
            value={`${verdict.targetName ?? verdict.targetEntityId}`}
            mono={!verdict.targetName}
          />
        ) : null}
        <DetailRow label="Status" value={verdict.status} mono />
        <DetailRow label="Reason" value={verdict.reason} />
        {verdict.validationReason ? <DetailRow label="Validation" value={verdict.validationReason} mono /> : null}
        {verdict.appliedLedgerRef ? <DetailRow label="Ledger" value={verdict.appliedLedgerRef} mono /> : null}
      </dl>

      {evidence ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evidence</h3>
          <p className="font-mono text-[11px] text-muted-foreground">
            {evidence.fileIds.length} file{evidence.fileIds.length === 1 ? "" : "s"} · {evidence.reviewIds.length}{" "}
            review
            {evidence.reviewIds.length === 1 ? "" : "s"}
          </p>
          {evidence.notes.map((note) => (
            <p key={note} className="mt-1 text-[12px] text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      ) : null}

      {canPreview(verdict.status) ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What applying will do
          </h3>
          {previewQuery.isLoading ? (
            <Skeleton className="h-8 rounded-md" />
          ) : previewStale ? (
            <StaleBanner />
          ) : previewQuery.isError ? (
            <p className="text-[12px] text-destructive">Dry run failed: {String(previewQuery.error)}</p>
          ) : (
            <WouldChangeTable counts={wouldChange} />
          )}
        </div>
      ) : null}

      {actionStale ? <StaleBanner /> : null}
      {actionError && !actionStale ? <p className="text-[12px] text-destructive">{String(actionError)}</p> : null}

      <div className="mt-auto flex justify-end gap-2 border-t border-border pt-3">
        {verdict.status === "awaiting_human" ? (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate()}>
              Reject
            </Button>
            <Button size="sm" disabled={busy} onClick={() => approve.mutate()} data-testid="graph-verdict-approve">
              Approve
            </Button>
          </>
        ) : null}
        {verdict.status === "approved" ? (
          <Button
            size="sm"
            disabled={busy || !previewQuery.isSuccess}
            onClick={() => apply.mutate()}
            data-testid="graph-verdict-apply"
            title={previewQuery.isSuccess ? undefined : "Apply unlocks once the dry run succeeds"}
          >
            Apply
          </Button>
        ) : null}
        {verdict.status === "applied" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => revert.mutate()}>
            Undo
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono text-[11.5px]" : "text-[12.5px]"}`}>{value}</dd>
    </div>
  );
}

function StaleBanner() {
  return (
    <p
      className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px]"
      data-testid="graph-verdict-stale"
    >
      Evidence changed since this was proposed — the graph moved underneath it. Ask the agent to re-propose.
    </p>
  );
}

function WouldChangeTable({ counts }: { counts: Record<string, number> | null }) {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) {
    return <p className="text-[12px] text-muted-foreground">No rows change — this action is a no-op.</p>;
  }
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {entries.map(([table, count]) => (
        <div key={table} className="flex items-center justify-between px-3 py-1.5">
          <span className="font-mono text-[11.5px]">{table}</span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{count}</span>
        </div>
      ))}
    </div>
  );
}

function parseEvidence(raw: unknown): { fileIds: string[]; reviewIds: string[]; notes: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { fileIds?: unknown; reviewIds?: unknown; notes?: unknown };
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  return { fileIds: strings(value.fileIds), reviewIds: strings(value.reviewIds), notes: strings(value.notes) };
}

function asCounts(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, number>;
}
