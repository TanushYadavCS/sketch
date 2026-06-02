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
 * Once step 2 starts, progress moves to the page-level rebuild banner so the
 * entity list remains browsable while work continues.
 *
 * Replaces the prior `RebuildDialog` which conflated destructive scope with
 * generative method in a single pane. That conflation silently dropped
 * categories when method=reextract — the regression that motivated this
 * redesign.
 */
import type { ReenrichScope, ResetCategory, ResetSubmitResponse } from "@/lib/api";
import { ApiRequestError, api } from "@/lib/api";
import { ArrowsClockwiseIcon, SparkleIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
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

const REBUILD_CATEGORIES: ResetCategory[] = ["connectors", "ai"];
const RESET_POLL_INTERVAL_MS = 300;

export interface GraphRebuildDialogPrefill {
  /** Pre-check the "Re-extract" method on step 2. Used by the banner Retry button. */
  preferReextract?: boolean;
}

type Step = "step1" | "step1-running" | "step2";
type Method = "replay" | "reextract";

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
        if (!res.job?.id) throw new Error("Server did not return a job id");
        return;
      }
      const res = await api.entities.rebuild(pendingRebuildId);
      if (!res.job.id) throw new Error("Server did not return a job id");
    },
    onSuccess: () => {
      onSubmitted();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
      setStep("step2");
    },
  });

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
      onSubmitted();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  const reextractEnabled = wipeLlmFacts;
  const submitting = submitRebuildMutation.isPending || cancelMutation.isPending;
  const isRunning = step === "step1-running";

  const deletedSummary = useMemo(() => summarizeDeleted(resetDeletedCounts), [resetDeletedCounts]);

  function handleDialogChange(next: boolean) {
    if (!next && (isRunning || submitting)) {
      return;
    }
    if (!next && step === "step2" && pendingRebuildId) {
      cancelMutation.mutate();
      return;
    }
    onOpenChange(next);
  }

  const title = (() => {
    if (step === "step1" || step === "step1-running") return "Rebuild graph — step 1 of 2";
    return "Rebuild graph — step 2 of 2";
  })();

  const description = (() => {
    if (step === "step1") return "What do you want to delete? Step 1 is instant.";
    if (step === "step1-running") return "Wiping the entity graph…";
    if (step === "step2") return "Now rebuild how? Step 2 is long-running.";
    return "";
  })();

  return (
    <AlertDialog open={open} onOpenChange={handleDialogChange}>
      <AlertDialogContent className="sm:max-w-md" data-testid="graph-rebuild-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        <div>
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
                  <dd className="min-w-0 break-words">{deletedSummary.join(", ")}</dd>
                  {factsWipedCount !== null && factsWipedCount > 0 ? (
                    <>
                      <dt className="text-muted-foreground">LLM facts tombstoned</dt>
                      <dd className="min-w-0 break-words">{factsWipedCount}</dd>
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
        </div>

        {errorMessage ? (
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
            Done
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
    return null;
  }
}

function Pane({ visible, children, testId }: { visible: boolean; children: React.ReactNode; testId: string }) {
  return (
    <div data-testid={testId} aria-hidden={!visible} className={visible ? "block" : "hidden"}>
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
