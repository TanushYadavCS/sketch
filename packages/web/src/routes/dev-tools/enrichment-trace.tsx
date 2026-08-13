/**
 * One enrichment run as master-detail: all eight stages in a rail on the left,
 * one stage open on the right.
 *
 * A rail rather than an accordion because the stage bodies are large — a
 * 19,000-character prompt or a hundred-row outcome list — and expanding one
 * inline would push the rest of the run off screen just when the reader needs
 * to compare it against the others.
 */
import { type DevLlmCallHeader, type DevStageReport, type DevTraceRunHeader, type DevTraceStep, api } from "@/lib/api";
import { CaretRightIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { useEffect, useRef, useState } from "react";
import { StageDetail } from "./stage-detail";
import { type RailSelection, StageRail } from "./stage-rail";
import { STAGES } from "./stages";

export function EnrichmentTrace({ runId }: { runId: string }) {
  const [header, setHeader] = useState<DevTraceRunHeader | null>(null);
  const [stageReports, setStageReports] = useState<DevStageReport[]>([]);
  const [steps, setSteps] = useState<DevTraceStep[]>([]);
  const [calls, setCalls] = useState<DevLlmCallHeader[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<RailSelection>({ kind: "stage", stage: STAGES[0].stage });
  /** Once the reader picks a stage, the run stops moving the selection under them. */
  const pinned = useRef(false);
  const lastSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    lastSeq.current = 0;
    pinned.current = false;
    setSteps([]);
    setStageReports([]);
    setCalls([]);
    setHeader(null);
    setError(null);
    setSelection({ kind: "stage", stage: STAGES[0].stage });

    async function poll() {
      if (cancelled) return;
      try {
        const [runData, callData] = await Promise.all([
          api.dev.enrichmentRun(runId, lastSeq.current),
          api.dev.enrichmentCalls(runId),
        ]);
        if (cancelled) return;
        setHeader(runData.run);
        setStageReports(runData.stageReports);
        setCalls(callData.calls);
        if (runData.steps.length > 0) {
          lastSeq.current = runData.steps[runData.steps.length - 1].seq;
          setSteps((prev) => [...prev, ...runData.steps]);
        }
        if (!pinned.current) {
          const latest = latestReportedStage(runData.stageReports);
          if (latest) setSelection({ kind: "stage", stage: latest });
        }
        if (runData.run.status === "running") setTimeout(poll, 1000);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load run");
      }
    }
    poll();

    return () => {
      cancelled = true;
    };
  }, [runId]);

  const reportByStage = new Map(stageReports.map((report) => [report.stage, report]));
  const callByStage = new Map(calls.map((call) => [call.stage, call]));
  const ranCount = stageReports.filter((report) => report.status === "done").length;
  const skippedAll = stageReports.length > 0 && stageReports.every((report) => report.status === "skipped");
  const totals = callTotals(calls);
  const running = header?.status === "running";

  const activeIndex = selection.kind === "stage" ? STAGES.findIndex((s) => s.stage === selection.stage) : -1;
  const activeDefinition = activeIndex >= 0 ? STAGES[activeIndex] : null;

  function select(next: RailSelection) {
    pinned.current = true;
    setSelection(next);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-2.5">
        {header && <RunStatusBadge status={header.status} />}
        <span className="text-xs text-muted-foreground">
          {ranCount} of {STAGES.length} stages ran
          {totals.tokens > 0 && ` · ${totals.tokens.toLocaleString()} tok`}
          {totals.cost > 0 && ` · $${totals.cost.toFixed(4)}`}
        </span>
        {header && (
          <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{header.dumpDir}</span>
        )}
      </div>

      {(header?.error || error || skippedAll) && (
        <div className="border-b border-border px-5 py-2">
          {header?.error && <p className="text-[13px] text-destructive">{header.error}</p>}
          {error && <p className="text-[13px] text-destructive">{error}</p>}
          {skippedAll && <p className="text-[13px]">{stageReports[0]?.error ?? "Nothing ran."}</p>}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <StageRail
          stages={STAGES}
          reportByStage={reportByStage}
          callByStage={callByStage}
          selected={selection}
          onSelect={select}
          logLineCount={steps.length}
          running={running}
        />
        {activeDefinition ? (
          <StageDetail
            key={activeDefinition.stage}
            runId={runId}
            definition={activeDefinition}
            report={reportByStage.get(activeDefinition.stage)}
            call={callByStage.get(activeDefinition.stage)}
            position={activeIndex + 1}
          />
        ) : (
          <LogPane steps={steps} truncated={header?.truncated ?? false} />
        )}
      </div>
    </div>
  );
}

/** The furthest stage the run has reported, so a live run follows itself down the rail. */
function latestReportedStage(reports: DevStageReport[]): string | null {
  let best: { stage: string; index: number } | null = null;
  for (const report of reports) {
    const index = STAGES.findIndex((stage) => stage.stage === report.stage);
    if (index >= 0 && (!best || index > best.index)) best = { stage: report.stage, index };
  }
  return best?.stage ?? null;
}

function callTotals(calls: DevLlmCallHeader[]) {
  return calls.reduce(
    (acc, call) => ({
      tokens: acc.tokens + (call.promptTokens ?? 0) + (call.completionTokens ?? 0),
      cost: acc.cost + (call.costUsd ?? 0),
    }),
    { tokens: 0, cost: 0 },
  );
}

/**
 * The raw pino stream. The fallback for a failure no stage report anticipated.
 */
function LogPane({ steps, truncated }: { steps: DevTraceStep[]; truncated: boolean }) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="border-b border-border px-5 py-3">
        <h3 className="text-[15px] font-medium">Log timeline</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Every line the pipeline logged, in order{truncated && " · capture cap reached"}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {steps.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted-foreground">Nothing logged yet.</p>
        ) : (
          steps.map((step) => <LogRow key={step.seq} step={step} />)
        )}
      </div>
    </div>
  );
}

function LogRow({ step }: { step: DevTraceStep }) {
  const [expanded, setExpanded] = useState(false);
  const fieldKeys = Object.keys(step.fields);

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => fieldKeys.length > 0 && setExpanded((v) => !v)}
        disabled={fieldKeys.length === 0}
        className="flex w-full items-center gap-2 px-5 py-1.5 text-left disabled:cursor-default"
      >
        <CaretRightIcon
          size={11}
          className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""} ${
            fieldKeys.length === 0 ? "opacity-0" : ""
          }`}
        />
        <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground">{step.seq}</span>
        <span className="w-10 shrink-0 font-mono text-[9px] uppercase text-muted-foreground">{step.level}</span>
        <span className="min-w-0 flex-1 truncate text-[13px]">{step.msg || "(no message)"}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{step.at.slice(11, 19)}</span>
      </button>

      {expanded && (
        <pre className="overflow-x-auto border-t border-border px-5 py-2 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(step.fields, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function RunStatusBadge({ status }: { status: DevTraceRunHeader["status"] }) {
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
