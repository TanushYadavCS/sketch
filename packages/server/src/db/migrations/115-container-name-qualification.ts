import { type Kysely, sql } from "kysely";
import { qualifyContainerName } from "../../connectors/container-name";
import { normalizeEntityMatchName } from "../../entities/materialize-deps";

interface SeedFactRow {
  subject_name: string | null;
  raw: string | null;
  source: string;
  subject_source: string | null;
  subject_source_id: string | null;
}

interface EntityCandidateRow extends SeedFactRow {
  entity_id: string;
  entity_name: string;
  entity_aliases: string | null;
}

interface QueueCandidateRow {
  id: string;
  proposed_name: string;
  normalized_name: string;
  entity_type: string;
  seed_source: string | null;
  seed_source_id: string | null;
}

interface MigrationDb {
  entities: {
    id: string;
    name: string;
    source_type: string;
    aliases: string | null;
    updated_at: string;
    deleted_at: string | null;
    merged_into_entity_id: string | null;
  };
  entity_source_refs: {
    id: string;
    entity_id: string;
    source: string;
    source_id: string;
  };
  indexed_file_facts: {
    id: string;
    source: string;
    fact_type: string;
    subject_name: string | null;
    subject_source: string | null;
    subject_source_id: string | null;
    raw: string | null;
    deleted_at: string | null;
  };
  entity_review_queue: {
    id: string;
    proposed_name: string;
    normalized_name: string;
    entity_type: string;
    status: string;
    seed_source: string | null;
    seed_source_id: string | null;
    seed_aliases: string | null;
  };
}

async function hasColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  return tables.some((table) => table.name === tableName && table.columns.some((column) => column.name === columnName));
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function readNestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const nested = value[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readBareLeaf(raw: Record<string, unknown> | null, subjectName: string | null): string | null {
  const aliases = raw?.aliases;
  if (Array.isArray(aliases)) {
    const alias = aliases.find((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (alias) return alias;
  }
  return readString(raw?.name) ?? readString(subjectName);
}

function readQualifier(source: string, raw: Record<string, unknown> | null): string | null {
  const metadata = raw ? readNestedRecord(raw, "metadata") : null;
  if (source === "linear") {
    const teams = metadata?.teams;
    if (!Array.isArray(teams) || teams.length !== 1) return null;
    return readString(teams[0]);
  }
  if (source === "clickup") return readString(metadata?.spaceName);
  return null;
}

function unionAlias(aliases: string[], alias: string): string[] {
  const trimmed = alias.trim();
  if (!trimmed) return aliases;
  if (aliases.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return aliases;
  return [...aliases, trimmed];
}

async function addSeedAliasesColumn(db: Kysely<unknown>): Promise<void> {
  if (await hasColumn(db, "entity_review_queue", "seed_aliases")) return;
  await db.schema.alterTable("entity_review_queue").addColumn("seed_aliases", "text").execute();
}

async function isNormalizedNameTaken(
  db: Kysely<MigrationDb>,
  row: QueueCandidateRow,
  normalizedName: string,
): Promise<boolean> {
  const colliding = await db
    .selectFrom("entity_review_queue")
    .select(["id"])
    .where("normalized_name", "=", normalizedName)
    .where("entity_type", "=", row.entity_type)
    .where("id", "!=", row.id)
    .executeTakeFirst();
  return Boolean(colliding);
}

/**
 * Returns a collision-free `normalized_name` honoring the unique
 * `(normalized_name, entity_type)` index, or null if even the seed-handle
 * fallback is already taken (caller skips the row rather than failing the
 * migration).
 */
async function normalizedQueueName(
  db: Kysely<MigrationDb>,
  row: QueueCandidateRow,
  normalizedName: string,
): Promise<string | null> {
  if (!(await isNormalizedNameTaken(db, row, normalizedName))) return normalizedName;
  const fallback = `${normalizedName}:${row.seed_source}:${row.seed_source_id}`;
  if (!(await isNormalizedNameTaken(db, row, fallback))) return fallback;
  return null;
}

async function findSeedFact(
  db: Kysely<MigrationDb>,
  source: string,
  sourceId: string,
): Promise<SeedFactRow | undefined> {
  return db
    .selectFrom("indexed_file_facts")
    .select(["source", "subject_source", "subject_source_id", "subject_name", "raw"])
    .where("fact_type", "=", "structural_seed")
    .where("deleted_at", "is", null)
    .where("subject_source", "=", source)
    .where("subject_source_id", "=", sourceId)
    .executeTakeFirst();
}

async function backfillQueueContainerNames(db: Kysely<MigrationDb>): Promise<void> {
  const rows = await db
    .selectFrom("entity_review_queue")
    .select(["id", "proposed_name", "normalized_name", "entity_type", "seed_source", "seed_source_id"])
    .where("entity_type", "=", "project")
    .where("status", "=", "pending")
    .where("seed_source", "in", ["linear", "clickup"])
    .where("seed_source_id", "is not", null)
    .execute();

  for (const row of rows as QueueCandidateRow[]) {
    if (!row.seed_source || !row.seed_source_id) continue;
    const fact = await findSeedFact(db, row.seed_source, row.seed_source_id);
    if (!fact) continue;

    const raw = parseJsonObject(fact.raw);
    const bareLeaf = readBareLeaf(raw, fact.subject_name);
    const qualifier = readQualifier(row.seed_source, raw);
    if (!bareLeaf || !qualifier || row.proposed_name !== bareLeaf) continue;

    const qualifiedName = qualifyContainerName(bareLeaf, qualifier);
    if (qualifiedName === bareLeaf) continue;

    const normalizedName = await normalizedQueueName(db, row, normalizeEntityMatchName(row.entity_type, qualifiedName));
    if (normalizedName === null) continue;
    await db
      .updateTable("entity_review_queue")
      .set({
        proposed_name: qualifiedName,
        normalized_name: normalizedName,
        seed_aliases: JSON.stringify([bareLeaf]),
      })
      .where("id", "=", row.id)
      .where("proposed_name", "=", bareLeaf)
      .execute();
  }
}

async function backfillEntityContainerNames(db: Kysely<MigrationDb>): Promise<void> {
  const rows = await db
    .selectFrom("entities")
    .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
    .innerJoin("indexed_file_facts", (join) =>
      join
        .onRef("indexed_file_facts.subject_source", "=", "entity_source_refs.source")
        .onRef("indexed_file_facts.subject_source_id", "=", "entity_source_refs.source_id"),
    )
    .select([
      "entities.id as entity_id",
      "entities.name as entity_name",
      "entities.aliases as entity_aliases",
      "indexed_file_facts.subject_name as subject_name",
      "indexed_file_facts.raw as raw",
      "entity_source_refs.source as source",
      "indexed_file_facts.subject_source as subject_source",
      "indexed_file_facts.subject_source_id as subject_source_id",
    ])
    .where("entities.source_type", "=", "project")
    .where("entities.deleted_at", "is", null)
    .where("entities.merged_into_entity_id", "is", null)
    .where("entity_source_refs.source", "in", ["linear", "clickup"])
    .where("indexed_file_facts.fact_type", "=", "structural_seed")
    .where("indexed_file_facts.deleted_at", "is", null)
    .execute();

  for (const row of rows as EntityCandidateRow[]) {
    const raw = parseJsonObject(row.raw);
    const bareLeaf = readBareLeaf(raw, row.subject_name);
    const qualifier = readQualifier(row.source, raw);
    if (!bareLeaf || !qualifier || row.entity_name !== bareLeaf) continue;

    const qualifiedName = qualifyContainerName(bareLeaf, qualifier);
    if (qualifiedName === bareLeaf) continue;

    const entityAliases = unionAlias(parseStringArray(row.entity_aliases), bareLeaf);
    await db
      .updateTable("entities")
      .set({
        name: qualifiedName,
        aliases: JSON.stringify(entityAliases),
        updated_at: sql`CURRENT_TIMESTAMP`,
      })
      .where("id", "=", row.entity_id)
      .where("name", "=", bareLeaf)
      .execute();
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await addSeedAliasesColumn(db);
  await backfillQueueContainerNames(db as Kysely<MigrationDb>);
  await backfillEntityContainerNames(db as Kysely<MigrationDb>);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await hasColumn(db, "entity_review_queue", "seed_aliases"))) return;
  await db.schema.alterTable("entity_review_queue").dropColumn("seed_aliases").execute();
}
