/**
 * One verdict, opened for decision. Reads top to bottom as the questions a
 * reviewer actually asks: who is this cluster, what is the relationship, what
 * will my answer cause, and is the detail right.
 *
 * Three things are kept visually separate and never merged — what the registry
 * declared, what the model nominated, and what the reviewer says. The accept
 * gate was rewritten specifically so a correction is obeyed rather than
 * silently replaced by the nomination; collapsing them here would reintroduce
 * that at the UI layer. The axis picker starts on the nomination so agreeing is
 * one click, but it reads as a choice, and the accept button names the decision
 * it is about to record.
 */
import { type ClientStage, type CounterpartyKind, type ProjectMintingVerdict, api } from "@/lib/api";
import { ApiRequestError } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type GateLine, kindCarriesStage, previewGate } from "./minting-gate";

const KINDS: CounterpartyKind[] = ["client", "partner", "vendor", "investor", "other"];
const STAGES: ClientStage[] = ["prospect", "pilot", "active", "dormant", "ended"];

export function MintingVerdictSheet({
  verdictId,
  onClose,
  onDecided,
}: {
  verdictId: string | null;
  onClose: () => void;
  onDecided: () => void;
}) {
  return (
    <Sheet open={!!verdictId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-[800px]">
        <SheetTitle className="sr-only">Project minting verdict</SheetTitle>
        <SheetDescription className="sr-only">
          Confirm what this counterparty is, then accept or reject what the pass proposed.
        </SheetDescription>
        {verdictId ? <SheetBody verdictId={verdictId} onClose={onClose} onDecided={onDecided} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({
  verdictId,
  onClose,
  onDecided,
}: {
  verdictId: string;
  onClose: () => void;
  onDecided: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["project-minting", "verdict", verdictId],
    queryFn: () => api.projectMinting.getVerdict(verdictId),
  });
  const verdict = data?.verdict;

  const [kind, setKind] = useState<CounterpartyKind | null>(null);
  const [stage, setStage] = useState<ClientStage | null>(null);
  const [struck, setStruck] = useState<Set<string>>(new Set());
  const [override, setOverride] = useState(false);

  /** Seed the picker from the nomination once the verdict lands. */
  useEffect(() => {
    if (!verdict) return;
    setKind(verdict.verdict.counterpartyKind);
    setStage(verdict.verdict.clientStage);
  }, [verdict]);

  const settle = () => {
    queryClient.invalidateQueries({ queryKey: ["project-minting"] });
    queryClient.invalidateQueries({ queryKey: ["entities"] });
    onDecided();
    onClose();
  };

  const accept = useMutation({
    mutationFn: () => {
      if (!kind) throw new Error("Pick what this counterparty is");
      return api.projectMinting.accept(verdictId, {
        confirmedCounterpartyKind: kind,
        ...(kindCarriesStage(kind) && stage ? { confirmedClientStage: stage } : {}),
        ...(struck.size > 0 ? { struckProjectNames: [...struck] } : {}),
        ...(override ? { overrideTripwireFlags: true } : {}),
      });
    },
    onSuccess: settle,
  });
  const reject = useMutation({ mutationFn: () => api.projectMinting.reject(verdictId), onSuccess: settle });

  if (isLoading || !verdict || !kind) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const carriesStage = kindCarriesStage(kind);
  const effectiveStage = carriesStage ? stage : null;
  const preview = previewGate(verdict, kind, effectiveStage, struck);
  const blockedByStage = carriesStage && !stage;
  const blockedByFlags = verdict.flags.length > 0 && !override;
  const canAccept = !preview.blocked && !blockedByStage && !blockedByFlags && !accept.isPending && !reject.isPending;
  const decision = carriesStage && stage ? `${kind} · ${stage}` : kind;
  const error = accept.error ?? reject.error;

  const toggleStrike = (name: string) => {
    setStruck((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-[17px] font-semibold text-foreground">{verdict.companyName}</h2>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          {verdict.fileCount} files · generated {verdict.createdAt.slice(0, 16).replace("T", " ")}
        </p>
      </div>

      <div className="flex-1 space-y-6 px-6 py-5">
        {verdict.flags.length > 0 ? (
          <div className="rounded-md border border-amber-300/70 bg-amber-50/60 px-3 py-2.5 text-[12.5px] text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/25 dark:text-amber-200">
            <p className="font-medium">Tripwire</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {verdict.flags.map((flag) => (
                <li key={flag}>{flag}</li>
              ))}
            </ul>
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              <span>Override and accept anyway</span>
            </label>
          </div>
        ) : null}

        <section>
          <SectionLabel>Relationship</SectionLabel>
          <dl className="mt-2 space-y-1">
            <Fact label="Registry says">
              {verdict.declaredCounterpartyKind ? (
                axisText(verdict.declaredCounterpartyKind, verdict.declaredClientStage)
              ) : (
                <span className="italic text-muted-foreground">undeclared</span>
              )}
            </Fact>
            <Fact label="Model nominates">
              {axisText(verdict.verdict.counterpartyKind, verdict.verdict.clientStage)}
            </Fact>
          </dl>

          <div className="mt-3 border-t border-border/60 pt-3">
            <SectionLabel>Your answer</SectionLabel>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {KINDS.map((option) => (
                <Pick key={option} label={option} selected={kind === option} onClick={() => setKind(option)} />
              ))}
            </div>
            {carriesStage ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {STAGES.map((option) => (
                  <Pick key={option} label={option} selected={stage === option} onClick={() => setStage(option)} />
                ))}
              </div>
            ) : null}
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              Accepting records this as the declaration. A stage applies to client and partner only.
            </p>
          </div>
        </section>

        <section>
          <SectionLabel>What accepting will do</SectionLabel>
          {preview.blocked ? (
            <p className="mt-2 rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2.5 text-[12.5px] text-destructive">
              {preview.blocked}
            </p>
          ) : blockedByStage ? (
            <p className="mt-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
              Pick a stage to see what this will do.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2.5">
              {preview.lines.map((line) => (
                <ConsequenceRow key={line.text} line={line} />
              ))}
            </ul>
          )}
        </section>

        {verdict.verdict.projects.length > 0 ? (
          <section>
            <div className="flex items-baseline justify-between">
              <SectionLabel>Proposed projects · {verdict.verdict.projects.length}</SectionLabel>
              <span className="font-mono text-[10px] text-muted-foreground">untick to strike</span>
            </div>
            <div className="mt-2 divide-y divide-border/60 rounded-md border border-border">
              {verdict.verdict.projects.map((project) => {
                const isStruck = struck.has(project.name);
                return (
                  <div key={project.name} className="px-3 py-2">
                    <label className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={!isStruck}
                        onChange={() => toggleStrike(project.name)}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            "text-[13px] font-medium text-foreground",
                            isStruck && "line-through opacity-60",
                          )}
                        >
                          {project.name}
                        </span>
                        <span className="ml-2 font-mono text-[10.5px] text-muted-foreground">
                          {project.status} · {project.confidence}
                        </span>
                        <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                          {evidenceSummary(project)}
                        </span>
                      </span>
                    </label>
                    {project.reasoning ? (
                      <details className="ml-7 mt-1">
                        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          why
                        </summary>
                        <p className="mt-1 text-[11.5px] text-muted-foreground">{project.reasoning}</p>
                      </details>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {verdict.verdict.existingEntities.length > 0 ? (
          <section>
            <SectionLabel>Existing entities · {verdict.verdict.existingEntities.length}</SectionLabel>
            <div className="mt-2 divide-y divide-border/60 rounded-md border border-border">
              {verdict.verdict.existingEntities.map((entity) => (
                <div key={entity.entityId} className="flex items-baseline gap-2 px-3 py-2">
                  <span className="text-[13px] font-medium text-foreground">{entity.name}</span>
                  <span className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">
                    {entity.disposition === "merge_into" ? `→ merge into “${entity.mergeInto}”` : "→ keep as canonical"}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {verdict.verdict.notes.length > 0 ? (
          <section>
            <SectionLabel>Notes</SectionLabel>
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[12.5px] text-muted-foreground">
              {verdict.verdict.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {verdict.dossier ? (
          <details className="rounded-md border border-border">
            <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              Dossier — the exact text the model was given · {verdict.dossier.length.toLocaleString()} characters
            </summary>
            <pre className="max-h-96 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {verdict.dossier}
            </pre>
          </details>
        ) : null}
      </div>

      <div className="sticky bottom-0 border-t border-border bg-background px-6 py-3">
        {error ? (
          <p className="mb-2 text-[12px] text-destructive">
            {error instanceof ApiRequestError ? `${error.code}: ${error.message}` : String(error)}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={accept.isPending || reject.isPending}
            onClick={() => reject.mutate()}
          >
            Reject
          </Button>
          <Button size="sm" disabled={!canAccept} onClick={() => accept.mutate()}>
            {accept.isPending ? "Accepting…" : `Accept as ${decision}`}
          </Button>
        </div>
        {blockedByFlags ? (
          <p className="mt-1.5 text-right text-[11px] text-muted-foreground">
            Tripwire flags must be overridden before accepting.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{children}</div>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-[12.5px]">
      <dt className="w-32 shrink-0 font-mono text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function Pick({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "rounded-full border px-2.5 py-0.5 font-mono text-[11px]",
        selected
          ? "border-foreground bg-foreground font-semibold text-background"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

const TONE_MARK: Record<GateLine["tone"], { mark: string; className: string }> = {
  add: { mark: "+", className: "text-foreground" },
  drop: { mark: "−", className: "text-muted-foreground" },
  warn: { mark: "!", className: "text-amber-700 dark:text-amber-400" },
  declare: { mark: "✓", className: "text-foreground" },
};

function ConsequenceRow({ line }: { line: GateLine }) {
  const tone = TONE_MARK[line.tone];
  return (
    <li className={cn("flex gap-2 text-[12.5px]", tone.className)}>
      <span className="w-3 shrink-0 font-mono">{tone.mark}</span>
      <span>{line.text}</span>
    </li>
  );
}

function axisText(kind: CounterpartyKind, stage: ClientStage | null): string {
  return kindCarriesStage(kind) && stage ? `${kind} · ${stage}` : kind;
}

function evidenceSummary(project: {
  evidenceTitleFamilies: string[];
  evidenceRepos: string[];
  evidencePeople: string[];
}) {
  const parts = [
    project.evidenceTitleFamilies.length > 0 ? `${project.evidenceTitleFamilies.length} title families` : null,
    project.evidenceRepos.length > 0 ? `${project.evidenceRepos.length} repos` : null,
    project.evidencePeople.length > 0 ? `${project.evidencePeople.length} people` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "no evidence anchors";
}
