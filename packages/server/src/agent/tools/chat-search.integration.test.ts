import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileWhatsAppGroupAcls } from "../../connectors/whatsapp-emission";
import { createConnectorRepository } from "../../db/repositories/connectors";
import { createConversationSlicesRepository } from "../../db/repositories/conversation-slices";
import { createConversationRepository } from "../../db/repositories/conversations";
import { createSlackChannelParticipantsRepository } from "../../db/repositories/slack-channel-participants";
import { createUserRepository } from "../../db/repositories/users";
import {
  createWhatsAppGroupRepository,
  whatsappParticipantObservationKey,
} from "../../db/repositories/whatsapp-groups";
import type { DB } from "../../db/schema";
import { createTestDb, createTestLogger, createTestPgDb, getSharedPgDb } from "../../test-utils";
import { stableWhatsAppParticipantJidRef } from "../../whatsapp/identity-resolution";
import { createReadChatHistoryTool } from "./chat-history";
import { ChatHistoryAccessResolver, type ProviderTargetRef, handleAllChatsRead } from "./chat-search";
import { handleSendMessage } from "./messaging";
import type { SketchMcpDeps } from "./types";

async function readAllChats(
  args: Parameters<typeof handleAllChatsRead>[0],
  deps: SketchMcpDeps,
  access?: ChatHistoryAccessResolver,
) {
  return handleAllChatsRead(
    {
      ...args,
      snapshotBeforeMessageId: deps.conversationContext?.currentMessageId,
    },
    deps,
    access,
  );
}

const USER_ID = "user-roopak";
const USER_EMAIL = "roopak@example.com";
const USER_SLACK_ID = "U-ROOPAK";
const USER_WHATSAPP_NUMBER = "+15550001234";

interface SeededConversation {
  conversationId: number;
  connectorConfigId: string;
  scopeId: string;
  fileId: string;
}

interface WhatsAppParticipantFixture {
  group_jid: string;
  participant_jid: string;
  phone_e164: string | null;
  lid: string | null;
  admin_role: "admin" | "superadmin" | null;
  last_seen_at: string;
}

async function insertWhatsAppParticipantFixtures(
  db: Kysely<DB>,
  fixtures: WhatsAppParticipantFixture[],
): Promise<void> {
  await db
    .insertInto("whatsapp_group_participants")
    .values(
      fixtures.map((fixture) => {
        const observationKey = whatsappParticipantObservationKey(fixture.phone_e164, fixture.lid);
        return {
          ...fixture,
          id: `fixture:${fixture.group_jid}:${observationKey}`,
          observation_key: observationKey,
        };
      }),
    )
    .execute();
}

async function seedUser(db: Kysely<DB>, options: { emailVerified?: boolean } = {}): Promise<void> {
  await createUserRepository(db).create({
    id: USER_ID,
    name: "Roopak",
    email: USER_EMAIL,
    emailVerified: options.emailVerified ?? true,
    slackUserId: USER_SLACK_ID,
    whatsappNumber: USER_WHATSAPP_NUMBER,
  });
  await db
    .insertInto("slack_user_sync_state")
    .values({ team_id: "T1", slack_user_id: USER_SLACK_ID, email: USER_EMAIL })
    .execute();
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
    members: string[];
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
    members: options.members,
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
    members: string[];
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
  if (options.members.includes(USER_EMAIL)) {
    await db
      .insertInto("slack_channel_participants")
      .values({
        channel_id: options.channelId,
        slack_user_id: USER_SLACK_ID,
        last_seen_at: new Date().toISOString(),
      })
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
    members: options.members,
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
    members: string[];
    connectorConfigId: string;
    indexEnabled?: boolean;
    displayName?: string;
    senderJid?: string;
    rosterSnapshot?: string;
    seedCurrentUserParticipant?: boolean;
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
  if (options.members.includes(USER_EMAIL) && options.seedCurrentUserParticipant !== false) {
    await insertWhatsAppParticipantFixtures(db, [
      {
        group_jid: groupJid,
        participant_jid: "15550001234@s.whatsapp.net",
        phone_e164: USER_WHATSAPP_NUMBER,
        lid: null,
        admin_role: null,
        last_seen_at: "2026-07-17T09:00:00.000Z",
      },
    ]);
  }
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
    members: options.members,
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
    userRepo: createUserRepository(db),
    ...overrides,
  } as unknown as SketchMcpDeps;
}

async function snapshotKnowledgeGraphState(db: Kysely<DB>) {
  const [
    slices,
    indexedFiles,
    chunks,
    facts,
    entities,
    entityMentions,
    entitySourceRefs,
    relationships,
    relationshipEvidence,
  ] = await Promise.all([
    db.selectFrom("conversation_slices").selectAll().orderBy("id").execute(),
    db.selectFrom("indexed_files").selectAll().orderBy("id").execute(),
    db.selectFrom("document_chunks").selectAll().orderBy("id").execute(),
    db.selectFrom("indexed_file_facts").selectAll().orderBy("id").execute(),
    db.selectFrom("entities").selectAll().orderBy("id").execute(),
    db.selectFrom("entity_mentions").selectAll().orderBy("id").execute(),
    db.selectFrom("entity_source_refs").selectAll().orderBy("id").execute(),
    db.selectFrom("entity_relationships").selectAll().orderBy("id").execute(),
    db.selectFrom("entity_relationship_evidence").selectAll().orderBy("id").execute(),
  ]);
  return {
    slices,
    indexedFiles,
    chunks,
    facts,
    entities,
    entityMentions,
    entitySourceRefs,
    relationships,
    relationshipEvidence,
  };
}

function runSuite(label: string, getDb: () => Promise<Kysely<DB>>, opts: { shared?: boolean } = {}) {
  describe(label, () => {
    let db!: Kysely<DB>;
    let slackConfigId!: string;
    let whatsappConfigId!: string;

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
      await db.insertInto("settings").values({ id: "default", slack_team_id: "T1" }).execute();
      await seedUser(db);
      slackConfigId = await seedConnectorConfig(db, "slack");
      whatsappConfigId = await seedConnectorConfig(db, "whatsapp");
    }, 30000);

    afterEach(async () => {
      if (opts.shared) {
        await sql`ROLLBACK`.execute(db);
      } else {
        await db.destroy();
      }
    });

    it("finds messages across authorized Slack channels and WhatsApp groups with conversation identity", async () => {
      await seedSlackChannel(db, {
        channelId: "C1",
        text: "atlas pricing decision in slack",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
        displayName: "general",
      });
      await seedWhatsAppGroup(db, {
        text: "atlas pricing agreed in whatsapp",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        displayName: "Deal Room",
      });

      const outcome = await readAllChats({}, depsFor(db));
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

    it("derives the complete member conversation set before applying the result limit", async () => {
      const matchingIds: number[] = [];
      for (const channelId of ["C-CANDIDATE-1", "C-CANDIDATE-2", "C-CANDIDATE-3"]) {
        const seeded = await seedSlackChannel(db, {
          channelId,
          text: "candidate-first marker",
          members: [USER_EMAIL],
          connectorConfigId: slackConfigId,
        });
        matchingIds.push(seeded.conversationId);
      }
      await seedSlackChannel(db, {
        channelId: "C-NONMATCH",
        text: "completely unrelated",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      const deps = depsFor(db);
      const access = new ChatHistoryAccessResolver(deps);
      const authorize = access.authorizedConversationIdsForAllChats.bind(access);
      const authorizationCalls: Array<"slack" | "whatsapp" | undefined> = [];
      access.authorizedConversationIdsForAllChats = async (platform) => {
        authorizationCalls.push(platform);
        return authorize(platform);
      };

      const outcome = await readAllChats({ limit: 1 }, deps, access);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
      expect(outcome.body.hasMore).toBe(true);
      expect(authorizationCalls).toEqual([undefined]);
      expect(matchingIds).toHaveLength(3);
    });

    it("uses passive Slack membership without calling Slack during a read", async () => {
      let providerCalls = 0;
      await seedSlackChannel(db, {
        channelId: "C2",
        text: "secret finance topic",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      const outcome = await readAllChats(
        {},
        depsFor(db, {
          getSlack: () =>
            ({
              isUserInChannel: async () => {
                providerCalls += 1;
                throw new Error("Chat history reads must not call Slack");
              },
            }) as unknown as NonNullable<ReturnType<NonNullable<SketchMcpDeps["getSlack"]>>>,
        }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
      expect(providerCalls).toBe(0);
    });

    it("rechecks a positive Slack grant after a processed leave event in the same agent run", async () => {
      await seedSlackChannel(db, {
        channelId: "C-LEAVE-CACHE",
        text: "leave cache marker",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      const deps = depsFor(db);
      const access = new ChatHistoryAccessResolver(deps);

      const before = await readAllChats({}, deps, access);
      expect(before.ok && before.body.messages).toHaveLength(1);

      await createSlackChannelParticipantsRepository(db).remove("C-LEAVE-CACHE", USER_SLACK_ID);

      const after = await readAllChats({}, deps, access);
      expect(after.ok && after.body.messages).toHaveLength(0);
    });

    it("retains Slack membership when the roster row is old", async () => {
      await seedSlackChannel(db, {
        channelId: "C2-ERROR",
        text: "provider failure secret",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      await db
        .updateTable("slack_channel_participants")
        .set({ last_seen_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString() })
        .where("channel_id", "=", "C2-ERROR")
        .execute();
      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
    });

    it("revokes passive Slack history access when disconnect clears the roster", async () => {
      await seedSlackChannel(db, {
        channelId: "C2-DISCONNECT",
        text: "disconnect revocation marker",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      const before = await readAllChats({}, depsFor(db));
      expect(before.ok && before.body.messages).toHaveLength(1);

      await createSlackChannelParticipantsRepository(db).clearAll();

      const after = await readAllChats({}, depsFor(db));
      expect(after.ok && after.body.messages).toHaveLength(0);
    });

    it("reads raw Slack history even when its indexed file is archived", async () => {
      await seedSlackChannel(db, {
        channelId: "C3",
        text: "archived channel content",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
        archived: true,
      });
      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
    });

    it("reads raw Slack history independently of indexed-file sharing state", async () => {
      await seedSlackChannel(db, {
        channelId: "C4",
        text: "broadcast topic",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
        shareWithEveryone: true,
      });
      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
    });

    it("reads WhatsApp group history when indexing is disabled", async () => {
      await seedWhatsAppGroup(db, {
        text: "disabled group content",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
    });

    it("excludes WhatsApp groups where the requester is not a current participant", async () => {
      await seedWhatsAppGroup(db, {
        text: "other group secret",
        members: ["other@example.com"],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(0);
    });

    it("revokes retained WhatsApp history when the requester leaves the group", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "departed group retained history",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      const before = await readAllChats({}, depsFor(db));
      expect(before.ok && before.body.messages).toHaveLength(1);

      await db
        .deleteFrom("whatsapp_group_participants")
        .where("group_jid", "=", seeded.groupJid)
        .where("phone_e164", "=", USER_WHATSAPP_NUMBER)
        .execute();

      const after = await readAllChats({}, depsFor(db));
      expect(after.ok && after.body.messages).toHaveLength(0);
    });

    it("authorizes a device-qualified group LID through a canonical non-legacy user alias", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "stable lid mapping marker",
        members: ["other@example.com"],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      await db.updateTable("users").set({ whatsapp_lid: "legacy-only@lid" }).where("id", "=", USER_ID).execute();
      await db
        .insertInto("user_whatsapp_lids")
        .values({
          user_id: USER_ID,
          lid: "86702773280883@lid",
          first_seen_at: "2026-07-17T09:00:00.000Z",
          last_seen_at: "2026-07-17T09:00:00.000Z",
        })
        .execute();
      const mappingGroup = `${randomUUID()}@g.us`;
      await createWhatsAppGroupRepository(db).upsert({
        jid: mappingGroup,
        name: "Mapping Source",
        description: null,
        updated_at: "2026-07-17T09:00:00.000Z",
      });
      await insertWhatsAppParticipantFixtures(db, [
        {
          group_jid: mappingGroup,
          participant_jid: "86702773280883@lid",
          phone_e164: USER_WHATSAPP_NUMBER,
          lid: "86702773280883@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
        {
          group_jid: seeded.groupJid,
          participant_jid: "86702773280883:7@lid",
          phone_e164: null,
          lid: "86702773280883:7@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
      ]);

      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
    });

    it("authorizes a stable phone-JID-to-LID mapping when phone_e164 is unavailable", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "phone jid lid mapping marker",
        members: ["other@example.com"],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      await db
        .insertInto("user_whatsapp_lids")
        .values({
          user_id: USER_ID,
          lid: "86702773280883@lid",
          first_seen_at: "2026-07-17T09:00:00.000Z",
          last_seen_at: "2026-07-17T09:00:00.000Z",
        })
        .execute();
      const mappingGroup = `${randomUUID()}@g.us`;
      await createWhatsAppGroupRepository(db).upsert({
        jid: mappingGroup,
        name: "Phone JID Mapping Source",
        description: null,
        updated_at: "2026-07-17T09:00:00.000Z",
      });
      await insertWhatsAppParticipantFixtures(db, [
        {
          group_jid: mappingGroup,
          participant_jid: "15550001234@s.whatsapp.net",
          phone_e164: null,
          lid: "86702773280883@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
        {
          group_jid: seeded.groupJid,
          participant_jid: "86702773280883@lid",
          phone_e164: null,
          lid: "86702773280883@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
      ]);

      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
    });

    it("does not infer WhatsApp membership from an ambiguous phone-to-LID mapping", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "ambiguous lid mapping marker",
        members: ["other@example.com"],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      const mappingGroup = `${randomUUID()}@g.us`;
      await createWhatsAppGroupRepository(db).upsert({
        jid: mappingGroup,
        name: "Mapping Source",
        description: null,
        updated_at: "2026-07-17T09:00:00.000Z",
      });
      await insertWhatsAppParticipantFixtures(db, [
        {
          group_jid: mappingGroup,
          participant_jid: "lid-one@lid",
          phone_e164: USER_WHATSAPP_NUMBER,
          lid: "lid-one@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
        {
          group_jid: mappingGroup,
          participant_jid: "lid-two@lid",
          phone_e164: USER_WHATSAPP_NUMBER,
          lid: "lid-two@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
        {
          group_jid: seeded.groupJid,
          participant_jid: "lid-one@lid",
          phone_e164: null,
          lid: "lid-one@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
      ]);

      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(0);
    });

    it("does not infer WhatsApp membership when one LID maps to multiple phones", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "ambiguous reverse lid marker",
        members: ["other@example.com"],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      const groups = createWhatsAppGroupRepository(db);
      const firstMappingGroup = `${randomUUID()}@g.us`;
      const secondMappingGroup = `${randomUUID()}@g.us`;
      for (const jid of [firstMappingGroup, secondMappingGroup]) {
        await groups.upsert({
          jid,
          name: "Mapping Source",
          description: null,
          updated_at: "2026-07-17T09:00:00.000Z",
        });
      }
      await insertWhatsAppParticipantFixtures(db, [
        {
          group_jid: firstMappingGroup,
          participant_jid: "shared-lid@lid",
          phone_e164: USER_WHATSAPP_NUMBER,
          lid: "shared-lid@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
        {
          group_jid: secondMappingGroup,
          participant_jid: "shared-lid@lid",
          phone_e164: "+15550009999",
          lid: "shared-lid@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
        {
          group_jid: seeded.groupJid,
          participant_jid: "shared-lid@lid",
          phone_e164: null,
          lid: "shared-lid@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
      ]);

      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(0);
    });

    it("keeps a direct WhatsApp phone match valid when inferred LID mappings are ambiguous", async () => {
      await seedWhatsAppGroup(db, {
        text: "direct phone survives ambiguity",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      const mappingGroup = `${randomUUID()}@g.us`;
      await createWhatsAppGroupRepository(db).upsert({
        jid: mappingGroup,
        name: "Mapping Source",
        description: null,
        updated_at: "2026-07-17T09:00:00.000Z",
      });
      await insertWhatsAppParticipantFixtures(db, [
        {
          group_jid: mappingGroup,
          participant_jid: "ambiguous-one@lid",
          phone_e164: USER_WHATSAPP_NUMBER,
          lid: "ambiguous-one@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
        {
          group_jid: mappingGroup,
          participant_jid: "ambiguous-two@lid",
          phone_e164: USER_WHATSAPP_NUMBER,
          lid: "ambiguous-two@lid",
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
      ]);

      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
    });

    it("reads sanitized chronology around an authorized cross-chat anchor", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "context before the decision",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
        displayName: "Decision Room",
      });
      const conversations = createConversationRepository(db);
      const anchor = await conversations.insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: `${seeded.groupJid}:2`,
        senderJid: "15550001111@s.whatsapp.net",
        senderName: "Tara",
        text: "cobalt launch decision approved",
        receivedAt: "2026-07-17T09:13:00.000Z",
      });
      await conversations.insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: `${seeded.groupJid}:3`,
        senderJid: "15550001111@s.whatsapp.net",
        senderName: "Tara",
        text: "context after the decision",
        receivedAt: "2026-07-17T09:14:00.000Z",
      });
      const current = await conversations.getOrCreate({
        platform: "slack",
        kind: "dm",
        providerConversationId: "D-CURRENT",
      });
      const trigger = await conversations.insertMessage({
        conversationId: current.id,
        providerMessageId: "trigger-read-cross-chat",
        senderJid: "U-ROOPAK",
        senderName: "Roopak",
        text: "show me the surrounding context",
        receivedAt: "2026-07-17T09:15:00.000Z",
      });
      const deps = depsFor(db, {
        conversationRepo: conversations,
        conversationContext: { conversationId: current.id, currentMessageId: trigger.row.id },
      });
      const listing = await readAllChats({}, deps);
      expect(listing.ok).toBe(true);
      if (!listing.ok) return;
      const hit = listing.body.messages[0];
      const conversationRef = (hit?.conversation as { ref: string }).ref;
      const readTool = createReadChatHistoryTool(deps) as unknown as {
        handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
      };

      const result = await readTool.handler({
        conversationRef,
        anchorMessageId: anchor.row.id,
        limit: 3,
      });
      const body = JSON.parse(result.content[0]?.text ?? "{}") as {
        messages: Array<Record<string, unknown>>;
      };
      expect(body.messages.map((message) => message.text)).toEqual([
        "context before the decision",
        "cobalt launch decision approved",
        "context after the decision",
      ]);
      expect(body.messages.every((message) => !("senderJid" in message))).toBe(true);
      expect(
        body.messages.every((message) => (message.conversation as { name: string }).name === "Decision Room"),
      ).toBe(true);
    });

    it("reauthorizes a cross-chat read from passive WhatsApp membership without changing knowledge state", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "cached membership target",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      const deps = depsFor(db, {
        conversationRepo: createConversationRepository(db),
      });
      const access = new ChatHistoryAccessResolver(deps);
      const graphBefore = await snapshotKnowledgeGraphState(db);
      const listing = await readAllChats({}, deps, access);
      expect(listing.ok).toBe(true);
      if (!listing.ok) return;
      const readTool = createReadChatHistoryTool(deps, access) as unknown as {
        handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
      };
      const read = await readTool.handler({
        conversationRef: `conversation:${seeded.conversationId}`,
        anchorMessageId: seeded.messageId,
      });
      expect(JSON.parse(read.content[0]?.text ?? "{}").messages).toHaveLength(1);
      expect(await snapshotKnowledgeGraphState(db)).toEqual(graphBefore);
    });

    it("emits both directions at limit one and reauthorizes continuation tokens", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "before the token anchor",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      const conversations = createConversationRepository(db);
      const anchor = await conversations.insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: `${seeded.groupJid}:anchor`,
        senderJid: "15550001111@s.whatsapp.net",
        senderName: "Tara",
        text: "token anchor",
      });
      await conversations.insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: `${seeded.groupJid}:after`,
        senderJid: "15550001111@s.whatsapp.net",
        senderName: "Tara",
        text: "after the token anchor",
      });
      const current = await conversations.getOrCreate({
        platform: "slack",
        kind: "dm",
        providerConversationId: "D-TOKEN-REAUTH",
      });
      const trigger = await conversations.insertMessage({
        conversationId: current.id,
        providerMessageId: "token-reauth-trigger",
        senderJid: USER_SLACK_ID,
        senderName: "Roopak",
        text: "read the result",
      });
      const readTool = createReadChatHistoryTool(
        depsFor(db, {
          conversationRepo: conversations,
          conversationContext: { conversationId: current.id, currentMessageId: trigger.row.id },
        }),
      ) as unknown as {
        handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
      };
      const first = await readTool.handler({
        conversationRef: `conversation:${seeded.conversationId}`,
        anchorMessageId: anchor.row.id,
        limit: 1,
      });
      const body = JSON.parse(first.content[0]?.text ?? "{}") as {
        messages: Array<{ id: number }>;
        olderPageToken?: string;
        newerPageToken?: string;
      };
      expect(body.messages.map((message) => message.id)).toEqual([anchor.row.id]);
      expect(body.olderPageToken).toBeTypeOf("string");
      expect(body.newerPageToken).toBeTypeOf("string");

      await db.deleteFrom("whatsapp_group_participants").where("group_jid", "=", seeded.groupJid).execute();
      const denied = await readTool.handler({ pageToken: body.olderPageToken });
      expect(denied.content[0]?.text).toBe(
        "The requested chat history is unavailable or you no longer have access to it.",
      );
    });

    it("requires an anchor when starting a referenced read", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "anchor required marker",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      const readTool = createReadChatHistoryTool(
        depsFor(db, { conversationRepo: createConversationRepository(db) }),
      ) as unknown as {
        handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
      };

      const result = await readTool.handler({
        conversationRef: `conversation:${seeded.conversationId}`,
      });

      expect(result.content[0]?.text).toBe("conversationRef must be combined with anchorMessageId.");
    });

    it("keeps cross-chat Slack reads inside the anchor thread", async () => {
      const conversations = createConversationRepository(db);
      const channel = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C-THREADS",
      });
      await db
        .insertInto("slack_channel_participants")
        .values({
          channel_id: "C-THREADS",
          slack_user_id: USER_SLACK_ID,
          last_seen_at: new Date().toISOString(),
        })
        .execute();
      const firstRoot = await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "1000.000",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "alpha thread root",
        providerThreadId: "1000.000",
        receivedAt: "2026-07-17T09:00:00.000Z",
      });
      await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "2000.000",
        senderJid: "U0OTHER",
        senderName: "Other",
        text: "unrelated thread root",
        providerThreadId: "2000.000",
        receivedAt: "2026-07-17T09:01:00.000Z",
      });
      const anchor = await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "1000.001",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "alpha thread launch decision",
        providerThreadId: "1000.000",
        providerParentMessageId: "1000.000",
        isThreadReply: true,
        receivedAt: "2026-07-17T09:02:00.000Z",
      });
      await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "2000.001",
        senderJid: "U0OTHER",
        senderName: "Other",
        text: "unrelated interleaved reply",
        providerThreadId: "2000.000",
        providerParentMessageId: "2000.000",
        isThreadReply: true,
        receivedAt: "2026-07-17T09:03:00.000Z",
      });
      const finalReply = await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "1000.002",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "alpha thread follow-up",
        providerThreadId: "1000.000",
        providerParentMessageId: "1000.000",
        isThreadReply: true,
        receivedAt: "2026-07-17T09:04:00.000Z",
      });
      const deps = depsFor(db, { conversationRepo: conversations });
      const readTool = createReadChatHistoryTool(deps) as unknown as {
        handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
      };
      const result = await readTool.handler({
        conversationRef: `conversation:${channel.id}`,
        anchorMessageId: anchor.row.id,
        limit: 5,
      });
      const body = JSON.parse(result.content[0]?.text ?? "{}") as {
        messages: Array<{ id: number; text: string }>;
      };
      expect(body.messages.map((message) => message.id)).toEqual([firstRoot.row.id, anchor.row.id, finalReply.row.id]);
      expect(body.messages.map((message) => message.text)).not.toContain("unrelated interleaved reply");

      const rootResult = await readTool.handler({
        conversationRef: `conversation:${channel.id}`,
        anchorMessageId: firstRoot.row.id,
        limit: 5,
      });
      const rootBody = JSON.parse(rootResult.content[0]?.text ?? "{}") as {
        messages: Array<{ id: number; text: string }>;
      };
      expect(rootBody.messages.map((message) => message.id)).toEqual([
        firstRoot.row.id,
        anchor.row.id,
        finalReply.row.id,
      ]);
      expect(rootBody.messages.map((message) => message.text)).not.toContain("unrelated thread root");
    });

    it("uses the anchor thread when conversationRef points to the active Slack channel", async () => {
      const conversations = createConversationRepository(db);
      const channel = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C-SAME-CONVERSATION",
      });
      await db
        .insertInto("slack_channel_participants")
        .values({ channel_id: "C-SAME-CONVERSATION", slack_user_id: USER_SLACK_ID })
        .execute();
      const otherRoot = await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "other-root",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "other thread root",
        providerThreadId: "other-root",
      });
      const otherAnchor = await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "other-reply",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "other thread decision",
        providerThreadId: "other-root",
        providerParentMessageId: "other-root",
        isThreadReply: true,
      });
      await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "active-root",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "active thread root",
        providerThreadId: "active-root",
      });
      const trigger = await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "active-reply",
        senderJid: USER_SLACK_ID,
        senderName: "Roopak",
        text: "read the other result",
        providerThreadId: "active-root",
        providerParentMessageId: "active-root",
        isThreadReply: true,
      });
      const readTool = createReadChatHistoryTool(
        depsFor(db, {
          conversationRepo: conversations,
          conversationContext: {
            conversationId: channel.id,
            currentMessageId: trigger.row.id,
            providerThreadId: "active-root",
            isThreadReply: true,
          },
        }),
      ) as unknown as {
        handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
      };

      const result = await readTool.handler({
        conversationRef: `conversation:${channel.id}`,
        anchorMessageId: otherAnchor.row.id,
        limit: 5,
      });
      const body = JSON.parse(result.content[0]?.text ?? "{}") as {
        messages: Array<{ id: number; text: string }>;
      };
      expect(body.messages.map((message) => message.id)).toEqual([otherRoot.row.id, otherAnchor.row.id]);
      expect(body.messages.map((message) => message.text)).not.toContain("active thread root");
    });

    it("pages both directions through more than 100 Slack thread messages without leakage", async () => {
      const conversations = createConversationRepository(db);
      const channel = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C-LONG-THREAD",
      });
      await db
        .insertInto("slack_channel_participants")
        .values({
          channel_id: "C-LONG-THREAD",
          slack_user_id: USER_SLACK_ID,
          last_seen_at: new Date().toISOString(),
        })
        .execute();
      const target: number[] = [];
      let anchorMessageId = 0;
      for (let index = 0; index < 121; index += 1) {
        const message = await conversations.insertMessage({
          conversationId: channel.id,
          providerMessageId: `long-${index}`,
          senderJid: "U0TEAM",
          senderName: "Tara",
          text: `long thread message ${index}`,
          providerThreadId: "long-0",
          providerParentMessageId: index === 0 ? null : "long-0",
          isThreadReply: index > 0,
          receivedAt: new Date(Date.UTC(2026, 6, 17, 9, 0, index)).toISOString(),
        });
        target.push(message.row.id);
        if (index === 60) anchorMessageId = message.row.id;
        if (index % 20 === 0) {
          await conversations.insertMessage({
            conversationId: channel.id,
            providerMessageId: `other-${index}`,
            senderJid: "U0OTHER",
            senderName: "Other",
            text: `other thread message ${index}`,
            providerThreadId: "other-0",
            providerParentMessageId: "other-0",
            isThreadReply: true,
          });
        }
      }
      const current = await conversations.getOrCreate({
        platform: "slack",
        kind: "dm",
        providerConversationId: "D-LONG-THREAD",
      });
      const trigger = await conversations.insertMessage({
        conversationId: current.id,
        providerMessageId: "long-thread-trigger",
        senderJid: USER_SLACK_ID,
        senderName: "Roopak",
        text: "read the whole thread",
      });
      const deps = depsFor(db, {
        conversationRepo: conversations,
        conversationContext: { conversationId: current.id, currentMessageId: trigger.row.id },
      });
      const readTool = createReadChatHistoryTool(deps) as unknown as {
        handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
      };
      const first = await readTool.handler({
        conversationRef: `conversation:${channel.id}`,
        anchorMessageId,
        limit: 10,
      });
      const firstBody = JSON.parse(first.content[0]?.text ?? "{}") as {
        messages: Array<{ id: number; text: string }>;
        olderPageToken?: string;
        newerPageToken?: string;
      };
      const seen = new Map(firstBody.messages.map((message) => [message.id, message.text]));
      await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "long-after-snapshot",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "long thread message after snapshot",
        providerThreadId: "long-0",
        providerParentMessageId: "long-0",
        isThreadReply: true,
      });

      let olderPageToken = firstBody.olderPageToken;
      while (olderPageToken) {
        const page = await readTool.handler({ pageToken: olderPageToken, limit: 17 });
        const body = JSON.parse(page.content[0]?.text ?? "{}") as {
          messages: Array<{ id: number; text: string }>;
          olderPageToken?: string;
        };
        for (const message of body.messages) seen.set(message.id, message.text);
        olderPageToken = body.olderPageToken;
      }

      let newerPageToken = firstBody.newerPageToken;
      while (newerPageToken) {
        const page = await readTool.handler({ pageToken: newerPageToken, limit: 19 });
        const body = JSON.parse(page.content[0]?.text ?? "{}") as {
          messages: Array<{ id: number; text: string }>;
          newerPageToken?: string;
        };
        for (const message of body.messages) seen.set(message.id, message.text);
        newerPageToken = body.newerPageToken;
      }

      expect([...seen.keys()].sort((a, b) => a - b)).toEqual(target);
      expect([...seen.values()].every((text) => text.startsWith("long thread message"))).toBe(true);
    });

    it("reads legacy Slack anchors without thread metadata while excluding newer thread rows", async () => {
      const conversations = createConversationRepository(db);
      const channel = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C-LEGACY",
      });
      await db
        .insertInto("slack_channel_participants")
        .values({
          channel_id: "C-LEGACY",
          slack_user_id: USER_SLACK_ID,
          last_seen_at: new Date().toISOString(),
        })
        .execute();
      const before = await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "legacy-1",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "legacy channel context",
        receivedAt: "2026-07-17T09:00:00.000Z",
      });
      const anchor = await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "legacy-2",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "legacy launch decision",
        receivedAt: "2026-07-17T09:01:00.000Z",
      });
      await conversations.insertMessage({
        conversationId: channel.id,
        providerMessageId: "modern-thread-1",
        senderJid: "U0OTHER",
        senderName: "Other",
        text: "new thread should stay out",
        providerThreadId: "3000.000",
        receivedAt: "2026-07-17T09:02:00.000Z",
      });
      const readTool = createReadChatHistoryTool(depsFor(db, { conversationRepo: conversations })) as unknown as {
        handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
      };

      const result = await readTool.handler({
        conversationRef: `conversation:${channel.id}`,
        anchorMessageId: anchor.row.id,
        limit: 5,
      });
      const body = JSON.parse(result.content[0]?.text ?? "{}") as {
        messages: Array<{ id: number; text: string }>;
      };
      expect(body.messages.map((message) => message.id)).toEqual([before.row.id, anchor.row.id]);
      expect(body.messages.map((message) => message.text)).not.toContain("new thread should stay out");
    });

    it("does not reveal whether a cross-chat conversation ref exists after access is revoked", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "revoked read target",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        indexEnabled: false,
      });
      await db
        .deleteFrom("whatsapp_group_participants")
        .where("group_jid", "=", seeded.groupJid)
        .where("phone_e164", "=", USER_WHATSAPP_NUMBER)
        .execute();
      const readTool = createReadChatHistoryTool(
        depsFor(db, { conversationRepo: createConversationRepository(db) }),
      ) as unknown as {
        handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
      };

      const denied = await readTool.handler({
        conversationRef: `conversation:${seeded.conversationId}`,
        anchorMessageId: seeded.messageId,
      });
      const guessed = await readTool.handler({
        conversationRef: "conversation:999999",
        anchorMessageId: seeded.messageId,
      });
      expect(denied.content[0]?.text).toBe(guessed.content[0]?.text);
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

      const outcome = await readAllChats(
        {},
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
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      await seedWhatsAppGroup(db, {
        text: "crossplatform token in whatsapp",
        members: [USER_EMAIL],
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

      const slackOnly = await readAllChats(
        { platform: "slack" },
        depsFor(db, { conversationContext: { conversationId: currentDm.id } }),
      );
      expect(slackOnly.ok).toBe(true);
      if (!slackOnly.ok) return;
      expect(slackOnly.body.messages).toHaveLength(1);
      expect((slackOnly.body.messages[0]?.conversation as { platform: string }).platform).toBe("slack");

      const whatsappOnly = await readAllChats(
        { platform: "whatsapp" },
        depsFor(db, { conversationContext: { conversationId: currentDm.id } }),
      );
      expect(whatsappOnly.ok).toBe(true);
      if (!whatsappOnly.ok) return;
      expect(whatsappOnly.body.messages).toHaveLength(2);
    });

    it("restricts candidate authorization to Slack when the platform filter is Slack", async () => {
      await seedSlackChannel(db, {
        channelId: "C-SLACK-ONLY",
        text: "slack-only provider marker",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      const outcome = await readAllChats({ platform: "slack" }, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
    });

    it("excludes bot messages by default and includes them on request", async () => {
      const seeded = await seedSlackChannel(db, {
        channelId: "C6",
        text: "botfilter human message",
        members: [USER_EMAIL],
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

      const withoutBots = await readAllChats({}, depsFor(db));
      expect(withoutBots.ok).toBe(true);
      if (!withoutBots.ok) return;
      expect(withoutBots.body.messages).toHaveLength(1);

      const withBots = await readAllChats({ includeBotMessages: true }, depsFor(db));
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
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      expect(seeded.messageId).toBeGreaterThan(trigger.row.id);

      const outcome = await readAllChats(
        {},
        depsFor(db, { conversationContext: { conversationId: currentDm.id, currentMessageId: trigger.row.id } }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(0);
    });

    it("normalizes time bounds, includes both edges, and omits null effective times", async () => {
      const seeded = await seedSlackChannel(db, {
        channelId: "C-TIME-BOUNDS",
        text: "outside lower bound",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      const conversations = createConversationRepository(db);
      const atLower = await conversations.insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: "time-lower",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "at lower bound",
        providerTimestamp: "2026-07-17T10:00:00.000Z",
        receivedAt: "2026-07-17T10:00:00.000Z",
      });
      const atUpper = await conversations.insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: "time-upper",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "at upper bound",
        providerTimestamp: "2026-07-17T11:30:00.000Z",
        receivedAt: "2026-07-17T11:30:00.000Z",
      });
      const nullEffective = await conversations.insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: "time-null",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "null effective time",
        providerTimestamp: null,
        receivedAt: "2026-07-17T10:30:00.000Z",
      });
      await db
        .updateTable("conversation_messages")
        .set({ effective_at: null })
        .where("id", "=", nullEffective.row.id)
        .execute();
      const current = await conversations.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "15550001234@s.whatsapp.net",
      });
      const trigger = await conversations.insertMessage({
        conversationId: current.id,
        providerMessageId: "time-trigger",
        senderJid: "15550001234@s.whatsapp.net",
        senderName: "Roopak",
        text: "read bounded history",
        receivedAt: "2026-07-17T12:00:00.000Z",
      });
      const readTool = createReadChatHistoryTool(
        depsFor(db, {
          conversationRepo: conversations,
          conversationContext: { conversationId: current.id, currentMessageId: trigger.row.id },
        }),
      ) as unknown as { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };

      const bounded = await readTool.handler({
        scope: "all_chats",
        platform: "slack",
        afterTime: "2026-07-17T15:30:00+05:30",
        beforeTime: "2026-07-17T17:00:00+05:30",
        limit: 10,
      });
      const body = JSON.parse(bounded.content[0]?.text ?? "{}") as {
        messages: Array<{ id: number; text: string }>;
      };
      expect(body.messages.map((message) => message.id)).toEqual([atLower.row.id, atUpper.row.id]);
      expect(body.messages.map((message) => message.text)).toEqual(["at lower bound", "at upper bound"]);

      const empty = await readTool.handler({
        scope: "all_chats",
        platform: "slack",
        afterTime: "2026-07-17T18:00:00+05:30",
        beforeTime: "2026-07-17T17:00:00+05:30",
      });
      expect(JSON.parse(empty.content[0]?.text ?? "{}").messages).toEqual([]);
    });

    it("pages a merged all-chat stream with a global effective-time cursor", async () => {
      const first = await seedSlackChannel(db, {
        channelId: "C-GLOBAL-CURSOR-A",
        text: "A twelve",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      const second = await seedSlackChannel(db, {
        channelId: "C-GLOBAL-CURSOR-B",
        text: "B eleven",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      const conversations = createConversationRepository(db);
      await db
        .updateTable("conversation_messages")
        .set({ provider_timestamp: "2026-07-17T12:00:00.000Z", effective_at: "2026-07-17T12:00:00.000Z" })
        .where("id", "=", first.messageId)
        .execute();
      await db
        .updateTable("conversation_messages")
        .set({ provider_timestamp: "2026-07-17T11:00:00.000Z", effective_at: "2026-07-17T11:00:00.000Z" })
        .where("id", "=", second.messageId)
        .execute();
      const aEarlier = await conversations.insertMessage({
        conversationId: first.conversationId,
        providerMessageId: "cursor-a-earlier",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "A ten",
        providerTimestamp: "2026-07-17T10:00:00.000Z",
        receivedAt: "2026-07-17T10:00:00.000Z",
      });
      const bEarlier = await conversations.insertMessage({
        conversationId: second.conversationId,
        providerMessageId: "cursor-b-earlier",
        senderJid: "U0TEAM",
        senderName: "Tara",
        text: "B nine",
        providerTimestamp: "2026-07-17T09:00:00.000Z",
        receivedAt: "2026-07-17T09:00:00.000Z",
      });
      const current = await conversations.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "15550001234@s.whatsapp.net",
      });
      const trigger = await conversations.insertMessage({
        conversationId: current.id,
        providerMessageId: "cursor-trigger",
        senderJid: "15550001234@s.whatsapp.net",
        senderName: "Roopak",
        text: "page all chats",
        receivedAt: "2026-07-17T13:00:00.000Z",
      });
      const readTool = createReadChatHistoryTool(
        depsFor(db, {
          conversationRepo: conversations,
          conversationContext: { conversationId: current.id, currentMessageId: trigger.row.id },
        }),
      ) as unknown as { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };

      const firstPage = await readTool.handler({ scope: "all_chats", platform: "slack", order: "desc", limit: 2 });
      const firstBody = JSON.parse(firstPage.content[0]?.text ?? "{}") as {
        messages: Array<{ id: number; text: string }>;
        nextPageToken?: string;
      };
      expect(firstBody.messages.map((message) => message.text)).toEqual(["A twelve", "B eleven"]);
      expect(firstBody.nextPageToken).toBeTypeOf("string");

      const secondPage = await readTool.handler({ pageToken: firstBody.nextPageToken, limit: 2 });
      const secondBody = JSON.parse(secondPage.content[0]?.text ?? "{}") as {
        messages: Array<{ id: number; text: string }>;
      };
      expect(secondBody.messages.map((message) => message.text)).toEqual(["A ten", "B nine"]);
      expect(secondBody.messages.map((message) => message.id)).toEqual([aEarlier.row.id, bEarlier.row.id]);
    });

    it("denies without an authenticated requester or any usable provider identity", async () => {
      await seedSlackChannel(db, {
        channelId: "C8",
        text: "gated content",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });

      const anonymous = await readAllChats({}, depsFor(db, { currentUserId: undefined }));
      expect(anonymous.ok).toBe(false);

      await db.updateTable("users").set({ email_verified_at: null }).where("id", "=", USER_ID).execute();
      await db.updateTable("users").set({ email: null }).where("id", "=", USER_ID).execute();
      await db.updateTable("users").set({ whatsapp_number: null }).where("id", "=", USER_ID).execute();
      await db.updateTable("users").set({ slack_user_id: null }).where("id", "=", USER_ID).execute();
      const unverified = await readAllChats({}, depsFor(db));
      expect(unverified.ok).toBe(false);
    });

    it("works from a shared group context and includes the current conversation without an access scope", async () => {
      await seedSlackChannel(db, {
        channelId: "C10",
        text: "shared context marker in slack",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      const conversations = createConversationRepository(db);
      await createWhatsAppGroupRepository(db).upsert({
        jid: "888800001111222233@g.us",
        name: "WhatsApp group",
        description: null,
        updated_at: "2026-07-17T09:00:00.000Z",
      });
      const currentGroup = await conversations.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "888800001111222233@g.us",
      });
      const groupMessage = await conversations.insertMessage({
        conversationId: currentGroup.id,
        providerMessageId: "grp-current-1",
        senderJid: "15550001111@s.whatsapp.net",
        senderName: "Tara",
        text: "shared context marker in this group",
        receivedAt: "2026-07-17T09:00:00.000Z",
      });
      await insertWhatsAppParticipantFixtures(db, [
        {
          group_jid: "888800001111222233@g.us",
          participant_jid: "15550001234@s.whatsapp.net",
          phone_e164: USER_WHATSAPP_NUMBER,
          lid: null,
          admin_role: null,
          last_seen_at: "2026-07-17T09:00:00.000Z",
        },
      ]);
      const trigger = await conversations.insertMessage({
        conversationId: currentGroup.id,
        providerMessageId: "grp-current-2",
        senderJid: "15550001234@s.whatsapp.net",
        senderName: "Roopak",
        text: "search my chats",
        receivedAt: "2026-07-17T09:01:00.000Z",
      });

      const outcome = await readAllChats(
        {},
        depsFor(db, {
          conversationContext: { conversationId: currentGroup.id, currentMessageId: trigger.row.id },
        }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(2);
      const platforms = outcome.body.messages.map((message) => (message.conversation as { platform: string }).platform);
      expect(platforms).toContain("slack");
      expect(platforms).toContain("whatsapp");
      expect(outcome.body.messages.some((message) => message.id === groupMessage.row.id)).toBe(true);
      const groupHit = outcome.body.messages.find((message) => message.id === groupMessage.row.id);
      expect((groupHit?.conversation as { name: string }).name).toBe("WhatsApp group");
    });

    it("denies the current Slack conversation and shared-target write after membership removal", async () => {
      const seeded = await seedSlackChannel(db, {
        channelId: "C-REMOVED-CURRENT",
        text: "removed current channel secret",
        members: [USER_EMAIL],
        connectorConfigId: slackConfigId,
      });
      const trigger = await createConversationRepository(db).insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: "removed-current-trigger",
        senderJid: USER_SLACK_ID,
        senderName: "Roopak",
        text: "search this",
        receivedAt: "2026-07-17T09:11:00.000Z",
      });
      await db
        .deleteFrom("slack_channel_participants")
        .where("channel_id", "=", "C-REMOVED-CURRENT")
        .where("slack_user_id", "=", USER_SLACK_ID)
        .execute();

      const deps = depsFor(db, {
        conversationContext: { conversationId: seeded.conversationId, currentMessageId: trigger.row.id },
      });
      const outcome = await handleAllChatsRead({}, deps);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(JSON.stringify(outcome.body.messages)).not.toContain("removed current channel secret");
      await expect(
        new ChatHistoryAccessResolver(deps).authorizedProviderTargets([
          { platform: "slack", targetId: "C-REMOVED-CURRENT" },
        ]),
      ).resolves.toEqual(new Set());
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
        members: [USER_EMAIL],
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
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        senderJid: "15559998888@s.whatsapp.net",
        rosterSnapshot: whatsappRoster,
      });

      const outcome = await readAllChats({}, depsFor(db));
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

    it("renders WhatsApp group names from whatsapp_groups when the conversation display name is a raw JID", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "jid name guard message",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        displayName: "Deal Room",
      });
      await db
        .updateTable("conversations")
        .set({ display_name: seeded.groupJid })
        .where("id", "=", seeded.conversationId)
        .execute();

      const outcome = await readAllChats({}, depsFor(db));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body.messages).toHaveLength(1);
      expect((outcome.body.messages[0]?.conversation as { name: string }).name).toBe("Deal Room");
      expect(JSON.stringify(outcome.body.messages)).not.toContain(seeded.groupJid);
    });

    describe("authorizedProviderTargets", () => {
      const upsertGroup = (groupJid: string) =>
        createWhatsAppGroupRepository(db).upsert({
          jid: groupJid,
          name: "Send Target",
          description: null,
          updated_at: "2026-07-17T09:00:00.000Z",
        });

      const insertSlackMember = (channelId: string, lastSeenAt: string) =>
        db
          .insertInto("slack_channel_participants")
          .values({ channel_id: channelId, slack_user_id: USER_SLACK_ID, last_seen_at: lastSeenAt })
          .execute();

      const authorize = (targets: ProviderTargetRef[], deps = depsFor(db)) =>
        new ChatHistoryAccessResolver(deps).authorizedProviderTargets(targets);

      it("authorizes a Slack channel with fresh membership and no conversations row", async () => {
        await insertSlackMember("C-SEND-FRESH", new Date().toISOString());

        const granted = await authorize([{ platform: "slack", targetId: "C-SEND-FRESH" }]);

        expect([...granted]).toEqual(["slack:C-SEND-FRESH"]);
      });

      it("authorizes a Slack channel whose membership is older than the former freshness window", async () => {
        await insertSlackMember("C-SEND-STALE", new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString());

        const granted = await authorize([{ platform: "slack", targetId: "C-SEND-STALE" }]);

        expect(granted.size).toBe(1);
      });

      it("denies a Slack channel the requester is not in", async () => {
        await db
          .insertInto("slack_channel_participants")
          .values({
            channel_id: "C-SEND-OTHER",
            slack_user_id: "U-SOMEONE-ELSE",
            last_seen_at: new Date().toISOString(),
          })
          .execute();

        const granted = await authorize([{ platform: "slack", targetId: "C-SEND-OTHER" }]);

        expect(granted.size).toBe(0);
      });

      it("authorizes a WhatsApp group on a direct phone match and no conversations row", async () => {
        const groupJid = `${randomUUID()}@g.us`;
        await upsertGroup(groupJid);
        await insertWhatsAppParticipantFixtures(db, [
          {
            group_jid: groupJid,
            participant_jid: "15550001234@s.whatsapp.net",
            phone_e164: USER_WHATSAPP_NUMBER,
            lid: null,
            admin_role: null,
            last_seen_at: "2026-07-17T09:00:00.000Z",
          },
        ]);

        const granted = await authorize([{ platform: "whatsapp", targetId: groupJid }]);

        expect([...granted]).toEqual([`whatsapp:${groupJid}`]);
      });

      it("authorizes a WhatsApp group through a linked LID alias", async () => {
        const targetGroup = `${randomUUID()}@g.us`;
        await upsertGroup(targetGroup);
        await db
          .insertInto("user_whatsapp_lids")
          .values({
            user_id: USER_ID,
            lid: "86702773280883@lid",
            first_seen_at: "2026-07-17T09:00:00.000Z",
            last_seen_at: "2026-07-17T09:00:00.000Z",
          })
          .execute();
        await insertWhatsAppParticipantFixtures(db, [
          {
            group_jid: targetGroup,
            participant_jid: "86702773280883@lid",
            phone_e164: null,
            lid: "86702773280883@lid",
            admin_role: null,
            last_seen_at: "2026-07-17T09:00:00.000Z",
          },
        ]);

        const granted = await authorize([{ platform: "whatsapp", targetId: targetGroup }]);

        expect([...granted]).toEqual([`whatsapp:${targetGroup}`]);
      });

      it("denies a WhatsApp group reached only through a LID that is not linked to the requester", async () => {
        const targetGroup = `${randomUUID()}@g.us`;
        await upsertGroup(targetGroup);
        const otherUserId = `user-other-lid-${randomUUID()}`;
        await createUserRepository(db).create({
          id: otherUserId,
          name: "Other",
          email: `${otherUserId}@example.com`,
        });
        await db
          .insertInto("user_whatsapp_lids")
          .values({
            user_id: otherUserId,
            lid: "lid-one@lid",
            first_seen_at: "2026-07-17T09:00:00.000Z",
            last_seen_at: "2026-07-17T09:00:00.000Z",
          })
          .execute();
        await insertWhatsAppParticipantFixtures(db, [
          {
            group_jid: targetGroup,
            participant_jid: "lid-one@lid",
            phone_e164: null,
            lid: "lid-one@lid",
            admin_role: null,
            last_seen_at: "2026-07-17T09:00:00.000Z",
          },
        ]);

        const granted = await authorize([{ platform: "whatsapp", targetId: targetGroup }]);

        expect(granted.size).toBe(0);
      });

      it("denies every target when the requester has no linked Slack or WhatsApp identity", async () => {
        const groupJid = `${randomUUID()}@g.us`;
        await upsertGroup(groupJid);
        await insertSlackMember("C-SEND-NO-IDENTITY", new Date().toISOString());
        await insertWhatsAppParticipantFixtures(db, [
          {
            group_jid: groupJid,
            participant_jid: "15550001234@s.whatsapp.net",
            phone_e164: USER_WHATSAPP_NUMBER,
            lid: null,
            admin_role: null,
            last_seen_at: "2026-07-17T09:00:00.000Z",
          },
        ]);
        const unlinkedId = `user-unlinked-${randomUUID()}`;
        await createUserRepository(db).create({
          id: unlinkedId,
          name: "Unlinked",
          email: `${unlinkedId}@example.com`,
        });

        const granted = await authorize(
          [
            { platform: "slack", targetId: "C-SEND-NO-IDENTITY" },
            { platform: "whatsapp", targetId: groupJid },
          ],
          depsFor(db, { currentUserId: unlinkedId }),
        );

        expect(granted.size).toBe(0);
      });

      it("denies every target when there is no requesting user", async () => {
        await insertSlackMember("C-SEND-ANON", new Date().toISOString());

        const granted = await authorize(
          [{ platform: "slack", targetId: "C-SEND-ANON" }],
          depsFor(db, { currentUserId: undefined }),
        );

        expect(granted.size).toBe(0);
      });

      it("lets handleSendMessage post through the real resolver for a fresh member", async () => {
        await insertSlackMember("C-SEND-E2E", new Date().toISOString());
        const sendTargetMessage = vi.fn().mockResolvedValue({ messageRef: "1700000000.0100" });

        const result = await handleSendMessage(
          { target: { platform: "slack", targetType: "channel", targetId: "C-SEND-E2E" }, message: "hello channel" },
          depsFor(db, { sendTargetMessage }),
        );

        expect(sendTargetMessage).toHaveBeenCalledOnce();
        expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "sent", targetId: "C-SEND-E2E" });
      });

      it("lets handleSendMessage deny through the real resolver for a non-member", async () => {
        const sendTargetMessage = vi.fn();

        const result = await handleSendMessage(
          { target: { platform: "slack", targetType: "channel", targetId: "C-SEND-E2E-DENY" }, message: "hello" },
          depsFor(db, { sendTargetMessage }),
        );

        expect(sendTargetMessage).not.toHaveBeenCalled();
        expect(result.content[0].text).toContain("not a known member of that channel or group");
      });

      it("denies a non-member send through the real resolver even from inside that conversation", async () => {
        const conversation = await createConversationRepository(db).getOrCreate({
          platform: "slack",
          kind: "channel",
          providerConversationId: "C-SEND-CTX",
        });
        const sendTargetMessage = vi.fn();

        const result = await handleSendMessage(
          { target: { platform: "slack", targetType: "channel", targetId: "C-SEND-CTX" }, message: "hello" },
          depsFor(db, { sendTargetMessage, conversationContext: { conversationId: conversation.id } }),
        );

        expect(sendTargetMessage).not.toHaveBeenCalled();
        expect(result.content[0].text).toContain("not a known member of that channel or group");
      });
    });
  });
}

/**
 * Runs on a fresh database per test (createTestPgDb on Postgres, not the
 * shared BEGIN/ROLLBACK database): these tests call refreshParticipants,
 * which opens its own Kysely transaction and would collide with an outer
 * per-test transaction scope.
 */
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

    async function scopePrincipalValues(scopeId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("access_scope_members")
        .select("principal_value")
        .where("access_scope_id", "=", scopeId)
        .execute();
      return rows.map((row) => row.principal_value).sort();
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
        members: ["tara@example.com", "departed@example.com"],
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
      expect(await scopePrincipalValues(seeded.scopeId)).toEqual(["+15551230001", "tara@example.com"]);
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
        members: ["tara2@example.com", "departed@example.com"],
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
      expect(await scopePrincipalValues(seeded.scopeId)).toEqual(["+15551230002", "tara2@example.com"]);
      const file = await db
        .selectFrom("indexed_files")
        .select("is_archived")
        .where("id", "=", seeded.fileId)
        .executeTakeFirst();
      expect(file?.is_archived).toBe(0);
    });

    it("clears scope members instead of archiving when a disabled group's roster has zero teammates", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "disabled zero teammates",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        seedCurrentUserParticipant: false,
      });
      const groups = createWhatsAppGroupRepository(db);
      await groups.refreshParticipants(seeded.groupJid, [
        { participantJid: "15559990001@s.whatsapp.net", phoneE164: "+15559990001", adminRole: null },
      ]);
      await groups.setIndexEnabled(seeded.groupJid, false);

      const summary = await reconcileWhatsAppGroupAcls({
        db,
        logger: createTestLogger(),
        connectorConfigId: whatsappConfigId,
      });
      expect(summary.scopesArchived).toBe(0);
      expect(summary.scopesRefreshed).toBe(1);
      expect(await scopePrincipalValues(seeded.scopeId)).toEqual(["+15559990001"]);
      const file = await db
        .selectFrom("indexed_files")
        .select("is_archived")
        .where("id", "=", seeded.fileId)
        .executeTakeFirst();
      expect(file?.is_archived).toBe(0);
    });

    it("retains files when the roster has only an unresolved phone principal", async () => {
      const seeded = await seedWhatsAppGroup(db, {
        text: "external only group",
        members: [USER_EMAIL],
        connectorConfigId: whatsappConfigId,
        seedCurrentUserParticipant: false,
      });
      await createWhatsAppGroupRepository(db).refreshParticipants(seeded.groupJid, [
        { participantJid: "15559990000@s.whatsapp.net", phoneE164: "+15559990000", adminRole: null },
      ]);

      const summary = await reconcileWhatsAppGroupAcls({
        db,
        logger: createTestLogger(),
        connectorConfigId: whatsappConfigId,
      });
      expect(summary.scopesArchived).toBe(0);
      expect(summary.scopesRefreshed).toBe(1);
      expect(await scopePrincipalValues(seeded.scopeId)).toEqual(["+15559990000"]);
    });
  });
}

runSuite("chat-search sqlite", createTestDb);
runSuite("chat-search postgres", createTestPgDb);
runReconcileSuite("sqlite", createTestDb);
runReconcileSuite("postgres", createTestPgDb);
