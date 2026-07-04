/**
 * Shared presentation for generated agent output — the "previous runs" list, a
 * single run's rendered sections, the run-now button, and the empty/loading
 * cards. Used by both the prebuilt-agent detail page (all routes) and the
 * per-summariser page (one route), so the two surfaces stay visually identical.
 */
import type { AgentOutput } from "@/lib/api";
import { cn } from "@sketch/ui/lib/utils";
import { useEffect, useState } from "react";

export function formatOutputDate(value: string): string {
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border py-10 text-center text-[12.5px] text-muted-foreground">
      {children}
    </p>
  );
}

export function RunButton({ running, pending, onRun }: { running: boolean; pending: boolean; onRun: () => void }) {
  return (
    <button
      type="button"
      onClick={onRun}
      disabled={running || pending}
      className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-[12px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {running ? "Running…" : "Run now"}
    </button>
  );
}

export function OutputView({ output, sectionTitles }: { output: AgentOutput; sectionTitles: Record<string, string> }) {
  const sectionEntries = Object.entries(output.sections).filter(([, items]) => items.length > 0);
  return (
    <div className="flex flex-col gap-6">
      {output.masthead ? (
        <div className="rounded-xl border-[0.5px] border-border bg-gradient-to-b from-muted/50 to-card px-4 py-3.5">
          <p className="text-[14px] font-semibold text-foreground">{output.masthead.title}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{output.masthead.summary}</p>
        </div>
      ) : null}
      {sectionEntries.length === 0 ? (
        <EmptyCard>No items in this run.</EmptyCard>
      ) : (
        sectionEntries.map(([sectionKey, items]) => (
          <div key={sectionKey}>
            <div className="mb-2 border-b border-border/60 pb-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                {sectionTitles[sectionKey] ?? sectionKey}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {items.map((item) => (
                <div key={item.id} className="rounded-xl border-[0.5px] border-border bg-card px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[13px] font-medium text-foreground">{item.title}</span>
                    {item.label ? (
                      <span className="rounded-full bg-muted/60 px-1.5 py-[1px] font-mono text-[8.5px] uppercase tracking-[0.06em] text-muted-foreground">
                        {item.label.replaceAll("_", " ")}
                      </span>
                    ) : null}
                    {item.displayRef ? (
                      <span className="font-mono text-[10px] text-muted-foreground/70">{item.displayRef}</span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{item.summary}</p>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The full "runs" experience — a run-now header, the previous-runs rail, and the
 * selected run's rendered sections. Manages its own selection; the caller owns
 * fetching (and any refetch-while-running polling) and passes the outputs in.
 */
export function RunsPanel({
  outputs,
  loading,
  running,
  runPending,
  onRun,
  sectionTitles,
  emptyHint,
}: {
  outputs: AgentOutput[];
  loading: boolean;
  running: boolean;
  runPending: boolean;
  onRun: () => void;
  sectionTitles: Record<string, string>;
  emptyHint: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && outputs.length > 0) setSelectedId(outputs[0].id);
  }, [outputs, selectedId]);
  const selected = outputs.find((output) => output.id === selectedId) ?? outputs[0] ?? null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          {selected ? `Generated ${formatOutputDate(selected.generatedAt ?? selected.outputDate)}` : "No output yet"}
        </span>
        <RunButton running={running} pending={runPending} onRun={onRun} />
      </div>

      {running && !selected ? (
        <EmptyCard>Generating…</EmptyCard>
      ) : loading && outputs.length === 0 ? (
        <EmptyCard>Loading…</EmptyCard>
      ) : !selected ? (
        <EmptyCard>{emptyHint}</EmptyCard>
      ) : (
        <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
          <div className="flex flex-col gap-1">
            {outputs.map((output) => (
              <button
                key={output.id}
                type="button"
                onClick={() => setSelectedId(output.id)}
                className={cn(
                  "rounded-lg px-3 py-2 text-left transition-colors",
                  selected.id === output.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
                )}
              >
                <span className="block truncate text-[12.5px] font-medium">{output.sourceLabel ?? "Summary"}</span>
                <span className="mt-0.5 block truncate font-mono text-[10px] uppercase tracking-[0.08em]">
                  {formatOutputDate(output.generatedAt ?? output.outputDate)}
                </span>
              </button>
            ))}
          </div>
          <OutputView output={selected} sectionTitles={sectionTitles} />
        </div>
      )}
    </div>
  );
}
