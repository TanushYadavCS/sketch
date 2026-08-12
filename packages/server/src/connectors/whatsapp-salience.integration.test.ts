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
import { runEnrichment } from "./enrichment";
import type { GeminiGenerator } from "./gemini-generate";
import { runConnectorSync } from "./sync";
import { emitWhatsAppSyncedItems, reconcileWhatsAppGroupAcls } from "./whatsapp-salience";

const RAW_IDENTIFIER_PATTERN = /(?:\+?[1-9]\d{9,14}\b|@s\.whatsapp\.net|@lid)/iu;
const SALIENCE_SIGNALS = JSON.stringify({ signals: ["decision"], entities: [] });
let seededTeammateSequence = 0;

interface SeededSlice {
  groupJid: string;
  conversationId: number;
  sliceId: string;
  teammatePhone: string;
  teammateEmail: string | null;
  teammateUserId: string | null;
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
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

function nextTeammatePhone(): string {
  seededTeammateSequence += 1;
  return `+1555${String(seededTeammateSequence).padStart(7, "0")}`;
}

async function seedSlice(
  db: Kysely<DB>,
  options: {
    teammate?: boolean;
    verdict?: "kept" | "dropped" | null;
    status?: "open" | "closed";
    chunkMinMessages?: number | null;
    chunkProvisionalRefreshMessages?: number | null;
    salienceSignals?: string | null;
    text?: string;
    teammatePhone?: string;
    teammateUserId?: string;
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
  await groups.setIndexEnabled(groupJid, true, {
    chunkMinMessages: options.chunkMinMessages,
    chunkProvisionalRefreshMessages: options.chunkProvisionalRefreshMessages,
  });

  const teammateUserId = options.teammate === false ? null : (options.teammateUserId ?? `teammate-${randomUUID()}`);
  const teammatePhone = options.teammatePhone ?? nextTeammatePhone();
  const teammateJid = `${teammatePhone.replace(/\D/gu, "")}@s.whatsapp.net`;
  const teammateEmail = teammateUserId ? `${teammateUserId}@example.com` : null;
  if (teammateUserId && teammateEmail) {
    await createUserRepository(db).create({
      id: teammateUserId,
      name: "Tara Teammate",
      email: teammateEmail,
      whatsappNumber: teammatePhone,
    });
  }

  const participants = teammateEmail
    ? [
        { participantJid: teammateJid, phoneE164: teammatePhone, adminRole: null },
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
        senderJid: teammateJid,
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
    status: options.status,
  });

  return {
    groupJid,
    conversationId: conversation.id,
    sliceId: inserted.row.id,
    teammatePhone,
    teammateEmail,
    teammateUserId,
  };
}

async function collectEmittedWhatsAppItems(db: Kysely<DB>, options: { emissionRefreshDays?: number; now?: Date } = {}) {
  const items = [];
  for await (const item of emitWhatsAppSyncedItems({
    db,
    logger: fakeLogger(),
    emissionRefreshDays: options.emissionRefreshDays,
    now: options.now,
  })) {
    items.push(item);
  }
  return items;
}

async function setSliceWindow(db: Kysely<DB>, sliceId: string, startedAt: string, endedAt: string): Promise<void> {
  await db
    .updateTable("conversation_slices")
    .set({ started_at: startedAt, ended_at: endedAt })
    .where("id", "=", sliceId)
    .execute();
}

async function linkSliceToIndexedFile(db: Kysely<DB>, connectorConfigId: string, sliceId: string): Promise<string> {
  const fileId = `file-${randomUUID()}`;
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: connectorConfigId,
      provider_file_id: sliceId,
      provider_message_id: null,
      thread_id: null,
      provider_url: null,
      file_name: `WhatsApp slice ${sliceId}`,
      file_type: "whatsapp_conversation_slice",
      content_category: "document",
      content: "Linked WhatsApp slice",
      summary: null,
      source: "whatsapp",
      source_path: null,
      rollup_group_id: null,
      content_hash: null,
      source_created_at: null,
      source_updated_at: null,
      synced_at: "2026-07-08T00:00:00.000Z",
      context_note: null,
      access_scope_id: null,
      mime_type: null,
      embedding_next_retry_at: null,
      summary_next_retry_at: null,
    })
    .execute();
  await db.updateTable("conversation_slices").set({ indexed_file_id: fileId }).where("id", "=", sliceId).execute();
  return fileId;
}

async function activeFacts(db: Kysely<DB>, fileId?: string) {
  let query = db.selectFrom("indexed_file_facts").selectAll().where("deleted_at", "is", null);
  if (fileId) query = query.where("indexed_file_id", "=", fileId);
  return query.orderBy("subject_name", "asc").execute();
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

    it("emits a closed LLM-kept slice once with group scope and never re-judges", async () => {
      const seeded = await seedSlice(db, {
        verdict: "kept",
        status: "closed",
        salienceSignals: JSON.stringify({ boundary: "llm" }),
      });
      const config = await seedConnectorConfig(db);

      const firstSync = await runConnectorSync(db, config.id, createTestLogger());
      const secondSync = await runConnectorSync(db, config.id, createTestLogger());
      const slice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      const file = await db
        .selectFrom("indexed_files")
        .selectAll()
        .where("provider_file_id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      const scopeMembers = await db
        .selectFrom("access_scope_members")
        .innerJoin("access_scopes", "access_scopes.id", "access_scope_members.access_scope_id")
        .select(["access_scope_members.principal_value", "access_scopes.provider_scope_id"])
        .where("access_scopes.provider_scope_id", "=", seeded.groupJid)
        .execute();

      expect(firstSync.itemsCreated).toBe(1);
      expect(secondSync.itemsCreated).toBe(0);
      expect(slice.salience_verdict).toBe("kept");
      expect(file.provider_file_id).toBe(seeded.sliceId);
      expect(file.content).toContain("Group: ");
      expect(file.content).not.toContain("WhatsApp roster:");
      expect(file.content).toContain("Tara Teammate:");
      expect(file.content).not.toMatch(RAW_IDENTIFIER_PATTERN);
      expect(scopeMembers.map((row) => row.principal_value)).toEqual(
        expect.arrayContaining([seeded.teammatePhone, "+15550000002", seeded.teammateEmail]),
      );
    });

    it("materializes and refreshes one open slice by growth threshold, then emits a boundary shrink", async () => {
      const seeded = await seedSlice(db, {
        status: "open",
        verdict: "kept",
        chunkMinMessages: 1,
        chunkProvisionalRefreshMessages: 2,
      });
      const config = await seedConnectorConfig(db);
      const liveNow = new Date().toISOString();
      await db
        .updateTable("conversation_messages")
        .set({ received_at: liveNow })
        .where("conversation_id", "=", seeded.conversationId)
        .execute();
      await setSliceWindow(db, seeded.sliceId, liveNow, liveNow);
      const firstSync = await runConnectorSync(db, config.id, createTestLogger());
      const before = await db
        .selectFrom("indexed_files")
        .selectAll()
        .where("provider_file_id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      const slice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      const messages = createConversationRepository(db);
      const third = await messages.insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: `${seeded.groupJid}:3`,
        senderJid: "15550000002@s.whatsapp.net",
        senderName: "External Buyer",
        text: "one more update",
        receivedAt: "2026-07-07T09:02:00.000Z",
      });
      await db
        .updateTable("conversation_slices")
        .set({
          last_message_id: third.row.id,
          ended_at: "2026-07-07T09:02:00.000Z",
          message_count: 3,
          denoised_message_ids: JSON.stringify([slice.first_message_id, slice.last_message_id, third.row.id]),
        })
        .where("id", "=", seeded.sliceId)
        .execute();
      await expect(collectEmittedWhatsAppItems(db)).resolves.toEqual([]);

      const fourth = await messages.insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: `${seeded.groupJid}:4`,
        senderJid: "15550000002@s.whatsapp.net",
        senderName: "External Buyer",
        text: "second update",
        receivedAt: "2026-07-07T09:03:00.000Z",
      });
      await db
        .updateTable("conversation_slices")
        .set({
          last_message_id: fourth.row.id,
          ended_at: "2026-07-07T09:03:00.000Z",
          message_count: 4,
          denoised_message_ids: JSON.stringify([
            slice.first_message_id,
            slice.last_message_id,
            third.row.id,
            fourth.row.id,
          ]),
        })
        .where("id", "=", seeded.sliceId)
        .execute();
      const grown = await collectEmittedWhatsAppItems(db);

      expect(firstSync.itemsCreated).toBe(1);
      expect(before.access_scope_id).not.toBeNull();
      const scopeMembers = await db
        .selectFrom("access_scope_members")
        .selectAll()
        .where("access_scope_id", "=", before.access_scope_id)
        .execute();
      expect(scopeMembers.length).toBeGreaterThanOrEqual(2);
      expect(grown).toHaveLength(1);
      expect(grown[0]?.providerFileId).toBe(seeded.sliceId);
      expect(grown[0]?.contentHash).not.toBe(before.content_hash);
      await createWhatsAppGroupRepository(db).setIndexEnabled(seeded.groupJid, true, {
        chunkIdleCloseHours: 100_000,
      });
      const materializedGrowth = await runConnectorSync(db, config.id, createTestLogger());
      const grownFile = await db
        .selectFrom("indexed_files")
        .select("content_hash")
        .where("id", "=", before.id)
        .executeTakeFirstOrThrow();
      expect(materializedGrowth.itemsUpdated).toBe(1);
      expect(grownFile.content_hash).toBe(grown[0]?.contentHash);

      await db
        .updateTable("conversation_slices")
        .set({
          last_message_id: slice.last_message_id,
          ended_at: slice.ended_at,
          message_count: 2,
          denoised_message_ids: JSON.stringify([slice.first_message_id, slice.last_message_id]),
        })
        .where("id", "=", seeded.sliceId)
        .execute();
      const shrunk = await collectEmittedWhatsAppItems(db);

      expect(shrunk).toHaveLength(1);
      expect(shrunk[0]?.providerFileId).toBe(seeded.sliceId);
      await expect(
        db.selectFrom("indexed_files").select("provider_file_id").where("id", "=", before.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ provider_file_id: seeded.sliceId });
    });

    it("emits zero structural_seed facts for a kept slice with salience structural entities", async () => {
      const seeded = await seedSlice(db, {
        verdict: "kept",
        salienceSignals: JSON.stringify({
          signals: ["decision", "named_entity"],
          entities: [
            { name: "ClickUp", type: "product" },
            { name: "WATI", type: "product" },
            { name: "Sketch", type: "product" },
            { name: "Jarvis", type: "product" },
          ],
        }),
        text: "ClickUp and WATI should feed Sketch and Jarvis followups.",
      });
      const config = await seedConnectorConfig(db);

      const result = await runConnectorSync(db, config.id, createTestLogger());
      const slice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      const facts = await activeFacts(db, slice.indexed_file_id ?? undefined);

      expect(result.itemsCreated).toBe(1);
      expect(slice.indexed_file_id).not.toBeNull();
      expect(facts.filter((fact) => fact.fact_type === "structural_seed")).toHaveLength(0);
    });

    it("creates WhatsApp slice entities through sync plus v13 enrichment, not salience seeds", async () => {
      const seeded = await seedSlice(db, {
        verdict: "kept",
        salienceSignals: JSON.stringify({
          signals: ["decision", "named_entity"],
          entities: [
            { name: "ClickUp", type: "product" },
            { name: "WATI", type: "product" },
            { name: "Sketch", type: "product" },
            { name: "Jarvis", type: "product" },
          ],
        }),
        text: "Use ClickUp and WATI as tools while Sketch and Jarvis stay product workstreams.",
      });
      const config = await seedConnectorConfig(db);
      const syncResult = await runConnectorSync(db, config.id, createTestLogger());
      const slice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      if (!slice.indexed_file_id) throw new Error("expected linked WhatsApp slice file");

      const generator = {
        generate: async () => "ClickUp and WATI support Sketch and Jarvis workstreams.",
        generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
          if (opts?.label?.startsWith("extractEntities")) {
            return {
              mentions: [
                { mention: "ClickUp", type: "tool", variations: [], confidence: 0.95 },
                { mention: "WATI", type: "tool", variations: [], confidence: 0.95 },
                { mention: "Sketch", type: "product", variations: [], confidence: 0.94 },
                { mention: "Jarvis", type: "product", variations: [], confidence: 0.94 },
              ],
              relations: [],
            } as T;
          }
          return {} as T;
        },
      } as GeminiGenerator;

      const enrichResult = await runEnrichment({
        db,
        logger: createTestLogger(),
        embeddingProvider: null,
        generator,
        fileIds: [slice.indexed_file_id],
      });
      const facts = await activeFacts(db, slice.indexed_file_id);
      const structuralFacts = facts.filter((fact) => fact.fact_type === "structural_seed");
      const llmFacts = facts.filter((fact) => fact.fact_type === "llm_extracted");
      const llmTypesByName = new Map(
        llmFacts.map((fact) => [fact.subject_name, JSON.parse(fact.raw ?? "{}").type as string]),
      );

      expect(syncResult.itemsCreated).toBe(1);
      expect(enrichResult.filesProcessed).toBe(1);
      expect(structuralFacts).toHaveLength(0);
      expect(llmTypesByName).toEqual(
        new Map([
          ["ClickUp", "tool"],
          ["Jarvis", "product"],
          ["Sketch", "product"],
          ["WATI", "tool"],
        ]),
      );
      expect(new Set(llmFacts.map((fact) => fact.subject_name)).size).toBe(llmFacts.length);
    });

    it("emits kept closed slices without a WhatsApp salience gate and preserves privacy", async () => {
      const kept = await seedSlice(db, {
        verdict: "kept",
        salienceSignals: JSON.stringify({ boundary: "llm" }),
        text: "We decided Project Atlas starts Monday with 0 tasks assigned.",
      });
      const dropped = await seedSlice(db, { verdict: "dropped", text: "haha okay" });
      const unscoped = await seedSlice(db, {
        teammate: false,
        verdict: "kept",
        salienceSignals: JSON.stringify({ boundary: "llm" }),
      });
      const config = await seedConnectorConfig(db);
      const result = await runConnectorSync(db, config.id, createTestLogger());
      const keptSlice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", kept.sliceId)
        .executeTakeFirstOrThrow();
      const droppedSlice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", dropped.sliceId)
        .executeTakeFirstOrThrow();
      const unscopedSlice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", unscoped.sliceId)
        .executeTakeFirstOrThrow();

      expect(result.itemsCreated).toBe(2);
      expect(keptSlice.salience_verdict).toBe("kept");
      expect(droppedSlice.salience_verdict).toBe("dropped");
      expect(unscopedSlice.salience_verdict).toBe("kept");
      expect(keptSlice.indexed_file_id).not.toBeNull();
      expect(droppedSlice.indexed_file_id).toBeNull();
      expect(unscopedSlice.indexed_file_id).not.toBeNull();
      const keptFile = await db
        .selectFrom("indexed_files")
        .select("content")
        .where("id", "=", keptSlice.indexed_file_id)
        .executeTakeFirstOrThrow();
      expect(keptFile.content).toContain("Group: ");
      expect(keptFile.content).not.toContain("WhatsApp roster:");
      expect(keptFile.content).toContain("Tara Teammate:");
      expect(keptFile.content).not.toMatch(RAW_IDENTIFIER_PATTERN);
      await expect(db.selectFrom("tasks").selectAll().execute()).resolves.toEqual([]);
    });

    it("does not emit a non-kept slice when the LLM path has no kept boundary", async () => {
      const seeded = await seedSlice(db, { verdict: "dropped", text: "haha okay" });
      const config = await seedConnectorConfig(db);

      const result = await runConnectorSync(db, config.id, createTestLogger());
      const slice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();

      expect(result.itemsCreated).toBe(0);
      expect(slice.salience_verdict).toBe("dropped");
      await expect(db.selectFrom("indexed_files").selectAll().execute()).resolves.toEqual([]);
    });

    it("leaves a pending slice untouched when the WhatsApp chunker generator is unavailable", async () => {
      const seeded = await seedSlice(db, { verdict: null });
      const config = await seedConnectorConfig(db);

      const result = await runConnectorSync(db, config.id, createTestLogger());
      const slice = await db
        .selectFrom("conversation_slices")
        .select("salience_verdict")
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();

      expect(result.itemsCreated).toBe(0);
      expect(slice.salience_verdict).toBeNull();
      await expect(db.selectFrom("indexed_files").selectAll().execute()).resolves.toEqual([]);
    });

    it("keeps a phone-only group when no teammate email resolves", async () => {
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

      expect(result.itemsProcessed).toBe(1);
      expect(slice.indexed_file_id).not.toBeNull();
      await expect(db.selectFrom("indexed_files").selectAll().execute()).resolves.toHaveLength(1);
    });

    it("archives a group when its typed principal set is truly empty", async () => {
      const seeded = await seedSlice(db, {
        teammatePhone: "+15550000003",
        verdict: "kept",
        salienceSignals: SALIENCE_SIGNALS,
      });
      const config = await seedConnectorConfig(db);
      const scopeId = await createConnectorRepository(db).upsertAccessScope(config.id, {
        scopeType: "whatsapp_group",
        providerScopeId: seeded.groupJid,
        label: "Deal Room",
        members: [],
      });
      const fileId = await linkSliceToIndexedFile(db, config.id, seeded.sliceId);
      await db.updateTable("indexed_files").set({ access_scope_id: scopeId }).where("id", "=", fileId).execute();

      await db.deleteFrom("whatsapp_group_participants").where("group_jid", "=", seeded.groupJid).execute();
      const result = await reconcileWhatsAppGroupAcls({
        db,
        logger: createTestLogger(),
        connectorConfigId: config.id,
      });
      const file = await db
        .selectFrom("indexed_files")
        .select(["is_archived", "access_scope_id"])
        .where("id", "=", fileId)
        .executeTakeFirstOrThrow();

      expect(result.filesArchived).toBe(1);
      expect(file).toEqual({ is_archived: 1, access_scope_id: null });
    });

    it("keeps an existing linked file when email resolution later disappears", async () => {
      const seeded = await seedSlice(db, {
        verdict: "kept",
        salienceSignals: JSON.stringify({ signals: ["decision"], entities: [] }),
      });
      const config = await seedConnectorConfig(db);
      await runConnectorSync(db, config.id, createTestLogger());
      if (!seeded.teammateUserId) throw new Error("expected teammate user");
      const before = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      if (!before.indexed_file_id) throw new Error("expected linked file");

      const recentEnd = new Date();
      await setSliceWindow(
        db,
        seeded.sliceId,
        new Date(recentEnd.getTime() - 60_000).toISOString(),
        recentEnd.toISOString(),
      );

      await db.updateTable("users").set({ whatsapp_number: null }).where("id", "=", seeded.teammateUserId).execute();
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

      expect(result.itemsProcessed).toBe(1);
      expect(after.indexed_file_id).toBe(before.indexed_file_id);
      expect(archivedFile.is_archived).toBe(0);
      expect(archivedFile.access_scope_id).not.toBeNull();
    });

    it("keeps a requeued slice when email resolution later disappears", async () => {
      const seeded = await seedSlice(db, {
        verdict: "kept",
        salienceSignals: JSON.stringify({ signals: ["decision"], entities: [] }),
      });
      const config = await seedConnectorConfig(db);
      await runConnectorSync(db, config.id, createTestLogger());
      if (!seeded.teammateUserId) throw new Error("expected teammate user");
      const before = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", seeded.sliceId)
        .executeTakeFirstOrThrow();
      if (!before.indexed_file_id) throw new Error("expected linked file");

      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: null })
        .where("id", "=", seeded.sliceId)
        .execute();
      const recentEnd = new Date();
      await setSliceWindow(
        db,
        seeded.sliceId,
        new Date(recentEnd.getTime() - 60_000).toISOString(),
        recentEnd.toISOString(),
      );
      await db.updateTable("users").set({ whatsapp_number: null }).where("id", "=", seeded.teammateUserId).execute();

      const result = await runConnectorSync(db, config.id, createTestLogger());
      const archivedFile = await db
        .selectFrom("indexed_files")
        .selectAll()
        .where("id", "=", before.indexed_file_id)
        .executeTakeFirstOrThrow();

      expect(result.itemsProcessed).toBe(1);
      expect(archivedFile.is_archived).toBe(0);
      expect(archivedFile.access_scope_id).not.toBeNull();
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
        .select(["access_scope_members.principal_value", "access_scopes.provider_scope_id"])
        .execute();

      expect(result.itemsCreated).toBe(1);
      expect(slice.indexed_file_id).toBe(file.id);
      expect(JSON.parse(slice.roster_snapshot).participants).toHaveLength(2);
      expect(file.provider_file_id).toBe(seeded.sliceId);
      expect(file.source).toBe("whatsapp");
      expect(file.content).not.toMatch(RAW_IDENTIFIER_PATTERN);
      expect(scopeMembers.map((row) => `${row.principal_value}\u0000${row.provider_scope_id}`).sort()).toEqual(
        [
          `+15550000002\u0000${seeded.groupJid}`,
          `${seeded.teammateEmail}\u0000${seeded.groupJid}`,
          `${seeded.teammatePhone}\u0000${seeded.groupJid}`,
        ].sort(),
      );
    });

    it("emits old unlinked and recent linked kept slices while skipping old linked slices", async () => {
      const config = await seedConnectorConfig(db);
      const oldLinked = await seedSlice(db, { verdict: "kept", salienceSignals: SALIENCE_SIGNALS });
      const oldUnlinked = await seedSlice(db, { verdict: "kept", salienceSignals: SALIENCE_SIGNALS });
      const recentLinked = await seedSlice(db, { verdict: "kept", salienceSignals: SALIENCE_SIGNALS });

      await setSliceWindow(db, oldLinked.sliceId, "2026-06-30T09:00:00.000Z", "2026-06-30T09:01:00.000Z");
      await setSliceWindow(db, oldUnlinked.sliceId, "2026-06-30T10:00:00.000Z", "2026-06-30T10:01:00.000Z");
      await setSliceWindow(db, recentLinked.sliceId, "2026-07-05T09:00:00.000Z", "2026-07-05T09:01:00.000Z");
      await linkSliceToIndexedFile(db, config.id, oldLinked.sliceId);
      await linkSliceToIndexedFile(db, config.id, recentLinked.sliceId);

      const items = await collectEmittedWhatsAppItems(db, {
        emissionRefreshDays: 7,
        now: new Date("2026-07-08T00:00:00.000Z"),
      });

      expect(items.map((item) => item.providerFileId).sort()).toEqual(
        [oldUnlinked.sliceId, recentLinked.sliceId].sort(),
      );
    });

    it("does not archive old linked slices when a partial sync emits newer slices", async () => {
      const config = await seedConnectorConfig(db);
      const oldLinked = await seedSlice(db, { verdict: "kept", salienceSignals: SALIENCE_SIGNALS });
      const recentUnlinked = await seedSlice(db, { verdict: "kept", salienceSignals: SALIENCE_SIGNALS });
      await setSliceWindow(db, oldLinked.sliceId, "2020-01-01T09:00:00.000Z", "2020-01-01T09:01:00.000Z");
      await setSliceWindow(
        db,
        recentUnlinked.sliceId,
        new Date(Date.now() - 60_000).toISOString(),
        new Date().toISOString(),
      );
      const oldFileId = await linkSliceToIndexedFile(db, config.id, oldLinked.sliceId);

      const result = await runConnectorSync(db, config.id, createTestLogger());
      const oldFile = await db
        .selectFrom("indexed_files")
        .select(["is_archived"])
        .where("id", "=", oldFileId)
        .executeTakeFirstOrThrow();

      expect(result.itemsCreated).toBe(1);
      expect(result.itemsArchived).toBe(0);
      expect(oldFile.is_archived).toBe(0);
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
