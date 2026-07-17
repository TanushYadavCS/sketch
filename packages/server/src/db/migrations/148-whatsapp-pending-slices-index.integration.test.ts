import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { isPg } from "../dialect";
import type { DB } from "../schema";
import * as migration from "./148-whatsapp-pending-slices-index";

const INDEX_NAME = "idx_conversation_slices_pending_salience";

async function readIndexDefinition(db: Kysely<DB>): Promise<string | null> {
  if (isPg(db)) {
    const result = await sql<{ definition: string }>`SELECT indexdef AS definition
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'conversation_slices'
        AND indexname = ${INDEX_NAME}`.execute(db);
    return result.rows[0]?.definition ?? null;
  }
  const result = await sql<{ definition: string }>`SELECT sql AS definition
    FROM sqlite_master
    WHERE type = 'index'
      AND tbl_name = 'conversation_slices'
      AND name = ${INDEX_NAME}`.execute(db);
  return result.rows[0]?.definition ?? null;
}

function runMigrationSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await migration.down(db as unknown as Kysely<unknown>);
      await migration.up(db as unknown as Kysely<unknown>);
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("creates and removes the pending-salience partial index", async () => {
      const definition = (await readIndexDefinition(db))?.toLowerCase().replaceAll('"', "") ?? "";
      expect(definition).toContain("conversation_slices");
      expect(definition).toContain("salience_verdict");
      expect(definition).toMatch(/where\s+\(?salience_verdict is null\)?/u);

      await migration.down(db as unknown as Kysely<unknown>);
      await expect(readIndexDefinition(db)).resolves.toBeNull();
    });
  });
}

runMigrationSuite("148 WhatsApp pending slices index migration SQLite", createTestDb);
runMigrationSuite("148 WhatsApp pending slices index migration Postgres", createTestPgDb);
