/**
 * Rehomes legacy Linear project entities from the indexed-file promotion path.
 * Old promotion facts used provider ids like `project-{id}` and replayed as
 * `linear_project`; native Linear project seeds now use bare ids and `project`.
 */
import { type Kysely, sql } from "kysely";

interface EntitySourceRefRow {
  id: string;
  entity_id: string;
  source_id: string;
}

interface IndexedFileFactRow {
  id: string;
  raw: string | null;
}

interface MigrationDb {
  entities: {
    id: string;
    source_type: string;
    updated_at: string;
  };
  entity_source_refs: {
    id: string;
    entity_id: string;
    source: string;
    source_id: string;
    last_seen_at: string;
  };
  indexed_file_facts: {
    id: string;
    source: string;
    fact_type: string;
    subject_source: string | null;
    subject_source_id: string | null;
    raw: string | null;
    deleted_at: string | null;
    materialized_at: string | null;
    updated_at: string;
  };
}

function bareLinearProjectId(sourceId: string): string | null {
  if (!sourceId.startsWith("project-")) return null;
  const bare = sourceId.slice("project-".length);
  return bare.length > 0 ? bare : null;
}

function isLegacyLinearProjectPromotionFact(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { fileType?: unknown };
    return parsed.fileType === "project";
  } catch {
    return false;
  }
}

async function rewriteLegacySourceRefs(db: Kysely<MigrationDb>): Promise<void> {
  const legacyRefs = await db
    .selectFrom("entity_source_refs")
    .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
    .select(["entity_source_refs.id", "entity_source_refs.entity_id", "entity_source_refs.source_id"])
    .where("entity_source_refs.source", "=", "linear")
    .where("entity_source_refs.source_id", "like", "project-%")
    .where("entities.source_type", "=", "linear_project")
    .execute();

  for (const legacyRef of legacyRefs as EntitySourceRefRow[]) {
    const bareId = bareLinearProjectId(legacyRef.source_id);
    if (!bareId) continue;

    const existingBareRef = await db
      .selectFrom("entity_source_refs")
      .select(["id", "entity_id", "source_id"])
      .where("source", "=", "linear")
      .where("source_id", "=", bareId)
      .executeTakeFirst();

    if (existingBareRef) {
      await db.deleteFrom("entity_source_refs").where("id", "=", legacyRef.id).execute();
      if (existingBareRef.entity_id !== legacyRef.entity_id) {
        await db
          .deleteFrom("entities")
          .where("id", "=", legacyRef.entity_id)
          .where("source_type", "=", "linear_project")
          .execute();
      }
      continue;
    }

    await db
      .updateTable("entity_source_refs")
      .set({
        source_id: bareId,
        last_seen_at: sql`CURRENT_TIMESTAMP`,
      })
      .where("id", "=", legacyRef.id)
      .execute();
  }
}

async function tombstoneLegacyPromotionFacts(db: Kysely<MigrationDb>): Promise<void> {
  const candidateFacts = await db
    .selectFrom("indexed_file_facts")
    .select(["id", "raw"])
    .where("source", "=", "linear")
    .where("fact_type", "=", "structural_seed")
    .where("subject_source", "=", "linear")
    .where("subject_source_id", "like", "project-%")
    .where("deleted_at", "is", null)
    .execute();

  for (const fact of candidateFacts as IndexedFileFactRow[]) {
    if (!isLegacyLinearProjectPromotionFact(fact.raw)) continue;
    await db
      .updateTable("indexed_file_facts")
      .set({
        deleted_at: sql`CURRENT_TIMESTAMP`,
        materialized_at: sql`CURRENT_TIMESTAMP`,
        updated_at: sql`CURRENT_TIMESTAMP`,
      })
      .where("id", "=", fact.id)
      .execute();
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const typedDb = db as Kysely<MigrationDb>;

  await rewriteLegacySourceRefs(typedDb);
  await typedDb
    .updateTable("entities")
    .set({
      source_type: "project",
      updated_at: sql`CURRENT_TIMESTAMP`,
    })
    .where("source_type", "=", "linear_project")
    .execute();
  await tombstoneLegacyPromotionFacts(typedDb);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
