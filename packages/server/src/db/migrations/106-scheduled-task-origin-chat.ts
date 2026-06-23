import { type Kysely, sql } from "kysely";

const TABLE = "scheduled_tasks";

export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);

  if (!columns.has("origin_platform")) {
    await db.schema.alterTable(TABLE).addColumn("origin_platform", "text").execute();
  }
  if (!columns.has("origin_conversation_id")) {
    await db.schema.alterTable(TABLE).addColumn("origin_conversation_id", "text").execute();
  }
  if (!columns.has("origin_provider_thread_id")) {
    await db.schema.alterTable(TABLE).addColumn("origin_provider_thread_id", "text").execute();
  }
  if (!columns.has("origin_message_id")) {
    await db.schema.alterTable(TABLE).addColumn("origin_message_id", "integer").execute();
  }

  await sql`CREATE INDEX IF NOT EXISTS scheduled_tasks_origin_chat_idx ON scheduled_tasks(origin_platform, origin_conversation_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS scheduled_tasks_origin_chat_idx`.execute(db);
  const columns = await getColumns(db);

  if (columns.has("origin_message_id")) {
    await db.schema.alterTable(TABLE).dropColumn("origin_message_id").execute();
  }
  if (columns.has("origin_provider_thread_id")) {
    await db.schema.alterTable(TABLE).dropColumn("origin_provider_thread_id").execute();
  }
  if (columns.has("origin_conversation_id")) {
    await db.schema.alterTable(TABLE).dropColumn("origin_conversation_id").execute();
  }
  if (columns.has("origin_platform")) {
    await db.schema.alterTable(TABLE).dropColumn("origin_platform").execute();
  }
}

async function getColumns(db: Kysely<unknown>): Promise<Set<string>> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === TABLE);
  return new Set(table?.columns.map((column) => column.name) ?? []);
}
