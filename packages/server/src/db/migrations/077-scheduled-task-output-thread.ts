import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("scheduled_tasks").addColumn("output_thread_ts", "text").execute();

  await sql`
    UPDATE scheduled_tasks
    SET output_thread_ts = thread_ts
    WHERE platform = 'slack'
      AND context_type = 'channel'
      AND thread_ts IS NOT NULL
      AND (output_target IS NULL OR output_target = delivery_target)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("scheduled_tasks").dropColumn("output_thread_ts").execute();
}
