import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createInboxMessagesRepository } from "./inbox-messages";
import { createUserRepository } from "./users";

/**
 * The Postgres arm uses the worker-shared PGlite instance with transaction
 * rollback isolation. The query under test is data-only and exists specifically
 * to keep proactive nudge dedupe portable across SQLite and Postgres.
 */
function runPendingByKindSuite(label: string, getDb: () => Promise<Kysely<DB>>, opts: { shared?: boolean } = {}) {
  describe(label, () => {
    let db!: Kysely<DB>;

    if (opts.shared) {
      beforeAll(async () => {
        db = await getDb();
      }, 30000);
    }

    beforeEach(async () => {
      if (opts.shared) {
        await sql`BEGIN`.execute(db);
      } else {
        db = await getDb();
      }
    }, 30000);

    afterEach(async () => {
      if (opts.shared) {
        await sql`ROLLBACK`.execute(db);
      } else {
        await db.destroy();
      }
    });

    it("orders pending rows by created_at then id", async () => {
      const repo = createInboxMessagesRepository(db);
      const users = createUserRepository(db);
      const sender = await users.create({ name: "Alice" });
      const recipient = await users.create({ name: "Bob" });

      await db
        .insertInto("inbox_messages")
        .values([
          {
            id: "pending-b",
            sender_user_id: sender.id,
            recipient_user_id: recipient.id,
            message: "Pending B",
            kind: "workflow_output",
            platform: "whatsapp",
            created_at: "2026-07-03T10:00:00.000Z",
          },
          {
            id: "pending-a",
            sender_user_id: sender.id,
            recipient_user_id: recipient.id,
            message: "Pending A",
            kind: "workflow_output",
            platform: "whatsapp",
            created_at: "2026-07-03T10:00:00.000Z",
          },
          {
            id: "pending-old",
            sender_user_id: sender.id,
            recipient_user_id: recipient.id,
            message: "Pending old",
            kind: "workflow_output",
            platform: "whatsapp",
            created_at: "2026-07-03T09:00:00.000Z",
          },
          {
            id: "pending-resolved",
            sender_user_id: sender.id,
            recipient_user_id: recipient.id,
            message: "Resolved",
            kind: "workflow_output",
            platform: "whatsapp",
            created_at: "2026-07-03T11:00:00.000Z",
            resolved_at: "2026-07-03T11:00:00.000Z",
          },
        ])
        .execute();

      const rows = await repo.listPendingForRecipientByKind(recipient.id, "workflow_output");

      expect(rows.map((row) => row.id)).toEqual(["pending-old", "pending-a", "pending-b"]);
    });
  });
}

runPendingByKindSuite("createInboxMessagesRepository sqlite", createTestDb);
runPendingByKindSuite("createInboxMessagesRepository postgres", getSharedPgDb, { shared: true });
