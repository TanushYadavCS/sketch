import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger, createTestPgDb } from "../test-utils";
import { type WhatsAppLlmChunkerDeps, evaluateIdleClose, runLlmChunkingPass } from "./whatsapp-llm-chunker";

const knobs = {
  windowMessages: 20,
  windowTokens: 7500,
  minMessages: 2,
  targetMessages: 4,
  maxMessages: 8,
  maxTokens: 1500,
  tickMinutes: 30,
  idleCloseHours: 96,
  provisionalRefreshMessages: 15,
  model: null,
  reasoningEffort: "high" as const,
  burstThresholdMessages: null,
  topicRegistryCap: 30,
  groupWorkerPool: 4,
};

describe("WhatsApp LLM boundary engine", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("numbers the denoised stream while slices retain the surrounding raw range", async () => {
    const groupJid = "llm-boundary@g.us";
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const messages = createConversationRepository(db);
    await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "m-1",
      senderName: "Asha",
      text: "first topic",
      receivedAt: "2026-07-07T09:00:00.000Z",
    });
    await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "m-noise",
      senderName: "Bot",
      text: "bot noise",
      isBot: true,
      receivedAt: "2026-07-07T09:01:00.000Z",
    });
    await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "m-2",
      senderName: "Rahul",
      text: "second topic",
      receivedAt: "2026-07-07T09:02:00.000Z",
    });
    await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "m-3",
      senderName: "Asha",
      text: "third topic",
      receivedAt: "2026-07-07T09:03:00.000Z",
    });
    await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "m-4",
      senderName: "Rahul",
      text: "fourth topic",
      receivedAt: "2026-07-07T09:04:00.000Z",
    });

    const deps: WhatsAppLlmChunkerDeps = {
      db,
      logger: createTestLogger(),
      generate: async () =>
        JSON.stringify({
          segments: [
            { start: 1, end: 2, threads: ["topic one"] },
            { start: 3, end: 4, threads: ["topic two"] },
          ],
        }),
      now: () => Date.parse("2026-07-07T09:05:00.000Z"),
    };

    const result = await runLlmChunkingPass(deps, {
      conversationId: conversation.id,
      groupJid,
      knobs,
      mode: "backfill",
    });
    const slices = await db
      .selectFrom("conversation_slices")
      .selectAll()
      .where("conversation_id", "=", conversation.id)
      .orderBy("first_message_id", "asc")
      .execute();
    const cursor = await db
      .selectFrom("conversation_slice_cursors")
      .selectAll()
      .where("conversation_id", "=", conversation.id)
      .executeTakeFirstOrThrow();

    expect(result).toMatchObject({ windowsProcessed: 1, slicesClosed: 1, openSliceId: slices[1]?.id });
    expect(slices).toHaveLength(2);
    expect(slices[0]).toMatchObject({
      status: "closed",
      first_message_id: 1,
      last_message_id: 3,
      message_count: 2,
      denoised_message_ids: JSON.stringify([1, 3]),
      flush_reason: "llm_boundary",
      salience_verdict: "kept",
    });
    expect(slices[1]).toMatchObject({
      status: "open",
      first_message_id: 4,
      last_message_id: 5,
      denoised_message_ids: JSON.stringify([4, 5]),
    });
    expect(cursor).toMatchObject({ last_message_id: 5, last_effective_at: "2026-07-07T09:04:00.000Z" });
  });

  it("repairs an invalid response before applying the window", async () => {
    const { conversationId, groupJid } = await seedConversation(db, 3);
    const prompts: string[] = [];
    let calls = 0;
    const deps = createDeps(db, async (prompt) => {
      prompts.push(prompt);
      calls += 1;
      return calls === 1
        ? JSON.stringify({
            segments: [
              { start: 1, end: 1, threads: ["one"] },
              { start: 3, end: 3, threads: ["two"] },
            ],
          })
        : JSON.stringify({ segments: [{ start: 1, end: 3, threads: ["one"] }] });
    });

    const result = await runLlmChunkingPass(deps, { conversationId, groupJid, knobs, mode: "backfill" });

    expect(result.windowsProcessed).toBe(1);
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("gap or overlap");
  });

  it("bisects only the new suffix and gives the second half the first half's open state", async () => {
    const { conversationId, groupJid } = await seedConversation(db, 8);
    const prompts: string[] = [];
    let calls = 0;
    const deps = createDeps(db, async (prompt) => {
      prompts.push(prompt);
      calls += 1;
      if (calls <= 2) return "not json";
      return JSON.stringify({ segments: [{ start: 1, end: calls === 3 ? 4 : 8, threads: ["thread"] }] });
    });

    const result = await runLlmChunkingPass(deps, { conversationId, groupJid, knobs, mode: "backfill" });

    expect(result.windowsProcessed).toBe(2);
    expect(calls).toBe(4);
    expect(prompts[3]).toContain("[OPEN CHUNK]");
    expect(prompts[3]).toContain("2026-07-07T09:07:00.000Z");
  });

  it("closes and revises the open tail across consecutive windows without changing closed slices", async () => {
    const { conversationId, groupJid } = await seedConversation(db, 4);
    const protocolKnobs = { ...knobs, minMessages: 1, targetMessages: 40 };
    let calls = 0;
    const deps = createDeps(db, async () => {
      calls += 1;
      if (calls === 1) return JSON.stringify({ segments: [{ start: 1, end: 4, threads: ["one"] }] });
      if (calls === 2)
        return JSON.stringify({
          segments: [
            { start: 1, end: 5, threads: ["one"] },
            { start: 6, end: 7, threads: ["two"] },
          ],
        });
      if (calls === 3)
        return JSON.stringify({
          segments: [
            { start: 1, end: 2, threads: ["two"] },
            { start: 3, end: 4, threads: ["three"] },
          ],
        });
      return JSON.stringify({
        segments: [
          { start: 1, end: 1, threads: ["three"] },
          { start: 2, end: 3, threads: ["four"] },
        ],
      });
    });

    await runLlmChunkingPass(deps, { conversationId, groupJid, knobs: protocolKnobs, mode: "backfill" });
    await appendMessages(db, conversationId, 5, 7);
    await runLlmChunkingPass(deps, { conversationId, groupJid, knobs: protocolKnobs, mode: "backfill" });
    await appendMessages(db, conversationId, 8, 9);
    await runLlmChunkingPass(deps, { conversationId, groupJid, knobs: protocolKnobs, mode: "backfill" });
    await appendMessages(db, conversationId, 10, 10);
    await runLlmChunkingPass(deps, { conversationId, groupJid, knobs: protocolKnobs, mode: "backfill" });

    const slices = await db
      .selectFrom("conversation_slices")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .orderBy("first_message_id", "asc")
      .execute();
    expect(slices.filter((slice) => slice.status === "closed")).toHaveLength(3);
    expect(slices[0]).toMatchObject({ first_message_id: 1, last_message_id: 5, status: "closed" });
    expect(slices[1]).toMatchObject({ first_message_id: 6, last_message_id: 7, status: "closed" });
    expect(slices[2]).toMatchObject({ first_message_id: 8, last_message_id: 8, status: "closed" });
    expect(slices[3]).toMatchObject({ first_message_id: 9, last_message_id: 10, status: "open" });
  });

  it("rejects a shifted replay through the effective-time overlap guard", async () => {
    const { conversationId, groupJid } = await seedConversation(db, 3);
    const sliceRepo = createConversationSlicesRepository(db);
    await sliceRepo.insertIfAbsent({
      conversationId,
      firstMessageId: 1,
      lastMessageId: 2,
      startedAt: "2026-07-07T09:00:00.000Z",
      endedAt: "2026-07-07T09:01:00.000Z",
      messageCount: 2,
      denoisedMessageIds: [1, 2],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      status: "closed",
    });
    await sliceRepo.advanceCursor({
      conversationId,
      lastEffectiveAt: "2026-07-07T08:59:00.000Z",
      lastMessageId: 0,
    });
    const deps = createDeps(db, async () => JSON.stringify({ segments: [{ start: 1, end: 3, threads: ["shifted"] }] }));

    const result = await runLlmChunkingPass(deps, { conversationId, groupJid, knobs, mode: "backfill" });

    expect(result).toMatchObject({ windowsProcessed: 0, skippedReason: "overlap_guard" });
    await expect(db.selectFrom("conversation_slices").selectAll().execute()).resolves.toHaveLength(1);
  });

  it("rejects a write when another worker steals the claim during generation", async () => {
    const { conversationId, groupJid } = await seedConversation(db, 3);
    const deps = createDeps(db, async () => {
      await db
        .updateTable("conversation_slice_cursors")
        .set({ claim_token: "stolen" })
        .where("conversation_id", "=", conversationId)
        .execute();
      return JSON.stringify({ segments: [{ start: 1, end: 3, threads: ["thread"] }] });
    });

    const result = await runLlmChunkingPass(deps, { conversationId, groupJid, knobs, mode: "backfill" });

    expect(result).toMatchObject({ windowsProcessed: 0, skippedReason: "claim_lost" });
    await expect(db.selectFrom("conversation_slices").selectAll().execute()).resolves.toHaveLength(0);
  });

  it("uses received-time for live idle close and chat-time frontier for backfill", async () => {
    const live = await seedConversation(db, 2, "2026-07-01T09:00:00.000Z");
    const liveSlice = await createConversationSlicesRepository(db).insertIfAbsent({
      conversationId: live.conversationId,
      firstMessageId: 1,
      lastMessageId: 2,
      startedAt: "2026-07-01T09:00:00.000Z",
      endedAt: "2026-07-01T09:01:00.000Z",
      messageCount: 2,
      denoisedMessageIds: [1, 2],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      status: "open",
    });
    await createConversationSlicesRepository(db).advanceCursor({
      conversationId: live.conversationId,
      lastEffectiveAt: "2026-07-01T09:01:00.000Z",
      lastMessageId: 2,
    });
    const deps = createDeps(db, async () => "", "2026-07-05T10:00:00.000Z");
    await expect(evaluateIdleClose(deps, { conversationId: live.conversationId, knobs, mode: "live" })).resolves.toBe(
      true,
    );
    await expect(
      db.selectFrom("conversation_slices").select("status").where("id", "=", liveSlice.row.id).executeTakeFirst(),
    ).resolves.toMatchObject({ status: "closed" });

    const backfill = await seedConversation(db, 2, "2026-07-01T09:00:00.000Z");
    await createConversationSlicesRepository(db).insertIfAbsent({
      conversationId: backfill.conversationId,
      firstMessageId: 3,
      lastMessageId: 4,
      startedAt: "2026-07-01T09:00:00.000Z",
      endedAt: "2026-07-01T09:01:00.000Z",
      messageCount: 2,
      denoisedMessageIds: [3, 4],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      status: "open",
    });
    await createConversationSlicesRepository(db).advanceCursor({
      conversationId: backfill.conversationId,
      lastEffectiveAt: "2026-07-01T09:01:00.000Z",
      lastMessageId: 4,
    });
    const backfillDeps = createDeps(db, async () => "", "2026-07-05T10:00:00.000Z");
    await expect(
      evaluateIdleClose(backfillDeps, { conversationId: backfill.conversationId, knobs, mode: "backfill" }),
    ).resolves.toBe(false);
    await createConversationRepository(db).insertMessage({
      conversationId: backfill.conversationId,
      providerMessageId: "backfill-frontier",
      senderName: "Asha",
      text: "next historical message",
      receivedAt: "2026-07-05T10:02:00.000Z",
    });
    await expect(
      evaluateIdleClose(backfillDeps, { conversationId: backfill.conversationId, knobs, mode: "backfill" }),
    ).resolves.toBe(true);
  });

  it("keeps a roster-projected Person stable instead of recording unresolved candidates", async () => {
    const { conversationId, groupJid } = await seedConversation(db, 2, "2026-07-01T09:00:00.000Z");
    await createWhatsAppGroupRepository(db).upsert({
      jid: groupJid,
      name: "Candidates",
      description: null,
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    await createWhatsAppGroupRepository(db).refreshParticipants(
      groupJid,
      [{ participantJid: "15551234567@s.whatsapp.net", phoneE164: "+15551234567" }],
      "2026-07-01T00:00:00.000Z",
    );
    const deps = createDeps(
      db,
      async () =>
        JSON.stringify({
          segments: [
            { start: 1, end: 1, threads: ["one"] },
            { start: 2, end: 2, threads: ["two"] },
          ],
        }),
      "2026-07-05T10:00:00.000Z",
    );

    await runLlmChunkingPass(deps, { conversationId, groupJid, knobs: { ...knobs, minMessages: 1 }, mode: "backfill" });
    await expect(evaluateIdleClose(deps, { conversationId, knobs, mode: "live" })).resolves.toBe(true);
    const firstPerson = await db
      .selectFrom("entity_contact_points")
      .select("entity_id")
      .where("kind", "=", "phone")
      .where("value", "=", "+15551234567")
      .executeTakeFirstOrThrow();
    await expect(db.selectFrom("whatsapp_identity_candidates").select("candidate_ref").execute()).resolves.toEqual([]);
    await db
      .updateTable("conversation_slices")
      .set({ status: "open" })
      .where("status", "=", "closed")
      .where("conversation_id", "=", conversationId)
      .where("first_message_id", "=", 2)
      .execute();
    await expect(evaluateIdleClose(deps, { conversationId, knobs, mode: "live" })).resolves.toBe(true);
    const replayPeople = await db
      .selectFrom("entity_contact_points")
      .select("entity_id")
      .where("kind", "=", "phone")
      .where("value", "=", "+15551234567")
      .execute();

    expect(replayPeople).toEqual([firstPerson]);
    await expect(db.selectFrom("whatsapp_identity_candidates").select("candidate_ref").execute()).resolves.toEqual([]);
  });

  it("enriches resolved person aliases while building LLM chunk rosters", async () => {
    const groupJid = "llm-aliases@g.us";
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: groupJid,
      name: "Alias Group",
      description: null,
      updated_at: "2026-07-07T09:00:00.000Z",
    });
    await db
      .insertInto("entities")
      .values({
        id: "llm-alias-person",
        name: "CRM Contact",
        source_type: "person",
        subtype: "external",
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: "2026-07-07T09:00:00.000Z",
        updated_at: "2026-07-07T09:00:00.000Z",
        ai_brief: null,
      })
      .execute();
    await db
      .insertInto("entity_contact_points")
      .values({
        id: "llm-alias-phone",
        entity_id: "llm-alias-person",
        kind: "phone",
        value: "+15550000123",
        source: "test",
      })
      .execute();
    await groups.refreshParticipants(groupJid, [
      { participantJid: "15550000123@s.whatsapp.net", phoneE164: "+15550000123" },
    ]);
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const messages = createConversationRepository(db);
    await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "alias-1",
      senderJid: "15550000123@s.whatsapp.net",
      senderName: "Asha Buyer",
      text: "first topic",
      receivedAt: "2026-07-07T09:00:00.000Z",
    });
    await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "alias-2",
      senderJid: "15550000123@s.whatsapp.net",
      senderName: "Asha Buyer",
      text: "second topic",
      receivedAt: "2026-07-07T09:01:00.000Z",
    });

    await runLlmChunkingPass(
      createDeps(db, async () => JSON.stringify({ segments: [{ start: 1, end: 2, threads: ["topic"] }] })),
      { conversationId: conversation.id, groupJid, knobs, mode: "backfill" },
    );

    const entity = await db
      .selectFrom("entities")
      .select("aliases")
      .where("id", "=", "llm-alias-person")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entity.aliases ?? "[]")).toEqual(["Asha Buyer"]);
  });

  it("applies the same slice and topic transaction on Postgres", async () => {
    const pgDb = await createTestPgDb();
    try {
      const { conversationId, groupJid } = await seedConversation(pgDb, 3);
      const deps = createDeps(pgDb, async () =>
        JSON.stringify({
          segments: [
            { start: 1, end: 2, threads: ["postgres topic"] },
            { start: 3, end: 3, threads: ["postgres tail"] },
          ],
        }),
      );

      const result = await runLlmChunkingPass(deps, { conversationId, groupJid, knobs, mode: "backfill" });
      const slices = await pgDb
        .selectFrom("conversation_slices")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .execute();
      const topics = await pgDb
        .selectFrom("conversation_topics")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .execute();

      expect(result.slicesClosed).toBe(1);
      expect(slices).toHaveLength(2);
      expect(topics).toHaveLength(2);
    } finally {
      await pgDb.destroy();
    }
  }, 30000);

  it("calls the shrink hook when a revised open chunk loses members", async () => {
    const { conversationId, groupJid } = await seedConversation(db, 2);
    await db
      .insertInto("connector_configs")
      .values({
        id: "chunker-config",
        connector_type: "whatsapp",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "chunker-owner",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "open-file",
        connector_config_id: "chunker-config",
        provider_file_id: "open-file",
        provider_message_id: null,
        thread_id: null,
        provider_url: null,
        file_name: "Open chunk",
        file_type: "whatsapp_message",
        content_category: "conversation",
        content: "open",
        summary: null,
        source: "whatsapp",
        source_path: null,
        rollup_group_id: null,
        content_hash: "open-hash",
        synced_at: "2026-07-07T09:02:00.000Z",
      })
      .execute();
    await createConversationSlicesRepository(db).insertIfAbsent({
      conversationId,
      firstMessageId: 1,
      lastMessageId: 2,
      startedAt: "2026-07-07T09:00:00.000Z",
      endedAt: "2026-07-07T09:01:00.000Z",
      messageCount: 2,
      denoisedMessageIds: [1, 2],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      status: "open",
    });
    await createConversationSlicesRepository(db).advanceCursor({
      conversationId,
      lastEffectiveAt: "2026-07-07T09:01:00.000Z",
      lastMessageId: 2,
    });
    await db
      .updateTable("conversation_slices")
      .set({ indexed_file_id: "open-file" })
      .where("conversation_id", "=", conversationId)
      .execute();
    await appendMessages(db, conversationId, 3, 3);
    const shrunk: string[] = [];
    const deps = {
      ...createDeps(db, async () =>
        JSON.stringify({
          segments: [
            { start: 1, end: 1, threads: ["old"] },
            { start: 2, end: 3, threads: ["new"] },
          ],
        }),
      ),
      onOpenChunkShrunk: async (fileId: string) => {
        shrunk.push(fileId);
      },
    };

    await runLlmChunkingPass(deps, { conversationId, groupJid, knobs: { ...knobs, minMessages: 1 }, mode: "backfill" });

    expect(shrunk).toEqual(["open-file"]);
  });
});

function createDeps(
  db: Kysely<DB>,
  generate: WhatsAppLlmChunkerDeps["generate"],
  now = "2026-07-07T09:10:00.000Z",
): WhatsAppLlmChunkerDeps {
  return { db, logger: createTestLogger(), generate, now: () => Date.parse(now) };
}

async function seedConversation(db: Kysely<DB>, count: number, receivedAt = "2026-07-07T09:00:00.000Z") {
  const groupJid = `llm-${Math.random().toString(16).slice(2)}@g.us`;
  const conversation = await createConversationRepository(db).getOrCreate({
    platform: "whatsapp",
    kind: "group",
    providerConversationId: groupJid,
  });
  await appendMessages(db, conversation.id, 1, count, receivedAt);
  return { conversationId: conversation.id, groupJid };
}

async function appendMessages(
  db: Kysely<DB>,
  conversationId: number,
  first: number,
  last: number,
  startAt = "2026-07-07T09:00:00.000Z",
) {
  const base = Date.parse(startAt);
  const messages = createConversationRepository(db);
  for (let id = first; id <= last; id += 1) {
    await messages.insertMessage({
      conversationId,
      providerMessageId: `m-${id}`,
      senderName: id % 2 === 0 ? "Rahul" : "Asha",
      text: `message ${id}`,
      receivedAt: new Date(base + (id - 1) * 60_000).toISOString(),
    });
  }
}
