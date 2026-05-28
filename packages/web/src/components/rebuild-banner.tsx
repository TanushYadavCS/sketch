import type { GraphRebuildDialogPrefill } from "@/components/graph-rebuild-dialog";
import type { ActiveRebuildJob, RebuildJobState } from "@/hooks/use-rebuild-job";
import { type RebuildJob, api } from "@/lib/api";
import { ArrowsClockwiseIcon, CheckCircleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const SUCCESS_AUTO_DISMISS_MS = 10000;

interface RebuildBannerProps {
  state: RebuildJobState;
  onRetry: (prefill: GraphRebuildDialogPrefill) => void;
}

/**
 * Sticky banner that follows the merged rebuild-job state. Kind-agnostic
 * — the banner reads `kind` and `phase` off the polled payload and renders
 * a label, but doesn't branch on the kind. Three job kinds (reset, reenrich,
 * rebuild) all feed the same flow, so per-kind UI logic would just be drift.
 */
export function RebuildBanner({ state, onRetry }: RebuildBannerProps) {
  const [dismissedSuccessJobId, setDismissedSuccessJobId] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const active = state.activeJob;
  const latest = state.latestJob;
  const externalActive = state.externalActive;

  const successJob =
    !active && latest && latest.job.phase === "done" && latest.job.id !== dismissedSuccessJobId ? latest : null;
  const errorJob = !active && latest && latest.job.phase === "failed" ? latest : null;
  const cancelledJob = !active && latest && latest.job.phase === "cancelled" ? latest : null;

  const stopMutation = useMutation({
    mutationFn: (job: ActiveRebuildJob) => api.entities.stopReenrichJob(job.job.id),
    onSuccess: () => {
      toast.success("Re-enrich stop requested");
      state.refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  useEffect(() => {
    if (!successJob) return;
    const t = setTimeout(() => setDismissedSuccessJobId(successJob.job.id), SUCCESS_AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [successJob]);

  if (active) {
    return (
      <>
        <ActiveBanner
          active={active}
          onDetails={() => setShowDetails(true)}
          onStop={active.kind === "reenrich" ? () => stopMutation.mutate(active) : undefined}
          stopping={stopMutation.isPending}
        />
        <DetailsModal open={showDetails} onOpenChange={setShowDetails} job={active} />
      </>
    );
  }

  if (externalActive) {
    return <ExternalActiveBanner />;
  }

  if (successJob) {
    return (
      <>
        <SuccessBanner
          job={successJob}
          onDismiss={() => setDismissedSuccessJobId(successJob.job.id)}
          onDetails={() => setShowDetails(true)}
        />
        <DetailsModal open={showDetails} onOpenChange={setShowDetails} job={successJob} />
      </>
    );
  }

  if (errorJob) {
    return <ErrorBanner job={errorJob} onRetry={() => onRetry(prefillFromJob(errorJob))} />;
  }

  if (cancelledJob) {
    return <CancelledBanner job={cancelledJob} />;
  }

  return null;
}

function ActiveBanner({
  active,
  onDetails,
  onStop,
  stopping,
}: {
  active: ActiveRebuildJob;
  onDetails: () => void;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const { job } = active;
  const elapsed = formatElapsed(Date.now() - new Date(job.startedAt).getTime());
  const progress = formatProgress(job);
  return (
    <div
      className="sticky top-0 z-20 flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs dark:border-blue-900 dark:bg-blue-950/60"
      data-testid="rebuild-banner-active"
    >
      <ArrowsClockwiseIcon size={16} className="shrink-0 animate-spin text-blue-700 dark:text-blue-300" />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-blue-900 dark:text-blue-100">Rebuilding entities</span>
        <span className="ml-2 text-blue-800/80 dark:text-blue-300/80">
          Phase: {job.phase}
          {progress ? ` · ${progress}` : ""} · started {elapsed}
        </span>
      </div>
      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onDetails}>
        Details
      </Button>
      {onStop ? (
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs"
          onClick={onStop}
          disabled={stopping}
          data-testid="rebuild-stop"
        >
          {stopping ? "Stopping..." : "Stop"}
        </Button>
      ) : null}
    </div>
  );
}

function ExternalActiveBanner() {
  return (
    <div
      className="sticky top-0 z-20 flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs dark:border-blue-900 dark:bg-blue-950/60"
      data-testid="rebuild-banner-external"
    >
      <ArrowsClockwiseIcon size={16} className="shrink-0 animate-spin text-blue-700 dark:text-blue-300" />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-blue-900 dark:text-blue-100">
          A rebuild is in progress in another session.
        </span>
      </div>
    </div>
  );
}

function SuccessBanner({
  job,
  onDismiss,
  onDetails,
}: {
  job: ActiveRebuildJob;
  onDismiss: () => void;
  onDetails: () => void;
}) {
  const counts = relationsCount(job.job);
  return (
    <div
      className="sticky top-0 z-20 flex items-center gap-3 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs dark:border-emerald-900 dark:bg-emerald-950/60"
      data-testid="rebuild-banner-success"
    >
      <CheckCircleIcon size={16} className="shrink-0 text-emerald-700 dark:text-emerald-300" />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-emerald-900 dark:text-emerald-100">Rebuild complete</span>
        {counts ? <span className="ml-2 text-emerald-800/80 dark:text-emerald-300/80">{counts}</span> : null}
      </div>
      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onDetails}>
        Details
      </Button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-emerald-700 hover:text-emerald-900 dark:text-emerald-300"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

function ErrorBanner({ job, onRetry }: { job: ActiveRebuildJob; onRetry: () => void }) {
  return (
    <div
      className="sticky top-0 z-20 flex items-center gap-3 border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs dark:border-rose-900 dark:bg-rose-950/60"
      data-testid="rebuild-banner-error"
    >
      <WarningCircleIcon size={16} className="shrink-0 text-rose-700 dark:text-rose-300" />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-rose-900 dark:text-rose-100">Rebuild failed</span>
        {job.job.error ? (
          <span className="ml-2 truncate text-rose-800/80 dark:text-rose-300/80">{job.job.error}</span>
        ) : null}
      </div>
      <Button variant="outline" size="sm" className="h-6 text-xs" onClick={onRetry} data-testid="rebuild-retry">
        Retry
      </Button>
    </div>
  );
}

function CancelledBanner({ job }: { job: ActiveRebuildJob }) {
  return (
    <div
      className="sticky top-0 z-20 flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs dark:border-amber-900 dark:bg-amber-950/60"
      data-testid="rebuild-banner-cancelled"
    >
      <WarningCircleIcon size={16} className="shrink-0 text-amber-700 dark:text-amber-300" />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-amber-900 dark:text-amber-100">Re-enrich stopped</span>
        {job.job.error ? (
          <span className="ml-2 truncate text-amber-800/80 dark:text-amber-300/80">{job.job.error}</span>
        ) : null}
      </div>
    </div>
  );
}

function DetailsModal({
  open,
  onOpenChange,
  job,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: ActiveRebuildJob;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rebuild details</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-1 text-xs">
          <dt className="text-muted-foreground">Kind</dt>
          <dd>{job.kind}</dd>
          <dt className="text-muted-foreground">Phase</dt>
          <dd>{job.job.phase}</dd>
          <dt className="text-muted-foreground">Started</dt>
          <dd>{new Date(job.job.startedAt).toLocaleString()}</dd>
          {job.job.finishedAt ? (
            <>
              <dt className="text-muted-foreground">Finished</dt>
              <dd>{new Date(job.job.finishedAt).toLocaleString()}</dd>
            </>
          ) : null}
          {job.job.progress ? (
            <>
              <dt className="text-muted-foreground">Progress</dt>
              <dd>
                {job.job.progress.phase} — {job.job.progress.completed} / {job.job.progress.total}
              </dd>
            </>
          ) : null}
          {job.job.reset?.deleted ? (
            <>
              <dt className="text-muted-foreground">Deleted</dt>
              <dd>
                {Object.entries(job.job.reset.deleted)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ") || "—"}
              </dd>
            </>
          ) : null}
          {job.job.replay ? (
            <>
              <dt className="text-muted-foreground">Replay</dt>
              <dd>
                {job.job.replay.entitiesCreated} created · {job.job.replay.entitiesLinked} linked ·{" "}
                {job.job.replay.relationshipsWritten} relations
              </dd>
            </>
          ) : null}
          {job.job.summary?.enrichment ? (
            <>
              <dt className="text-muted-foreground">Enrichment</dt>
              <dd>
                {job.job.summary.enrichment.filesProcessed} processed · {job.job.summary.enrichment.filesFailed} failed
              </dd>
            </>
          ) : null}
          {job.job.error ? (
            <>
              <dt className="text-muted-foreground">Error</dt>
              <dd className="col-span-1 truncate">{job.job.error}</dd>
            </>
          ) : null}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function formatProgress(job: RebuildJob): string | null {
  if (!job.progress) return null;
  if (job.progress.total <= 0) return null;
  return `${job.progress.completed} / ${job.progress.total} ${job.progress.phase}`;
}

function relationsCount(job: RebuildJob): string | null {
  const replay = job.replay ?? job.summary?.recreate?.replay;
  if (!replay) return null;
  return `${replay.entitiesCreated} entities, ${replay.mentionsWritten ?? 0} mentions, ${replay.relationshipsWritten} relations written`;
}

function prefillFromJob(job: ActiveRebuildJob): GraphRebuildDialogPrefill {
  // For reenrich failures, default to the re-extract path on retry — the
  // operator's last intent was an LLM re-extract. For reset/rebuild
  // failures, no preference (let the user choose at step 2).
  return { preferReextract: job.kind === "reenrich" };
}
