import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE scheduled_tasks SET session_mode = 'fresh' WHERE session_mode <> 'fresh'`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
