import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createConversationTopicsRepository } from "./conversation-topics";
import { createConversationRepository } from "./conversations";

describe("conversation topics repository", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("revives a topic by normalized name instead of creating a duplicate", async () => {
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: "topics@g.us",
    });
    const repo = createConversationTopicsRepository(db);

    const first = await repo.upsertTopic({
      conversationId: conversation.id,
      name: "Project Alpha",
      oneLiner: "Initial planning",
      activityAt: "2026-07-01T00:00:00.000Z",
    });
    const revived = await repo.upsertTopic({
      conversationId: conversation.id,
      name: "  project   alpha ",
      oneLiner: "Latest planning",
      activityAt: "2026-07-02T00:00:00.000Z",
    });

    expect(revived.topic.id).toBe(first.topic.id);
    expect(revived.topic.status).toBe("open");
    expect(revived.topic.one_liner).toBe("Latest planning");
    await expect(
      db
        .selectFrom("conversation_topics")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirst(),
    ).resolves.toMatchObject({ count: 1 });
  });

  it("records a normalized-name merge and evicts topics quiet for seven days", async () => {
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: "topic-merge@g.us",
    });
    const repo = createConversationTopicsRepository(db);

    const canonical = await repo.upsertTopic({
      conversationId: conversation.id,
      name: "Project Alpha",
      activityAt: "2026-07-01T00:00:00.000Z",
    });
    const merged = await repo.upsertTopic({
      conversationId: conversation.id,
      name: " project   alpha ",
      activityAt: "2026-07-02T00:00:00.000Z",
      recordMerge: true,
    });
    await repo.upsertTopic({
      conversationId: conversation.id,
      name: " project   alpha ",
      activityAt: "2026-07-03T00:00:00.000Z",
      recordMerge: true,
    });
    const registry = await repo.listPromptRegistry(conversation.id, "2026-07-11T00:00:00.000Z", 30);

    expect(merged.topic.id).toBe(canonical.topic.id);
    await expect(db.selectFrom("topic_merges").selectAll().execute()).resolves.toHaveLength(1);
    expect(registry).toEqual([]);
    await expect(
      db.selectFrom("conversation_topics").select("status").where("id", "=", canonical.topic.id).executeTakeFirst(),
    ).resolves.toMatchObject({ status: "stale" });
  });
});
