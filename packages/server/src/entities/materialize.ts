export {
  buildMaterializeDeps,
  configureMaterializeDefaults,
} from "./materialize-deps";
export type { BuildMaterializeDepsOptions } from "./materialize-deps";
export {
  cleanupEmptyRelationships,
  cleanupRelationshipEvidenceForFacts,
  materializeFromFact,
  materializeUnmaterializedFacts,
  MAX_MATERIALIZATION_ATTEMPTS,
  replaySourceFacts,
  shouldMarkMaterialized,
} from "./materialize-replay";
export type {
  IndexedFileFactRow,
  LookupIndex,
  MaterializeDeps,
  MaterializeFactsSummary,
  MaterializeProgress,
  MaterializeResult,
  MaterializeUnmaterializedOptions,
  ReplayFactsSummary,
  ReplaySourceFactsOptions,
} from "./materialize-types";
