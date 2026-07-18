import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import * as migration from "./147-whatsapp-backfill-graph-admission";

function runMigrationSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await migration.down(db as unknown as Kysely<unknown>);
      await db
        .insertInto("whatsapp_backfill_checkpoints")
        .values({ group_jid: "graph-migration@g.us", last_fetched_key: null, status: "complete" })
        .execute();
      await db
        .insertInto("whatsapp_backfill_ranges")
        .values({
          id: "graph-migration-range",
          group_jid: "graph-migration@g.us",
          range_key: "initial",
          kind: "initial",
          connection_key: "000000000001:000000000001",
          status: "complete",
          lower_bound_at: "2026-06-17T00:00:00.000Z",
          upper_bound_at: "2026-07-17T00:00:00.000Z",
          terminal_status: "complete",
        })
        .execute();
      await migration.up(db as unknown as Kysely<unknown>);
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("adds durable composite graph progress, fairness, and halt state", async () => {
      await db
        .updateTable("whatsapp_backfill_ranges")
        .set({
          graph_cursor_effective_at: "2026-07-01T09:00:00.000Z",
          graph_cursor_message_id: 42,
          graph_completed_at: "2026-07-17T12:00:00.000Z",
        })
        .where("id", "=", "graph-migration-range")
        .execute();
      await db
        .updateTable("whatsapp_backfill_checkpoints")
        .set({
          graph_last_served_at: "2026-07-17T11:00:00.000Z",
          graph_halted_at: "2026-07-17T12:00:00.000Z",
          graph_halt_reason: "membership conflict",
        })
        .where("group_jid", "=", "graph-migration@g.us")
        .execute();

      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select(["graph_cursor_effective_at", "graph_cursor_message_id", "graph_completed_at"])
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        graph_cursor_effective_at: "2026-07-01T09:00:00.000Z",
        graph_cursor_message_id: 42,
        graph_completed_at: "2026-07-17T12:00:00.000Z",
      });
      await expect(
        db
          .selectFrom("whatsapp_backfill_checkpoints")
          .select(["graph_last_served_at", "graph_halted_at", "graph_halt_reason"])
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        graph_last_served_at: "2026-07-17T11:00:00.000Z",
        graph_halted_at: "2026-07-17T12:00:00.000Z",
        graph_halt_reason: "membership conflict",
      });
    });
  });
}

runMigrationSuite("147 WhatsApp backfill graph admission migration SQLite", createTestDb);
runMigrationSuite("147 WhatsApp backfill graph admission migration Postgres", createTestPgDb);
