import { type Kysely, sql } from "kysely";

async function hasTable(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  return tables.some((table) => table.name === tableName);
}

async function hasColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  return tables.some((table) => table.name === tableName && table.columns.some((column) => column.name === columnName));
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await hasColumn(db, "entity_review_queue", "candidate_user_ids"))) {
    await db.schema.alterTable("entity_review_queue").addColumn("candidate_user_ids", "text").execute();
  }
  await sql`CREATE INDEX IF NOT EXISTS idx_entity_review_queue_source_source_id
    ON entity_review_queue(source, source_id)`.execute(db);

  if (!(await hasTable(db, "user_entity_links"))) {
    await db.schema
      .createTable("user_entity_links")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
      .addColumn("entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
      .addColumn("matched_via", "text", (col) => col.notNull())
      .addColumn("confirmed_by_user_id", "text", (col) => col.references("users.id").onDelete("set null"))
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint("user_entity_links_user_unique", ["user_id"])
      .addUniqueConstraint("user_entity_links_entity_unique", ["entity_id"])
      .execute();
  }

  if (!(await hasTable(db, "user_entity_link_sweep_runs"))) {
    await db.schema
      .createTable("user_entity_link_sweep_runs")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("run_key", "text", (col) => col.notNull())
      .addColumn("lease_token", "text")
      .addColumn("status", "text", (col) => col.notNull())
      .addColumn("stage", "text", (col) => col.notNull())
      .addColumn("entity_cursor", "text")
      .addColumn("user_cursor", "text")
      .addColumn("heartbeat_at", "text")
      .addColumn("linked_by_email", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("linked_by_phone", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("linked_by_user_creation", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("provisioned", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("review_queued", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("skipped", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("started_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn("completed_at", "text")
      .addColumn("error", "text")
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint("user_entity_link_sweep_runs_key_unique", ["run_key"])
      .execute();
  } else {
    if (!(await hasColumn(db, "user_entity_link_sweep_runs", "lease_token"))) {
      await db.schema.alterTable("user_entity_link_sweep_runs").addColumn("lease_token", "text").execute();
    }
    if (!(await hasColumn(db, "user_entity_link_sweep_runs", "linked_by_user_creation"))) {
      await db.schema
        .alterTable("user_entity_link_sweep_runs")
        .addColumn("linked_by_user_creation", "integer", (col) => col.notNull().defaultTo(0))
        .execute();
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (await hasTable(db, "user_entity_link_sweep_runs")) {
    await db.schema.dropTable("user_entity_link_sweep_runs").execute();
  }
  if (await hasTable(db, "user_entity_links")) {
    await db.schema.dropTable("user_entity_links").execute();
  }
  if (await hasColumn(db, "entity_review_queue", "candidate_user_ids")) {
    await db.schema.alterTable("entity_review_queue").dropColumn("candidate_user_ids").execute();
  }
  await sql`DROP INDEX IF EXISTS idx_entity_review_queue_source_source_id`.execute(db);
}
