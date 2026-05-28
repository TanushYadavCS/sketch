import { randomUUID } from "node:crypto";
import type { MaterializeFactsSummary } from "../../entities/materialize";
import type { RecreateSummary, ResetSummary } from "../../entities/recreate";
import type { ReenrichDryRunSummary, ReenrichScope, ReenrichSummary } from "../../entities/reenrich";
import type { ResetRequest } from "./reset-service";

export type ResetJobPhase = "idle" | "resetting" | "reset_done" | "replaying_facts" | "enriching" | "done" | "failed";
export type ReenrichJobPhase = "idle" | "wiping" | "enriching" | "rebuilding" | "done" | "failed" | "cancelled";
export type RebuildJobPhase = "idle" | "replaying_facts" | "enriching" | "done" | "failed";

export interface JobProgress {
  phase: string;
  completed: number;
  total: number;
}

export interface ReenrichRequest {
  scope: ReenrichScope;
  runAfter: boolean;
}

export interface RebuildRequest {
  pendingRebuildId: string;
}

export interface ResetJob {
  id: string;
  phase: ResetJobPhase;
  startedAt: string;
  finishedAt: string | null;
  request: ResetRequest;
  progress?: JobProgress;
  reset?: ResetSummary;
  replay?: MaterializeFactsSummary;
  recreate?: RecreateSummary;
  pendingRebuildId?: string;
  pendingRebuildExpiresAt?: string;
  llmFactsWiped?: {
    factsTombstoned: number;
    relationshipEvidenceDeleted: number;
    relationshipsDeleted: number;
  };
  error?: string;
}

export interface ReenrichJob {
  id: string;
  phase: ReenrichJobPhase;
  startedAt: string;
  finishedAt: string | null;
  request: ReenrichRequest;
  progress?: JobProgress;
  dryRun?: ReenrichDryRunSummary;
  summary?: ReenrichSummary;
  error?: string;
  cancelRequested?: boolean;
}

export interface RebuildJob {
  id: string;
  phase: RebuildJobPhase;
  startedAt: string;
  finishedAt: string | null;
  request: RebuildRequest;
  progress?: JobProgress;
  recreate?: RecreateSummary;
  error?: string;
}

let currentResetJob: ResetJob | null = null;
let latestResetJob: ResetJob | null = null;
let currentReenrichJob: ReenrichJob | null = null;
let latestReenrichJob: ReenrichJob | null = null;
let currentRebuildJob: RebuildJob | null = null;
let latestRebuildJob: RebuildJob | null = null;

export function newResetJob(request: ResetRequest): ResetJob {
  return {
    id: randomUUID(),
    phase: "idle",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    request,
  };
}

export function newReenrichJob(request: ReenrichRequest): ReenrichJob {
  return {
    id: randomUUID(),
    phase: "idle",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    request,
  };
}

export function newRebuildJob(request: RebuildRequest): RebuildJob {
  return {
    id: randomUUID(),
    phase: "idle",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    request,
  };
}

export function getCurrentResetJob(): ResetJob | null {
  return currentResetJob;
}

export function setCurrentResetJob(job: ResetJob | null): void {
  currentResetJob = job;
}

export function getLatestResetJob(): ResetJob | null {
  return latestResetJob;
}

export function setLatestResetJob(job: ResetJob | null): void {
  latestResetJob = job;
}

export function getCurrentReenrichJob(): ReenrichJob | null {
  return currentReenrichJob;
}

export function setCurrentReenrichJob(job: ReenrichJob | null): void {
  currentReenrichJob = job;
}

export function getLatestReenrichJob(): ReenrichJob | null {
  return latestReenrichJob;
}

export function setLatestReenrichJob(job: ReenrichJob | null): void {
  latestReenrichJob = job;
}

export function getCurrentRebuildJob(): RebuildJob | null {
  return currentRebuildJob;
}

export function setCurrentRebuildJob(job: RebuildJob | null): void {
  currentRebuildJob = job;
}

export function getLatestRebuildJob(): RebuildJob | null {
  return latestRebuildJob;
}

export function setLatestRebuildJob(job: RebuildJob | null): void {
  latestRebuildJob = job;
}

export function _setCurrentResetJobForTests(active: boolean): void {
  currentResetJob = active ? newResetJob({ categories: ["manual"], runAfter: false }) : null;
}

export function _setCurrentReenrichJobForTests(active: boolean): string | null {
  currentReenrichJob = active ? newReenrichJob({ scope: { all: true }, runAfter: true }) : null;
  if (currentReenrichJob) currentReenrichJob.phase = "enriching";
  return currentReenrichJob?.id ?? null;
}
