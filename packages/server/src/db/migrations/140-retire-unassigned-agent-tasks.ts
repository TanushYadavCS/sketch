import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE tasks
    SET valid_to = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE valid_to IS NULL
      AND status_authority = 'local'
      AND provenance IN ('brief', 'summary')
      AND assignee_entity_id IS NULL
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
