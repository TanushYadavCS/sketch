import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS slack_file_access_backfill`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
