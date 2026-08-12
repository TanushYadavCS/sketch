/**
 * The left rail of a run: all eight stages at once, so the shape of the run
 * stays visible while one stage is being read on the right.
 */
import type { DevLlmCallHeader, DevStageReport } from "@/lib/api";
import { SpinnerGapIcon } from "@phosphor-icons/react";
import type { StageDefinition } from "./stages";

export type RailSelection = { kind: "stage"; stage: string } | { kind: "log" };

export function StageRail({
  stages,
  reportByStage,
  callByStage,
  selected,
  onSelect,
  logLineCount,
  running,
}: {
  stages: StageDefinition[];
  reportByStage: Map<string, DevStageReport>;
  callByStage: Map<string, DevLlmCallHeader>;
  selected: RailSelection;
  onSelect: (selection: RailSelection) => void;
  logLineCount: number;
  running: boolean;
}) {
  return (
    <nav className="flex h-full w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/20">
      {stages.map((definition, index) => {
        const report = reportByStage.get(definition.stage);
        const call = callByStage.get(definition.stage);
        const active = selected.kind === "stage" && selected.stage === definition.stage;
        return (
          <button
            key={definition.stage}
            type="button"
            onClick={() => onSelect({ kind: "stage", stage: definition.stage })}
            className={`flex items-start gap-2.5 border-b border-border px-3 py-2.5 text-left ${
              active ? "bg-background" : "hover:bg-background/60"
            }`}
          >
            <StatusDot status={report?.status} running={running} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="font-mono text-[10px] text-muted-foreground">{index + 1}</span>
                <span className={`truncate text-[13px] ${active ? "font-medium" : ""}`}>{definition.label}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {railLine(definition, report, call)}
              </span>
            </span>
          </button>
        );
      })}

      <button
        type="button"
        onClick={() => onSelect({ kind: "log" })}
        className={`mt-auto flex items-center gap-2.5 border-t border-border px-3 py-2.5 text-left ${
          selected.kind === "log" ? "bg-background" : "hover:bg-background/60"
        }`}
      >
        <span className="h-2 w-2 shrink-0 rounded-full border border-border" />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13px] ${selected.kind === "log" ? "font-medium" : ""}`}>
            Log timeline
          </span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{logLineCount} lines</span>
        </span>
      </button>
    </nav>
  );
}

/**
 * The rail's one line per stage: its own counts if it ran, its cost if it called
 * a model, and the reason it did not run if it was skipped.
 */
function railLine(definition: StageDefinition, report?: DevStageReport, call?: DevLlmCallHeader): string {
  if (!report) return definition.kind === "model" ? "model call" : "not started";
  if (report.status === "skipped") return "skipped";
  if (report.status === "failed") return "failed";

  const parts: string[] = [];
  if (report.summary) {
    for (const [key, value] of Object.entries(report.summary)) parts.push(`${humanizeKey(key)} ${String(value)}`);
  }
  if (call?.promptTokens != null) parts.push(`${call.promptTokens.toLocaleString()} tok`);
  return parts.length > 0 ? parts.join(" · ") : "done";
}

function humanizeKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();
}

function StatusDot({ status, running }: { status?: DevStageReport["status"]; running: boolean }) {
  if (!status) {
    return running ? (
      <SpinnerGapIcon size={9} className="mt-1.5 shrink-0 animate-spin text-muted-foreground" />
    ) : (
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-border" />
    );
  }
  const tone =
    status === "failed" ? "bg-destructive" : status === "skipped" ? "bg-muted-foreground/40" : "bg-foreground/70";
  return <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone}`} />;
}
