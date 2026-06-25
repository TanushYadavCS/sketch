import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const TABLE = "scheduled_tasks";

export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);

  if (!columns.has("updated_at")) {
    if (!isPg(db)) {
      await rebuildSqliteTableWithRevisionColumns(db);
      return;
    }
    await addUpdatedAtColumn(db);
  }
  if (!columns.has("revision")) {
    await addRevisionColumn(db);
  }
  if (!columns.has("last_edited_by")) {
    await db.schema.alterTable(TABLE).addColumn("last_edited_by", "text").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);

  if (columns.has("last_edited_by")) {
    await db.schema.alterTable(TABLE).dropColumn("last_edited_by").execute();
  }
  if (columns.has("revision")) {
    await db.schema.alterTable(TABLE).dropColumn("revision").execute();
  }
  if (columns.has("updated_at")) {
    await db.schema.alterTable(TABLE).dropColumn("updated_at").execute();
  }
}

async function getColumns(db: Kysely<unknown>): Promise<Set<string>> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === TABLE);
  return new Set(table?.columns.map((column) => column.name) ?? []);
}

async function addUpdatedAtColumn(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable(TABLE)
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

async function addRevisionColumn(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable(TABLE)
    .addColumn("revision", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
}

async function rebuildSqliteTableWithRevisionColumns(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE scheduled_tasks RENAME TO scheduled_tasks_107_old`.execute(db);
  await sql`
    CREATE TABLE scheduled_tasks (
      id text PRIMARY KEY,
      platform text NOT NULL,
      context_type text NOT NULL,
      delivery_target text NOT NULL,
      thread_ts text,
      prompt text NOT NULL,
      schedule_type text NOT NULL,
      schedule_value text NOT NULL,
      timezone text DEFAULT 'UTC',
      session_mode text NOT NULL DEFAULT 'fresh',
      next_run_at text,
      last_run_at text,
      status text NOT NULL DEFAULT 'active',
      created_by text,
      created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      title text,
      description text,
      steps text,
      edges text,
      output_target text,
      output_platform text,
      output_mode text NOT NULL DEFAULT 'deliver',
      output_thread_ts text,
      updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revision integer NOT NULL DEFAULT 0,
      last_edited_by text
    )
  `.execute(db);
  await sql`
    INSERT INTO scheduled_tasks (
      id,
      platform,
      context_type,
      delivery_target,
      thread_ts,
      prompt,
      schedule_type,
      schedule_value,
      timezone,
      session_mode,
      next_run_at,
      last_run_at,
      status,
      created_by,
      created_at,
      title,
      description,
      steps,
      edges,
      output_target,
      output_platform,
      output_mode,
      output_thread_ts,
      updated_at,
      revision,
      last_edited_by
    )
    SELECT
      id,
      platform,
      context_type,
      delivery_target,
      thread_ts,
      prompt,
      schedule_type,
      schedule_value,
      timezone,
      session_mode,
      next_run_at,
      last_run_at,
      status,
      created_by,
      created_at,
      title,
      description,
      steps,
      edges,
      output_target,
      output_platform,
      output_mode,
      output_thread_ts,
      CURRENT_TIMESTAMP,
      0,
      NULL
    FROM scheduled_tasks_107_old
  `.execute(db);
  await sql`DROP TABLE scheduled_tasks_107_old`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status)`.execute(db);
}
