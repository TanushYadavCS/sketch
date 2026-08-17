import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { isPg } from "../dialect";
import type { DB } from "../schema";
import * as migration from "./194-remove-scheduled-task-builder-locks";

const TABLE = "scheduled_task_builder_locks";

async function tableExists(db: Kysely<DB>): Promise<boolean> {
  if (isPg(db)) {
    const result = await sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${TABLE}
    `.execute(db);
    return result.rows.length === 1;
  }

  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${TABLE}
  `.execute(db);
  return result.rows.length === 1;
}

function runMigrationSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("drops the legacy table and recreates its historical shape on down", async () => {
      await expect(tableExists(db)).resolves.toBe(false);

      await migration.down(db as unknown as Kysely<unknown>);
      await expect(tableExists(db)).resolves.toBe(true);

      const expiresAt = Date.now() + 5 * 60 * 1000;
      await sql`
        INSERT INTO ${sql.table(TABLE)}
          (task_id, conversation_id, transcript_user_id, expires_at)
        VALUES ('legacy-task', 'legacy-conversation', 'legacy-user', ${expiresAt})
      `.execute(db);

      const row = await sql<{ task_id: string; expires_at: number | string }>`
        SELECT task_id, expires_at
        FROM ${sql.table(TABLE)}
        WHERE task_id = 'legacy-task'
      `.execute(db);
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]?.task_id).toBe("legacy-task");
      expect(Number(row.rows[0]?.expires_at)).toBe(expiresAt);

      await migration.up(db as unknown as Kysely<unknown>);
      await expect(tableExists(db)).resolves.toBe(false);
    });
  });
}

runMigrationSuite("194 legacy builder-lock removal migration SQLite", createTestDb);
runMigrationSuite("194 legacy builder-lock removal migration Postgres", createTestPgDb);
