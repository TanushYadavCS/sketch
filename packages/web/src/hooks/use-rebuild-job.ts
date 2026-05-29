import type { RebuildJob, RebuildJobKind, RebuildJobsResponse } from "@/lib/api";
import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

const ACTIVE_INTERVAL_MS = 2000;
const IDLE_INTERVAL_MS = 30000;

const RESET_JOBS_KEY = ["entities", "rebuild", "reset-jobs"] as const;
const REENRICH_JOBS_KEY = ["entities", "rebuild", "reenrich-jobs"] as const;

export interface ActiveRebuildJob {
  kind: RebuildJobKind;
  job: RebuildJob;
}

export interface RebuildJobState {
  /** Job currently running (newest by startedAt across reset + reenrich streams). */
  activeJob: ActiveRebuildJob | null;
  /** Most recent terminal job — used for the success / failure banner state. */
  latestJob: ActiveRebuildJob | null;
  /** True if either stream reports `active`. Also true when the shared recreate lock is held. */
  anyActive: boolean;
  /** True when one stream reports `active: true` but no job is owned by it (lock held by the other). */
  externalActive: boolean;
  /** Refetch both streams immediately (used after submitting a new job). */
  refetch: () => void;
}

function isTerminal(phase: string): boolean {
  return phase === "done" || phase === "failed";
}

function pickActive(
  reset: RebuildJobsResponse | undefined,
  reenrich: RebuildJobsResponse | undefined,
): ActiveRebuildJob | null {
  const candidates: ActiveRebuildJob[] = [];
  if (reset?.currentJob) candidates.push({ kind: "reset", job: reset.currentJob });
  if (reenrich?.currentJob) candidates.push({ kind: "reenrich", job: reenrich.currentJob });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.job.startedAt < b.job.startedAt ? -1 : 1));
  return candidates[0];
}

function pickLatest(
  reset: RebuildJobsResponse | undefined,
  reenrich: RebuildJobsResponse | undefined,
): ActiveRebuildJob | null {
  const candidates: ActiveRebuildJob[] = [];
  if (reset?.latestJob && isTerminal(reset.latestJob.phase)) {
    candidates.push({ kind: "reset", job: reset.latestJob });
  }
  if (reenrich?.latestJob && isTerminal(reenrich.latestJob.phase)) {
    candidates.push({ kind: "reenrich", job: reenrich.latestJob });
  }
  if (candidates.length === 0) return null;
  const finishTime = (j: ActiveRebuildJob): string => j.job.finishedAt ?? j.job.startedAt;
  candidates.sort((a, b) => (finishTime(a) > finishTime(b) ? -1 : 1));
  return candidates[0];
}

/**
 * Polls both reset and reenrich job streams and merges them for the UI.
 *
 * - Active job (newest by startedAt) drives the in-progress banner.
 * - Most recent terminal job drives the success/error banner state.
 * - Polling speeds up to 2s while active and slows to 30s while idle, so
 *   tab-count overhead stays low for the common no-job case while keeping
 *   feedback snappy during a rebuild.
 *
 * External-active: if one stream reports `active: true` with no `currentJob`
 * (lock held by the other stream, e.g. another tab triggered it) the merged
 * state still surfaces `anyActive: true` so the banner can render a generic
 * "rebuild in progress" message rather than disappearing.
 */
export function useRebuildJob(opts?: { enabled?: boolean }): RebuildJobState {
  const enabled = opts?.enabled ?? true;

  const resetQuery = useQuery({
    queryKey: RESET_JOBS_KEY,
    queryFn: () => api.entities.resetJobs(),
    enabled,
    refetchInterval: (query) => (query.state.data?.active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS),
    refetchOnWindowFocus: true,
  });

  const reenrichQuery = useQuery({
    queryKey: REENRICH_JOBS_KEY,
    queryFn: () => api.entities.reenrichJobs(),
    enabled,
    refetchInterval: (query) => (query.state.data?.active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS),
    refetchOnWindowFocus: true,
  });

  const activeJob = pickActive(resetQuery.data, reenrichQuery.data);
  const latestJob = pickLatest(resetQuery.data, reenrichQuery.data);
  const anyActive = Boolean(resetQuery.data?.active || reenrichQuery.data?.active);
  const externalActive = anyActive && activeJob === null;

  return {
    activeJob,
    latestJob,
    anyActive,
    externalActive,
    refetch: () => {
      void resetQuery.refetch();
      void reenrichQuery.refetch();
    },
  };
}
