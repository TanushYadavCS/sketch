/**
 * Runs one file through the pipeline and shows every stage as it happens.
 *
 * Lives inside /dev-tools only. It exposes prompts, and prompts embed the file
 * body, so it has no place on a product surface.
 */
import { api } from "@/lib/api";
import { SparkleIcon, SpinnerGapIcon, WarningIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EnrichmentTrace } from "./enrichment-trace";

export function TraceDialog({
  file,
  existingRunId,
  onOpenChange,
}: {
  /** Set to start a fresh run for this file. */
  file: { id: string; name: string } | null;
  /** Set to reopen a run that already happened. */
  existingRunId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [runId, setRunId] = useState<string | null>(existingRunId);

  const startMutation = useMutation({
    mutationFn: (fileId: string) => api.dev.startEnrichmentRun(fileId),
    onSuccess: (data) => setRunId(data.runId),
    onError: (err: Error) => toast.error(err.message),
  });

  useEffect(() => {
    setRunId(existingRunId);
  }, [existingRunId]);

  const open = Boolean(file || existingRunId);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setRunId(null);
      startMutation.reset();
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[88vh] w-[96vw] max-w-[1180px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1180px]">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-3">
          <DialogTitle>Trace enrichment</DialogTitle>
          <DialogDescription>
            {file ? (
              <>
                Runs the pipeline against <span className="font-medium text-foreground">{file.name}</span> and shows
                each stage as it happens.
              </>
            ) : (
              "An earlier run, replayed from what the server still holds in memory."
            )}
          </DialogDescription>
        </DialogHeader>

        {runId ? (
          <div className="min-h-0 flex-1">
            <EnrichmentTrace runId={runId} />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-5 py-6 text-center">
            <div className="mb-4 flex max-w-md gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-left text-xs">
              <WarningIcon size={14} className="mt-0.5 shrink-0" />
              <span>
                This writes facts and can create entities. Stages the file has already been through are re-run, so the
                graph changes.
              </span>
            </div>
            <Button
              onClick={() => file && startMutation.mutate(file.id)}
              disabled={startMutation.isPending || !file}
              className="gap-1.5"
            >
              {startMutation.isPending ? (
                <>
                  <SpinnerGapIcon size={14} className="animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <SparkleIcon size={14} />
                  Run enrichment
                </>
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
