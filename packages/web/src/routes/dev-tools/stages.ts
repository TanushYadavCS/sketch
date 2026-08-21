/**
 * The stages of each traced pipeline, in run order.
 *
 * Listed here rather than derived from what the server has reported so far, so a
 * run in flight shows the stages it has not reached yet instead of growing a
 * list from nothing.
 */
import type { DevStageKey, DevTraceRunKind } from "@/lib/api";

export interface StageDefinition {
  stage: DevStageKey;
  label: string;
  kind: "model" | "code";
  /** Set when this stage runs concurrently with another, so the list does not imply an order that does not exist. */
  parallelWith?: string;
}

export const STAGES: StageDefinition[] = [
  { stage: "extractEntities", label: "Extract entities", kind: "model" },
  { stage: "dedupAdjudicate", label: "Adjudicate known matches", kind: "model" },
  { stage: "reconcileFacts", label: "Reconcile facts", kind: "code" },
  { stage: "matchEntities", label: "Match entities", kind: "code" },
  { stage: "generateSummary", label: "Summary", kind: "model", parallelWith: "entity facts" },
  { stage: "extractEntityFacts", label: "Entity facts", kind: "model", parallelWith: "summary" },
  { stage: "engagementFloor", label: "Engagement floor", kind: "code" },
  { stage: "materialize", label: "Materialise", kind: "code" },
];

/**
 * Minting is four stages, and the last one carries the answer people actually
 * come for: a candidate the model proposed that never became a task, and the
 * reason the fact pipeline gave for that.
 */
export const MINT_STAGES: StageDefinition[] = [
  { stage: "neighbourhood", label: "Nearest files", kind: "code" },
  { stage: "gatherContext", label: "Gather context", kind: "code" },
  { stage: "extractCandidates", label: "Extract candidates", kind: "model" },
  { stage: "writeCandidates", label: "Write candidates", kind: "code" },
];

/**
 * Search's eleven stages. All `code`: the one model call a search makes is the query
 * embedding, which has no prompt or response worth a tab, so it reports as a summary.
 */
export const SEARCH_STAGES: StageDefinition[] = [
  { stage: "discoverEntities", label: "Discover entities", kind: "code" },
  { stage: "resolveEntities", label: "Resolve entity scope", kind: "code" },
  { stage: "embedQuery", label: "Embed query", kind: "code" },
  { stage: "ftsCandidates", label: "Keyword candidates", kind: "code" },
  { stage: "vectorCandidates", label: "Vector candidates", kind: "code" },
  { stage: "fuse", label: "Fuse rankings", kind: "code" },
  { stage: "filter", label: "Metadata filters", kind: "code" },
  { stage: "rbac", label: "Access filter", kind: "code" },
  { stage: "finalize", label: "Collapse and slice", kind: "code" },
  { stage: "rerank", label: "Entity re-sort", kind: "code" },
  { stage: "finalOutput", label: "Final output", kind: "code" },
];

export function stagesFor(kind: DevTraceRunKind): StageDefinition[] {
  return kind === "mint" ? MINT_STAGES : STAGES;
}
