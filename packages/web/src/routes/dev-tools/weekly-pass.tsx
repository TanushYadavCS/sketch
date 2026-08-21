/**
 * The weekly pass control room. One trigger — the same POST /runs latch the
 * org review band uses — plus a run history with live counters, a per-company
 * event feed, and a drill-down into the exact prompt, raw response and final
 * dispositions of each judgment. The read endpoints are dev-tools-gated on the
 * server; this panel is their only consumer.
 */
import { type WeeklyMintRun, type WeeklyMintRunEvent, api } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const LIVE_STATUSES = new Set(["running", "queued"]);

export function WeeklyPass() {
  const queryClient = useQueryClient();
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ["project-minting", "runs"],
    queryFn: () => api.projectMinting.listRuns(),
    retry: false,
    refetchInterval: (query) => (query.state.data?.runs.some((run) => LIVE_STATUSES.has(run.status)) ? 3000 : false),
  });

  const start = useMutation({
    mutationFn: () => api.projectMinting.runNow(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-minting", "runs"] });
    },
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
        Could not load weekly runs: {String(runsQuery.error)}
      </p>
    );
  }

  const runs = runsQuery.data?.runs ?? [];
  const live = runs.some((run) => LIVE_STATUSES.has(run.status));

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Weekly pass · {runs.length} run{runs.length === 1 ? "" : "s"}
        </h2>
        <Button
          size="sm"
          variant="outline"
          className="text-xs"
          disabled={start.isPending || live}
          onClick={() => start.mutate()}
          data-testid="weekly-pass-run"
        >
          Run pass
        </Button>
      </div>
      <p className="mb-2 text-[12px] text-muted-foreground">
        Judges every pooled container with a model call — minutes, company by company. Expand a run for its decision
        feed; judged companies open into the full prompt and response.
      </p>

      {start.error ? <p className="mb-2 text-[12px] text-destructive">{String(start.error)}</p> : null}

      {runs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-6 text-center">
          <p className="text-[13px] text-muted-foreground">No runs yet — this week's first pass starts on Run pass.</p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              expanded={expandedRunId === run.id}
              onToggle={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RunRow({ run, expanded, onToggle }: { run: WeeklyMintRun; expanded: boolean; onToggle: () => void }) {
  const summary = [
    `${run.verdictsStored} verdict${run.verdictsStored === 1 ? "" : "s"}`,
    `${run.candidatesGrouped} candidates`,
    run.agedOut > 0 ? `${run.agedOut} aged out` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        data-testid="weekly-run-row"
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/40"
      >
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{expanded ? "▾" : "▸"}</span>
        <span className="shrink-0 text-[13px] font-medium text-foreground">{run.runKey}</span>
        <span
          className={`shrink-0 font-mono text-[10px] uppercase ${
            run.status === "failed" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {run.status}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{summary}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{run.eventCount} events</span>
      </button>
      {run.error ? <p className="px-3 pb-2 text-[12px] text-destructive">{run.error}</p> : null}
      {expanded ? <RunEvents runId={run.id} live={LIVE_STATUSES.has(run.status)} /> : null}
    </div>
  );
}

type ContainerFeed = {
  containerKey: string;
  companyName: string;
  kinds: string[];
  events: WeeklyMintRunEvent[];
};

function groupByContainer(events: WeeklyMintRunEvent[]): ContainerFeed[] {
  const byContainer = new Map<string, ContainerFeed>();
  for (const event of events) {
    const feed = byContainer.get(event.containerKey) ?? {
      containerKey: event.containerKey,
      companyName: event.companyName,
      kinds: [],
      events: [],
    };
    feed.kinds.push(event.kind);
    feed.events.push(event);
    byContainer.set(event.containerKey, feed);
  }
  return [...byContainer.values()];
}

function RunEvents({ runId, live }: { runId: string; live: boolean }) {
  const [traceFeed, setTraceFeed] = useState<{ containerKey: string; companyName: string } | null>(null);
  const eventsQuery = useQuery({
    queryKey: ["project-minting", "runs", runId, "events"],
    queryFn: () => api.projectMinting.listRunEvents(runId),
    retry: false,
    refetchInterval: live ? 3000 : false,
  });

  if (eventsQuery.isLoading) return <Skeleton className="mx-3 mb-2 h-8 rounded-md" />;
  if (eventsQuery.isError) {
    return <p className="px-3 pb-2 text-[12px] text-destructive">Could not load events: {String(eventsQuery.error)}</p>;
  }

  const feeds = groupByContainer(eventsQuery.data?.events ?? []);
  if (feeds.length === 0) {
    return <p className="px-3 pb-2 text-[12px] text-muted-foreground">No decisions recorded yet.</p>;
  }

  return (
    <div className="mx-3 mb-2 divide-y divide-border rounded-md border border-border bg-muted/20">
      {feeds.map((feed) => {
        const judged = feed.kinds.includes("judged") || feed.kinds.includes("model_error");
        return (
          <div key={feed.containerKey} data-testid="weekly-run-container">
            <div className="flex items-center gap-3 px-3 py-1.5">
              <span className="shrink-0 text-[12.5px] font-medium text-foreground">{feed.companyName}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
                {feed.kinds.join(" → ")}
              </span>
              {judged ? (
                <button
                  type="button"
                  onClick={() => setTraceFeed({ containerKey: feed.containerKey, companyName: feed.companyName })}
                  className="shrink-0 text-[11px] text-muted-foreground underline"
                >
                  view trace
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      <Sheet open={!!traceFeed} onOpenChange={(open) => !open && setTraceFeed(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-[800px]">
          <SheetTitle className="text-[14px]">{traceFeed?.companyName} · judge trace</SheetTitle>
          <SheetDescription className="sr-only">
            The exact prompt, tool calls, raw response and final dispositions of this judgment.
          </SheetDescription>
          {traceFeed ? <TraceView runId={runId} containerKey={traceFeed.containerKey} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function TraceView({ runId, containerKey }: { runId: string; containerKey: string }) {
  const traceQuery = useQuery({
    queryKey: ["project-minting", "runs", runId, "traces", containerKey],
    queryFn: () => api.projectMinting.getRunTrace(runId, containerKey),
    retry: false,
  });

  if (traceQuery.isLoading) return <Skeleton className="mt-3 h-8 rounded-md" />;
  if (traceQuery.isError) {
    return <p className="mt-3 text-[12px] text-destructive">Could not load trace: {String(traceQuery.error)}</p>;
  }

  const steps = traceQuery.data?.steps ?? [];
  return (
    <div className="mt-3 space-y-1.5" data-testid="weekly-trace">
      {steps.map((step) => (
        <details key={step.seq} className="rounded-md border border-border bg-background px-2.5 py-1.5">
          <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">
            {step.seq}. {step.kind}
          </summary>
          <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-foreground">
            {typeof step.payload.prompt === "string"
              ? step.payload.prompt
              : typeof step.payload.rawText === "string"
                ? step.payload.rawText
                : JSON.stringify(step.payload, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}
