import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectorRepository } from "../../db/repositories/connectors";
import { createConversationSlicesRepository } from "../../db/repositories/conversation-slices";
import { createConversationRepository } from "../../db/repositories/conversations";
import { createUserRepository } from "../../db/repositories/users";
import { createWhatsAppGroupRepository } from "../../db/repositories/whatsapp-groups";
import type { DB } from "../../db/schema";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { type WhatsAppRosterSnapshot, stableWhatsAppParticipantJidRef } from "../../whatsapp/identity-resolution";
import { UploadCollector } from "../sketch-tools";
import type { SketchMcpDeps } from "./types";
import { WHATSAPP_GROUP_HISTORY_DENIED_TEXT, handleWhatsAppGroupHistory } from "./whatsapp-group-history";

interface SeededDrill {
  groupJid: string;
  conversationId: number;
  sliceId: string;
  connectorConfigId: string;
  memberUserId: string;
  nonMemberUserId: string;
  memberEmail: string;
}

async function seedConnectorConfig(db: Kysely<DB>, ownerId: string) {
  return createConnectorRepository(db).createConfig({
    connectorType: "whatsapp",
    authType: "system",
    credentials: JSON.stringify({ type: "system" }),
    scopeConfig: "{}",
    createdBy: ownerId,
  });
}

function rosterSnapshot(memberUserId: string): WhatsAppRosterSnapshot {
  const teammateJid = "15550000001@s.whatsapp.net";
  const externalJid = "15550000002@s.whatsapp.net";
  return {
    participants: [
      {
        participantJidRef: stableWhatsAppParticipantJidRef(teammateJid),
        senderJidRefs: [stableWhatsAppParticipantJidRef(teammateJid)],
        displayName: "Tara Teammate",
        resolutionKind: "teammate",
        adminRole: null,
        userId: memberUserId,
      },
      {
        participantJidRef: stableWhatsAppParticipantJidRef(externalJid),
        senderJidRefs: [stableWhatsAppParticipantJidRef(externalJid)],
        displayName: "Rahul (Acme)",
        resolutionKind: "labeled",
        adminRole: null,
        company: "Acme",
      },
    ],
    resolutionCounts: { totalParticipants: 2, teammate: 1, entity: 0, labeled: 1, unresolved: 0 },
  };
}

async function seedIndexedGroupSlice(db: Kysely<DB>): Promise<SeededDrill> {
  const suffix = randomUUID();
  const ownerId = `owner-${suffix}`;
  const memberUserId = `member-${suffix}`;
  const nonMemberUserId = `nonmember-${suffix}`;
  const memberEmail = `member-${suffix}@example.com`;
  const groupJid = `${suffix}@g.us`;
  const users = createUserRepository(db);
  await users.create({ id: ownerId, name: "Owner", email: `owner-${suffix}@example.com` });
  await users.create({
    id: memberUserId,
    name: "Tara Teammate",
    email: memberEmail,
    whatsappNumber: "+15550000001",
  });
  await users.create({ id: nonMemberUserId, name: "Nina Nonmember", email: `nonmember-${suffix}@example.com` });

  const config = await seedConnectorConfig(db, ownerId);
  const groups = createWhatsAppGroupRepository(db);
  await groups.upsert({
    jid: groupJid,
    name: "Deal Room",
    description: null,
    updated_at: "2026-07-07T08:00:00.000Z",
  });
  await groups.setIndexEnabled(groupJid, true);
  await groups.refreshParticipants(groupJid, [
    { participantJid: "15550000001@s.whatsapp.net", phoneE164: "+15550000001", adminRole: null },
    { participantJid: "15550000002@s.whatsapp.net", phoneE164: "+15550000002", adminRole: null },
  ]);

  const conversation = await createConversationRepository(db).getOrCreate(
    { platform: "whatsapp", kind: "group", providerConversationId: groupJid },
    "Deal Room",
  );
  const messages = createConversationRepository(db);
  await messages.insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${suffix}:before`,
    senderJid: "15550000002@s.whatsapp.net",
    senderName: "Rahul",
    text: "adjacent setup banter",
    receivedAt: "2026-07-07T08:55:00.000Z",
    providerTimestamp: "2026-07-07T08:55:00.000Z",
  });
  const first = await messages.insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${suffix}:first`,
    senderJid: "15550000001@s.whatsapp.net",
    senderName: "Tara",
    text: "We decided Project Atlas starts Monday.",
    receivedAt: "2026-07-07T09:00:00.000Z",
    providerTimestamp: "2026-07-07T09:00:00.000Z",
  });
  const last = await messages.insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${suffix}:last`,
    senderJid: "15550000002@s.whatsapp.net",
    senderName: "Rahul",
    text: "Rahul confirmed the owner list.",
    receivedAt: "2026-07-07T09:10:00.000Z",
    providerTimestamp: "2026-07-07T09:10:00.000Z",
  });
  await messages.insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${suffix}:after`,
    senderJid: "15550000002@s.whatsapp.net",
    senderName: "Rahul",
    text: "adjacent after banter",
    attachments: [
      {
        originalName: "photo.jpg",
        mimeType: "image/jpeg",
        localPath: "/tmp/photo.jpg",
        sizeBytes: 10,
      },
    ],
    receivedAt: "2026-07-07T09:20:00.000Z",
    providerTimestamp: "2026-07-07T09:20:00.000Z",
  });

  const slice = await createConversationSlicesRepository(db).insertIfAbsent({
    conversationId: conversation.id,
    firstMessageId: first.row.id,
    lastMessageId: last.row.id,
    startedAt: first.row.receivedAt,
    endedAt: last.row.receivedAt,
    messageCount: 2,
    denoisedMessageIds: [first.row.id, last.row.id],
    flushReason: "gap",
    rosterSnapshot: JSON.stringify(rosterSnapshot(memberUserId)),
    salienceVerdict: "kept",
    salienceSignals: JSON.stringify({ signals: ["decision"], entities: [] }),
  });

  const scopeId = `scope-${suffix}`;
  const fileId = `file-${suffix}`;
  await db
    .insertInto("access_scopes")
    .values({
      id: scopeId,
      connector_config_id: config.id,
      scope_type: "whatsapp_group",
      provider_scope_id: groupJid,
      label: "Deal Room",
    })
    .execute();
  await db.insertInto("access_scope_members").values({ access_scope_id: scopeId, email: memberEmail }).execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: config.id,
      provider_file_id: slice.row.id,
      provider_message_id: null,
      thread_id: String(conversation.id),
      provider_url: null,
      file_name: "WhatsApp: Deal Room",
      file_type: "whatsapp_conversation_slice",
      content_category: "document",
      content:
        "WhatsApp roster:\n- Tara Teammate\n\nTranscript:\nTara Teammate: We decided Project Atlas starts Monday.",
      summary: null,
      source: "whatsapp",
      source_path: null,
      rollup_group_id: null,
      content_hash: `hash-${suffix}`,
      source_created_at: first.row.receivedAt,
      source_updated_at: last.row.receivedAt,
      synced_at: "2026-07-07T09:11:00.000Z",
      context_note: null,
      access_scope_id: scopeId,
      mime_type: null,
    })
    .execute();
  await db.updateTable("conversation_slices").set({ indexed_file_id: fileId }).where("id", "=", slice.row.id).execute();

  return {
    groupJid,
    conversationId: conversation.id,
    sliceId: slice.row.id,
    connectorConfigId: config.id,
    memberUserId,
    nonMemberUserId,
    memberEmail,
  };
}

async function seedArchivedZeroScopeSlice(db: Kysely<DB>, seeded: SeededDrill): Promise<string> {
  const suffix = randomUUID();
  const messages = createConversationRepository(db);
  const first = await messages.insertMessage({
    conversationId: seeded.conversationId,
    providerMessageId: `${suffix}:archived-first`,
    senderJid: "15550000002@s.whatsapp.net",
    senderName: "Rahul",
    text: "archived zero scope setup",
    receivedAt: "2026-07-07T12:00:00.000Z",
    providerTimestamp: "2026-07-07T12:00:00.000Z",
  });
  const last = await messages.insertMessage({
    conversationId: seeded.conversationId,
    providerMessageId: `${suffix}:archived-last`,
    senderJid: "15550000002@s.whatsapp.net",
    senderName: "Rahul",
    text: "archived zero scope followup",
    receivedAt: "2026-07-07T12:10:00.000Z",
    providerTimestamp: "2026-07-07T12:10:00.000Z",
  });
  const slice = await createConversationSlicesRepository(db).insertIfAbsent({
    conversationId: seeded.conversationId,
    firstMessageId: first.row.id,
    lastMessageId: last.row.id,
    startedAt: first.row.receivedAt,
    endedAt: last.row.receivedAt,
    messageCount: 2,
    denoisedMessageIds: [first.row.id, last.row.id],
    flushReason: "gap",
    rosterSnapshot: JSON.stringify(rosterSnapshot(seeded.memberUserId)),
    salienceVerdict: "kept",
  });
  const fileId = `archived-file-${suffix}`;
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: seeded.connectorConfigId,
      provider_file_id: slice.row.id,
      provider_message_id: null,
      thread_id: String(seeded.conversationId),
      provider_url: null,
      file_name: "WhatsApp: Deal Room archived",
      file_type: "whatsapp_conversation_slice",
      content_category: "document",
      content: "Archived zero scope transcript.",
      summary: null,
      source: "whatsapp",
      source_path: null,
      rollup_group_id: null,
      content_hash: `archived-hash-${suffix}`,
      is_archived: 1,
      source_created_at: first.row.receivedAt,
      source_updated_at: last.row.receivedAt,
      synced_at: "2026-07-07T12:11:00.000Z",
      context_note: null,
      access_scope_id: null,
      mime_type: null,
    })
    .execute();
  await db.updateTable("conversation_slices").set({ indexed_file_id: fileId }).where("id", "=", slice.row.id).execute();

  return slice.row.id;
}

async function seedWindowBoundaryMessages(db: Kysely<DB>, seeded: SeededDrill): Promise<void> {
  const suffix = randomUUID();
  await createConversationRepository(db).insertMessage({
    conversationId: seeded.conversationId,
    providerMessageId: `${suffix}:outside-before`,
    senderJid: "15550000002@s.whatsapp.net",
    senderName: "Rahul",
    text: "outside before authorized expansion",
    receivedAt: "2026-07-07T08:49:00.000Z",
    providerTimestamp: "2026-07-07T08:49:00.000Z",
  });
  await createConversationRepository(db).insertMessage({
    conversationId: seeded.conversationId,
    providerMessageId: `${suffix}:outside-after`,
    senderJid: "15550000002@s.whatsapp.net",
    senderName: "Rahul",
    text: "outside after authorized expansion",
    receivedAt: "2026-07-07T09:21:00.000Z",
    providerTimestamp: "2026-07-07T09:21:00.000Z",
  });
}

async function seedDmSlice(db: Kysely<DB>, memberUserId: string): Promise<{ conversationId: number; sliceId: string }> {
  const suffix = randomUUID();
  const conversation = await createConversationRepository(db).getOrCreate({
    platform: "whatsapp",
    kind: "dm",
    providerConversationId: `${suffix}@s.whatsapp.net`,
  });
  const inserted = await createConversationRepository(db).insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${suffix}:dm`,
    senderJid: `${suffix}@s.whatsapp.net`,
    senderName: "DM Sender",
    text: "private dm",
    receivedAt: "2026-07-07T09:00:00.000Z",
  });
  const slice = await createConversationSlicesRepository(db).insertIfAbsent({
    conversationId: conversation.id,
    firstMessageId: inserted.row.id,
    lastMessageId: inserted.row.id,
    startedAt: inserted.row.receivedAt,
    endedAt: inserted.row.receivedAt,
    messageCount: 1,
    flushReason: "gap",
    rosterSnapshot: JSON.stringify(rosterSnapshot(memberUserId)),
    salienceVerdict: "kept",
  });
  return { conversationId: conversation.id, sliceId: slice.row.id };
}

async function runTool(db: Kysely<DB>, currentUserId: string, input: Parameters<typeof handleWhatsAppGroupHistory>[0]) {
  return handleWhatsAppGroupHistory(input, {
    db,
    userRepo: createUserRepository(db),
    currentUserId,
    uploadCollector: new UploadCollector(),
    workspaceDir: "/tmp/workspace",
  } satisfies SketchMcpDeps);
}

function runWhatsAppGroupHistorySuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("lets an authorized member fetch a slice window with adjacent dropped messages", async () => {
      const seeded = await seedIndexedGroupSlice(db);
      const result = await runTool(db, seeded.memberUserId, {
        sliceId: seeded.sliceId,
        expandMinutes: 10,
        limit: 10,
      });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.groupRef).toBe(`conversation:${seeded.conversationId}`);
      expect(payload.messages.map((m: { text: string }) => m.text)).toEqual([
        "adjacent setup banter",
        "We decided Project Atlas starts Monday.",
        "Rahul confirmed the owner list.",
        "adjacent after banter",
      ]);
      expect(payload.messages[3]).toMatchObject({ attachments: ["[image]"] });
      expect(result.content[0].text).not.toContain("/tmp/photo.jpg");
      expect(result.content[0].text).not.toMatch(/@s\.whatsapp\.net|@lid/u);
    });

    it("supports direct group windows through the returned groupRef", async () => {
      const seeded = await seedIndexedGroupSlice(db);
      await seedWindowBoundaryMessages(db, seeded);
      const result = await runTool(db, seeded.memberUserId, {
        groupRef: `conversation:${seeded.conversationId}`,
        startedAt: "2026-07-07T09:00:00.000Z",
        endedAt: "2026-07-07T09:10:00.000Z",
        expandMinutes: 10,
        limit: 10,
      });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.window).toMatchObject({
        start: "2026-07-07T08:50:00.000Z",
        end: "2026-07-07T09:20:00.000Z",
        expandMinutes: 10,
      });
      expect(payload.messages.map((m: { text: string }) => m.text)).toEqual([
        "adjacent setup banter",
        "We decided Project Atlas starts Monday.",
        "Rahul confirmed the owner list.",
        "adjacent after banter",
      ]);
      expect(payload.hasMore).toBe(false);
    });

    it("denies groupRef windows over archived zero-scope slices even with accessible slices elsewhere", async () => {
      const seeded = await seedIndexedGroupSlice(db);
      await seedArchivedZeroScopeSlice(db, seeded);

      const result = await runTool(db, seeded.memberUserId, {
        groupRef: `conversation:${seeded.conversationId}`,
        startedAt: "2026-07-07T12:00:00.000Z",
        endedAt: "2026-07-07T12:10:00.000Z",
        expandMinutes: 0,
        limit: 10,
      });

      expect(result.content[0].text).toBe(WHATSAPP_GROUP_HISTORY_DENIED_TEXT);
    });

    it("returns hasMore and a page token when the result is limited", async () => {
      const seeded = await seedIndexedGroupSlice(db);
      const first = await runTool(db, seeded.memberUserId, {
        sliceId: seeded.sliceId,
        expandMinutes: 10,
        limit: 2,
      });
      const firstPayload = JSON.parse(first.content[0].text);
      const second = await runTool(db, seeded.memberUserId, {
        sliceId: seeded.sliceId,
        expandMinutes: 10,
        limit: 10,
        pageToken: firstPayload.nextPageToken,
      });
      const secondPayload = JSON.parse(second.content[0].text);

      expect(firstPayload.hasMore).toBe(true);
      expect(firstPayload.nextPageToken).toEqual(expect.any(String));
      expect(secondPayload.messages.map((m: { text: string }) => m.text)).toEqual([
        "Rahul confirmed the owner list.",
        "adjacent after banter",
      ]);
      expect(secondPayload.hasMore).toBe(false);
    });

    it("rejects a page token tampered across conversation bounds", async () => {
      const seeded = await seedIndexedGroupSlice(db);
      const first = await runTool(db, seeded.memberUserId, {
        sliceId: seeded.sliceId,
        expandMinutes: 10,
        limit: 2,
      });
      const firstPayload = JSON.parse(first.content[0].text);
      const decoded = JSON.parse(Buffer.from(firstPayload.nextPageToken, "base64url").toString("utf8"));
      const tampered = Buffer.from(
        JSON.stringify({ ...decoded, conversationId: decoded.conversationId + 1 }),
        "utf8",
      ).toString("base64url");

      const result = await runTool(db, seeded.memberUserId, {
        sliceId: seeded.sliceId,
        expandMinutes: 10,
        limit: 10,
        pageToken: tampered,
      });

      expect(result.content[0].text).toBe("Invalid pageToken.");
    });

    it("denies non-members, disabled groups, DM slices, and unknown slices with the same shape", async () => {
      const seeded = await seedIndexedGroupSlice(db);
      const nonMember = await runTool(db, seeded.nonMemberUserId, { sliceId: seeded.sliceId });
      await createWhatsAppGroupRepository(db).setIndexEnabled(seeded.groupJid, false);
      const disabled = await runTool(db, seeded.memberUserId, { sliceId: seeded.sliceId });
      const dmSlice = await seedDmSlice(db, seeded.memberUserId);
      const dm = await runTool(db, seeded.memberUserId, { sliceId: dmSlice.sliceId });
      const unknown = await runTool(db, seeded.memberUserId, { sliceId: `missing-${randomUUID()}` });

      expect(nonMember.content[0].text).toBe(WHATSAPP_GROUP_HISTORY_DENIED_TEXT);
      expect(disabled.content[0].text).toBe(nonMember.content[0].text);
      expect(dm.content[0].text).toBe(nonMember.content[0].text);
      expect(unknown.content[0].text).toBe(nonMember.content[0].text);
    });

    it("denies non-members, disabled groups, DM conversations, and unknown groupRefs with the same shape", async () => {
      const seeded = await seedIndexedGroupSlice(db);
      const input = {
        startedAt: "2026-07-07T09:00:00.000Z",
        endedAt: "2026-07-07T09:10:00.000Z",
        expandMinutes: 0,
      };
      const nonMember = await runTool(db, seeded.nonMemberUserId, {
        groupRef: `conversation:${seeded.conversationId}`,
        ...input,
      });
      const unknown = await runTool(db, seeded.memberUserId, {
        groupRef: `conversation:${seeded.conversationId + 10_000}`,
        ...input,
      });
      const dmSlice = await seedDmSlice(db, seeded.memberUserId);
      const dm = await runTool(db, seeded.memberUserId, {
        groupRef: `conversation:${dmSlice.conversationId}`,
        ...input,
      });
      await createWhatsAppGroupRepository(db).setIndexEnabled(seeded.groupJid, false);
      const disabled = await runTool(db, seeded.memberUserId, {
        groupRef: `conversation:${seeded.conversationId}`,
        ...input,
      });

      expect(nonMember.content[0].text).toBe(WHATSAPP_GROUP_HISTORY_DENIED_TEXT);
      expect(unknown).toEqual(nonMember);
      expect(dm).toEqual(nonMember);
      expect(disabled).toEqual(nonMember);
    });
  });
}

runWhatsAppGroupHistorySuite("WhatsAppGroupHistory sqlite", createTestDb);
runWhatsAppGroupHistorySuite("WhatsAppGroupHistory postgres", createTestPgDb);
