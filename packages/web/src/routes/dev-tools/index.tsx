/**
 * /dev-tools — internal pipeline debugging. Not linked from the nav and not
 * mounted unless the server ran with DEV_TOOLS_ENABLED, so a tenant never
 * reaches it.
 *
 * The surface is one traced enrichment of one file: every log line the pipeline
 * emits — extraction, fact reconciliation, entity matching, materialisation —
 * lands here in order, including the drops that are otherwise invisible.
 */
import { type DevTraceRunHeader, type DevTraceStep, type UnifiedFile, api } from "@/lib/api";
import { CaretRightIcon, SpinnerGapIcon, WarningIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { dashboardRoute } from "../dashboard";

export const devToolsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/dev-tools",
  component: DevToolsPage,
});

/** Log messages worth surfacing on their own — the pipeline's silent rejections. */
const DROP_PATTERN = /drop|skip|suppress|reject|deferred|quarantin/i;

function isDrop(step: DevTraceStep) {
  return DROP_PATTERN.test(step.msg);
}

function DevToolsPage() {
  const [runId, setRunId] = useState<string | null>(null);

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div>
        <h1 className="text-[22px] font-medium">Pipeline debug</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Runs enrichment on one file and shows every step the pipeline logged, in order. Internal only — this is not
          part of the product.
        </p>
      </div>

      <div className="mt-5 flex gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
        <WarningIcon size={15} className="mt-0.5 shrink-0" />
        <span>
          This runs the real pipeline. It writes facts and can create entities, exactly as the Enrich File button does.
          Prompts and model responses are not shown here — they stay in the server's dump directory.
        </span>
      </div>

      <FilePicker onStarted={setRunId} />
      {runId && <RunTrace runId={runId} />}
      <PastRuns activeRunId={runId} onSelect={setRunId} />
    </div>
  );
}

/**
 * Recent files, filtered in the browser. A file id can also be pasted directly,
 * which is how a file found in logs or the DB gets here.
 */
function FilePicker({ onStarted }: { onStarted: (runId: string) => void }) {
  const [filter, setFilter] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filesQuery = useQuery({
    queryKey: ["dev-tools", "files"],
    queryFn: () => api.integrations.allFiles({ limit: 200 }),
  });

  const trimmed = filter.trim();
  const matches = (filesQuery.data?.files ?? [])
    .filter((file) => (trimmed ? matchesFile(file, trimmed) : true))
    .slice(0, 12);

  async function start(fileId: string) {
    setStarting(true);
    setError(null);
    try {
      const { runId } = await api.dev.startEnrichmentRun(fileId);
      onStarted(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="mt-7">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Pick a file</h2>
      <div className="flex gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter recent files, or paste a file id"
          className="flex-1"
        />
        {looksLikeId(trimmed) && (
          <Button onClick={() => start(trimmed)} disabled={starting}>
            Run on this id
          </Button>
        )}
      </div>

      {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}
      {filesQuery.isError && (
        <p className="mt-2 text-[13px] text-muted-foreground">Could not load files: {String(filesQuery.error)}</p>
      )}

      <div className="mt-2 divide-y divide-border rounded-md border border-border">
        {matches.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-muted-foreground">
            {filesQuery.isLoading ? "Loading files…" : "No files match."}
          </p>
        ) : (
          matches.map((file) => (
            <div key={file.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{file.fileName}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {file.source} · {file.id}
                </p>
              </div>
              <Button size="sm" variant="outline" disabled={starting} onClick={() => start(file.id)}>
                {starting ? <SpinnerGapIcon size={13} className="animate-spin" /> : "Trace"}
              </Button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function matchesFile(file: UnifiedFile, needle: string) {
  const lower = needle.toLowerCase();
  return file.fileName.toLowerCase().includes(lower) || file.id.toLowerCase().includes(lower);
}

function looksLikeId(value: string) {
  return /^[0-9a-f-]{20,}$/i.test(value);
}

/**
 * Polls one run, accumulating steps by sequence number so a long run streams in
 * rather than refetching its whole body each tick.
 */
function RunTrace({ runId }: { runId: string }) {
  const [header, setHeader] = useState<DevTraceRunHeader | null>(null);
  const [steps, setSteps] = useState<DevTraceStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dropsOnly, setDropsOnly] = useState(false);
  const lastSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    lastSeq.current = 0;
    setSteps([]);
    setHeader(null);
    setError(null);

    async function poll() {
      if (cancelled) return;
      try {
        const data = await api.dev.enrichmentRun(runId, lastSeq.current);
        if (cancelled) return;
        setHeader(data.run);
        if (data.steps.length > 0) {
          lastSeq.current = data.steps[data.steps.length - 1].seq;
          setSteps((prev) => [...prev, ...data.steps]);
        }
        if (data.run.status === "running") {
          setTimeout(poll, 1000);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load run");
      }
    }
    poll();

    return () => {
      cancelled = true;
    };
  }, [runId]);

  const shown = dropsOnly ? steps.filter(isDrop) : steps;
  const dropCount = steps.filter(isDrop).length;

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trace</h2>
        {header && <RunStatusBadge status={header.status} />}
        <span className="text-xs text-muted-foreground">
          {steps.length} steps · {dropCount} drops
          {header?.truncated && " · capture cap reached"}
        </span>
        {dropCount > 0 && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setDropsOnly((v) => !v)}>
            {dropsOnly ? "Show all steps" : "Drops only"}
          </Button>
        )}
      </div>

      {header && (
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {header.fileName} · raw calls: {header.dumpDir}
        </p>
      )}
      {header?.error && <p className="mt-2 text-[13px] text-destructive">{header.error}</p>}
      {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}

      <div className="mt-2 divide-y divide-border rounded-md border border-border">
        {shown.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-muted-foreground">
            {header?.status === "running" ? "Waiting for the first step…" : "No steps to show."}
          </p>
        ) : (
          shown.map((step) => <StepRow key={step.seq} step={step} />)
        )}
      </div>
    </section>
  );
}

function StepRow({ step }: { step: DevTraceStep }) {
  const [expanded, setExpanded] = useState(false);
  const fieldKeys = Object.keys(step.fields);
  const drop = isDrop(step);

  return (
    <div className={drop ? "bg-destructive/5" : undefined}>
      <button
        type="button"
        onClick={() => fieldKeys.length > 0 && setExpanded((v) => !v)}
        disabled={fieldKeys.length === 0}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-default"
      >
        <CaretRightIcon
          size={11}
          className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""} ${
            fieldKeys.length === 0 ? "opacity-0" : ""
          }`}
        />
        <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground">{step.seq}</span>
        <LevelBadge level={step.level} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{step.msg || "(no message)"}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{step.at.slice(11, 19)}</span>
      </button>

      {expanded && (
        <pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(step.fields, null, 2)}
        </pre>
      )}
    </div>
  );
}

function LevelBadge({ level }: { level: string }) {
  const variant = level === "error" || level === "fatal" ? "destructive" : level === "warn" ? "default" : "secondary";
  return (
    <Badge variant={variant} className="w-14 shrink-0 justify-center font-mono text-[9px] uppercase">
      {level}
    </Badge>
  );
}

function RunStatusBadge({ status }: { status: DevTraceRunHeader["status"] }) {
  if (status === "running") {
    return (
      <Badge variant="secondary" className="gap-1 text-[10px]">
        <SpinnerGapIcon size={11} className="animate-spin" />
        running
      </Badge>
    );
  }
  return (
    <Badge variant={status === "failed" ? "destructive" : "outline"} className="text-[10px]">
      {status}
    </Badge>
  );
}

/**
 * Runs are held in memory and evicted, so this list is short by design and
 * empties on a server restart.
 */
function PastRuns({ activeRunId, onSelect }: { activeRunId: string | null; onSelect: (runId: string) => void }) {
  const runsQuery = useQuery({
    queryKey: ["dev-tools", "runs", activeRunId],
    queryFn: () => api.dev.enrichmentRuns(),
    refetchInterval: 5000,
  });

  const runs = runsQuery.data?.runs ?? [];
  if (runs.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Recent runs</h2>
      <div className="divide-y divide-border rounded-md border border-border">
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => onSelect(run.id)}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left ${
              run.id === activeRunId ? "bg-muted/50" : ""
            }`}
          >
            <RunStatusBadge status={run.status} />
            <span className="min-w-0 flex-1 truncate text-[13px]">{run.fileName}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {run.stepCount} steps · {run.startedAt.slice(11, 19)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
