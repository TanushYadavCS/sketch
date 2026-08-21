import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import type { EmbeddingProvider } from "../connectors/embeddings/types";
import type { StageReporter } from "../connectors/enrichment-stage-report";
import type { createEntityRepository } from "../db/repositories/entities";
import type { EntityDomainsRepository } from "../db/repositories/entity-domains";
import type { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { EntitySuppressionRepository } from "../db/repositories/entity-suppressions";
import type { IndexedFileFactType } from "../db/repositories/indexed-file-facts";
import type { DB, EntitiesTable, IndexedFileFactsTable } from "../db/schema";
import type { MentionType } from "./graph";
import type { CandidatePool, CandidatePoolEntry } from "./name-dedup";
import type { Entity, EntityLookup, ProposeEntityType } from "./propose";

export interface ReplayFactsSummary {
  factsRead: number;
  entitiesCreated: number;
  entitiesLinked: number;
  queued: number;
  mentionsWritten: number;
  relationshipsWritten: number;
  skipped: number;
}

export interface MaterializeFactsSummary extends ReplayFactsSummary {
  eligibleFacts: number;
  indexBuilds: number;
  scopeKeyReads: number;
  materialized: number;
  deferred: number;
  deferredBelowThreshold: number;
}

export type EntityRow = Selectable<EntitiesTable>;
export type IndexedFileFactRow = Selectable<IndexedFileFactsTable>;

/**
 * Entity columns hydrated into the in-memory lookup index. Restricted to the
 * fields matching and materialization actually read: `id`/`source_type`/
 * `provenance_tier` gate match targets, `name`/`aliases` drive normalized name
 * and dedup lookup, `metadata` yields person email/scope, and
 * `status`/`hotness`/`created_at` break ties among confirmed candidates. Wide
 * or unused columns (notably `ai_brief`) are deliberately omitted so the single
 * shared row per entity stays small.
 */
export const ENTITY_INDEX_COLUMNS = [
  "id",
  "name",
  "source_type",
  "provenance_tier",
  "aliases",
  "metadata",
  "status",
  "hotness",
  "created_at",
] as const satisfies readonly (keyof EntityRow)[];

/**
 * Projection of {@link EntityRow} restricted to {@link ENTITY_INDEX_COLUMNS}.
 * This is the declared type of every index-origin row (lookup buckets,
 * `EntityLookup` results, and `MaterializeResult.entity`), so a consumer that
 * reaches for an omitted column fails to compile instead of reading `undefined`
 * at runtime. Signatures that receive full rows from their own DB query keep
 * `EntityRow`; only index-origin surfaces narrow to this type.
 */
export type IndexEntityRow = Pick<EntityRow, (typeof ENTITY_INDEX_COLUMNS)[number]>;

export const lookupIndexScopeBrand: unique symbol = Symbol("lookupIndexScope");

export type LookupIndexScope = { kind: "full" } | { kind: "scoped"; types: ReadonlySet<ProposeEntityType> };

export interface LookupIndex {
  readonly [lookupIndexScopeBrand]: LookupIndexScope;
  entitiesByType: Map<ProposeEntityType, IndexEntityRow[]>;
  byNormalizedName: Map<string, IndexEntityRow[]>;
  byNormalizedAlias: Map<string, IndexEntityRow[]>;
  collisionNameKeysByType: Map<ProposeEntityType, Set<string>>;
  dedupEntriesByType: Map<ProposeEntityType, CandidatePoolEntry[]>;
  dedupPoolsByType: Map<ProposeEntityType, CandidatePool>;
  bySourceRef: Map<string, IndexEntityRow>;
  companyIdsByDomain: Map<string, string[]>;
  corporateDomains: Set<string>;
  personScopeKeysByEntityId: Map<string, string[]>;
  personScopeKeyReads: number;
}

export interface MaterializeDeps {
  db: Kysely<DB>;
  logger?: Logger;
  entityRepo: ReturnType<typeof createEntityRepository>;
  reviewRepo: ReturnType<typeof createEntityReviewRepo>;
  suppressionRepo: EntitySuppressionRepository;
  domainsRepo: EntityDomainsRepository;
  lookup: EntityLookup;
  index: LookupIndex;
  readEmail: (entity: IndexEntityRow) => string | null;
  onEntityResolved: (entity: IndexEntityRow) => void | Promise<void>;
  resolveOwner: (fact: IndexedFileFactRow) => string | null;
  getIndexedFileSourceTime: (indexedFileId: string) => Promise<{
    source_created_at: string | null;
    source_updated_at: string | null;
    synced_at: string;
  } | null>;
  llmPromotionThreshold: number;
  llmTaskCorroborationThreshold: number;
  birthGateTypes: Set<ProposeEntityType>;
  birthGateLiveTypes: Set<ProposeEntityType>;
  structuralAutoBirthTypes: Set<ProposeEntityType>;
  birthGateDryRun: boolean;
  embeddingProvider: EmbeddingProvider | null;
  countActiveLlmFilesForName: (normalizedName: string, mentionType: MentionType) => Promise<number>;
  hasOnlyChatConversationSliceEvidence: (normalizedName: string, mentionType: MentionType) => Promise<boolean>;
  /**
   * True when the fact's file is a WhatsApp/Slack conversation slice. Relation
   * endpoints from chat slices are link-only: chat can corroborate entities
   * born from stronger sources but must never mint them (the mention path
   * enforces the same rule via hasOnlyChatConversationSliceEvidence).
   */
  isChatConversationSliceFile: (indexedFileId: string) => Promise<boolean>;
  /**
   * True once the Fix 2b normalization backfill has populated projection columns
   * for every pre-existing row. Feature corroboration and LLM count/third-party
   * reads switch from legacy `raw`-parsing scans to indexed SQL only when set.
   */
  normalizationBackfillComplete: boolean;
}

export type MaterializeResult =
  | { kind: "entity_created"; entity: IndexEntityRow; mentionWritten: boolean; countEntity?: boolean }
  | { kind: "entity_linked"; entity: IndexEntityRow; mentionWritten: boolean; countEntity?: boolean }
  | { kind: "queued"; reviewId: string }
  | { kind: "queued_held"; reviewId: string; reason: "llm_ambiguous" | "non_person_collision" | "relation_endpoint" }
  | {
      kind: "relationship_materialized";
      entitiesCreated: number;
      entitiesLinked: number;
      mentionsWritten: number;
      relationshipsWritten: number;
    }
  | { kind: "task_materialized"; taskId: string; created: boolean; updated?: boolean }
  | { kind: "commitment_materialized" }
  | { kind: "decision_materialized" }
  | { kind: "milestone_materialized" }
  | { kind: "structural"; entity: IndexEntityRow }
  | { kind: "skipped_missing_owner"; reason: string }
  | { kind: "deferred_below_threshold"; reason: string }
  | { kind: "skipped"; reason: string };

export interface ReplaySourceFactsOptions {
  llmPromotionThreshold?: number;
  llmTaskCorroborationThreshold?: number;
  birthGateTypes?: Set<ProposeEntityType>;
  birthGateLiveTypes?: Set<ProposeEntityType>;
  structuralAutoBirthTypes?: Set<ProposeEntityType>;
  birthGateDryRun?: boolean;
  embeddingProvider?: EmbeddingProvider | null;
  /**
   * Rows fetched per keyset page. Bounds peak heap: only one page of facts
   * (including their `raw` payloads) is held at a time. Defaults to
   * `DEFAULT_FACT_BATCH_SIZE`.
   */
  batchSize?: number;
}

export interface MaterializeProgress {
  phase: string;
  completed: number;
  total: number;
}

export interface MaterializeUnmaterializedOptions {
  llmPromotionThreshold?: number;
  llmTaskCorroborationThreshold?: number;
  birthGateTypes?: Set<ProposeEntityType>;
  birthGateLiveTypes?: Set<ProposeEntityType>;
  structuralAutoBirthTypes?: Set<ProposeEntityType>;
  birthGateDryRun?: boolean;
  embeddingProvider?: EmbeddingProvider | null;
  factTypes?: IndexedFileFactType[];
  indexedFileIds?: string[];
  /**
   * Rows fetched per keyset page. Bounds peak heap: only one page of facts
   * (including their `raw` payloads) is held at a time. Defaults to
   * `DEFAULT_FACT_BATCH_SIZE`.
   */
  batchSize?: number;
  /**
   * Fires before processing each fact with `completed = index, total = facts.length`
   * and after the loop with `completed = total`. Used by the reset/reenrich job
   * watcher to surface live progress to the rebuild banner in the UI.
   */
  onProgress?: (progress: MaterializeProgress) => void;
  shouldCancel?: () => boolean;
  stageReport?: StageReporter;
}

export const MAX_MATERIALIZE_INDEXED_FILE_ID_FILTER = 1000;

export function indexedFileIdsForMaterializeScope(fileIds: readonly string[]): string[] | undefined {
  const unique = [...new Set(fileIds.filter(Boolean))];
  if (unique.length > MAX_MATERIALIZE_INDEXED_FILE_ID_FILTER) return undefined;
  return unique;
}
