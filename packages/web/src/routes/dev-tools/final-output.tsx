import { type DevSearchSynthesis, type DevSearchSynthesisHeader, type DevSearchTraceResult, api } from "@/lib/api";
/**
 * What the agent actually received, and an optional answer synthesised from it.
 *
 * The distinction the page has to carry: stages 1-11 are a record of something that ran.
 * Synthesis is not — it runs now, on click, and is a different model call from the one the
 * agent made. A good synthetic answer does not mean the agent answered well.
 */
import { useEffect, useState } from "react";

export function FinalOutput({ results }: { results: DevSearchTraceResult[] }) {
  if (results.length === 0) {
    return <p className="text-[13px] text-muted-foreground">This search returned nothing.</p>;
  }

  return (
    <div>
      <p className="mb-2 text-[12px] text-muted-foreground">
        The text below is what the agent received, verbatim. Search prefers a file&apos;s summary over its matched chunk
        and cuts it at 200 characters — reading the whole document is a separate GetFileContent call the agent has to
        decide to make.
      </p>
      <div className="space-y-2">
        {results.map((result) => {
          const full = result.summary ?? result.snippet ?? "";
          const withheld = Math.max(0, full.length - 200);
          return (
            <div key={result.position} className="rounded-md border border-border px-3 py-2">
              <div className="mb-1 flex items-baseline gap-2">
                <span className="font-mono text-[10px] text-muted-foreground">{result.position}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{result.fileName}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{result.source}</span>
                <span className="shrink-0 font-mono text-[11px]">{result.score.toFixed(4)}</span>
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                {result.agentText}
              </pre>
              {withheld > 0 && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {withheld} more characters existed and were not sent.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Synthesis({ traceId }: { traceId: string }) {
  const [runs, setRuns] = useState<DevSearchSynthesisHeader[]>([]);
  const [open, setOpen] = useState<DevSearchSynthesis | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Lists only. Nothing here may call the model — that is the POST, on click. */
  useEffect(() => {
    setOpen(null);
    api.dev
      .searchTraceSyntheses(traceId)
      .then((data) => setRuns(data.syntheses))
      .catch(() => setRuns([]));
  }, [traceId]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const { synthesis } = await api.dev.runSearchSynthesis(traceId);
      setOpen(synthesis);
      setRuns((await api.dev.searchTraceSyntheses(traceId)).syntheses);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-6 rounded-md border border-dashed border-border p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium">12 · Synthesize</span>
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
          synthetic
        </span>
      </div>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Not part of the traced run. Sends the results above, plus this trace&apos;s query, to the configured model and
        stores the answer. Each click spends one real model call. It shows whether these results <em>can</em> support an
        answer — not what the agent said, which had a system prompt, tools and a conversation this does not.
      </p>

      <button
        type="button"
        onClick={run}
        disabled={running}
        className="mt-2 rounded-md border border-border px-3 py-1.5 text-[12px] disabled:opacity-50"
      >
        {running ? "Running…" : "Run synthesis"}
      </button>
      {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}

      {runs.length > 0 && (
        <div className="mt-3 space-y-1">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => api.dev.searchSynthesis(run.id).then((data) => setOpen(data.synthesis))}
              className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-muted ${
                open?.id === run.id ? "bg-muted" : ""
              }`}
            >
              <span className="font-mono text-[10px] text-muted-foreground">
                {new Date(run.createdAtMs).toLocaleTimeString()}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{run.model}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {run.status} · {run.durationMs}ms
              </span>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div className="mt-3 rounded-md border border-border p-3">
          <p className="mb-1 font-mono text-[10px] text-muted-foreground">
            {open.provider} · {open.model}
          </p>
          <pre className="whitespace-pre-wrap break-words text-[12px] leading-relaxed">
            {open.answer ?? open.error ?? "(no answer)"}
          </pre>
        </div>
      )}
    </div>
  );
}
