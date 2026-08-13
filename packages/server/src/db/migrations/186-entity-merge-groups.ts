import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const ENTITY_MERGE_COLUMNS = [
  "id",
  "survivor_entity_id",
  "merged_entity_id",
  "entity_type",
  "moves",
  "merged_by_user_id",
  "merged_at",
  "unmerged_at",
  "unmerged_by_user_id",
  "group_id",
  "merged_by",
] as const;

async function hasColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  return tables.some((table) => table.name === tableName && table.columns.some((column) => column.name === columnName));
}

async function createLedgerIndexes(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS entity_merges_survivor_idx ON entity_merges(survivor_entity_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS entity_merges_merged_idx ON entity_merges(merged_entity_id)`.execute(db);
}

async function createIndexes(db: Kysely<unknown>): Promise<void> {
  await createLedgerIndexes(db);
  await sql`CREATE INDEX IF NOT EXISTS entity_merges_group_idx ON entity_merges(group_id)`.execute(db);
}

async function rebuildSqlite(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS entity_merges_171_old`.execute(db);
  await sql`DROP INDEX IF EXISTS entity_merges_survivor_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS entity_merges_merged_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS entity_merges_group_idx`.execute(db);

  const hasGroupId = await hasColumn(db, "entity_merges", "group_id");
  const hasMergedBy = await hasColumn(db, "entity_merges", "merged_by");
  await sql`ALTER TABLE entity_merges RENAME TO entity_merges_171_old`.execute(db);
  await db.schema
    .createTable("entity_merges")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("survivor_entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("restrict"))
    .addColumn("merged_entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("restrict"))
    .addColumn("entity_type", "text", (col) => col.notNull())
    .addColumn("moves", "text", (col) => col.notNull())
    .addColumn("merged_by_user_id", "text", (col) => col.references("users.id").onDelete("restrict"))
    .addColumn("merged_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("unmerged_at", "text")
    .addColumn("unmerged_by_user_id", "text", (col) => col.references("users.id").onDelete("restrict"))
    .addColumn("group_id", "text")
    .addColumn("merged_by", "text")
    .execute();

  const columnList = sql.raw(ENTITY_MERGE_COLUMNS.join(", "));
  const groupIdSelect = hasGroupId ? sql.raw("group_id") : sql`NULL`;
  const mergedBySelect = hasMergedBy ? sql.raw("merged_by") : sql`NULL`;
  await sql`INSERT INTO entity_merges (${columnList})
    SELECT id, survivor_entity_id, merged_entity_id, entity_type, moves, merged_by_user_id, merged_at,
      unmerged_at, unmerged_by_user_id, ${groupIdSelect}, ${mergedBySelect}
    FROM entity_merges_171_old`.execute(db);

  await sql`DROP TABLE IF EXISTS entity_merges_171_old`.execute(db);
  await createIndexes(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await db.schema.alterTable("entity_merges").addColumn("group_id", "text").execute();
    await db.schema.alterTable("entity_merges").addColumn("merged_by", "text").execute();
    await sql`ALTER TABLE entity_merges ALTER COLUMN merged_by_user_id DROP NOT NULL`.execute(db);
    await createIndexes(db);
    return;
  }

  await rebuildSqlite(db);
}

/**
 * Restoring `merged_by_user_id NOT NULL` discards every machine-authored merge —
 * the correction pass writes them with a null user by design, so there is no value
 * to keep them under. `unmergeEntities` reads the ledger to reverse a merge, so a
 * down migration also gives up the ability to reverse those merges. Reverse them
 * through `DELETE /api/entities/merges/groups/:groupId` first if that matters.
 *
 * The SQLite branch rebuilds without `group_id`, so it recreates only the two
 * ledger indexes. Calling `createIndexes` here would try to index a column that
 * no longer exists and the migration would throw.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS entity_merges_group_idx`.execute(db);
  if (isPg(db)) {
    await sql`ALTER TABLE entity_merges ALTER COLUMN merged_by_user_id SET NOT NULL`.execute(db);
    await db.schema.alterTable("entity_merges").dropColumn("merged_by").execute();
    await db.schema.alterTable("entity_merges").dropColumn("group_id").execute();
    return;
  }

  await sql`DROP TABLE IF EXISTS entity_merges_171_old`.execute(db);
  await sql`DROP INDEX IF EXISTS entity_merges_survivor_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS entity_merges_merged_idx`.execute(db);
  await sql`ALTER TABLE entity_merges RENAME TO entity_merges_171_old`.execute(db);
  await db.schema
    .createTable("entity_merges")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("survivor_entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("restrict"))
    .addColumn("merged_entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("restrict"))
    .addColumn("entity_type", "text", (col) => col.notNull())
    .addColumn("moves", "text", (col) => col.notNull())
    .addColumn("merged_by_user_id", "text", (col) => col.notNull().references("users.id").onDelete("restrict"))
    .addColumn("merged_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("unmerged_at", "text")
    .addColumn("unmerged_by_user_id", "text", (col) => col.references("users.id").onDelete("restrict"))
    .execute();
  await sql`INSERT INTO entity_merges (
      id, survivor_entity_id, merged_entity_id, entity_type, moves, merged_by_user_id, merged_at,
      unmerged_at, unmerged_by_user_id
    )
    SELECT id, survivor_entity_id, merged_entity_id, entity_type, moves, merged_by_user_id, merged_at,
      unmerged_at, unmerged_by_user_id
    FROM entity_merges_171_old
    WHERE merged_by_user_id IS NOT NULL`.execute(db);
  await sql`DROP TABLE IF EXISTS entity_merges_171_old`.execute(db);
  await createLedgerIndexes(db);
}
