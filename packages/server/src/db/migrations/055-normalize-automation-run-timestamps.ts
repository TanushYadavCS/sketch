/**
 * Normalize automation run timestamps from SQLite CURRENT_TIMESTAMP format
 * ("YYYY-MM-DD HH:MM:SS") to ISO 8601 UTC strings.
 */
import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`
      UPDATE automation_runs
      SET started_at = to_char(started_at::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      WHERE started_at NOT LIKE '%T%'
    `.execute(db);

    await sql`
      UPDATE automation_runs
      SET completed_at = to_char(completed_at::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      WHERE completed_at IS NOT NULL AND completed_at NOT LIKE '%T%'
    `.execute(db);
    return;
  }

  await sql`
    UPDATE automation_runs
    SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at)
    WHERE started_at NOT LIKE '%T%'
  `.execute(db);

  await sql`
    UPDATE automation_runs
    SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)
    WHERE completed_at IS NOT NULL AND completed_at NOT LIKE '%T%'
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
