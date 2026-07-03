import type { Kysely, Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSourceConfig } from "../../db/repositories/agent-outputs";
import type { DB, UsersTable } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import {
  CONVERSATION_SUMMARY_AGENT_KEY,
  buildConversationSummaryRuntimeContext,
  conversationSummaryDefinition,
} from "./conversation-summary";

const NOW = new Date("2026-07-01T18:00:00.000Z");

async function seedUser(db: Kysely<DB>): Promise<Selectable<UsersTable>> {
  await db.insertInto("users").values({ id: "user-1", name: "Summary User", email: "user@example.com" }).execute();
  return db.selectFrom("users").selectAll().where("id", "=", "user-1").executeTakeFirstOrThrow();
}

async function seedConversation(db: Kysely<DB>): Promise<number> {
  await db
    .insertInto("conversations")
    .values({
      platform: "slack",
      kind: "channel",
      provider_conversation_id: "C_SUMMARY",
      display_name: "summary-room",
    })
    .execute();
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("provider_conversation_id", "=", "C_SUMMARY")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function seedMessage(
  db: Kysely<DB>,
  conversationId: number,
  params: { id: string; text: string; receivedAt: string; isBot?: boolean },
): Promise<void> {
  await db
    .insertInto("conversation_messages")
    .values({
      conversation_id: conversationId,
      provider_message_id: params.id,
      sender_jid: "U_1",
      sender_name: "Mina",
      sender_user_id: "user-1",
      is_bot: params.isBot ? 1 : 0,
      addressed_to_sketch: 0,
      text: params.text,
      received_at: params.receivedAt,
    })
    .execute();
}

function source(): AgentSourceConfig {
  return {
    platform: "slack",
    targetType: "channel",
    targetId: "C_SUMMARY",
    label: "#summary-room",
  };
}

describe("conversationSummaryDefinition", () => {
  it("is registered as a source-configurable summarizer", () => {
    expect(conversationSummaryDefinition.key).toBe(CONVERSATION_SUMMARY_AGENT_KEY);
    expect(conversationSummaryDefinition.sourceConfig).toMatchObject({
      supportsSlackChannels: true,
      supportsWhatsAppGroups: true,
    });
    expect(conversationSummaryDefinition.requiresKnowledgeRefs).toBe(false);
  });
});

describe("buildConversationSummaryRuntimeContext", () => {
  let db: Kysely<DB>;
  let user: Selectable<UsersTable>;

  beforeEach(async () => {
    db = await createTestDb();
    user = await seedUser(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("uses a 24 hour first-run window and excludes bot messages", async () => {
    const conversationId = await seedConversation(db);
    await seedMessage(db, conversationId, {
      id: "m-old",
      text: "outside window",
      receivedAt: "2026-06-30T17:00:00.000Z",
    });
    await seedMessage(db, conversationId, {
      id: "m-new",
      text: "Launch decision is ready",
      receivedAt: "2026-07-01T10:00:00.000Z",
    });
    await seedMessage(db, conversationId, {
      id: "m-bot",
      text: "Previous summary",
      receivedAt: "2026-07-01T11:00:00.000Z",
      isBot: true,
    });

    const context = await buildConversationSummaryRuntimeContext({
      db,
      user,
      outputDate: "2026-07-01",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["user@example.com"],
      agentConfig: {
        enabledSections: {},
        maxItemsPerSection: 5,
        focus: null,
        delivery: null,
        sources: [source()],
      },
    });

    expect(context.summaryWindow).toMatchObject({
      mode: "first_run_last_24h",
      start: "2026-06-30T18:00:00.000Z",
      end: "2026-07-01T18:00:00.000Z",
    });
    expect(context.summarySources).toEqual([
      expect.objectContaining({
        label: "#summary-room",
        conversationId,
        messageCount: 1,
        messages: [expect.objectContaining({ text: "Launch decision is ready" })],
      }),
    ]);
  });

  it("uses the previous summary window end as the next window start", async () => {
    const conversationId = await seedConversation(db);
    await db
      .insertInto("agent_outputs")
      .values({
        id: "summary-prev",
        agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
        user_id: user.id,
        output_date: "2026-07-01",
        timezone: "UTC",
        status: "completed",
        trigger_type: "scheduled",
        agent_version: "test",
        generated_at: "2026-07-01T12:05:00.000Z",
        raw_payload_json: JSON.stringify({
          summaryWindow: {
            start: "2026-07-01T11:00:00.000Z",
            end: "2026-07-01T12:00:00.000Z",
          },
        }),
      })
      .execute();
    await seedMessage(db, conversationId, {
      id: "m-before",
      text: "already summarized",
      receivedAt: "2026-07-01T11:00:00.000Z",
    });
    await seedMessage(db, conversationId, {
      id: "m-during-completion",
      text: "arrived while the prior summary was still writing",
      receivedAt: "2026-07-01T12:03:00.000Z",
    });
    await seedMessage(db, conversationId, {
      id: "m-after",
      text: "later unblocker",
      receivedAt: "2026-07-01T12:30:00.000Z",
    });

    const context = await buildConversationSummaryRuntimeContext({
      db,
      user,
      outputDate: "2026-07-01",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["user@example.com"],
      agentConfig: {
        enabledSections: {},
        maxItemsPerSection: 5,
        focus: null,
        delivery: null,
        sources: [source()],
      },
    });

    expect(context.summaryWindow).toMatchObject({
      mode: "since_last_successful_run",
      start: "2026-07-01T12:00:00.000Z",
      previousOutputId: "summary-prev",
    });
    expect(context.summarySources).toEqual([
      expect.objectContaining({
        messageCount: 2,
        messages: [
          expect.objectContaining({ text: "arrived while the prior summary was still writing" }),
          expect.objectContaining({ text: "later unblocker" }),
        ],
      }),
    ]);
  });
});
