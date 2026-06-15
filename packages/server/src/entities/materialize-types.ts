import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import type { createEntityRepository } from "../db/repositories/entities";
import type { EntityDomainsRepository } from "../db/repositories/entity-domains";
import type { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { EntitySuppressionRepository } from "../db/repositories/entity-suppressions";
import type { IndexedFileFactType } from "../db/repositories/indexed-file-facts";
import type { DB, EntitiesTable, IndexedFileFactsTable } from "../db/schema";
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
  materialized: number;
  deferred: number;
  deferredBelowThreshold: number;
}

export type EntityRow = Selectable<EntitiesTable>;
export type IndexedFileFactRow = Selectable<IndexedFileFactsTable>;

export interface LookupIndex {
  entitiesByType: Map<ProposeEntityType, EntityRow[]>;
  byNormalizedName: Map<string, EntityRow[]>;
  byNormalizedAlias: Map<string, EntityRow[]>;
  bySourceRef: Map<string, EntityRow>;
  companyIdsByDomain: Map<string, string[]>;
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
  readEmail: (entity: Entity) => string | null;
  onEntityResolved: (entity: Entity) => void | Promise<void>;
  resolveOwner: (fact: IndexedFileFactRow) => string | null;
  llmPromotionThreshold: number;
}

export type MaterializeResult =
  | { kind: "entity_created"; entity: EntityRow; mentionWritten: boolean; countEntity?: boolean }
  | { kind: "entity_linked"; entity: EntityRow; mentionWritten: boolean; countEntity?: boolean }
  | { kind: "queued"; reviewId: string }
  | { kind: "queued_held"; reviewId: string; reason: "llm_ambiguous" | "non_person_collision" | "relation_endpoint" }
  | {
      kind: "relationship_materialized";
      entitiesCreated: number;
      entitiesLinked: number;
      mentionsWritten: number;
      relationshipsWritten: number;
    }
  | { kind: "structural"; entity: EntityRow }
  | { kind: "skipped_missing_owner"; reason: string }
  | { kind: "deferred_below_threshold"; reason: string }
  | { kind: "skipped"; reason: string };

export interface ReplaySourceFactsOptions {
  llmPromotionThreshold?: number;
}

export interface MaterializeProgress {
  phase: string;
  completed: number;
  total: number;
}

export interface MaterializeUnmaterializedOptions {
  llmPromotionThreshold?: number;
  factTypes?: IndexedFileFactType[];
  /**
   * Fires before processing each fact with `completed = index, total = facts.length`
   * and after the loop with `completed = total`. Used by the reset/reenrich job
   * watcher to surface live progress to the rebuild banner in the UI.
   */
  onProgress?: (progress: MaterializeProgress) => void;
  shouldCancel?: () => boolean;
}
