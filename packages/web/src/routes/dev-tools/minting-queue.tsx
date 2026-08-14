/**
 * The pending project-minting queue. Rows state the disagreement — what the
 * model nominated against what the registry declared — because a row where
 * those agree is usually a formality and one where they differ is the reason
 * to open it.
 *
 * Order comes from the server (`pendingSortKey`: flagged last, then confidence,
 * then age); this list does not re-sort. Nothing fills the queue over HTTP yet,
 * so the empty state carries the command that does.
 */
import { type ProjectMintingVerdict, api } from "@/lib/api";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { MintingClusters } from "./minting-clusters";
import { MintingVerdictSheet } from "./minting-sheet";

export function MintingQueue() {
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["project-minting", "verdicts"],
    queryFn: () => api.projectMinting.listVerdicts(),
    retry: false,
    refetchInterval: 15000,
  });

  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className="h-12 rounded-md" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
        Could not load verdicts: {String(error)}
      </p>
    );
  }

  const verdicts = data?.verdicts ?? [];

  return (
    <>
      <MintingClusters />
      <section className="mt-8">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Pending verdicts · {verdicts.length}
        </h2>

        {verdicts.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
            <p className="text-[13px] text-muted-foreground">Nothing waiting.</p>
            <p className="mt-1.5 text-[12px] text-muted-foreground">Run a pass on a company above to fill this.</p>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {verdicts.map((verdict) => (
              <QueueRow key={verdict.id} verdict={verdict} onOpen={() => setOpenId(verdict.id)} />
            ))}
          </div>
        )}

        <MintingVerdictSheet verdictId={openId} onClose={() => setOpenId(null)} onDecided={() => void refetch()} />
      </section>
    </>
  );
}

function QueueRow({ verdict, onOpen }: { verdict: ProjectMintingVerdict; onOpen: () => void }) {
  const proposal = verdict.verdict;
  const nominated = axisText(proposal.counterpartyKind, proposal.clientStage);
  const declared = verdict.declaredCounterpartyKind
    ? axisText(verdict.declaredCounterpartyKind, verdict.declaredClientStage)
    : null;
  const shape = [
    proposal.engagement ? "1 container" : null,
    proposal.projects.length > 0
      ? `${proposal.projects.length} project${proposal.projects.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-3 py-2 text-left"
      data-testid={`minting-row-${verdict.id}`}
    >
      {verdict.flags.length > 0 ? (
        <span className="shrink-0 rounded-full border border-amber-400/70 bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] uppercase text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          flag
        </span>
      ) : (
        <span aria-hidden className="w-[34px] shrink-0" />
      )}
      <span className="shrink-0 text-[13px] font-medium text-foreground">{verdict.companyName}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
        nominates <span className="text-foreground">{nominated}</span> — registry says{" "}
        {declared ? <span className="text-foreground">{declared}</span> : <span className="italic">undeclared</span>}
        {shape.length > 0 ? ` · ${shape.join(", ")}` : " · nothing proposed"}
      </span>
      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{verdict.fileCount} files</span>
    </button>
  );
}

function axisText(kind: string, stage: string | null): string {
  return stage ? `${kind} · ${stage}` : kind;
}
