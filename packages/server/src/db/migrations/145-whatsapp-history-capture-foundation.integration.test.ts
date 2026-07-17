import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { isPg } from "../dialect";
import type { DB } from "../schema";
import * as migration from "./145-whatsapp-history-capture-foundation";

async function seedLegacyRows(db: Kysely<DB>) {
  await db
    .insertInto("conversations")
    .values({
      platform: "whatsapp",
      kind: "group",
      provider_conversation_id: "history-foundation@g.us",
      display_name: "History Foundation",
    })
    .execute();
  const conversation = await db
    .selectFrom("conversations")
    .select("id")
    .where("provider_conversation_id", "=", "history-foundation@g.us")
    .executeTakeFirstOrThrow();
  await sql`INSERT INTO conversation_messages
    (conversation_id, provider_message_id, sender_jid, sender_name, provider_timestamp, received_at)
    VALUES
      (${conversation.id}, 'valid-provider', 'sender@g.us', 'Sender', '2026-07-01T09:00:00.000Z', '2026-07-02T09:00:00.000Z'),
      (${conversation.id}, 'same-effective-later-id', 'sender@g.us', 'Sender', NULL, '2026-07-01T09:00:00.000Z'),
      (${conversation.id}, 'before-floor', 'sender@g.us', 'Sender', '2008-01-01T00:00:00.000Z', '2026-07-03T09:00:00.000Z'),
      (${conversation.id}, 'far-future', 'sender@g.us', 'Sender', '2099-01-01T00:00:00.000Z', '2026-07-04T09:00:00.000Z'),
      (${conversation.id}, 'missing-provider-time', 'sender@g.us', 'Sender', NULL, '2026-07-05T09:00:00.000Z')`.execute(
    db,
  );
  await db
    .insertInto("whatsapp_backfill_checkpoints")
    .values({
      group_jid: "history-foundation@g.us",
      last_fetched_key: "v1:legacy",
      status: "complete",
    })
    .execute();
}

async function expectEffectiveIndex(db: Kysely<DB>): Promise<void> {
  const rows = isPg(db)
    ? await sql<{ name: string }>`SELECT indexname AS name
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'conversation_messages'
          AND indexname = 'idx_conversation_messages_effective'`.execute(db)
    : await sql<{ name: string }>`SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'conversation_messages'
          AND name = 'idx_conversation_messages_effective'`.execute(db);
  expect(rows.rows).toEqual([{ name: "idx_conversation_messages_effective" }]);
}

async function expectSourceNotNull(db: Kysely<DB>): Promise<void> {
  if (isPg(db)) {
    const row = await sql<{ is_nullable: string }>`SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'conversation_messages'
        AND column_name = 'source'`.execute(db);
    expect(row.rows).toEqual([{ is_nullable: "NO" }]);
    return;
  }
  const rows = await sql<{ name: string; notnull: number }>`PRAGMA table_info('conversation_messages')`.execute(db);
  expect(rows.rows.find((row) => row.name === "source")?.notnull).toBe(1);
}

function runMigrationSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await migration.down(db as unknown as Kysely<unknown>);
      await seedLegacyRows(db);
      await migration.up(db as unknown as Kysely<unknown>);
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("backfills provenance, effective timestamps, the live boundary, and the effective keyset index", async () => {
      const rows = await db
        .selectFrom("conversation_messages")
        .select(["id", "provider_message_id", "source", "effective_at", "connection_key", "backfill_range_id"])
        .orderBy("id", "asc")
        .execute();

      expect(
        rows.map((row) => ({
          providerMessageId: row.provider_message_id,
          source: row.source,
          effectiveAt: row.effective_at,
          connectionKey: row.connection_key,
          backfillRangeId: row.backfill_range_id,
        })),
      ).toEqual([
        {
          providerMessageId: "valid-provider",
          source: "live",
          effectiveAt: "2026-07-01T09:00:00.000Z",
          connectionKey: null,
          backfillRangeId: null,
        },
        {
          providerMessageId: "same-effective-later-id",
          source: "live",
          effectiveAt: "2026-07-01T09:00:00.000Z",
          connectionKey: null,
          backfillRangeId: null,
        },
        {
          providerMessageId: "before-floor",
          source: "live",
          effectiveAt: "2026-07-03T09:00:00.000Z",
          connectionKey: null,
          backfillRangeId: null,
        },
        {
          providerMessageId: "far-future",
          source: "live",
          effectiveAt: "2026-07-04T09:00:00.000Z",
          connectionKey: null,
          backfillRangeId: null,
        },
        {
          providerMessageId: "missing-provider-time",
          source: "live",
          effectiveAt: "2026-07-05T09:00:00.000Z",
          connectionKey: null,
          backfillRangeId: null,
        },
      ]);

      const checkpoint = await db
        .selectFrom("whatsapp_backfill_checkpoints")
        .selectAll()
        .where("group_jid", "=", "history-foundation@g.us")
        .executeTakeFirstOrThrow();
      expect(checkpoint).toMatchObject({
        status: "complete",
        last_fetched_key: "v1:legacy",
        live_start_effective_at: "2026-07-01T09:00:00.000Z",
        live_start_message_id: rows[0]?.id,
      });
      await expectEffectiveIndex(db);
      await expectSourceNotNull(db);
    });
  });
}

runMigrationSuite("145 WhatsApp history capture foundation migration SQLite", createTestDb);
runMigrationSuite("145 WhatsApp history capture foundation migration Postgres", createTestPgDb);
