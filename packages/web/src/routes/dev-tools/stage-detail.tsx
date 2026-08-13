/**
 * The right pane of a run: one stage with the mint-tasks anatomy — what was
 * sent, what came back, and what the code then did with it.
 *
 * A model stage gets four tabs. A code stage has no prompt, so it opens straight
 * on its outcomes, which is the half of the pipeline that leaves no trace
 * anywhere else.
 */
import { ContextBlockRow } from "@/components/context-block-row";
import { type DevLlmCallHeader, type DevStageOutcome, type DevStageReport, api } from "@/lib/api";
import { SpinnerGapIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { StageDefinition } from "./stages";

type StageTab = "context" | "prompt" | "response" | "parsed" | "outcomes";

/** Results that mean the pipeline declined to act, which is what a reader is usually hunting. */
const NEGATIVE_RESULTS = new Set(["dropped", "suppressed", "deferred"]);

const MODEL_TABS: Array<{ id: StageTab; label: string }> = [
  { id: "context", label: "Context sent" },
  { id: "prompt", label: "Full prompt" },
  { id: "response", label: "Raw response" },
  { id: "parsed", label: "Parsed" },
  { id: "outcomes", label: "Outcomes" },
];

export function StageDetail({
  runId,
  definition,
  report,
  call,
  position,
}: {
  runId: string;
  definition: StageDefinition;
  report?: DevStageReport;
  call?: DevLlmCallHeader;
  position: number;
}) {
  const [tab, setTab] = useState<StageTab>(definition.kind === "model" ? "context" : "outcomes");
  const activeTab = definition.kind === "model" ? tab : "outcomes";

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">{position}</span>
          <h3 className="text-[15px] font-medium">{definition.label}</h3>
          <Badge variant="secondary" className="font-mono text-[9px] uppercase">
            {definition.kind}
          </Badge>
          <StageStatus status={report?.status} />
          {definition.parallelWith && (
            <span className="text-[11px] text-muted-foreground">runs with {definition.parallelWith}</span>
          )}
        </div>
        {call && (
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {call.model}
            {call.promptChars !== null && ` · ${call.promptChars.toLocaleString()} chars in`}
            {call.promptTokens !== null && ` · ${call.promptTokens.toLocaleString()} tok`}
            {call.costUsd !== null && ` · $${call.costUsd.toFixed(4)}`}
            {call.finishReason && ` · ${call.finishReason}`}
          </p>
        )}
        {report?.error && <p className="mt-1.5 text-[13px] text-destructive">{report.error}</p>}

        {definition.kind === "model" && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {MODEL_TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                className={`rounded-md px-2.5 py-1 text-[12px] ${
                  tab === entry.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {activeTab === "context" ? (
          <ContextPane report={report} />
        ) : activeTab === "outcomes" ? (
          <OutcomesPane report={report} definition={definition} />
        ) : (
          <CallPane runId={runId} call={call} view={activeTab} />
        )}
      </div>
    </div>
  );
}

function ContextPane({ report }: { report?: DevStageReport }) {
  if (!report?.context || report.context.length === 0) {
    return <Empty text="This stage declared no context blocks." />;
  }
  return (
    <>
      <div className="space-y-1.5">
        {report.context.map((block) => (
          <ContextBlockRow key={block.key} block={block} />
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Each block states the rule that selected it and the count it matched before any cap.
      </p>
    </>
  );
}

function OutcomesPane({ report, definition }: { report?: DevStageReport; definition: StageDefinition }) {
  const outcomes = report?.outcomes ?? [];
  if (outcomes.length === 0) {
    return (
      <Empty
        text={
          definition.kind === "model"
            ? "This stage records its decisions on the code stage that consumes it."
            : "This stage recorded no per-item outcomes."
        }
      />
    );
  }

  const negative = outcomes.filter((outcome) => NEGATIVE_RESULTS.has(outcome.result));
  const positive = outcomes.filter((outcome) => !NEGATIVE_RESULTS.has(outcome.result));

  return (
    <div className="space-y-4">
      {negative.length > 0 && <OutcomeGroup title={`Not acted on (${negative.length})`} outcomes={negative} negative />}
      {positive.length > 0 && <OutcomeGroup title={`Acted on (${positive.length})`} outcomes={positive} />}
    </div>
  );
}

function OutcomeGroup({
  title,
  outcomes,
  negative,
}: {
  title: string;
  outcomes: DevStageOutcome[];
  negative?: boolean;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className={`overflow-hidden rounded-md border border-border ${negative ? "bg-destructive/5" : ""}`}>
        {outcomes.map((outcome, index) => (
          <div
            key={`${outcome.subject}-${outcome.result}-${index}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-b border-border px-3 py-1.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_5rem_5rem_minmax(0,14rem)]"
          >
            <span className="truncate text-[13px]">{outcome.subject}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{outcome.kind}</span>
            <span className="font-mono text-[10px]">{outcome.result}</span>
            <span className="col-span-2 text-[11px] text-muted-foreground sm:col-span-1">{outcome.reason ?? ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Prompt and response bodies load only when their tab is opened — an extraction
 * prompt runs to roughly 19,000 characters.
 */
function CallPane({
  runId,
  call,
  view,
}: {
  runId: string;
  call?: DevLlmCallHeader;
  view: "prompt" | "response" | "parsed";
}) {
  const bodyQuery = useQuery({
    queryKey: ["dev-tools", "call", runId, call?.seq],
    queryFn: () => api.dev.enrichmentCall(runId, call?.seq ?? 0),
    enabled: Boolean(call),
  });

  if (!call) {
    return (
      <Empty text="No dump was written for this stage. Dumps are saved after a response arrives, so a call that threw leaves nothing behind." />
    );
  }
  if (bodyQuery.isLoading) {
    return (
      <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <SpinnerGapIcon size={13} className="animate-spin" />
        Loading the call…
      </p>
    );
  }
  if (bodyQuery.isError) return <p className="text-[13px] text-destructive">{String(bodyQuery.error)}</p>;

  const body = bodyQuery.data?.call;
  if (view === "prompt") {
    return (
      <div className="space-y-3">
        {body?.systemPrompt && <Payload label="System prompt" text={body.systemPrompt} />}
        {body?.prompt ? <Payload label="Prompt" text={body.prompt} /> : <Empty text="No prompt recorded." />}
      </div>
    );
  }
  if (view === "parsed") {
    return body?.parsed === undefined ? (
      <Empty text="The response did not parse as JSON." />
    ) : (
      <Payload label="Parsed" text={JSON.stringify(body.parsed, null, 2)} />
    );
  }
  return body?.text ? <Payload label="Response" text={body.text} /> : <Empty text="No response text." />;
}

function Payload({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-[11px] text-muted-foreground">{text.length.toLocaleString()} chars</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-[11px]"
          onClick={() => navigator.clipboard.writeText(text)}
        >
          Copy
        </Button>
      </div>
      <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-[13px] text-muted-foreground">{text}</p>;
}

function StageStatus({ status }: { status?: DevStageReport["status"] }) {
  if (!status) return <span className="font-mono text-[10px] text-muted-foreground">not started</span>;
  return (
    <Badge
      variant={status === "failed" ? "destructive" : status === "skipped" ? "secondary" : "outline"}
      className="text-[10px]"
    >
      {status}
    </Badge>
  );
}
