import type { RebuildDialogPrefill } from "@/components/rebuild-dialog";
import type { ActiveRebuildJob, RebuildJobState } from "@/hooks/use-rebuild-job";
import type { RebuildJob, ResetCategory } from "@/lib/api";
import { ArrowsClockwiseIcon, CheckCircleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { useEffect, useState } from "react";

const SUCCESS_AUTO_DISMISS_MS = 10000;

interface RebuildBannerProps {
  state: RebuildJobState;
  onRetry: (prefill: RebuildDialogPrefill) => void;
}

export function RebuildBanner({ state, onRetry }: RebuildBannerProps) {
  const [dismissedSuccessJobId, setDismissedSuccessJobId] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const active = state.activeJob;
  const latest = state.latestJob;
  const externalActive = state.externalActive;

  const successJob =
    !active && latest && latest.job.phase === "done" && latest.job.id !== dismissedSuccessJobId ? latest : null;
  const errorJob = !active && latest && latest.job.phase === "failed" ? latest : null;

  useEffect(() => {
    if (!successJob) return;
    const t = setTimeout(() => setDismissedSuccessJobId(successJob.job.id), SUCCESS_AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [successJob]);

  if (active) {
    return (
      <>
        <ActiveBanner active={active} onDetails={() => setShowDetails(true)} />
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

  return null;
}

function ActiveBanner({ active, onDetails }: { active: ActiveRebuildJob; onDetails: () => void }) {
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
  return `${replay.entitiesCreated} entities, ${replay.mentionsWritten} mentions, ${replay.relationshipsWritten} relations written`;
}

function prefillFromJob(job: ActiveRebuildJob): RebuildDialogPrefill {
  const req = job.job.request;
  if (!req) return {};
  if (job.kind === "reenrich") {
    // `fileIds` scopes can't round-trip through the dialog (it only exposes
    // source pickers), so fall back to all-sources when the original job
    // used a file-id scope.
    const scope = req.scope;
    const sources = scope && "sources" in scope ? scope.sources : undefined;
    return {
      categories: ["ai"],
      method: "reextract",
      sources,
    };
  }
  return {
    categories: (req.categories as ResetCategory[] | undefined) ?? ["connectors", "ai"],
    method: "replay",
  };
}
