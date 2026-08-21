import { EntryList, SectionLabel, SourceTag } from "@/components/entity-drawer/drawer-kit";
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
 *
 * Renames and moves are keyed by the project's ORIGINAL verdict name
 * throughout; the server applies renames only at write time, so the two never
 * interact. Every tree computation here (ordering, strike cascade, move
 * targets) runs on the EFFECTIVE forest — verdict parents with the reviewer's
 * moves overlaid — mirroring the server's validation exactly.
 */
import {
  type ClientStage,
  type CounterpartyKind,
  type ProjectMintingAcceptance,
  type ProjectMintingVerdict,
  api,
} from "@/lib/api";
import { ApiRequestError } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const KINDS: CounterpartyKind[] = ["client", "partner", "vendor", "investor", "other"];
const STAGES: ClientStage[] = ["prospect", "pilot", "active", "dormant", "ended"];

const STAGE_KINDS: ReadonlySet<CounterpartyKind> = new Set(["client", "partner"]);

function kindCarriesStage(kind: CounterpartyKind): boolean {
  return STAGE_KINDS.has(kind);
}

type GateLineTone = "add" | "drop" | "warn" | "declare";

/**
 * Create-lines shown before the box collapses behind "Show N more". Small
 * dossiers (Habuild's 3) render in full; a 27-project OW dossier shows 5
 * plus the toggle, so the unique consequence lines stay above the fold.
 */
const PREVIEW_CREATE_CAP = 5;

interface GateLine {
  tone: GateLineTone;
  text: string;
  /** Per-entity create lines collapse behind "Show more" past a cap; consequence lines never do. */
  collapsible?: boolean;
}

export type MintingSheetVariant = "dev" | "org";

export function MintingVerdictSheet({
  verdictId,
  onClose,
  onDecided,
  variant = "dev",
}: {
  verdictId: string | null;
  onClose: () => void;
  onDecided: (accepted: ProjectMintingAcceptance | null) => void;
  variant?: MintingSheetVariant;
}) {
  return (
    <Sheet open={!!verdictId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-[800px]">
        <SheetTitle className="sr-only">Project minting verdict</SheetTitle>
        <SheetDescription className="sr-only">
          Confirm what this counterparty is, then accept or reject what the pass proposed.
        </SheetDescription>
        {verdictId ? (
          <SheetBody verdictId={verdictId} onClose={onClose} onDecided={onDecided} variant={variant} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

type VerdictProject = ProjectMintingVerdict["verdict"]["projects"][number];

function SheetBody({
  verdictId,
  onClose,
  onDecided,
  variant,
}: {
  verdictId: string;
  onClose: () => void;
  onDecided: (accepted: ProjectMintingAcceptance | null) => void;
  variant: MintingSheetVariant;
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
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [reparents, setReparents] = useState<Record<string, string | null>>({});
  const [override, setOverride] = useState(false);
  const [draggedName, setDraggedName] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [filesFor, setFilesFor] = useState<string | null>(null);
  const [showAllPreviewLines, setShowAllPreviewLines] = useState(false);

  /** Seed the picker from the nomination once the verdict lands. */
  useEffect(() => {
    if (!verdict) return;
    setKind(verdict.verdict.counterpartyKind);
    setStage(verdict.verdict.clientStage);
    setShowAllPreviewLines(false);
  }, [verdict]);

  const settle = (accepted: ProjectMintingAcceptance | null) => {
    queryClient.invalidateQueries({ queryKey: ["project-minting"] });
    queryClient.invalidateQueries({ queryKey: ["entities"] });
    queryClient.invalidateQueries({ queryKey: ["entity-review"] });
    onDecided(accepted);
    onClose();
  };

  const projects = verdict?.verdict.projects ?? [];
  const verdictParentByName = new Map(projects.map((project) => [project.name, project.parentName ?? null]));
  const projectNames = new Set(projects.map((project) => project.name));

  const effectiveParentOf = (name: string): string | null => {
    const overlaid = Object.hasOwn(reparents, name) ? reparents[name] : (verdictParentByName.get(name) ?? null);
    return overlaid && projectNames.has(overlaid) ? overlaid : null;
  };

  const effectiveProjects: VerdictProject[] = projects.map((project) => ({
    ...project,
    parentName: effectiveParentOf(project.name),
  }));

  const descendantsOf = (root: string): Set<string> => {
    const out = new Set<string>();
    const walk = (parent: string) => {
      for (const project of effectiveProjects) {
        if (project.parentName === parent && !out.has(project.name)) {
          out.add(project.name);
          walk(project.name);
        }
      }
    };
    walk(root);
    return out;
  };

  /** Explicit strikes plus every effective descendant — what the server will actually be told. */
  const effectiveStruck = new Set<string>();
  for (const name of struck) {
    if (!projectNames.has(name)) continue;
    effectiveStruck.add(name);
    for (const descendant of descendantsOf(name)) effectiveStruck.add(descendant);
  }

  const mergeTargets = new Set(
    (verdict?.verdict.existingEntities ?? [])
      .filter((entity) => entity.disposition === "merge_into" && entity.mergeInto)
      .map((entity) => entity.mergeInto as string),
  );

  const renamePayload: Record<string, string> = {};
  for (const [name, value] of Object.entries(renames)) {
    const trimmed = value.trim();
    if (trimmed && trimmed !== name && projectNames.has(name)) renamePayload[name] = trimmed;
  }
  const reparentPayload: Record<string, string | null> = {};
  for (const [name, target] of Object.entries(reparents)) {
    if (!projectNames.has(name)) continue;
    if ((verdictParentByName.get(name) ?? null) !== target) reparentPayload[name] = target;
  }

  const acceptBody = (dryRun: boolean) => {
    if (!kind) throw new Error("Pick what this counterparty is");
    return {
      confirmedCounterpartyKind: kind,
      ...(kindCarriesStage(kind) && stage ? { confirmedClientStage: stage } : {}),
      ...(effectiveStruck.size > 0 ? { struckProjectNames: [...effectiveStruck] } : {}),
      ...(Object.keys(renamePayload).length > 0 ? { renameMap: renamePayload } : {}),
      ...(Object.keys(reparentPayload).length > 0 ? { reparentMap: reparentPayload } : {}),
      ...(dryRun ? { overrideTripwireFlags: true, dryRun: true } : override ? { overrideTripwireFlags: true } : {}),
    };
  };

  const accept = useMutation({
    mutationFn: () => api.projectMinting.accept(verdictId, acceptBody(false)),
    onSuccess: (result) => settle(result.acceptance),
  });
  const reject = useMutation({
    mutationFn: () => api.projectMinting.reject(verdictId),
    onSuccess: () => settle(null),
  });

  /**
   * The server computes what accepting will do, with zero writes. This
   * replaced a client-side mirror of the accept gate that could drift; the
   * tripwire override is always sent because the flags are surfaced (and
   * gated) separately above — the preview should show the plan behind them.
   */
  const stageMissing = !!kind && kindCarriesStage(kind) && !stage;
  const editKey = JSON.stringify([[...effectiveStruck].sort(), renamePayload, reparentPayload]);
  const dryRun = useQuery({
    queryKey: ["project-minting", "dry-run", verdictId, kind, stage, editKey],
    enabled: !!kind && !stageMissing,
    retry: false,
    queryFn: () => api.projectMinting.accept(verdictId, acceptBody(true)),
  });

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
  const blockedByStage = carriesStage && !stage;
  const blockedByFlags = verdict.flags.length > 0 && !override;
  const previewBlocked =
    dryRun.error instanceof ApiRequestError ? dryRun.error.message : dryRun.error ? String(dryRun.error) : null;
  const displayName = (originalName: string) => renamePayload[originalName] ?? originalName;
  const previewLines = dryRun.data
    ? dryRunLines(verdict, dryRun.data.acceptance, kind, carriesStage ? stage : null, {
        effectiveParentOf,
        displayName,
      })
    : [];
  const createLines = previewLines.filter((line) => line.collapsible);
  const consequenceLines = previewLines.filter((line) => !line.collapsible);
  const visibleCreateLines = showAllPreviewLines ? createLines : createLines.slice(0, PREVIEW_CREATE_CAP);
  const hiddenCreateCount = createLines.length - visibleCreateLines.length;
  const canAccept =
    !previewBlocked && !!dryRun.data && !blockedByStage && !blockedByFlags && !accept.isPending && !reject.isPending;
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

  /** Dry-run claim per ORIGINAL project name — entities come back under display names. */
  const claimByOriginal = new Map(
    (dryRun.data?.acceptance.entities ?? [])
      .filter((entity) => entity.kind === "project")
      .map((entity) => [originalNameByDisplay(projects, renamePayload, entity.name), entity] as const)
      .filter((pair): pair is [string, (typeof pair)[1]] => pair[0] !== null),
  );

  const isValidDropTarget = (target: string): boolean => {
    if (!draggedName || target === draggedName) return false;
    if (effectiveStruck.has(target)) return false;
    return !descendantsOf(draggedName).has(target);
  };

  const dropOn = (target: string | null) => {
    if (!draggedName) return;
    if (target !== null && !isValidDropTarget(target)) return;
    if (effectiveParentOf(draggedName) !== target) {
      setReparents((current) => ({ ...current, [draggedName]: target }));
    }
    setDraggedName(null);
    setDropTarget(null);
  };

  const filesPanelProject = filesFor ? claimByOriginal.get(filesFor) : undefined;

  return (
    <div className="relative flex min-h-full flex-col">
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
          <p className="mt-2 text-[12.5px] text-muted-foreground">
            Model nominates{" "}
            <span className="text-foreground">
              {axisText(verdict.verdict.counterpartyKind, verdict.verdict.clientStage)}
            </span>{" "}
            — registry{" "}
            {verdict.declaredCounterpartyKind ? (
              <>
                says{" "}
                <span className="text-foreground">
                  {axisText(verdict.declaredCounterpartyKind, verdict.declaredClientStage)}
                </span>
              </>
            ) : (
              <span className="italic">undeclared</span>
            )}
          </p>

          <div className="mt-3">
            <div className="flex flex-wrap gap-1.5">
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
          {blockedByStage ? (
            <p className="mt-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
              Pick a stage to see what this will do.
            </p>
          ) : previewBlocked ? (
            <p className="mt-2 rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2.5 text-[12.5px] text-destructive">
              {previewBlocked}
            </p>
          ) : dryRun.data ? (
            <ul className="mt-2 space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2.5">
              {visibleCreateLines.map((line) => (
                <ConsequenceRow key={line.text} line={line} />
              ))}
              {hiddenCreateCount > 0 || showAllPreviewLines ? (
                <li>
                  <button
                    type="button"
                    onClick={() => setShowAllPreviewLines((value) => !value)}
                    className="ml-5 text-[11px] text-primary hover:underline"
                  >
                    {showAllPreviewLines ? "Show less" : `Show ${hiddenCreateCount} more`}
                  </button>
                </li>
              ) : null}
              {consequenceLines.map((line) => (
                <ConsequenceRow key={line.text} line={line} />
              ))}
            </ul>
          ) : (
            <p className="mt-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
              Computing…
            </p>
          )}
        </section>

        {projects.length > 0 ? (
          <section>
            <div className="flex items-baseline justify-between">
              <SectionLabel>Proposed projects · {projects.length}</SectionLabel>
              <span className="font-mono text-[10px] text-muted-foreground">untick to strike · drag to nest</span>
            </div>
            <div className="mt-2 divide-y divide-border/60 rounded-md border border-border">
              {draggedName && effectiveParentOf(draggedName) !== null ? (
                <div
                  data-testid="minting-drop-top-level"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => dropOn(null)}
                  className="border-b border-dashed border-border px-3 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground"
                >
                  drop here for top level
                </div>
              ) : null}
              {treeOrder(effectiveProjects).map(({ project, depth }) => {
                const name = project.name;
                const isStruck = effectiveStruck.has(name);
                const struckViaAncestor = isStruck && !struck.has(name);
                const isMergeTarget = mergeTargets.has(name);
                const claim = claimByOriginal.get(name);
                const draggable = !isStruck && projects.length > 1;
                return (
                  <div
                    key={name}
                    data-testid={`minting-project-${name}`}
                    draggable={draggable}
                    onDragStart={(e) => {
                      setDraggedName(name);
                      e.dataTransfer?.setData("text/plain", name);
                    }}
                    onDragEnd={() => {
                      setDraggedName(null);
                      setDropTarget(null);
                    }}
                    onDragOver={(e) => {
                      if (!isValidDropTarget(name)) return;
                      e.preventDefault();
                      setDropTarget(name);
                    }}
                    onDragLeave={() => setDropTarget((current) => (current === name ? null : current))}
                    onDrop={() => dropOn(name)}
                    className={cn(
                      "px-3 py-2",
                      draggedName === name && "opacity-50",
                      dropTarget === name && "bg-muted/60",
                    )}
                    style={{ paddingLeft: 12 + depth * 20 }}
                  >
                    <div className="flex items-center gap-2.5">
                      {draggable ? (
                        <span aria-hidden className="cursor-grab select-none text-[13px] text-muted-foreground/70">
                          ⠿
                        </span>
                      ) : null}
                      <input
                        type="checkbox"
                        checked={!isStruck}
                        disabled={struckViaAncestor || isMergeTarget}
                        aria-label={`keep ${name}`}
                        onChange={() => toggleStrike(name)}
                      />
                      {isStruck ? (
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground line-through opacity-60">
                          {name}
                        </span>
                      ) : (
                        <input
                          type="text"
                          value={renames[name] ?? name}
                          aria-label={`name for ${name}`}
                          onChange={(e) => setRenames((current) => ({ ...current, [name]: e.target.value }))}
                          className="h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-[13px] font-medium text-foreground hover:border-border focus:border-border focus:outline-none"
                        />
                      )}
                      {!isStruck && claim ? (
                        <button
                          type="button"
                          aria-label={`files for ${name}`}
                          onClick={() => setFilesFor(name)}
                          disabled={claim.fileIds.length === 0}
                          className={cn(
                            "shrink-0 font-mono text-[10.5px] tabular-nums",
                            claim.fileIds.length === 0
                              ? "text-muted-foreground/60"
                              : "text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground",
                          )}
                        >
                          {claim.fileIds.length} {claim.fileIds.length === 1 ? "file" : "files"}
                        </button>
                      ) : null}
                      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                        {project.status} · {project.confidence}
                      </span>
                    </div>
                    {isMergeTarget ? (
                      <span className="mt-0.5 block pl-6 text-[11px] text-muted-foreground">
                        Merge target for an existing entity — can't be struck.
                      </span>
                    ) : null}
                    {struckViaAncestor ? (
                      <span className="mt-0.5 block pl-6 text-[11px] text-muted-foreground">
                        Struck with its parent.
                      </span>
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

        {variant === "dev" && verdict.dossier ? (
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

      {filesFor && filesPanelProject ? (
        <div className="absolute inset-0 z-10 flex flex-col bg-background" data-testid="minting-files-panel">
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <div>
              <h3 className="text-[15px] font-semibold text-foreground">{filesPanelProject.name}</h3>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {filesPanelProject.fileIds.length} {filesPanelProject.fileIds.length === 1 ? "file" : "files"} this
                accept will attach
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setFilesFor(null)}>
              Back
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <EntryList>
              {(filesPanelProject.files ?? []).map((file) => (
                <li key={file.id} className="flex items-center gap-2 px-3 py-2">
                  <SourceTag>{file.source}</SourceTag>
                  <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
                  <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
                    {file.date ? file.date.slice(0, 10) : "—"}
                  </span>
                </li>
              ))}
            </EntryList>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Dry-run entities come back under their DISPLAY names (renames applied).
 * Recover the original verdict name so claims key the same way every other
 * per-project structure in this sheet does.
 */
function originalNameByDisplay(
  projects: VerdictProject[],
  renamePayload: Record<string, string>,
  entityDisplayName: string,
): string | null {
  for (const project of projects) {
    if ((renamePayload[project.name] ?? project.name) === entityDisplayName) return project.name;
  }
  return null;
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

/**
 * Verdict projects in parents-before-children order with their nesting
 * depth. v1 verdicts carry no parentName, so every project sits at depth 0
 * in its original order. A parentName pointing outside the verdict (or a
 * malformed cycle) renders at top level rather than disappearing. Callers
 * pass projects with EFFECTIVE parents already overlaid.
 */
function treeOrder(projects: VerdictProject[]): {
  project: VerdictProject;
  depth: number;
}[] {
  const names = new Set(projects.map((project) => project.name));
  const out: { project: VerdictProject; depth: number }[] = [];
  const placed = new Set<string>();
  const place = (parent: string | null, depth: number) => {
    if (depth > projects.length) return;
    for (const project of projects) {
      const projectParent = project.parentName && names.has(project.parentName) ? project.parentName : null;
      if (projectParent !== parent || placed.has(project.name)) continue;
      placed.add(project.name);
      out.push({ project, depth });
      place(project.name, depth + 1);
    }
  };
  place(null, 0);
  for (const project of projects) {
    if (!placed.has(project.name)) out.push({ project, depth: 0 });
  }
  return out;
}

/**
 * The consequence list, from the server's dry run. Names and counts come from
 * the computed acceptance. Parent labels come from the server's
 * parentOriginalName when present, else the reviewer's effective overlay —
 * never reconstructed by matching renamed entity names against the verdict.
 */
function dryRunLines(
  verdict: ProjectMintingVerdict,
  acceptance: ProjectMintingAcceptance,
  kind: CounterpartyKind,
  stage: ClientStage | null,
  labels: {
    effectiveParentOf: (name: string) => string | null;
    displayName: (originalName: string) => string;
  },
): GateLine[] {
  const lines: GateLine[] = [];
  const entities = acceptance.entities ?? [];
  const dropped = acceptance.droppedByGate ?? { engagement: null, projects: [], unmergedFragments: [] };
  const fragmentNameById = new Map(verdict.verdict.existingEntities.map((entity) => [entity.entityId, entity.name]));
  const originalByDisplay = new Map(
    verdict.verdict.projects.map((project) => [labels.displayName(project.name), project.name]),
  );

  if (entities.length === 0) {
    lines.push({ tone: "drop", text: "Nothing will be created, and nothing existing is touched" });
    if (dropped.engagement || dropped.projects.length > 0) {
      const discarded = [
        ...(dropped.engagement ? [`the container “${dropped.engagement}”`] : []),
        ...(dropped.projects.length > 0 ? [`${dropped.projects.length} proposed project(s)`] : []),
      ].join(" and ");
      lines.push({ tone: "drop", text: `The model proposed ${discarded}. All of it is discarded.` });
    }
  }
  for (const entity of entities) {
    const files = entity.fileIds.length > 0 ? ` — ${entity.fileIds.length} files` : "";
    if (entity.kind === "engagement") {
      lines.push({ tone: "add", text: `Create “${entity.name}” as the account container${files}`, collapsible: true });
    } else {
      const parentOriginal =
        entity.parentOriginalName !== undefined
          ? entity.parentOriginalName
          : labels.effectiveParentOf(originalByDisplay.get(entity.name) ?? entity.name);
      const parent = parentOriginal ? labels.displayName(parentOriginal) : null;
      lines.push({
        tone: "add",
        text: parent ? `Create “${entity.name}” under “${parent}”${files}` : `Create “${entity.name}”${files}`,
        collapsible: true,
      });
    }
  }
  if (entities.length > 0 && dropped.engagement) {
    lines.push({
      tone: "drop",
      text: `“${dropped.engagement}” will not be created — this stage carries no account container`,
    });
  }

  const requestedMerges = verdict.verdict.existingEntities.filter(
    (entity) => entity.disposition === "merge_into",
  ).length;
  const mergeCount = requestedMerges - dropped.unmergedFragments.length;
  if (mergeCount > 0) {
    lines.push({ tone: "add", text: `Merge ${mergeCount} existing fragment${mergeCount === 1 ? "" : "s"} into them` });
  }
  for (const fragment of dropped.unmergedFragments) {
    const name = fragmentNameById.get(fragment.entityId) ?? fragment.entityId;
    lines.push({
      tone: "warn",
      text: `“${name}” was to be merged into “${fragment.intoName}”, which will not exist. It stays a loose fragment.`,
    });
  }

  if (entities.length > 0) {
    lines.push(
      acceptance.residualTarget
        ? { tone: "add", text: `Files matching no project attach to “${acceptance.residualTarget}”` }
        : { tone: "warn", text: "Files matching no project will attach to nothing" },
    );
  }
  const unresolved = acceptance.unresolvedAnchors ?? [];
  if (unresolved.length > 0) {
    lines.push({
      tone: "warn",
      text: `${unresolved.length} anchor${unresolved.length === 1 ? "" : "s"} match nothing`,
    });
  }
  lines.push({ tone: "declare", text: `Declare ${verdict.companyName} as ${axisText(kind, stage)}` });
  return lines;
}
