import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE task_durability_route_state
    SET mode = 'hybrid',
        seed_state = 'pending',
        seed_reviewed_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE source_key LIKE 'route:%'
      AND seed_state = 'reviewed'
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
