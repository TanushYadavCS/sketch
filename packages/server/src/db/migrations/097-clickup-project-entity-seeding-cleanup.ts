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
    raw: string | null;
    deleted_at: string | null;
    materialized_at: string | null;
    updated_at: string;
  };
}

function isLegacyClickUpFolderSeedFact(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { sourceType?: unknown };
    return parsed.sourceType === "clickup_folder";
  } catch {
    return false;
  }
}

async function dropLegacyFolderRowsThatAlreadyHaveProjectRefs(db: Kysely<MigrationDb>): Promise<void> {
  const legacyRefs = await db
    .selectFrom("entity_source_refs")
    .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
    .select(["entity_source_refs.id", "entity_source_refs.entity_id", "entity_source_refs.source_id"])
    .where("entity_source_refs.source", "=", "clickup")
    .where("entities.source_type", "=", "clickup_folder")
    .execute();

  for (const legacyRef of legacyRefs as EntitySourceRefRow[]) {
    const projectRef = await db
      .selectFrom("entity_source_refs")
      .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
      .select(["entity_source_refs.id", "entity_source_refs.entity_id", "entity_source_refs.source_id"])
      .where("entity_source_refs.source", "=", "clickup")
      .where("entity_source_refs.source_id", "=", legacyRef.source_id)
      .where("entity_source_refs.entity_id", "!=", legacyRef.entity_id)
      .where("entities.source_type", "=", "project")
      .executeTakeFirst();

    if (!projectRef) continue;
    await db.deleteFrom("entity_source_refs").where("id", "=", legacyRef.id).execute();
    await db
      .deleteFrom("entities")
      .where("id", "=", legacyRef.entity_id)
      .where("source_type", "=", "clickup_folder")
      .execute();
  }
}

async function tombstoneLegacyFolderSeedFacts(db: Kysely<MigrationDb>): Promise<void> {
  const candidateFacts = await db
    .selectFrom("indexed_file_facts")
    .select(["id", "raw"])
    .where("source", "=", "clickup")
    .where("fact_type", "=", "structural_seed")
    .where("deleted_at", "is", null)
    .execute();

  for (const fact of candidateFacts as IndexedFileFactRow[]) {
    if (!isLegacyClickUpFolderSeedFact(fact.raw)) continue;
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

  await dropLegacyFolderRowsThatAlreadyHaveProjectRefs(typedDb);
  await typedDb
    .updateTable("entities")
    .set({
      source_type: "project",
      updated_at: sql`CURRENT_TIMESTAMP`,
    })
    .where("source_type", "=", "clickup_folder")
    .execute();
  await typedDb
    .updateTable("entity_source_refs")
    .set({ last_seen_at: sql`CURRENT_TIMESTAMP` })
    .where("source", "=", "clickup")
    .where("entity_id", "in", typedDb.selectFrom("entities").select("id").where("source_type", "=", "project"))
    .execute();
  await tombstoneLegacyFolderSeedFacts(typedDb);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
