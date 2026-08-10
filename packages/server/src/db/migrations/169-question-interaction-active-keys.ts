import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  const table = (await db.introspection.getTables()).find((candidate) => candidate.name === "question_interactions");
  const columns = new Set(table?.columns.map((column) => column.name) ?? []);
  if (!columns.has("active_scope_key")) {
    await db.schema.alterTable("question_interactions").addColumn("active_scope_key", "text").execute();
  }
  if (!columns.has("active_task_key")) {
    await db.schema.alterTable("question_interactions").addColumn("active_task_key", "text").execute();
  }
  await db.schema.createIndex("question_interactions_active_scope").ifNotExists().unique().on("question_interactions").column("active_scope_key").execute();
  await db.schema.createIndex("question_interactions_active_task").ifNotExists().unique().on("question_interactions").column("active_task_key").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("question_interactions_active_task").ifExists().execute();
  await db.schema.dropIndex("question_interactions_active_scope").ifExists().execute();
  await db.schema.alterTable("question_interactions").dropColumn("active_task_key").execute();
  await db.schema.alterTable("question_interactions").dropColumn("active_scope_key").execute();
}
