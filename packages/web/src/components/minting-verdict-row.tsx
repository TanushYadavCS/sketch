/**
 * One pending verdict as a list row. States the disagreement — what the model
 * nominated against what the registry declared — because a row where those
 * agree is usually a formality and one where they differ is the reason to open
 * it. Shared between the dev-tools minting queue and the Your Org review tab;
 * `trailing` lets a caller append inline actions (the review tab's Dismiss).
 */
import type { ProjectMintingVerdict } from "@/lib/api";

export function MintingVerdictRow({
  verdict,
  onOpen,
  trailing,
}: {
  verdict: ProjectMintingVerdict;
  onOpen: () => void;
  trailing?: React.ReactNode;
}) {
  const proposal = verdict.verdict;
  const nominated = verdictAxisText(proposal.counterpartyKind, proposal.clientStage);
  const declared = verdict.declaredCounterpartyKind
    ? verdictAxisText(verdict.declaredCounterpartyKind, verdict.declaredClientStage)
    : null;
  const shape = [
    proposal.engagement ? "1 container" : null,
    proposal.projects.length > 0
      ? `${proposal.projects.length} project${proposal.projects.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  return (
    <div className="flex w-full items-center gap-3 px-3 py-2">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
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
      {trailing}
    </div>
  );
}

export function verdictAxisText(kind: string, stage: string | null): string {
  return stage ? `${kind} · ${stage}` : kind;
}
