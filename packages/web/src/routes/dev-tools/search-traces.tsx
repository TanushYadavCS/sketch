/**
 * The Search tab: real `Search` calls Sketch made, captured as they happened.
 *
 * Nothing is started here. There is no Run button because there is no synthetic run — a
 * trace exists because an agent, an automation or an MCP client actually searched.
 */
import { type DevSearchStageKey, type DevSearchTraceHeader, type DevStageReport, api } from "@/lib/api";
import { CaretLeftIcon, MagnifyingGlassIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FinalOutput, Synthesis } from "./final-output";
import { RankingTable } from "./ranking-table";
import { SEARCH_STAGES } from "./stages";
import { VectorChunks } from "./vector-chunks";

export function SearchTraces() {
  const [openId, setOpenId] = useState<string | null>(null);
  const tracesQuery = useQuery({
    queryKey: ["dev-tools", "search-traces"],
    queryFn: () => api.dev.searchTraces(),
    refetchInterval: openId ? false : 4000,
  });

  if (openId) return <TraceDetail id={openId} onBack={() => setOpenId(null)} />;

  const traces = tracesQuery.data?.traces ?? [];

  return (
    <section className="mt-6">
      <p className="mb-3 text-[13px] text-muted-foreground">
        Every <code>Search</code> the agent, an automation or an MCP client ran while dev tools were enabled. The web
        search box is not covered — it calls the search layer directly and skips entity discovery entirely.
      </p>

      <RunSearch onRan={(id) => setOpenId(id)} />

      {tracesQuery.isLoading ? (
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <SpinnerGapIcon size={13} className="animate-spin" />
          Loading traces…
        </p>
      ) : traces.length === 0 ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
          No searches captured yet. Capture only covers searches made <em>while</em> dev tools were enabled — anything
          run before the flag was switched on was never recorded and cannot be recovered.
        </p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {traces.map((trace) => (
            <TraceRow key={trace.id} trace={trace} onOpen={() => setOpenId(trace.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Runs a search from here, through the same traced core the agent uses.
 *
 * Not a simulation — `Search` is a pure read, so this executes the real pipeline against
 * the real index and stores a real trace. It is tagged `dev_tools` so the feed can tell a
 * test run apart from live traffic, and it uses your own principals, so it answers "what
 * would I see" rather than what another user would.
 */
function RunSearch({ onRan }: { onRan: (traceId: string) => void }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [sortBy, setSortBy] = useState<"relevance" | "recency">("relevance");
  const queryClient = useQueryClient();

  const run = useMutation({
    mutationFn: () =>
      api.dev.runSearch({
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(kind ? { kind } : {}),
        sortBy,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["dev-tools", "search-traces"] });
      onRan(data.trace.id);
    },
  });

  const canRun = query.trim().length > 0 || kind !== "";

  return (
    <div className="mb-4 rounded-md border border-border p-3">
      <div className="flex flex-wrap gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canRun && !run.isPending) run.mutate();
          }}
          placeholder="Run a search, exactly as the agent would"
          className="min-w-[16rem] flex-1"
        />
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          className="rounded-md border border-border bg-background px-2 text-[13px]"
        >
          <option value="">Any kind</option>
          <option value="meeting">meeting</option>
          <option value="doc">doc</option>
          <option value="task">task</option>
          <option value="message">message</option>
        </select>
        <select
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as "relevance" | "recency")}
          className="rounded-md border border-border bg-background px-2 text-[13px]"
        >
          <option value="relevance">relevance</option>
          <option value="recency">recency</option>
        </select>
        <Button onClick={() => run.mutate()} disabled={!canRun || run.isPending} className="gap-1.5">
          {run.isPending ? <SpinnerGapIcon size={14} className="animate-spin" /> : <MagnifyingGlassIcon size={14} />}
          Run
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Runs the real pipeline against the real index and stores a trace. Search only reads, so nothing in the graph
        changes — but it does spend one embedding call.
      </p>
      {run.isError && <p className="mt-1.5 text-[12px] text-destructive">{String(run.error)}</p>}
    </div>
  );
}

function TraceRow({ trace, onOpen }: { trace: DevSearchTraceHeader; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-3 py-2 text-left">
      <StatusBadge status={trace.status} />
      <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
        {originLabel(trace.origin)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{trace.query || "(no query — filters only)"}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {trace.resultCount} results · {trace.durationMs}ms · {trace.startedAt.slice(11, 19)}
      </span>
    </button>
  );
}

function TraceDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const traceQuery = useQuery({
    queryKey: ["dev-tools", "search-trace", id],
    queryFn: () => api.dev.searchTrace(id),
  });
  const [selected, setSelected] = useState<DevSearchStageKey>(SEARCH_STAGES[0].stage as DevSearchStageKey);

  const trace = traceQuery.data?.trace;
  const reportByStage = new Map((trace?.stages ?? []).map((stage) => [stage.stage, stage]));
  const active = reportByStage.get(selected);
  const definition = SEARCH_STAGES.find((entry) => entry.stage === selected);

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
      >
        <CaretLeftIcon size={12} />
        All searches
      </button>

      {traceQuery.isLoading && <p className="text-[13px] text-muted-foreground">Loading…</p>}
      {traceQuery.isError && <p className="text-[13px] text-destructive">{String(traceQuery.error)}</p>}

      {trace && (
        <>
          <div className="mb-3 rounded-md border border-border px-3 py-2">
            <p className="text-[14px] font-medium">{trace.query || "(no query — filters only)"}</p>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {originLabel(trace.origin)} · {trace.userId ?? "no user"} ·{" "}
              {trace.conversationId ? `chat ${trace.conversationId}` : "no chat"} · {trace.resultCount} results ·{" "}
              {trace.durationMs}ms
            </p>
            {trace.error && <p className="mt-1 text-[12px] text-destructive">{trace.error}</p>}
            <pre className="mt-2 overflow-x-auto rounded border border-border bg-muted/30 px-2 py-1.5 font-mono text-[10px]">
              {JSON.stringify(trace.args, null, 2)}
            </pre>
          </div>

          <div className="flex min-h-[26rem] rounded-md border border-border">
            <nav className="w-56 shrink-0 overflow-y-auto border-r border-border bg-muted/20">
              {SEARCH_STAGES.map((entry, index) => {
                const report = reportByStage.get(entry.stage);
                const isActive = selected === entry.stage;
                return (
                  <button
                    key={entry.stage}
                    type="button"
                    onClick={() => setSelected(entry.stage as DevSearchStageKey)}
                    className={`flex w-full items-start gap-2.5 border-b border-border px-3 py-2 text-left ${
                      isActive ? "bg-background" : "hover:bg-background/60"
                    }`}
                  >
                    <StatusDot status={report?.status} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="font-mono text-[10px] text-muted-foreground">{index + 1}</span>
                        <span className={`truncate text-[13px] ${isActive ? "font-medium" : ""}`}>{entry.label}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {railLine(report)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              <h3 className="text-[15px] font-medium">{definition?.label}</h3>
              {active?.error && <p className="mt-1 text-[13px] text-destructive">{active.error}</p>}
              {!active && <p className="mt-2 text-[13px] text-muted-foreground">This stage did not report.</p>}

              {active?.summary && (
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
                  {Object.entries(active.summary).map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="text-muted-foreground">{humanize(key)}</dt>
                      <dd className="min-w-0 break-words font-mono">{formatSummaryValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {active?.outcomes && active.outcomes.length > 0 && (
                <div className="mt-4 overflow-hidden rounded-md border border-border">
                  {active.outcomes.map((outcome, index) => {
                    const removed = outcome.result === "dropped" || outcome.result === "suppressed";
                    return (
                      <div
                        key={`${outcome.subject}-${index}`}
                        className={`flex items-baseline gap-3 border-b border-border px-3 py-1.5 last:border-b-0 ${
                          removed ? "bg-destructive/5" : ""
                        }`}
                      >
                        <span
                          className={`min-w-0 flex-1 truncate text-[13px] ${
                            removed ? "text-muted-foreground line-through decoration-destructive/70" : ""
                          }`}
                        >
                          {outcome.subject}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{outcome.kind}</span>
                        <span className="shrink-0 text-right text-[11px] text-muted-foreground">{outcome.reason}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {active?.vectorChunks && (
                <div className="mt-4">
                  <VectorChunks chunks={active.vectorChunks} />
                </div>
              )}

              {active?.candidates && (
                <div className="mt-4">
                  <RankingTable candidates={active.candidates} />
                </div>
              )}

              {selected === "finalOutput" && trace && (
                <div className="mt-4">
                  <FinalOutput results={trace.results} />
                  <Synthesis traceId={trace.id} />
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function railLine(report?: DevStageReport): string {
  if (!report) return "not reported";
  if (report.status === "skipped") return "skipped";
  if (report.status === "failed") return "failed";
  if (!report.summary) return "done";
  return Object.entries(report.summary)
    .slice(0, 2)
    .map(([key, value]) => `${humanize(key)} ${String(value)}`)
    .join(" · ");
}

/**
 * Summary values are mostly scalars, but the embed stage carries the leading slice of the
 * real query vector — which has to render as numbers, not as "[object Object]".
 */
function formatSummaryValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" && !Number.isInteger(value)) return value.toFixed(5);
  return String(value);
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();
}

function originLabel(origin: DevSearchTraceHeader["origin"]): string {
  if (origin === "public_mcp") return "mcp";
  if (origin === "dev_tools") return "manual";
  return origin;
}

function StatusBadge({ status }: { status: DevSearchTraceHeader["status"] }) {
  return (
    <Badge
      variant={status === "failed" ? "destructive" : status === "empty" ? "secondary" : "outline"}
      className="text-[10px]"
    >
      {status}
    </Badge>
  );
}

function StatusDot({ status }: { status?: DevStageReport["status"] }) {
  if (!status) return <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-border" />;
  const tone =
    status === "failed" ? "bg-destructive" : status === "skipped" ? "bg-muted-foreground/40" : "bg-foreground/70";
  return <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone}`} />;
}
