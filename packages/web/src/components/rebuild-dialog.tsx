import type { ReenrichScope, ResetCategory } from "@/lib/api";
import { api } from "@/lib/api";
import { CheckIcon, SparkleIcon, WarningIcon } from "@phosphor-icons/react";
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
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const CATEGORIES: { key: ResetCategory; label: string; desc: string }[] = [
  {
    key: "connectors",
    label: "Connector entities",
    desc: "Spaces, folders, pages, databases from connected sources.",
  },
  {
    key: "ai",
    label: "AI-extracted entities",
    desc: "Companies, products, projects, teams found by enrichment.",
  },
  { key: "manual", label: "Manual entities", desc: "Created by hand." },
];

const STEPS = ["Categories", "Method", "Review"] as const;
type StepIdx = 0 | 1 | 2;

type Method = "replay" | "reextract";

export interface RebuildDialogPrefill {
  categories?: ResetCategory[];
  method?: Method;
  sources?: string[];
}

interface RebuildDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
  prefill?: RebuildDialogPrefill | null;
}

export function RebuildDialog({ open, onOpenChange, onSubmitted, prefill }: RebuildDialogProps) {
  const [step, setStep] = useState<StepIdx>(0);
  const [categories, setCategories] = useState<Set<ResetCategory>>(new Set(["connectors", "ai"]));
  const [method, setMethod] = useState<Method>("replay");
  const [selectedSources, setSelectedSources] = useState<Set<string> | null>(null);
  const [confirmExpensive, setConfirmExpensive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sourcesQuery = useQuery({
    queryKey: ["connectors", "file-counts-by-source"],
    queryFn: () => api.integrations.fileCountsBySource(),
    enabled: open && method === "reextract",
    staleTime: 30_000,
  });
  const availableSources = useMemo<Array<{ source: string; count: number }>>(
    () => sourcesQuery.data?.counts ?? [],
    [sourcesQuery.data],
  );

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setConfirmExpensive(false);
    setErrorMessage(null);
    if (prefill) {
      const nextMethod = prefill.method ?? "replay";
      setCategories(new Set(nextMethod === "reextract" ? ["ai"] : (prefill.categories ?? ["connectors", "ai"])));
      setMethod(nextMethod);
      setSelectedSources(prefill.sources ? new Set(prefill.sources) : null);
    } else {
      setCategories(new Set(["connectors", "ai"]));
      setMethod("replay");
      setSelectedSources(null);
    }
  }, [open, prefill]);

  // Once the source list arrives in re-extract mode, default to "all selected"
  // until the user explicitly narrows it.
  useEffect(() => {
    if (method !== "reextract" || selectedSources !== null) return;
    if (availableSources.length === 0) return;
    setSelectedSources(new Set(availableSources.map((s) => s.source)));
  }, [method, selectedSources, availableSources]);

  const allThree = categories.size === 3;
  const allSourcesSelected =
    selectedSources !== null &&
    availableSources.length > 0 &&
    availableSources.every((s) => selectedSources.has(s.source));
  const sourcesReady =
    method !== "reextract" ||
    (!sourcesQuery.isLoading && availableSources.length > 0 && selectedSources !== null && selectedSources.size > 0);

  const onlyManualWithReplay = method === "replay" && categories.size === 1 && categories.has("manual");
  const invalidReextractCategories = method === "reextract" && (categories.size !== 1 || !categories.has("ai"));
  const needsExpensiveConfirm = allThree || (method === "reextract" && allSourcesSelected);

  const canAdvanceFromCategories = categories.size > 0;
  const canAdvanceFromMethod = !onlyManualWithReplay && !invalidReextractCategories && sourcesReady;
  const canRun = canAdvanceFromCategories && canAdvanceFromMethod && (!needsExpensiveConfirm || confirmExpensive);

  const submitMutation = useMutation({
    mutationFn: async () => {
      setErrorMessage(null);
      if (method === "reextract") {
        const scope: ReenrichScope = allSourcesSelected
          ? { all: true }
          : { sources: selectedSources ? [...selectedSources] : [] };
        const isAll = "all" in scope;
        return api.entities.reenrich(scope, {
          runAfter: true,
          confirm: isAll ? "REENRICH" : undefined,
        });
      }
      return api.entities.reset([...categories], {
        runAfter: true,
        confirm: "RESET_AND_RECREATE",
      });
    },
    onSuccess: () => {
      toast.success("Job started. Watching progress…");
      onSubmitted();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  function toggleCategory(key: ResetCategory) {
    setCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSource(source: string) {
    setSelectedSources((prev) => {
      const next = new Set(prev ?? availableSources.map((s) => s.source));
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }

  function goNext() {
    setErrorMessage(null);
    if (step === 0 && canAdvanceFromCategories) setStep(1);
    else if (step === 1 && canAdvanceFromMethod) setStep(2);
  }
  function goBack() {
    setErrorMessage(null);
    if (step > 0) setStep((step - 1) as StepIdx);
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rebuild entities</AlertDialogTitle>
          <AlertDialogDescription>
            {step === 0
              ? "Pick which entity categories to reset."
              : step === 1
                ? "Choose how to rebuild after the reset."
                : "Review and run."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <StepperHeader current={step} />

        {step === 0 ? (
          <section className="space-y-1.5 py-2">
            {CATEGORIES.map((cat) => (
              <label
                key={cat.key}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 hover:bg-muted/30"
              >
                <input
                  type="checkbox"
                  checked={categories.has(cat.key)}
                  onChange={() => toggleCategory(cat.key)}
                  className="mt-0.5 h-4 w-4 rounded border-border"
                  data-testid={`rebuild-category-${cat.key}`}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{cat.label}</p>
                  <p className="text-xs text-muted-foreground">{cat.desc}</p>
                </div>
              </label>
            ))}
          </section>
        ) : null}

        {step === 1 ? (
          <section className="space-y-1.5 py-2">
            <MethodOption
              value="replay"
              checked={method === "replay"}
              onSelect={() => setMethod("replay")}
              title="Replay from existing facts"
              description="Recreate entities from facts already on disk. Fast, no LLM cost."
            />
            <MethodOption
              value="reextract"
              checked={method === "reextract"}
              onSelect={() => {
                setMethod("reextract");
                setCategories(new Set(["ai"]));
              }}
              icon={<SparkleIcon size={14} className="text-violet-500" />}
              title="Re-extract via LLM"
              description={
                <>
                  Re-run LLM extraction over file contents. Slower.
                  <span className="ml-1 inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                    <WarningIcon size={11} /> Costs Gemini API calls.
                  </span>
                </>
              }
            >
              {method === "reextract" ? (
                <div className="mt-2 space-y-1.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Sources to re-extract
                  </p>
                  {sourcesQuery.isLoading ? (
                    <p className="text-xs text-muted-foreground">Loading sources…</p>
                  ) : availableSources.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No connected sources have indexed files.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5" data-testid="rebuild-source-picker">
                      {availableSources.map((s) => {
                        const isChecked = selectedSources?.has(s.source) ?? true;
                        return (
                          <button
                            key={s.source}
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              toggleSource(s.source);
                            }}
                            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                              isChecked
                                ? "border-foreground bg-foreground text-background"
                                : "border-border bg-background hover:bg-muted"
                            }`}
                            data-testid={`rebuild-source-${s.source}`}
                          >
                            {isChecked ? <CheckIcon size={10} weight="bold" /> : null}
                            {humanSource(s.source)}
                            <span className="opacity-70">· {s.count}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </MethodOption>

            {onlyManualWithReplay ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Manual entities have no facts to replay. Pick Connector or AI categories, or switch to re-extract.
              </p>
            ) : null}
            {invalidReextractCategories ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Re-extract only rebuilds AI-extracted entities. Select only AI-extracted entities to continue.
              </p>
            ) : null}
          </section>
        ) : null}

        {step === 2 ? (
          <section className="space-y-2 py-2 text-sm" data-testid="rebuild-review">
            <ReviewLine label="Categories">
              {[...categories].map((c) => CATEGORIES.find((x) => x.key === c)?.label ?? c).join(", ")}
            </ReviewLine>
            <ReviewLine label="Method">
              {method === "replay" ? "Replay from existing facts" : "Re-extract via LLM"}
            </ReviewLine>
            {method === "reextract" ? (
              <ReviewLine label="Sources">
                {allSourcesSelected || !selectedSources
                  ? `All sources (${availableSources.length})`
                  : [...selectedSources].map(humanSource).join(", ") || "(none selected)"}
              </ReviewLine>
            ) : null}

            {needsExpensiveConfirm ? (
              <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-md border border-amber-300 bg-amber-50/50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/30">
                <input
                  type="checkbox"
                  checked={confirmExpensive}
                  onChange={() => setConfirmExpensive((v) => !v)}
                  className="mt-0.5 h-4 w-4 rounded border-border"
                  data-testid="rebuild-expensive-confirm"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-200">Are you sure?</p>
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    {method === "reextract"
                      ? "Re-extracting across all sources will run LLM enrichment on every indexed file."
                      : "Resetting all three categories will delete every entity."}
                  </p>
                </div>
              </label>
            ) : null}

            {errorMessage ? (
              <p className="text-xs text-destructive" data-testid="rebuild-error">
                {errorMessage}
              </p>
            ) : null}
          </section>
        ) : null}

        <AlertDialogFooter>
          {step > 0 ? (
            <Button variant="outline" onClick={goBack} disabled={submitMutation.isPending} data-testid="rebuild-back">
              Back
            </Button>
          ) : null}
          <AlertDialogCancel disabled={submitMutation.isPending}>Cancel</AlertDialogCancel>
          {step < 2 ? (
            <Button
              onClick={goNext}
              disabled={step === 0 ? !canAdvanceFromCategories : !canAdvanceFromMethod}
              data-testid="rebuild-next"
            >
              Next
            </Button>
          ) : (
            <Button
              onClick={() => submitMutation.mutate()}
              disabled={!canRun || submitMutation.isPending}
              data-testid="rebuild-run"
            >
              {submitMutation.isPending ? "Starting…" : "Run"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function StepperHeader({ current }: { current: StepIdx }) {
  return (
    <ol className="flex items-center gap-2 pb-2" data-testid="rebuild-stepper">
      {STEPS.map((label, idx) => {
        const done = idx < current;
        const active = idx === current;
        return (
          <li key={label} className="flex items-center gap-2 text-[11px]">
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-medium ${
                done
                  ? "border-emerald-500 bg-emerald-500 text-background"
                  : active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground"
              }`}
            >
              {done ? <CheckIcon size={11} weight="bold" /> : idx + 1}
            </span>
            <span
              className={`uppercase tracking-wider ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
            >
              {label}
            </span>
            {idx < STEPS.length - 1 ? <span className="mx-1 h-px w-6 bg-border" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

interface MethodOptionProps {
  value: Method;
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: React.ReactNode;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

function MethodOption({ value, checked, onSelect, title, description, icon, children }: MethodOptionProps) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 hover:bg-muted/30 ${
        checked ? "border-foreground" : "border-border"
      }`}
    >
      <input
        type="radio"
        name="rebuild-method"
        value={value}
        checked={checked}
        onChange={onSelect}
        className="mt-1 h-4 w-4 border-border"
        data-testid={`rebuild-method-${value}`}
      />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {icon}
          {title}
        </p>
        <p className="text-xs text-muted-foreground">{description}</p>
        {children}
      </div>
    </label>
  );
}

function ReviewLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-xs">{children}</span>
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  clickup: "ClickUp",
  notion: "Notion",
  linear: "Linear",
  fireflies: "Fireflies",
  google_drive: "Google Drive",
  slack: "Slack",
  llm_extraction: "LLM extraction",
};

function humanSource(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}
