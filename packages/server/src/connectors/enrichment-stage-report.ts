import type { MintContextBlock } from "./mint-context";

export type EnrichmentStageKey =
  | "extractEntities"
  | "dedupAdjudicate"
  | "reconcileFacts"
  | "matchEntities"
  | "generateSummary"
  | "extractEntityFacts"
  | "engagementFloor"
  | "materialize";

/**
 * Task minting's own stages. Kept in the same vocabulary as enrichment so one
 * ring, one dump reader and one rail serve both pipelines; the keys are
 * disjoint, so a report always says which pipeline it came from.
 */
export type MintStageKey = "neighbourhood" | "gatherContext" | "extractCandidates" | "writeCandidates";

export type StageKey = EnrichmentStageKey | MintStageKey;

export type EnrichmentStageKind = "model" | "code";
export type EnrichmentStageStatus = "done" | "failed" | "skipped";

export type StageOutcome = {
  subject: string;
  kind: string;
  result: "kept" | "dropped" | "created" | "linked" | "queued" | "suppressed" | "deferred";
  reason?: string;
};

export interface MaterializeStageSummary {
  eligibleFacts: number;
  indexBuilds: number;
  scopeKeyReads: number;
}

export interface StageReport {
  stage: StageKey;
  label: string;
  kind: EnrichmentStageKind;
  status: EnrichmentStageStatus;
  context?: MintContextBlock[];
  outcomes?: StageOutcome[];
  error?: string;
  parallelGroup?: string;
  summary?: Record<string, unknown>;
  materializeSummary?: MaterializeStageSummary;
}

export type StageReporter = (report: StageReport) => void;

export type { MintContextBlock } from "./mint-context";
