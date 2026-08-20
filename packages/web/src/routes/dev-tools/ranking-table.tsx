/**
 * One row per scored candidate: where each ranking placed it, what the fusion scored it,
 * and — for the ones that did not survive — which stage removed it and why.
 *
 * This is the answer to "why is that file not in my results", which no other surface can
 * give: the drops happen inside one SQL statement and leave nothing behind.
 */
import type { DevSearchCandidate } from "@/lib/api";
import { useState } from "react";

type Filter = "all" | "returned" | "dropped";

export function RankingTable({ candidates }: { candidates: DevSearchCandidate[] }) {
  const [filter, setFilter] = useState<Filter>("all");

  if (candidates.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        No candidates were recorded. Either nothing scored, or the trace ran without drop attribution.
      </p>
    );
  }

  const returned = candidates.filter((candidate) => candidate.finalPosition !== null);
  const dropped = candidates.filter((candidate) => candidate.finalPosition === null);
  const shown = filter === "returned" ? returned : filter === "dropped" ? dropped : candidates;
  const ordered = [...shown].sort(byFinalThenScore);

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label={`All ${candidates.length}`} />
        <FilterChip
          active={filter === "returned"}
          onClick={() => setFilter("returned")}
          label={`Returned ${returned.length}`}
        />
        <FilterChip
          active={filter === "dropped"}
          onClick={() => setFilter("dropped")}
          label={`Not returned ${dropped.length}`}
        />
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[46rem] border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <Th className="w-10">#</Th>
              <Th>File</Th>
              <Th className="w-14 text-right">FTS</Th>
              <Th className="w-14 text-right">Vec</Th>
              <Th className="w-16 text-right">Sim</Th>
              <Th className="w-20 text-right">Score</Th>
              <Th className="w-[15rem]">Outcome</Th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((candidate) => (
              <Row key={candidate.fileId} candidate={candidate} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ candidate }: { candidate: DevSearchCandidate }) {
  const survived = candidate.finalPosition !== null;
  return (
    <tr className={`border-b border-border last:border-b-0 ${survived ? "" : "bg-destructive/5"}`}>
      <Td className="font-mono text-muted-foreground">{candidate.finalPosition ?? "—"}</Td>
      <Td>
        <span className={`block truncate ${survived ? "" : "text-muted-foreground line-through"}`}>
          {candidate.fileName}
        </span>
        <span className="block font-mono text-[10px] text-muted-foreground">
          {candidate.source}
          {candidate.boosted && " · entity-boosted"}
        </span>
      </Td>
      <Td className="text-right font-mono text-muted-foreground">{candidate.ftsRank ?? "—"}</Td>
      <Td className="text-right font-mono text-muted-foreground">{candidate.vecRank ?? "—"}</Td>
      <Td className="text-right font-mono text-muted-foreground">
        {candidate.similarity === null ? "—" : candidate.similarity.toFixed(3)}
      </Td>
      <Td className="text-right font-mono">{candidate.score.toFixed(5)}</Td>
      <Td className="text-[11px] text-muted-foreground">{outcomeText(candidate)}</Td>
    </tr>
  );
}

function outcomeText(candidate: DevSearchCandidate): string {
  if (candidate.mergedInto) return `merged into thread ${candidate.mergedInto}`;
  if (candidate.droppedAt) return `${candidate.droppedAt}: ${candidate.dropReason ?? "dropped"}`;
  if (candidate.finalPosition !== null) return "returned";
  return "not returned";
}

/** Returned rows first in the order the caller saw them, then the drops by score. */
function byFinalThenScore(a: DevSearchCandidate, b: DevSearchCandidate): number {
  if (a.finalPosition !== null && b.finalPosition !== null) return a.finalPosition - b.finalPosition;
  if (a.finalPosition !== null) return -1;
  if (b.finalPosition !== null) return 1;
  return b.score - a.score;
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[11px] ${
        active ? "border-foreground/30 bg-muted font-medium" : "border-border text-muted-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-2.5 py-1.5 font-medium text-[10px] uppercase tracking-wide ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`max-w-0 px-2.5 py-1.5 align-top ${className}`}>{children}</td>;
}
