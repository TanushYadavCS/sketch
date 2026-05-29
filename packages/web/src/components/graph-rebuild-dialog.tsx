/**
 * GraphRebuildDialog — two-step entity-graph rebuild flow.
 *
 * Step 1 ("What do you want to delete?"): instantaneous category purge.
 * Submits POST /api/entities/resets with runAfter:false. The server holds a
 * pending recreate lock so sync/enrichment can't slip in between steps.
 *
 * Step 2 ("Now rebuild how?"): long-running. Either replay existing facts
 * (POST /api/entities/rebuilds) or re-extract LLM facts and then replay
 * (POST /api/entities/reenrichments with the pendingRebuildId from step 1).
 *
 * The dialog stays mounted (and modal) for the entire flow — including the
 * long-running step-2 phase — so the operator can't drive the rest of the
 * UI into a half-rebuilt graph. A persistent progress bar polls the running
 * job. The dialog only releases when the job reaches a terminal state.
 *
 * Replaces the prior `RebuildDialog` which conflated destructive scope with
 * generative method in a single pane. That conflation silently dropped
 * categories when method=reextract — the regression that motivated this
 * redesign.
 */
import type { ReenrichScope, ResetCategory, ResetSubmitResponse } from "@/lib/api";
import { ApiRequestError, api } from "@/lib/api";
import { ArrowsClockwiseIcon, CheckCircleIcon, SparkleIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { Button } from "@sketch/ui/components/button";
import { Progress } from "@sketch/ui/components/progress";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const REBUILD_CATEGORIES: ResetCategory[] = ["connectors", "ai"];
const RESET_POLL_INTERVAL_MS = 300;
const STEP2_POLL_INTERVAL_MS = 1500;

export interface GraphRebuildDialogPrefill {
  /** Pre-check the "Re-extract" method on step 2. Used by the banner Retry button. */
  preferReextract?: boolean;
}

type Step = "step1" | "step1-running" | "step2" | "step2-running" | "step2-done" | "step2-failed";
type Method = "replay" | "reextract";
type Step2JobKind = "rebuild" | "reenrich";

interface GraphRebuildDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
  prefill?: GraphRebuildDialogPrefill | null;
}

export function GraphRebuildDialog({ open, onOpenChange, onSubmitted, prefill }: GraphRebuildDialogProps) {
  const [step, setStep] = useState<Step>("step1");
  const [wipeLlmFacts, setWipeLlmFacts] = useState(false);
  const [method, setMethod] = useState<Method>("replay");
  const [pendingRebuildId, setPendingRebuildId] = useState<string | null>(null);
  const [resetJobId, setResetJobId] = useState<string | null>(null);
  const [resetDeletedCounts, setResetDeletedCounts] = useState<Record<string, number> | null>(null);
  const [factsWipedCount, setFactsWipedCount] = useState<number | null>(null);
  const [step2JobId, setStep2JobId] = useState<string | null>(null);
  const [step2JobKind, setStep2JobKind] = useState<Step2JobKind | null>(null);
  const [step2Progress, setStep2Progress] = useState<{
    phase: string;
    completed: number;
    total: number;
  } | null>(null);
  const [step2FinalSummary, setStep2FinalSummary] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset all state when the dialog re-opens.
  useEffect(() => {
    if (open) return;
    setStep("step1");
    setWipeLlmFacts(false);
    setMethod("replay");
    setPendingRebuildId(null);
    setResetJobId(null);
    setResetDeletedCounts(null);
    setFactsWipedCount(null);
    setStep2JobId(null);
    setStep2JobKind(null);
    setStep2Progress(null);
    setStep2FinalSummary(null);
    setErrorMessage(null);
  }, [open]);

  // Banner retry: jump straight into step 2 with re-extract pre-selected.
  // The pending lock is acquired at step 1 submit; the prefill only biases
  // the radio default once we reach step 2.
  useEffect(() => {
    if (!open) return;
    if (prefill?.preferReextract) {
      setWipeLlmFacts(true);
      setMethod("reextract");
    }
  }, [open, prefill]);

  // ── Step 1 — submit a reset job, poll until done, transition to step 2 ──
  const resetMutation = useMutation({
    mutationFn: (): Promise<ResetSubmitResponse> =>
      api.entities.reset(REBUILD_CATEGORIES, {
        runAfter: false,
        confirm: "RESET_AND_RECREATE",
        wipeLlmFacts,
      }),
    onSuccess: (res) => {
      const id = res.pendingRebuildId ?? res.job?.pendingRebuildId ?? null;
      const jobId = res.job?.id ?? null;
      if (!id || !jobId) {
        setErrorMessage("Server did not return a pendingRebuildId");
        setStep("step1");
        return;
      }
      setPendingRebuildId(id);
      setResetJobId(jobId);
      setStep("step1-running");
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
      setStep("step1");
    },
  });

  // Poll the reset job. Sub-second in practice; once it reaches `done`,
  // capture the deleted counts and advance the pane.
  useQuery({
    queryKey: ["graph-rebuild-dialog", "reset-job", resetJobId],
    queryFn: async () => {
      if (!resetJobId) return null;
      const job = await api.entities.resetJob(resetJobId);
      if (job.phase === "done") {
        setResetDeletedCounts(job.reset?.deleted ?? null);
        setFactsWipedCount(job.llmFactsWiped?.factsTombstoned ?? null);
        setStep("step2");
      } else if (job.phase === "failed") {
        setErrorMessage(job.error ?? "Reset failed");
        setStep("step1");
        setPendingRebuildId(null);
        setResetJobId(null);
      }
      return job;
    },
    enabled: step === "step1-running" && !!resetJobId,
    refetchInterval: step === "step1-running" ? RESET_POLL_INTERVAL_MS : false,
  });

  // ── Step 2 — submit the long-running rebuild (replay or re-extract) ─────
  // On success we do NOT close the dialog. We capture the job id and kind,
  // transition to the running pane, and let the polling query below take
  // over. The dialog remains modal until the job reaches a terminal state.
  const submitRebuildMutation = useMutation({
    mutationFn: async () => {
      if (!pendingRebuildId) throw new Error("Missing pendingRebuildId");
      if (method === "reextract") {
        const scope: ReenrichScope = { all: true };
        const res = await api.entities.reenrich(scope, {
          runAfter: true,
          confirm: "REENRICH",
          pendingRebuildId,
        });
        return { kind: "reenrich" as const, jobId: res.job?.id ?? null };
      }
      const res = await api.entities.rebuild(pendingRebuildId);
      return { kind: "rebuild" as const, jobId: res.job.id };
    },
    onSuccess: (res) => {
      if (!res.jobId) {
        setErrorMessage("Server did not return a job id");
        setStep("step2");
        return;
      }
      setStep2JobKind(res.kind);
      setStep2JobId(res.jobId);
      setStep("step2-running");
      // Let the banner pick this up too so it stays in sync if the dialog
      // is later dismissed.
      onSubmitted();
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
      setStep("step2");
    },
  });

  // Persistent poll of the step-2 job. Updates the progress bar and waits
  // for the terminal phase before unblocking the dialog.
  useQuery({
    queryKey: ["graph-rebuild-dialog", "step2-job", step2JobKind, step2JobId],
    queryFn: async () => {
      if (!step2JobId || !step2JobKind) return null;
      const job =
        step2JobKind === "rebuild"
          ? await api.entities.rebuildJob(step2JobId)
          : await api.entities.reenrichJob(step2JobId);
      if (job.progress) {
        setStep2Progress({ phase: job.progress.phase, completed: job.progress.completed, total: job.progress.total });
      }
      if (job.phase === "done") {
        const replay = job.replay ?? job.summary?.recreate?.replay ?? null;
        if (replay) {
          setStep2FinalSummary(
            `${replay.entitiesCreated} entities created · ${replay.entitiesLinked ?? 0} linked · ${replay.relationshipsWritten} edges written`,
          );
        } else {
          setStep2FinalSummary("Rebuild complete.");
        }
        setStep("step2-done");
      } else if (job.phase === "failed") {
        setErrorMessage(job.error ?? "Rebuild failed");
        setStep("step2-failed");
      }
      return job;
    },
    enabled: step === "step2-running" && !!step2JobId,
    refetchInterval: step === "step2-running" ? STEP2_POLL_INTERVAL_MS : false,
  });

  // Cancel on step 2 (before submit) releases the pending lock so
  // sync/enrichment can resume. Not available once the rebuild has started.
  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!pendingRebuildId) return;
      try {
        await api.entities.cancelPendingRebuild(pendingRebuildId);
      } catch (err) {
        // 404 means the lock already expired — treat as success from the
        // UI's perspective. 409 means the server somehow promoted it;
        // bubble that up so we don't silently mask a state mismatch.
        if (err instanceof ApiRequestError && err.status === 404) return;
        throw err;
      }
    },
    onSuccess: () => {
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  const reextractEnabled = wipeLlmFacts;
  const submitting = submitRebuildMutation.isPending || cancelMutation.isPending;
  const isRunning = step === "step1-running" || step === "step2-running";

  const deletedSummary = useMemo(() => summarizeDeleted(resetDeletedCounts), [resetDeletedCounts]);
  const step2ProgressValue = useMemo(() => {
    if (!step2Progress || step2Progress.total <= 0) return null;
    return Math.min(100, Math.round((step2Progress.completed / step2Progress.total) * 100));
  }, [step2Progress]);

  function handleDialogChange(next: boolean) {
    if (!next && (isRunning || submitting)) {
      // Don't allow Esc/outside-click to close while a job is in flight.
      // The dialog is the operator's guarantee that the rest of the UI
      // isn't drivable mid-rebuild.
      return;
    }
    // If the user dismisses on step 2 (clean close without explicit Cancel
    // press), best-effort release the pending lock.
    if (!next && step === "step2" && pendingRebuildId) {
      cancelMutation.mutate();
      return;
    }
    onOpenChange(next);
  }

  const title = (() => {
    if (step === "step1" || step === "step1-running") return "Rebuild graph — step 1 of 2";
    if (step === "step2-done") return "Rebuild graph — done";
    if (step === "step2-failed") return "Rebuild graph — failed";
    return "Rebuild graph — step 2 of 2";
  })();

  const description = (() => {
    if (step === "step1") return "What do you want to delete? Step 1 is instant.";
    if (step === "step1-running") return "Wiping the entity graph…";
    if (step === "step2") return "Now rebuild how? Step 2 is long-running.";
    if (step === "step2-running") return "Rebuilding the graph. Don't navigate away.";
    if (step === "step2-done") return "Rebuild finished successfully.";
    return "Rebuild failed. Review the error and decide whether to retry.";
  })();

  return (
    <AlertDialog open={open} onOpenChange={handleDialogChange}>
      <AlertDialogContent className="sm:max-w-md" data-testid="graph-rebuild-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="relative min-h-[200px]">
          <Pane visible={step === "step1" || step === "step1-running"} testId="graph-rebuild-step-1">
            <section className="space-y-2 py-1">
              <CheckboxOption
                checked
                disabled
                title="Entities, mentions, edges"
                description="The full graph is rebuilt from facts in step 2. Always required."
              />
              <CheckboxOption
                checked={wipeLlmFacts}
                onChange={() => setWipeLlmFacts((v) => !v)}
                disabled={step === "step1-running"}
                testId="graph-rebuild-wipe-llm"
                title="LLM-extracted facts"
                description="Also tombstone llm_extracted / llm_relation facts and clear their relation evidence. Required if you want step 2 to re-extract via LLM."
              />
              {step === "step1-running" ? (
                <div className="space-y-2 pt-2" data-testid="graph-rebuild-step1-running">
                  <Progress value={null} className="h-1 animate-pulse" />
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ArrowsClockwiseIcon size={12} className="animate-spin" />
                    Wiping entities, mentions, and edges…
                  </p>
                </div>
              ) : null}
            </section>
          </Pane>

          <Pane visible={step === "step2"} testId="graph-rebuild-step-2">
            <section className="space-y-3 py-1">
              {deletedSummary.length > 0 ? (
                <dl
                  className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
                  data-testid="graph-rebuild-step1-result"
                >
                  <dt className="text-muted-foreground">Step 1 deleted</dt>
                  <dd>{deletedSummary.join(", ")}</dd>
                  {factsWipedCount !== null && factsWipedCount > 0 ? (
                    <>
                      <dt className="text-muted-foreground">LLM facts tombstoned</dt>
                      <dd>{factsWipedCount}</dd>
                    </>
                  ) : null}
                </dl>
              ) : null}

              <fieldset className="space-y-2">
                <legend className="sr-only">Rebuild method</legend>
                <RadioOption
                  name="graph-rebuild-method"
                  value="replay"
                  checked={method === "replay"}
                  onChange={() => setMethod("replay")}
                  testId="graph-rebuild-method-replay"
                  title="Replay existing facts → graph"
                  description="Recreate the entity graph from facts already on disk. No LLM calls. Typical: 10–30 min."
                />
                <RadioOption
                  name="graph-rebuild-method"
                  value="reextract"
                  checked={method === "reextract"}
                  onChange={() => setMethod("reextract")}
                  disabled={!reextractEnabled}
                  testId="graph-rebuild-method-reextract"
                  icon={<SparkleIcon size={12} className="text-violet-500" />}
                  title="Re-extract LLM facts, then replay"
                  description={
                    reextractEnabled ? (
                      <>
                        Wipe document chunks/embeddings, re-run LLM extraction across every file, then rebuild.
                        <span className="ml-1 inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                          <WarningIcon size={11} /> Costs Gemini API calls. Hours.
                        </span>
                      </>
                    ) : (
                      <>
                        LLM facts are already on disk — replay will use them. To get fresh extraction, re-open step 1
                        and check "LLM-extracted facts".
                      </>
                    )
                  }
                />
              </fieldset>
            </section>
          </Pane>

          <Pane visible={step === "step2-running"} testId="graph-rebuild-step-2-running">
            <section className="space-y-4 py-1">
              {deletedSummary.length > 0 ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                  <dt className="text-muted-foreground">Step 1 deleted</dt>
                  <dd>{deletedSummary.join(", ")}</dd>
                </dl>
              ) : null}

              <div className="space-y-2" data-testid="graph-rebuild-step2-progress">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2 font-medium">
                    <ArrowsClockwiseIcon size={12} className="animate-spin text-blue-600 dark:text-blue-300" />
                    {step2JobKind === "reenrich" ? "Re-extracting & rebuilding" : "Rebuilding graph"}
                  </span>
                  <span className="text-muted-foreground">
                    {step2ProgressValue !== null ? `${step2ProgressValue}%` : "Working…"}
                  </span>
                </div>
                <Progress
                  value={step2ProgressValue ?? null}
                  className={step2ProgressValue === null ? "h-2 animate-pulse" : "h-2"}
                />
                {step2Progress ? (
                  <p className="text-[11px] text-muted-foreground">
                    Phase: {step2Progress.phase}
                    {step2Progress.total > 0 ? ` · ${step2Progress.completed} / ${step2Progress.total}` : ""}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">Job queued; waiting for first progress report…</p>
                )}
              </div>

              <p className="rounded-md border border-amber-300 bg-amber-50/50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                Keep this dialog open. The rest of the page is locked while the graph rebuilds so partial data doesn't
                leak into the UI.
              </p>
            </section>
          </Pane>

          <Pane visible={step === "step2-done"} testId="graph-rebuild-step-2-done">
            <section className="space-y-3 py-1">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircleIcon size={16} weight="fill" />
                Graph rebuilt
              </div>
              {step2FinalSummary ? (
                <p className="rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
                  {step2FinalSummary}
                </p>
              ) : null}
            </section>
          </Pane>

          <Pane visible={step === "step2-failed"} testId="graph-rebuild-step-2-failed">
            <section className="space-y-3 py-1">
              <p className="text-sm font-medium text-destructive">Rebuild failed.</p>
              <p className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-xs text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
                {errorMessage ?? "Unknown error"}
              </p>
            </section>
          </Pane>
        </div>

        {errorMessage && step !== "step2-failed" ? (
          <p className="text-xs text-destructive" data-testid="graph-rebuild-error">
            {errorMessage}
          </p>
        ) : null}

        <AlertDialogFooter>{renderFooter()}</AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  function renderFooter(): React.ReactNode {
    if (step === "step1" || step === "step1-running") {
      return (
        <>
          <AlertDialogCancel disabled={resetMutation.isPending || step === "step1-running"}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending || step === "step1-running"}
            data-testid="graph-rebuild-step1-submit"
          >
            <TrashIcon size={14} />
            {resetMutation.isPending || step === "step1-running" ? "Wiping…" : "Delete"}
          </Button>
        </>
      );
    }
    if (step === "step2") {
      return (
        <>
          <Button
            variant="outline"
            onClick={() => cancelMutation.mutate()}
            disabled={submitting}
            data-testid="graph-rebuild-step2-cancel"
          >
            Cancel rebuild
          </Button>
          <Button
            onClick={() => submitRebuildMutation.mutate()}
            disabled={submitting || (method === "reextract" && !reextractEnabled)}
            data-testid="graph-rebuild-step2-submit"
          >
            {submitting ? "Starting…" : method === "replay" ? "Rebuild" : "Re-extract & rebuild"}
          </Button>
        </>
      );
    }
    if (step === "step2-running") {
      // No actionable buttons: the operator should not be able to drive
      // anything while the rebuild is in flight. The progress pane is the
      // only feedback surface.
      return (
        <Button disabled data-testid="graph-rebuild-step2-running-button">
          Working — please wait…
        </Button>
      );
    }
    if (step === "step2-done") {
      return (
        <Button onClick={() => onOpenChange(false)} data-testid="graph-rebuild-step2-close">
          Close
        </Button>
      );
    }
    // step2-failed
    return (
      <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="graph-rebuild-step2-failed-close">
        Close
      </Button>
    );
  }
}

function Pane({ visible, children, testId }: { visible: boolean; children: React.ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      aria-hidden={!visible}
      className={`absolute inset-0 transition-opacity duration-150 ${
        visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

interface CheckboxOptionProps {
  checked: boolean;
  onChange?: () => void;
  disabled?: boolean;
  title: string;
  description: React.ReactNode;
  icon?: React.ReactNode;
  testId?: string;
}

function CheckboxOption({ checked, onChange, disabled, title, description, icon, testId }: CheckboxOptionProps) {
  return (
    <label
      className={`flex items-start gap-3 rounded-md border px-3 py-2 ${
        disabled ? "cursor-default border-border bg-muted/30" : "cursor-pointer border-border hover:bg-muted/30"
      } ${checked && !disabled ? "border-foreground" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 rounded border-border"
        data-testid={testId}
      />
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {icon}
          {title}
        </p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </label>
  );
}

interface RadioOptionProps {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title: string;
  description: React.ReactNode;
  icon?: React.ReactNode;
  testId?: string;
}

function RadioOption({ name, value, checked, onChange, disabled, title, description, icon, testId }: RadioOptionProps) {
  return (
    <label
      className={`flex items-start gap-3 rounded-md border px-3 py-2 ${
        disabled
          ? "cursor-not-allowed border-border bg-muted/20 opacity-60"
          : "cursor-pointer border-border hover:bg-muted/30"
      } ${checked && !disabled ? "border-foreground" : ""}`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-1 h-4 w-4 border-border"
        data-testid={testId}
      />
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {icon}
          {title}
        </p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </label>
  );
}

const DELETED_LABELS: Record<string, string> = {
  entities: "entities",
  entity_mentions: "mentions",
  entity_relationships: "edges",
  entity_review_queue: "review rows",
};

function summarizeDeleted(deleted: Record<string, number> | null): string[] {
  if (!deleted) return [];
  return Object.entries(deleted)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v} ${DELETED_LABELS[k] ?? k}`);
}
