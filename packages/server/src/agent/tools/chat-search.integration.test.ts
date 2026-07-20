import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileWhatsAppGroupAcls } from "../../connectors/whatsapp-salience";
import { createConnectorRepository } from "../../db/repositories/connectors";
import { createConversationSlicesRepository } from "../../db/repositories/conversation-slices";
import { createConversationRepository } from "../../db/repositories/conversations";
import { createUserRepository } from "../../db/repositories/users";
import { createWhatsAppGroupRepository } from "../../db/repositories/whatsapp-groups";
import type { DB } from "../../db/schema";
import { createTestDb, createTestLogger, createTestPgDb } from "../../test-utils";
import { stableWhatsAppParticipantJidRef } from "../../whatsapp/identity-resolution";
import { handleAllChatsSearch } from "./chat-search";
import type { SketchMcpDeps } from "./types";

const USER_ID = "user-roopak";
const USER_EMAIL = "roopak@example.com";

interface SeededConversation {
  conversationId: number;
  connectorConfigId: string;
  scopeId: string;
  fileId: string;
}

async function seedUser(db: Kysely<DB>, options: { emailVerified?: boolean } = {}): Promise<void> {
  await createUserRepository(db).create({
    id: USER_ID,
    name: "Roopak",
    email: USER_EMAIL,
    emailVerified: options.emailVerified ?? true,
  });
}

async function seedConnectorConfig(db: Kysely<DB>, connectorType: "slack" | "whatsapp"): Promise<string> {
  const ownerId = `owner-${randomUUID()}`;
  await createUserRepository(db).create({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
  const config = await createConnectorRepository(db).createConfig({
    connectorType,
    authType: "system",
    credentials: JSON.stringify({ type: "system" }),
    scopeConfig: "{}",
    createdBy: ownerId,
  });
  return config.id;
}

async function linkSliceScopeFile(
  db: Kysely<DB>,
  options: {
    conversationId: number;
    connectorConfigId: string;
    source: "slack" | "whatsapp";
    scopeType: "slack_channel" | "whatsapp_group";
    providerScopeId: string;
    memberEmails: string[];
    firstMessageId: number;
    lastMessageId: number;
    rosterSnapshot?: string | null;
    archived?: boolean;
    shareWithEveryone?: boolean;
  },
): Promise<{ scopeId: string; fileId: string; sliceId: string }> {
  const slice = await createConversationSlicesRepository(db).insertIfAbsent({
    conversationId: options.conversationId,
    firstMessageId: options.firstMessageId,
    lastMessageId: options.lastMessageId,
    startedAt: "2026-07-17T09:00:00.000Z",
    endedAt: "2026-07-17T09:30:00.000Z",
    messageCount: 1,
    denoisedMessageIds: [options.firstMessageId],
    flushReason: "gap",
    rosterSnapshot: options.rosterSnapshot ?? "{}",
    salienceVerdict: "kept",
  });
  const connectorRepo = createConnectorRepository(db);
  const scopeId = await connectorRepo.upsertAccessScope(options.connectorConfigId, {
    scopeType: options.scopeType,
    providerScopeId: options.providerScopeId,
    label: options.providerScopeId,
    memberEmails: options.memberEmails,
  });
  const fileId = `file-${randomUUID()}`;
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: options.connectorConfigId,
      provider_file_id: slice.row.id,
      file_name: `slice ${slice.row.id}`,
      file_type: options.source === "slack" ? "slack_conversation_slice" : "whatsapp_conversation_slice",
      content_category: "document",
      source: options.source,
      access_scope_id: scopeId,
      is_archived: options.archived ? 1 : 0,
      share_with_everyone: options.shareWithEveryone ? 1 : 0,
      synced_at: "2026-07-17T09:35:00.000Z",
    })
    .execute();
  await db.updateTable("conversation_slices").set({ indexed_file_id: fileId }).where("id", "=", slice.row.id).execute();
  return { scopeId, fileId, sliceId: slice.row.id };
}

async function seedSlackChannel(
  db: Kysely<DB>,
  options: {
    channelId: string;
    text: string;
    memberEmails: string[];
    connectorConfigId: string;
    displayName?: string;
    archived?: boolean;
    shareWithEveryone?: boolean;
    rosterSnapshot?: string;
  },
): Promise<SeededConversation & { messageId: number }> {
  const conversations = createConversationRepository(db);
  const conversation = await conversations.getOrCreate({
    platform: "slack",
    kind: "channel",
    providerConversationId: options.channelId,
  });
  if (options.displayName) {
    await db
      .updateTable("conversations")
      .set({ display_name: options.displayName })
      .where("id", "=", conversation.id)
      .execute();
  }
  const message = await conversations.insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${options.channelId}-1`,
    senderJid: "U0TEAM",
    senderName: "Tara",
    text: options.text,
    providerTimestamp: "2026-07-17T09:10:00.000Z",
    receivedAt: "2026-07-17T09:10:00.000Z",
  });
  const linked = await linkSliceScopeFile(db, {
    conversationId: conversation.id,
    connectorConfigId: options.connectorConfigId,
    source: "slack",
    scopeType: "slack_channel",
    providerScopeId: options.channelId,
    memberEmails: options.memberEmails,
    firstMessageId: message.row.id,
    lastMessageId: message.row.id,
    rosterSnapshot: options.rosterSnapshot,
    archived: options.archived,
    shareWithEveryone: options.shareWithEveryone,
  });
  return {
    conversationId: conversation.id,
    connectorConfigId: options.connectorConfigId,
    scopeId: linked.scopeId,
    fileId: linked.fileId,
    messageId: message.row.id,
  };
}

async function seedWhatsAppGroup(
  db: Kysely<DB>,
  options: {
    text: string;
    memberEmails: string[];
    connectorConfigId: string;
    indexEnabled?: boolean;
    displayName?: string;
    senderJid?: string;
    rosterSnapshot?: string;
  },
): Promise<SeededConversation & { messageId: number; groupJid: string }> {
  const groupJid = `${randomUUID()}@g.us`;
  const groups = createWhatsAppGroupRepository(db);
  await groups.upsert({
    jid: groupJid,
    name: options.displayName ?? "Deal Room",
    description: null,
    updated_at: "2026-07-17T09:00:00.000Z",
  });
  await groups.setIndexEnabled(groupJid, options.indexEnabled ?? true);
  const conversations = createConversationRepository(db);
  const conversation = await conversations.getOrCreate({
    platform: "whatsapp",
    kind: "group",
    providerConversationId: groupJid,
  });
  if (options.displayName) {
    await db
      .updateTable("conversations")
      .set({ display_name: options.displayName })
      .where("id", "=", conversation.id)
      .execute();
  }
  const message = await conversations.insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${groupJid}:1`,
    senderJid: options.senderJid ?? "15550001111@s.whatsapp.net",
    senderName: "Tara",
    text: options.text,
    providerTimestamp: "2026-07-17T09:12:00.000Z",
    receivedAt: "2026-07-17T09:12:00.000Z",
  });
  const linked = await linkSliceScopeFile(db, {
    conversationId: conversation.id,
    connectorConfigId: options.connectorConfigId,
    source: "whatsapp",
    scopeType: "whatsapp_group",
    providerScopeId: groupJid,
    memberEmails: options.memberEmails,
    firstMessageId: message.row.id,
    lastMessageId: message.row.id,
    rosterSnapshot: options.rosterSnapshot,
  });
  return {
    conversationId: conversation.id,
    connectorConfigId: options.connectorConfigId,
    scopeId: linked.scopeId,
    fileId: linked.fileId,
    messageId: message.row.id,
    groupJid,
  };
}

function depsFor(db: Kysely<DB>, overrides: Partial<SketchMcpDeps> = {}): SketchMcpDeps {
  return {
    db,
    currentUserId: USER_ID,
    privateAudienceUserId: USER_ID,
    userRepo: createUserRepository(db),
    ...overrides,
  } as unknown as SketchMcpDeps;
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;
    let slackConfigId!: string;
    let whatsappConfigId!: string;

    beforeEach(async () => {
      db = await createDb();
      await seedUser(db);
      slackConfigId = await seedConnectorConfig(db, "slack");
      whatsappConfigId = await seedConnectorConfig(db, "whatsapp");
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("finds messages across authorized Slack channels and WhatsApp groups with conversation identity", async () => {
      await seedSlackChannel(db, {
        channelId: "C1",
        text: "atlas pricing decision in slack",
        memberEmails: [USER_EMAIL],
        connectorConfigId: slackConfigId,
        displayName: "general",
      });
      await seedWhatsAppGroup(db, {
        text: "atlas pricing agreed in whatsapp",
        memberEmails: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        displayName: "Deal Room",
      });

      const outcome = await handleAllChatsSearch({ query: "atlas pricing" }, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(2);
      const platforms = outcome.body.messages.map((m) => (m.conversation as { platform: string }).platform).sort();
      expect(platforms).toEqual(["slack", "whatsapp"]);
      for (const message of outcome.body.messages) {
        const conversation = message.conversation as Record<string, string>;
        expect(conversation.ref).toMatch(/^conversation:\d+$/);
        expect(conversation.name).toBeTruthy();
        expect(message).not.toHaveProperty("senderJid");
        expect(message).not.toHaveProperty("senderUserId");
        expect(message).not.toHaveProperty("rank");
        expect(message.isBot).toBe(false);
      }
    });

    it("excludes conversations where the caller is not a scope member", async () => {
      await seedSlackChannel(db, {
        channelId: "C2",
        text: "secret finance topic",
        memberEmails: ["other@example.com"],
        connectorConfigId: slackConfigId,
      });
      const outcome = await handleAllChatsSearch({ query: "secret finance" }, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(0);
    });

    it("excludes conversations whose only indexed file is archived", async () => {
      await seedSlackChannel(db, {
        channelId: "C3",
        text: "archived channel content",
        memberEmails: [USER_EMAIL],
        connectorConfigId: slackConfigId,
        archived: true,
      });
      const outcome = await handleAllChatsSearch({ query: "archived channel content" }, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(0);
    });

    it("excludes share_with_everyone files from authorization", async () => {
      await seedSlackChannel(db, {
        channelId: "C4",
        text: "broadcast topic",
        memberEmails: [USER_EMAIL],
        connectorConfigId: slackConfigId,
        shareWithEveryone: true,
      });
      const outcome = await handleAllChatsSearch({ query: "broadcast topic" }, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(0);
    });

    it("excludes WhatsApp groups with indexing disabled", async () => {
      await seedWhatsAppGroup(db, {
        text: "disabled group content",
        memberEmails: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      const outcome = await handleAllChatsSearch({ query: "disabled group content" }, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(0);
    });

    it("never returns other DM conversations but includes the current DM", async () => {
      const conversations = createConversationRepository(db);
      const otherDm = await conversations.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "15550009999@s.whatsapp.net",
      });
      await conversations.insertMessage({
        conversationId: otherDm.id,
        providerMessageId: "dm-other-1",
        senderJid: "15550009999@s.whatsapp.net",
        senderName: "Someone Else",
        text: "private dm mentioning atlas keyword",
        receivedAt: "2026-07-17T09:00:00.000Z",
      });
      const currentDm = await conversations.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "15550001234@s.whatsapp.net",
      });
      const mine = await conversations.insertMessage({
        conversationId: currentDm.id,
        providerMessageId: "dm-mine-1",
        senderJid: "15550001234@s.whatsapp.net",
        senderName: "Roopak",
        text: "my own dm note about atlas keyword",
        receivedAt: "2026-07-17T09:01:00.000Z",
      });
      const trigger = await conversations.insertMessage({
        conversationId: currentDm.id,
        providerMessageId: "dm-mine-2",
        senderJid: "15550001234@s.whatsapp.net",
        senderName: "Roopak",
        text: "search my chats",
        receivedAt: "2026-07-17T09:02:00.000Z",
      });

      const outcome = await handleAllChatsSearch(
        { query: "atlas keyword" },
        depsFor(db, {
          conversationContext: { conversationId: currentDm.id, currentMessageId: trigger.row.id },
        }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
      expect(outcome.body.messages[0]?.id).toBe(mine.row.id);
      expect((outcome.body.messages[0]?.conversation as { kind: string }).kind).toBe("dm");
    });

    it("applies the platform filter to authorized conversations and the current DM", async () => {
      await seedSlackChannel(db, {
        channelId: "C5",
        text: "crossplatform token in slack",
        memberEmails: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      await seedWhatsAppGroup(db, {
        text: "crossplatform token in whatsapp",
        memberEmails: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
      });
      const conversations = createConversationRepository(db);
      const currentDm = await conversations.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "15550001234@s.whatsapp.net",
      });
      await conversations.insertMessage({
        conversationId: currentDm.id,
        providerMessageId: "dm-x-1",
        senderJid: "15550001234@s.whatsapp.net",
        senderName: "Roopak",
        text: "crossplatform token in my dm",
        receivedAt: "2026-07-17T09:01:00.000Z",
      });

      const slackOnly = await handleAllChatsSearch(
        { query: "crossplatform token", platform: "slack" },
        depsFor(db, { conversationContext: { conversationId: currentDm.id } }),
      );
      expect(slackOnly.ok).toBe(true);
      if (!slackOnly.ok) return;
      expect(slackOnly.body.messages).toHaveLength(1);
      expect((slackOnly.body.messages[0]?.conversation as { platform: string }).platform).toBe("slack");

      const whatsappOnly = await handleAllChatsSearch(
        { query: "crossplatform token", platform: "whatsapp" },
        depsFor(db, { conversationContext: { conversationId: currentDm.id } }),
      );
      expect(whatsappOnly.ok).toBe(true);
      if (!whatsappOnly.ok) return;
      expect(whatsappOnly.body.messages).toHaveLength(2);
    });

    it("excludes bot messages by default and includes them on request", async () => {
      const seeded = await seedSlackChannel(db, {
        channelId: "C6",
        text: "botfilter human message",
        memberEmails: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      await createConversationRepository(db).insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: "C6-bot",
        senderJid: "B0BOT",
        senderName: "Sketch",
        isBot: true,
        text: "botfilter bot reply",
        receivedAt: "2026-07-17T09:20:00.000Z",
      });

      const withoutBots = await handleAllChatsSearch({ query: "botfilter" }, depsFor(db));
      expect(withoutBots.ok).toBe(true);
      if (!withoutBots.ok) return;
      expect(withoutBots.body.messages).toHaveLength(1);

      const withBots = await handleAllChatsSearch({ query: "botfilter", includeBotMessages: true }, depsFor(db));
      expect(withBots.ok).toBe(true);
      if (!withBots.ok) return;
      expect(withBots.body.messages).toHaveLength(2);
    });

    it("clamps results to the ingestion snapshot at the trigger message", async () => {
      const conversations = createConversationRepository(db);
      const currentDm = await conversations.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "15550001234@s.whatsapp.net",
      });
      const trigger = await conversations.insertMessage({
        conversationId: currentDm.id,
        providerMessageId: "dm-t-1",
        senderJid: "15550001234@s.whatsapp.net",
        senderName: "Roopak",
        text: "search request",
        receivedAt: "2026-07-17T09:00:00.000Z",
      });
      const seeded = await seedSlackChannel(db, {
        channelId: "C7",
        text: "snapshot marker arrived later",
        memberEmails: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      expect(seeded.messageId).toBeGreaterThan(trigger.row.id);

      const outcome = await handleAllChatsSearch(
        { query: "snapshot marker" },
        depsFor(db, { conversationContext: { conversationId: currentDm.id, currentMessageId: trigger.row.id } }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(0);
    });

    it("denies without a private audience, with a mismatched audience, and without a verified email", async () => {
      await seedSlackChannel(db, {
        channelId: "C8",
        text: "gated content",
        memberEmails: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });

      const noAudience = await handleAllChatsSearch(
        { query: "gated content" },
        depsFor(db, { privateAudienceUserId: undefined }),
      );
      expect(noAudience.ok).toBe(false);

      const mismatched = await handleAllChatsSearch(
        { query: "gated content" },
        depsFor(db, { privateAudienceUserId: "someone-else" }),
      );
      expect(mismatched.ok).toBe(false);

      await db.updateTable("users").set({ email_verified_at: null }).where("id", "=", USER_ID).execute();
      const unverified = await handleAllChatsSearch({ query: "gated content" }, depsFor(db));
      expect(unverified.ok).toBe(false);
    });

    it("handles punctuation-only queries safely", async () => {
      const outcome = await handleAllChatsSearch({ query: "!!! ??? ***" }, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(0);
    });

    it("resolves Slack mentions and uses hashed fallbacks for unknown WhatsApp senders", async () => {
      const slackRoster = JSON.stringify({
        channelId: "C9",
        channelName: "general",
        participants: [{ slackUserId: "U0TEAM", displayName: "Tara", kind: "teammate", email: USER_EMAIL }],
      });
      await seedSlackChannel(db, {
        channelId: "C9",
        text: "mention check <@U0TEAM> please",
        memberEmails: [USER_EMAIL],
        connectorConfigId: slackConfigId,
        rosterSnapshot: slackRoster,
      });
      const knownJid = "15550001111@s.whatsapp.net";
      const whatsappRoster = JSON.stringify({
        participants: [
          {
            participantJidRef: stableWhatsAppParticipantJidRef(knownJid),
            senderJidRefs: [stableWhatsAppParticipantJidRef(knownJid)],
            displayName: "Tara",
            resolutionKind: "teammate",
            adminRole: null,
          },
        ],
        resolutionCounts: { totalParticipants: 1, teammate: 1, entity: 0, labeled: 0, unresolved: 0 },
      });
      await seedWhatsAppGroup(db, {
        text: "mention check from unknown sender",
        memberEmails: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        senderJid: "15559998888@s.whatsapp.net",
        rosterSnapshot: whatsappRoster,
      });

      const outcome = await handleAllChatsSearch({ query: "mention check" }, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(2);
      const slackHit = outcome.body.messages.find((m) => (m.conversation as { platform: string }).platform === "slack");
      const whatsappHit = outcome.body.messages.find(
        (m) => (m.conversation as { platform: string }).platform === "whatsapp",
      );
      expect(slackHit?.text).toBe("mention check @Tara please");
      expect(String(whatsappHit?.sender)).toMatch(/^External \(/);
    });
  });
}

function runReconcileSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(`${label} reconcileWhatsAppGroupAcls`, () => {
    let db!: Kysely<DB>;
    let whatsappConfigId!: string;

    beforeEach(async () => {
      db = await createDb();
      await seedUser(db);
      whatsappConfigId = await seedConnectorConfig(db, "whatsapp");
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    async function scopeEmails(scopeId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("access_scope_members")
        .select("email")
        .where("access_scope_id", "=", scopeId)
        .execute();
      return rows.map((row) => row.email).sort();
    }

    it("removes a departed member from a quiet group's scope on reconciliation", async () => {
      const phone = "+15551230001";
      await createUserRepository(db).create({
        id: "teammate-1",
        name: "Tara",
        email: "tara@example.com",
        whatsappNumber: phone,
      });
      const seeded = await seedWhatsAppGroup(db, {
        text: "quiet group",
        memberEmails: ["tara@example.com", "departed@example.com"],
        connectorConfigId: whatsappConfigId,
      });
      const groups = createWhatsAppGroupRepository(db);
      await groups.refreshParticipants(seeded.groupJid, [
        { participantJid: `${phone.replace(/\D/gu, "")}@s.whatsapp.net`, phoneE164: phone, adminRole: null },
      ]);

      const summary = await reconcileWhatsAppGroupAcls({
        db,
        logger: createTestLogger(),
        connectorConfigId: whatsappConfigId,
      });
      expect(summary.scopesRefreshed).toBe(1);
      expect(await scopeEmails(seeded.scopeId)).toEqual(["tara@example.com"]);
    });

    it("still reconciles membership for disabled groups without archiving their retained files", async () => {
      const phone = "+15551230002";
      await createUserRepository(db).create({
        id: "teammate-2",
        name: "Tara",
        email: "tara2@example.com",
        whatsappNumber: phone,
      });
      const seeded = await seedWhatsAppGroup(db, {
        text: "soon disabled",
        memberEmails: ["tara2@example.com", "departed@example.com"],
        connectorConfigId: whatsappConfigId,
      });
      const groups = createWhatsAppGroupRepository(db);
      await groups.refreshParticipants(seeded.groupJid, [
        { participantJid: `${phone.replace(/\D/gu, "")}@s.whatsapp.net`, phoneE164: phone, adminRole: null },
      ]);
      await groups.setIndexEnabled(seeded.groupJid, false);

      const summary = await reconcileWhatsAppGroupAcls({
        db,
        logger: createTestLogger(),
        connectorConfigId: whatsappConfigId,
      });
      expect(summary.scopesRefreshed).toBe(1);
      expect(summary.scopesArchived).toBe(0);
      expect(await scopeEmails(seeded.scopeId)).toEqual(["tara2@example.com"]);
      const file = await db
        .selectFrom("indexed_files")
        .select("is_archived")
        .where("id", "=", seeded.fileId)
        .executeTakeFirst();
      expect(file?.is_archived).toBe(0);
    });

    it("archives files when the roster resolves to zero teammates", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "external only group",
        memberEmails: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
      });
      await createWhatsAppGroupRepository(db).refreshParticipants(seeded.groupJid, [
        { participantJid: "15559990000@s.whatsapp.net", phoneE164: "+15559990000", adminRole: null },
      ]);

      const summary = await reconcileWhatsAppGroupAcls({
        db,
        logger: createTestLogger(),
        connectorConfigId: whatsappConfigId,
      });
      expect(summary.scopesArchived).toBe(1);
    });
  });
}

runSuite("chat-search sqlite", createTestDb);
runSuite("chat-search postgres", createTestPgDb);
runReconcileSuite("sqlite", createTestDb);
runReconcileSuite("postgres", createTestPgDb);
