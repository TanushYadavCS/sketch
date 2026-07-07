import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { createConversationRepository } from "../repositories/conversations";
import type { DB } from "../schema";

async function runSchemaSmoke(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: "schema-user", name: "Schema User", email: "schema@example.com" })
    .execute();
  await db
    .insertInto("whatsapp_groups")
    .values({ jid: "schema-group@g.us", name: "Schema Group", description: null })
    .execute();

  const groupDefault = await db
    .selectFrom("whatsapp_groups")
    .select(["index_enabled", "slice_gap_minutes", "slice_max_age_minutes", "slice_max_messages"])
    .where("jid", "=", "schema-group@g.us")
    .executeTakeFirstOrThrow();
  expect(groupDefault).toEqual({
    index_enabled: 0,
    slice_gap_minutes: null,
    slice_max_age_minutes: null,
    slice_max_messages: null,
  });

  await db
    .updateTable("whatsapp_groups")
    .set({ index_enabled: 1, slice_gap_minutes: 25, slice_max_age_minutes: 120, slice_max_messages: 50 })
    .where("jid", "=", "schema-group@g.us")
    .execute();

  await db
    .insertInto("whatsapp_group_member_labels")
    .values({
      group_jid: "schema-group@g.us",
      phone_e164: "+15551234567",
      display_name: "Asha",
      company_name: "Acme",
      created_by: "schema-user",
    })
    .execute();
  await db
    .insertInto("whatsapp_backfill_checkpoints")
    .values({ group_jid: "schema-group@g.us", last_fetched_key: "key-1", status: "in_progress" })
    .execute();

  const conversations = createConversationRepository(db);
  const conversation = await conversations.getOrCreate({
    platform: "whatsapp",
    kind: "group",
    providerConversationId: "schema-group@g.us",
  });
  const first = await conversations.insertMessage({
    conversationId: conversation.id,
    providerMessageId: "schema-message-1",
    senderName: "Asha",
    receivedAt: "2026-07-07T09:00:00.000Z",
  });
  const last = await conversations.insertMessage({
    conversationId: conversation.id,
    providerMessageId: "schema-message-2",
    senderName: "Rahul",
    receivedAt: "2026-07-07T09:05:00.000Z",
  });

  await db
    .insertInto("conversation_slices")
    .values({
      id: randomUUID(),
      conversation_id: conversation.id,
      first_message_id: first.row.id,
      last_message_id: last.row.id,
      started_at: "2026-07-07T09:00:00.000Z",
      ended_at: "2026-07-07T09:05:00.000Z",
      message_count: 2,
      flush_reason: "gap",
      roster_snapshot: JSON.stringify([{ name: "Asha" }, { name: "Rahul" }]),
    })
    .execute();
  await db
    .insertInto("conversation_slice_cursors")
    .values({
      conversation_id: conversation.id,
      last_effective_at: "2026-07-07T09:05:00.000Z",
      last_message_id: last.row.id,
    })
    .execute();

  const sliceCount = await db
    .selectFrom("conversation_slices")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  expect(Number(sliceCount.count)).toBe(1);
}

describe("132-whatsapp-context-graph-indexing migration sqlite", () => {
  let db!: Kysely<DB>;

  afterEach(async () => {
    await db.destroy();
  });

  it("creates the Phase 1 schema and defaults", async () => {
    db = await createTestDb();
    await runSchemaSmoke(db);
  });
});

describe("132-whatsapp-context-graph-indexing migration postgres", () => {
  let db!: Kysely<DB>;

  afterEach(async () => {
    await db.destroy();
  });

  it("creates the Phase 1 schema and defaults", async () => {
    db = await createTestPgDb();
    await runSchemaSmoke(db);
  }, 30000);
});
