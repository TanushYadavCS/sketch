import type { Kysely } from "kysely";
import { sql } from "kysely";

interface MigrationDb {
  entities: {
    id: string;
    metadata: string | null;
    provenance_tier: string;
  };
  entity_source_refs: {
    entity_id: string;
    source: string;
    source_id: string;
  };
  indexed_file_facts: {
    id: string;
    source: string;
    fact_type: string;
    subject_source: string | null;
    subject_source_id: string | null;
    deleted_at: string | null;
  };
  entity_review_queue: {
    status: string;
    resolved_entity_id: string | null;
  };
}

async function hasColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  return tables.some((table) => table.name === tableName && table.columns.some((column) => column.name === columnName));
}

async function updateTier(db: Kysely<MigrationDb>, ids: string[], tier: string): Promise<void> {
  if (ids.length === 0) return;
  await db.updateTable("entities").set({ provenance_tier: tier }).where("id", "in", ids).execute();
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function positiveManualMarker(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase().replace(/[-\s]/g, "_");
  return normalized === "manual" || normalized === "human" || normalized === "user" || normalized === "non_ai";
}

/**
 * Historical manual creation was not represented by a stable source column.
 * This deliberately requires an explicit metadata marker such as
 * `origin: "manual"` or `createdBy: "user"` and no source refs; ambiguous
 * no-ref rows stay inferred.
 */
function isDeclaredHistoricalEntity(metadata: string | null): boolean {
  const parsed = parseMetadata(metadata);
  if (!parsed) return false;
  return (
    positiveManualMarker(parsed.origin) ||
    positiveManualMarker(parsed.source) ||
    positiveManualMarker(parsed.createdBy) ||
    positiveManualMarker(parsed.created_by) ||
    positiveManualMarker(parsed.creationSource) ||
    positiveManualMarker(parsed.manual)
  );
}

async function backfillStructural(db: Kysely<MigrationDb>): Promise<void> {
  const rows = await db
    .selectFrom("entity_source_refs as refs")
    .leftJoin("indexed_file_facts as facts", (join) =>
      join
        .onRef("facts.subject_source", "=", "refs.source")
        .onRef("facts.subject_source_id", "=", "refs.source_id")
        .on("facts.fact_type", "=", "structural_seed")
        .on(sql<boolean>`facts.deleted_at IS NULL`),
    )
    .select("refs.entity_id")
    .distinct()
    .where((eb) => eb.or([eb("refs.source", "=", "team"), eb("facts.id", "is not", null)]))
    .execute();
  await updateTier(
    db,
    rows.map((row) => row.entity_id),
    "structural",
  );
}

/**
 * `entity_review_queue.status = "confirmed"` is the approved terminal state;
 * rejected rows also carry `resolved_entity_id` for idempotency but are not
 * approval evidence for historical backfill.
 */
async function backfillHumanConfirmed(db: Kysely<MigrationDb>): Promise<void> {
  const rows = await db
    .selectFrom("entity_review_queue")
    .select("resolved_entity_id")
    .distinct()
    .where("status", "=", "confirmed")
    .where("resolved_entity_id", "is not", null)
    .execute();
  await updateTier(
    db,
    rows.map((row) => row.resolved_entity_id).filter((id): id is string => typeof id === "string"),
    "human_confirmed",
  );
}

async function backfillDeclared(db: Kysely<MigrationDb>): Promise<void> {
  const rows = await db
    .selectFrom("entities")
    .select(["id", "metadata"])
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("entity_source_refs")
            .select("entity_source_refs.entity_id")
            .whereRef("entity_source_refs.entity_id", "=", "entities.id"),
        ),
      ),
    )
    .execute();
  await updateTier(
    db,
    rows.filter((row) => isDeclaredHistoricalEntity(row.metadata)).map((row) => row.id),
    "declared",
  );
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await hasColumn(db, "entities", "provenance_tier"))) {
    await db.schema
      .alterTable("entities")
      .addColumn("provenance_tier", "text", (col) => col.notNull().defaultTo("inferred"))
      .execute();
  }
  await sql`CREATE INDEX IF NOT EXISTS idx_entities_provenance_tier ON entities(provenance_tier)`.execute(db);
  const typedDb = db as Kysely<MigrationDb>;
  await backfillStructural(typedDb);
  await backfillHumanConfirmed(typedDb);
  await backfillDeclared(typedDb);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_entities_provenance_tier`.execute(db);
  if (!(await hasColumn(db, "entities", "provenance_tier"))) return;
  await db.schema.alterTable("entities").dropColumn("provenance_tier").execute();
}
