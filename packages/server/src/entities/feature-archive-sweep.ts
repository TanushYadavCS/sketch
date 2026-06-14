import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { whereLiveEntity } from "../db/repositories/entities";
import type { DB } from "../db/schema";

export interface FeatureArchiveSweepOptions {
  minMentions?: number;
  ageDays?: number;
  maxPerRun?: number;
  now?: () => number;
}

export interface FeatureArchiveSweepResult {
  scanned: number;
  archived: number;
  skippedRecent: number;
  skippedEnoughMentions: number;
  skippedNonLlmEvidence: number;
}

const DEFAULT_MIN_MENTIONS = 2;
const DEFAULT_AGE_DAYS = 30;
const DEFAULT_MAX_PER_RUN = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AI_MENTION_SOURCES = new Set(["llm_extraction"]);
const AI_FACT_TYPES = new Set(["llm_extracted", "llm_relation"]);

async function distinctMentionFileCount(db: Kysely<DB>, entityId: string): Promise<number> {
  const row = await db
    .selectFrom("entity_mentions")
    .select(sql<number>`COUNT(DISTINCT indexed_file_id)`.as("count"))
    .where("entity_id", "=", entityId)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function hasOnlyAiMentions(db: Kysely<DB>, entityId: string): Promise<boolean> {
  const rows = await db.selectFrom("entity_mentions").select("source").where("entity_id", "=", entityId).execute();
  return rows.every((row) => AI_MENTION_SOURCES.has(row.source));
}

async function hasNonLlmSourceRefs(db: Kysely<DB>, entityId: string): Promise<boolean> {
  const rows = await db.selectFrom("entity_source_refs").select("source").where("entity_id", "=", entityId).execute();
  return rows.some((row) => row.source !== "llm_extraction");
}

async function hasNonLlmRelationshipEvidence(db: Kysely<DB>, entityId: string): Promise<boolean> {
  const rows = await db
    .selectFrom("entity_relationships")
    .innerJoin(
      "entity_relationship_evidence",
      "entity_relationship_evidence.relationship_id",
      "entity_relationships.id",
    )
    .leftJoin("indexed_file_facts", "indexed_file_facts.id", "entity_relationship_evidence.source_fact_id")
    .select(["indexed_file_facts.fact_type", "entity_relationship_evidence.source_fact_id"])
    .where((eb) =>
      eb.or([
        eb("entity_relationships.source_entity_id", "=", entityId),
        eb("entity_relationships.target_entity_id", "=", entityId),
      ]),
    )
    .execute();
  return rows.some((row) => !row.source_fact_id || !AI_FACT_TYPES.has(row.fact_type ?? ""));
}

export async function runFeatureArchiveSweep(
  db: Kysely<DB>,
  logger: Logger,
  opts: FeatureArchiveSweepOptions = {},
): Promise<FeatureArchiveSweepResult> {
  const minMentions = opts.minMentions ?? DEFAULT_MIN_MENTIONS;
  const ageDays = opts.ageDays ?? DEFAULT_AGE_DAYS;
  const maxPerRun = opts.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const cutoff = new Date((opts.now ? opts.now() : Date.now()) - ageDays * DAY_MS).toISOString();
  const result: FeatureArchiveSweepResult = {
    scanned: 0,
    archived: 0,
    skippedRecent: 0,
    skippedEnoughMentions: 0,
    skippedNonLlmEvidence: 0,
  };

  const candidates = await db
    .selectFrom("entities")
    .select(["id", "created_at"])
    .where("source_type", "=", "feature")
    .where("status", "=", "confirmed")
    .where(whereLiveEntity())
    .where(
      sql<boolean>`EXISTS (
        SELECT 1 FROM entity_source_refs
        WHERE entity_source_refs.entity_id = entities.id
          AND entity_source_refs.source = 'llm_extraction'
      )`,
    )
    .orderBy("created_at", "asc")
    .limit(maxPerRun)
    .execute();

  result.scanned = candidates.length;
  const archiveIds: string[] = [];
  for (const candidate of candidates) {
    if (candidate.created_at > cutoff) {
      result.skippedRecent += 1;
      continue;
    }
    const mentionCount = await distinctMentionFileCount(db, candidate.id);
    if (mentionCount >= minMentions) {
      result.skippedEnoughMentions += 1;
      continue;
    }
    if (
      !(await hasOnlyAiMentions(db, candidate.id)) ||
      (await hasNonLlmSourceRefs(db, candidate.id)) ||
      (await hasNonLlmRelationshipEvidence(db, candidate.id))
    ) {
      result.skippedNonLlmEvidence += 1;
      continue;
    }
    archiveIds.push(candidate.id);
  }

  if (archiveIds.length > 0) {
    const now = new Date().toISOString();
    await db
      .updateTable("entities")
      .set({ status: "archived", updated_at: now })
      .where("id", "in", archiveIds)
      .execute();
    result.archived = archiveIds.length;
  }

  logger.info(result, "feature archive sweep complete");
  return result;
}
