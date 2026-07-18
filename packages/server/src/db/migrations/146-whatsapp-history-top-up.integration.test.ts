import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import * as migration from "./146-whatsapp-history-top-up";

function runMigrationSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await migration.down(db as unknown as Kysely<unknown>);
      const conversation = await db
        .insertInto("conversations")
        .values({ platform: "whatsapp", kind: "group", provider_conversation_id: "migration@g.us" })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("conversation_messages")
        .values({
          conversation_id: conversation.id,
          provider_message_id: "existing-bot-message",
          sender_name: "Sketch",
          is_bot: 1,
          provider_timestamp: "2026-07-16T00:00:00.000Z",
          received_at: "2026-07-16T00:00:00.000Z",
        })
        .execute();
      await migration.up(db as unknown as Kysely<unknown>);
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("creates portable range state and durable request correlation columns", async () => {
      await db
        .insertInto("whatsapp_backfill_ranges")
        .values({
          id: "range-1",
          group_jid: "group@g.us",
          range_key: "initial",
          kind: "initial",
          connection_key: "000000000001:000000000002",
          status: "in_flight",
          lower_bound_at: "2026-06-17T00:00:00.000Z",
          upper_bound_at: "2026-07-17T00:00:00.000Z",
          cursor_remote_jid: "group@g.us",
          cursor_message_id: "anchor-1",
          cursor_from_me: 1,
          cursor_provider_timestamp: "2026-07-17T00:00:00.000Z",
          attempts: 2,
          claim_token: "claim-1",
          claimed_at: "2026-07-17T00:01:00.000Z",
          request_session_id: "request-1",
          request_lease_generation: 1,
          requested_at: "2026-07-17T00:01:00.000Z",
          response_deadline_at: "2026-07-17T00:02:00.000Z",
        })
        .execute();
      const range = await db
        .selectFrom("whatsapp_backfill_ranges")
        .selectAll()
        .where("id", "=", "range-1")
        .executeTakeFirstOrThrow();
      expect(range).toMatchObject({
        kind: "initial",
        status: "in_flight",
        cursor_from_me: 1,
        attempts: 2,
        request_session_id: "request-1",
      });
      await expect(
        db
          .selectFrom("conversation_messages")
          .select("provider_from_me")
          .where("provider_message_id", "=", "existing-bot-message")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ provider_from_me: 1 });

      await db
        .insertInto("whatsapp_inbound_events")
        .values({
          kind: "history_batch",
          origin: "gateway",
          envelope: "{}",
          request_session_id: "request-1",
          backfill_range_id: "range-1",
        })
        .execute();
      await expect(
        db
          .selectFrom("whatsapp_inbound_events")
          .select(["request_session_id", "backfill_range_id"])
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ request_session_id: "request-1", backfill_range_id: "range-1" });
    });
  });
}

runMigrationSuite("146 WhatsApp history top-up migration SQLite", createTestDb);
runMigrationSuite("146 WhatsApp history top-up migration Postgres", createTestPgDb);
