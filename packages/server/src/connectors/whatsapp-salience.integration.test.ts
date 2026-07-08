import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger, createTestPgDb } from "../test-utils";
import type { GeminiGenerator } from "./gemini-generate";
import { runConnectorSync } from "./sync";
import { createWhatsAppConnector } from "./whatsapp";

const RAW_IDENTIFIER_PATTERN = /(?:\+?[1-9]\d{9,14}\b|@s\.whatsapp\.net|@lid)/iu;

interface SeededSlice {
  groupJid: string;
  conversationId: number;
  sliceId: string;
  teammateEmail: string | null;
}

interface FakeGenerator extends GeminiGenerator {
  calls: string[];
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function fakeGenerator(responses: Array<unknown | Error>): FakeGenerator {
  const calls: string[] = [];
  return {
    calls,
    async generate() {
      return "";
    },
    async generateJSON<T>(prompt: string) {
      const response = responses[calls.length];
      calls.push(prompt);
      if (response instanceof Error) throw response;
      return response as T;
    },
  };
}

async function seedConnectorConfig(db: Kysely<DB>) {
  const ownerId = `owner-${randomUUID()}`;
  await createUserRepository(db).create({
    id: ownerId,
    name: "WhatsApp Owner",
    email: `${ownerId}@example.com`,
  });
  return createConnectorRepository(db).createConfig({
    connectorType: "whatsapp",
    authType: "system",
    credentials: JSON.stringify({ type: "system" }),
    scopeConfig: "{}",
    createdBy: ownerId,
  });
}

async function seedSlice(
  db: Kysely<DB>,
  options: {
    teammate?: boolean;
    verdict?: "kept" | "dropped" | null;
    salienceSignals?: string | null;
    text?: string;
  } = {},
): Promise<SeededSlice> {
  const groupJid = `${randomUUID()}@g.us`;
  const groups = createWhatsAppGroupRepository(db);
  await groups.upsert({
    jid: groupJid,
    name: "Deal Room",
    description: null,
    updated_at: "2026-07-07T09:00:00.000Z",
  });
  await groups.setIndexEnabled(groupJid, true);

  const teammateEmail = options.teammate === false ? null : `teammate-${randomUUID()}@example.com`;
  if (teammateEmail) {
    await createUserRepository(db).create({
      id: "teammate-user",
      name: "Tara Teammate",
      email: teammateEmail,
      whatsappNumber: "+15550000001",
    });
  }

  const participants = teammateEmail
    ? [
        { participantJid: "15550000001@s.whatsapp.net", phoneE164: "+15550000001", adminRole: null },
        { participantJid: "15550000002@s.whatsapp.net", phoneE164: "+15550000002", adminRole: null },
      ]
    : [{ participantJid: "15550000002@s.whatsapp.net", phoneE164: "+15550000002", adminRole: null }];
  await groups.refreshParticipants(groupJid, participants);

  const conversation = await createConversationRepository(db).getOrCreate({
    platform: "whatsapp",
    kind: "group",
    providerConversationId: groupJid,
  });
  const messages = createConversationRepository(db);
  const first = teammateEmail
    ? await messages.insertMessage({
        conversationId: conversation.id,
        providerMessageId: `${groupJid}:1`,
        senderJid: "15550000001@s.whatsapp.net",
        senderName: "Tara Teammate",
        text: options.text ?? "We decided Project Atlas starts Monday.",
        receivedAt: "2026-07-07T09:00:00.000Z",
      })
    : await messages.insertMessage({
        conversationId: conversation.id,
        providerMessageId: `${groupJid}:1`,
        senderJid: "15550000002@s.whatsapp.net",
        senderName: "External Buyer",
        text: options.text ?? "We decided Project Atlas starts Monday.",
        receivedAt: "2026-07-07T09:00:00.000Z",
      });
  const last = await messages.insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${groupJid}:2`,
    senderJid: "15550000002@s.whatsapp.net",
    senderName: "External Buyer +15550000002",
    text: "Please remove 15550000002@s.whatsapp.net from the sales deck.",
    receivedAt: "2026-07-07T09:01:00.000Z",
  });

  const inserted = await createConversationSlicesRepository(db).insertIfAbsent({
    conversationId: conversation.id,
    firstMessageId: first.row.id,
    lastMessageId: last.row.id,
    startedAt: first.row.receivedAt,
    endedAt: last.row.receivedAt,
    messageCount: 2,
    denoisedMessageIds: [first.row.id, last.row.id],
    flushReason: "gap",
    rosterSnapshot: "[]",
    salienceVerdict: options.verdict ?? null,
    salienceSignals: options.salienceSignals ?? null,
  });

  return { groupJid, conversationId: conversation.id, sliceId: inserted.row.id, teammateEmail };
}

async function collectWhatsAppItems(db: Kysely<DB>, generator?: GeminiGenerator | null) {
  const items = [];
  for await (const item of createWhatsAppConnector().sync({
    db,
    credentials: { type: "system" },
    scopeConfig: {},
    cursor: null,
    logger: fakeLogger(),
    salienceGenerator: generator,
  })) {
    items.push(item);
  }
  return items;
}

function runSalienceIntegrationSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("persists a kept verdict, emits a scoped SyncedItem, records candidates, and never re-judges", async () => {
      const seeded = await seedSlice(db);
      const generator = fakeGenerator([
        {
          salient: true,
          signals: ["decision", "named_entity"],
          entities: [
            { name: "Project Atlas", type: "project" },
            { name: "External Buyer", type: "person" },
          ],
        },
      ]);

      const firstItems = await collectWhatsAppItems(db, generator);
      const secondItems = await collectWhatsAppItems(db, generator);
      const slice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      const candidates = await db.selectFrom("whatsapp_identity_candidates").selectAll().execute();

      expect(generator.calls).toHaveLength(1);
      expect(firstItems).toHaveLength(1);
      expect(secondItems).toHaveLength(1);
      expect(slice.salience_verdict).toBe("kept");
      expect(slice.salience_signals).toContain("named_entity");
      expect(firstItems[0]).toMatchObject({
        providerFileId: seeded.sliceId,
        fileType: "whatsapp_conversation_slice",
        contentCategory: "document",
        threadId: String(seeded.conversationId),
        accessScope: {
          scopeType: "whatsapp_group",
          providerScopeId: seeded.groupJid,
          memberEmails: [seeded.teammateEmail],
        },
      });
      expect(firstItems[0]?.content).toContain("WhatsApp roster:");
      expect(firstItems[0]?.content).toContain("Tara Teammate:");
      expect(firstItems[0]?.content).not.toMatch(RAW_IDENTIFIER_PATTERN);
      expect(firstItems[0]?.entitySeeds).toEqual([
        expect.objectContaining({ name: "Project Atlas", sourceType: "project" }),
      ]);
      expect(firstItems[0]?.personSeeds).toBeUndefined();
      expect(firstItems[0]?.attendees).toBeUndefined();
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        group_jid: seeded.groupJid,
        kept_slice_count: 1,
        last_slice_id: seeded.sliceId,
      });
      expect(candidates[0]?.candidate_ref).not.toMatch(RAW_IDENTIFIER_PATTERN);
    });

    it("persists a dropped verdict and emits no item", async () => {
      const seeded = await seedSlice(db, { text: "haha okay" });
      const generator = fakeGenerator([{ salient: false, signals: [], entities: [] }]);

      const items = await collectWhatsAppItems(db, generator);
      const slice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();

      expect(items).toEqual([]);
      expect(slice.salience_verdict).toBe("dropped");
      await expect(db.selectFrom("indexed_files").selectAll().execute()).resolves.toEqual([]);
    });

    it("leaves a failed LLM verdict pending and retries it on the next run", async () => {
      const seeded = await seedSlice(db);
      const generator = fakeGenerator([
        new Error("fixture outage"),
        { salient: true, signals: ["decision"], entities: [] },
      ]);

      await expect(collectWhatsAppItems(db, generator)).resolves.toEqual([]);
      await expect(
        db
          .selectFrom("conversation_slices")
          .select(["salience_verdict", "salience_claim_token", "salience_claimed_at"])
          .where("id", "=", seeded.sliceId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ salience_verdict: null, salience_claim_token: null, salience_claimed_at: null });

      const retriedItems = await collectWhatsAppItems(db, generator);
      const slice = await db
        .selectFrom("conversation_slices")
        .select("salience_verdict")
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();

      expect(generator.calls).toHaveLength(2);
      expect(retriedItems).toHaveLength(1);
      expect(slice.salience_verdict).toBe("kept");
    });

    it("fails closed when a kept slice has zero resolved teammate emails", async () => {
      const seeded = await seedSlice(db, {
        teammate: false,
        verdict: "kept",
        salienceSignals: JSON.stringify({ signals: ["decision"], entities: [] }),
      });
      const config = await seedConnectorConfig(db);

      const result = await runConnectorSync(db, config.id, createTestLogger());
      const slice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();

      expect(result.itemsProcessed).toBe(0);
      expect(slice.indexed_file_id).toBeNull();
      await expect(db.selectFrom("indexed_files").selectAll().execute()).resolves.toEqual([]);
    });

    it("archives an existing linked file if scope later resolves to zero teammates", async () => {
      const seeded = await seedSlice(db, {
        verdict: "kept",
        salienceSignals: JSON.stringify({ signals: ["decision"], entities: [] }),
      });
      const config = await seedConnectorConfig(db);
      await runConnectorSync(db, config.id, createTestLogger());
      const before = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      if (!before.indexed_file_id) throw new Error("expected linked file");

      await db.updateTable("users").set({ whatsapp_number: null }).where("id", "=", "teammate-user").execute();
      const result = await runConnectorSync(db, config.id, createTestLogger());
      const after = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      const archivedFile = await db
        .selectFrom("indexed_files")
        .selectAll()
        .where("id", "=", before.indexed_file_id)
        .executeTakeFirstOrThrow();

      expect(result.itemsProcessed).toBe(0);
      expect(after.indexed_file_id).toBeNull();
      expect(archivedFile.is_archived).toBe(1);
      expect(archivedFile.access_scope_id).toBeNull();
    });

    it("links a kept slice to the indexed file after sync persistence", async () => {
      const seeded = await seedSlice(db, {
        verdict: "kept",
        salienceSignals: JSON.stringify({
          signals: ["decision", "named_entity"],
          entities: [{ name: "Project Atlas", type: "project" }],
        }),
      });
      const config = await seedConnectorConfig(db);

      const result = await runConnectorSync(db, config.id, createTestLogger());
      const slice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      const file = await db
        .selectFrom("indexed_files")
        .selectAll()
        .where("id", "=", slice.indexed_file_id)
        .executeTakeFirstOrThrow();
      const scopeMembers = await db
        .selectFrom("access_scope_members")
        .innerJoin("access_scopes", "access_scopes.id", "access_scope_members.access_scope_id")
        .select(["access_scope_members.email", "access_scopes.provider_scope_id"])
        .execute();

      expect(result.itemsCreated).toBe(1);
      expect(slice.indexed_file_id).toBe(file.id);
      expect(file.provider_file_id).toBe(seeded.sliceId);
      expect(file.source).toBe("whatsapp");
      expect(file.content).not.toMatch(RAW_IDENTIFIER_PATTERN);
      expect(scopeMembers).toEqual([{ email: seeded.teammateEmail, provider_scope_id: seeded.groupJid }]);
    });

    it("stops emissions for disabled groups while retaining previously indexed rows", async () => {
      const seeded = await seedSlice(db, {
        verdict: "kept",
        salienceSignals: JSON.stringify({ signals: ["decision"], entities: [] }),
      });
      const config = await seedConnectorConfig(db);
      const firstResult = await runConnectorSync(db, config.id, createTestLogger());
      const before = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      if (!before.indexed_file_id) throw new Error("expected linked file");
      const beforeFile = await db
        .selectFrom("indexed_files")
        .selectAll()
        .where("id", "=", before.indexed_file_id)
        .executeTakeFirstOrThrow();

      await createWhatsAppGroupRepository(db).setIndexEnabled(seeded.groupJid, false);
      const disabledResult = await runConnectorSync(db, config.id, createTestLogger());
      const after = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      const retainedFile = await db
        .selectFrom("indexed_files")
        .selectAll()
        .where("id", "=", before.indexed_file_id)
        .executeTakeFirstOrThrow();
      const retainedFilesForSlice = await db
        .selectFrom("indexed_files")
        .selectAll()
        .where("provider_file_id", "=", seeded.sliceId)
        .execute();

      expect(firstResult.itemsCreated).toBe(1);
      expect(disabledResult.itemsProcessed).toBe(0);
      expect(disabledResult.itemsCreated).toBe(0);
      expect(after.indexed_file_id).toBe(before.indexed_file_id);
      expect(retainedFile.is_archived).toBe(0);
      expect(retainedFile.access_scope_id).toBe(beforeFile.access_scope_id);
      expect(retainedFile.access_scope_id).not.toBeNull();
      expect(retainedFilesForSlice).toHaveLength(1);
    });
  });
}

runSalienceIntegrationSuite("WhatsApp salience sqlite", createTestDb);
runSalienceIntegrationSuite("WhatsApp salience postgres", createTestPgDb);
