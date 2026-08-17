import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import {
  collectWhatsAppIdentityGroupContext,
  mergeAnchorWindows,
  resolveWhatsAppViewerGroupJids,
  whatsappIdentitySenderJids,
} from "./identity-group-context";

const TARGET_LID = "149916051591191@lid";
const TARGET_PHONE = "+919969577769";
const OTHER_LID = "3878523285582@lid";

async function seedGroup(db: Kysely<DB>, jid: string, name: string, indexEnabled = 1) {
  await db
    .insertInto("whatsapp_groups")
    .values({ jid, name, description: null, index_enabled: indexEnabled })
    .execute();
}

async function seedParticipant(
  db: Kysely<DB>,
  groupJid: string,
  participant: { jid: string; phone?: string | null; lid?: string | null },
) {
  await db
    .insertInto("whatsapp_group_participants")
    .values({
      id: randomUUID(),
      group_jid: groupJid,
      observation_key: `phone:${participant.phone ?? "-"}|lid:${participant.lid ?? "-"}`,
      participant_jid: participant.jid,
      phone_e164: participant.phone ?? null,
      lid: participant.lid ?? null,
      admin_role: null,
    })
    .execute();
}

async function seedConversation(db: Kysely<DB>, groupJid: string): Promise<number> {
  const row = await db
    .insertInto("conversations")
    .values({ platform: "whatsapp", kind: "group", provider_conversation_id: groupJid, display_name: groupJid })
    .returning("id")
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

let messageSequence = 0;

async function seedMessage(
  db: Kysely<DB>,
  conversationId: number,
  message: { senderJid: string; senderName: string; text: string; at?: string },
) {
  messageSequence += 1;
  const at =
    message.at ??
    `2026-08-0${Math.min(9, 1 + Math.floor(messageSequence / 20))}T10:${String(messageSequence % 60).padStart(2, "0")}:00.000Z`;
  await db
    .insertInto("conversation_messages")
    .values({
      conversation_id: conversationId,
      provider_message_id: `pm-${messageSequence}`,
      sender_jid: message.senderJid,
      sender_name: message.senderName,
      text: message.text,
      is_bot: 0,
      received_at: at,
      effective_at: at,
    })
    .execute();
}

async function seedEntityWithContactPoint(db: Kysely<DB>, name: string, kind: string, value: string): Promise<string> {
  const entityId = randomUUID();
  const now = new Date("2026-08-01T00:00:00.000Z").toISOString();
  await db
    .insertInto("entities")
    .values({
      id: entityId,
      name,
      source_type: "person",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  await db
    .insertInto("entity_contact_points")
    .values({ id: randomUUID(), entity_id: entityId, kind, value, source: "whatsapp_identity" })
    .execute();
  return entityId;
}

describe("whatsappIdentitySenderJids", () => {
  it("expands a phone into every spelling the messages table uses", () => {
    expect(whatsappIdentitySenderJids({ lids: [], phoneE164: TARGET_PHONE })).toEqual([
      "+919969577769",
      "wati:+919969577769",
      "919969577769@s.whatsapp.net",
      "919969577769",
    ]);
  });

  it("normalizes a lid and strips its device suffix", () => {
    expect(whatsappIdentitySenderJids({ lids: ["149916051591191:12@lid"], phoneE164: null })).toEqual([TARGET_LID]);
  });

  it("returns nothing for an identity with neither lid nor phone", () => {
    expect(whatsappIdentitySenderJids({ lids: [], phoneE164: null })).toEqual([]);
  });
});

describe("mergeAnchorWindows", () => {
  const row = (id: number) => ({ id, at: "2026-08-01T00:00:00.000Z", senderJid: "a@lid", senderName: "A", text: "t" });

  it("merges windows whose id ranges overlap into one excerpt", () => {
    const merged = mergeAnchorWindows(
      [
        [row(1), row(2), row(3)],
        [row(3), row(4), row(5)],
      ],
      100,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps disjoint windows as separate excerpts", () => {
    const merged = mergeAnchorWindows(
      [
        [row(1), row(2)],
        [row(90), row(91)],
      ],
      100,
    );
    expect(merged.map((run) => run.map((entry) => entry.id))).toEqual([
      [1, 2],
      [90, 91],
    ]);
  });

  it("drops the oldest excerpts when the budget is exceeded", () => {
    const merged = mergeAnchorWindows(
      [
        [row(1), row(2)],
        [row(90), row(91)],
      ],
      2,
    );
    expect(merged.map((run) => run.map((entry) => entry.id))).toEqual([[90, 91]]);
  });
});

describe("collectWhatsAppIdentityGroupContext", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    messageSequence = 0;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("reports a roster-only group with no excerpts", async () => {
    await seedGroup(db, "g1@g.us", "Ops");
    await seedParticipant(db, "g1@g.us", { jid: TARGET_LID, lid: TARGET_LID, phone: TARGET_PHONE });

    const context = await collectWhatsAppIdentityGroupContext(db, { lids: [TARGET_LID], phoneE164: TARGET_PHONE });

    expect(context.totalGroups).toBe(1);
    expect(context.groups[0].membership).toBe("roster");
    expect(context.groups[0].messageCount).toBe(0);
    expect(context.groups[0].excerpts).toEqual([]);
  });

  it("finds a group the identity only ever spoke in and marks it messages-only", async () => {
    await seedGroup(db, "g2@g.us", "Sales");
    const conversationId = await seedConversation(db, "g2@g.us");
    await seedMessage(db, conversationId, { senderJid: TARGET_LID, senderName: "Ved", text: "hello there" });

    const context = await collectWhatsAppIdentityGroupContext(db, { lids: [TARGET_LID], phoneE164: null });

    expect(context.groups).toHaveLength(1);
    expect(context.groups[0].membership).toBe("messages");
    expect(context.groups[0].messageCount).toBe(1);
    expect(context.groups[0].name).toBe("Sales");
  });

  it("marks a group both when the identity is on the roster and has spoken", async () => {
    await seedGroup(db, "g3@g.us", "Eng");
    await seedParticipant(db, "g3@g.us", { jid: TARGET_LID, lid: TARGET_LID });
    const conversationId = await seedConversation(db, "g3@g.us");
    await seedMessage(db, conversationId, { senderJid: TARGET_LID, senderName: "Ved", text: "shipping today" });

    const context = await collectWhatsAppIdentityGroupContext(db, { lids: [TARGET_LID], phoneE164: null });

    expect(context.groups[0].membership).toBe("both");
  });

  it("matches the same human across the lid and phone-jid spellings", async () => {
    await seedGroup(db, "g4@g.us", "History");
    const conversationId = await seedConversation(db, "g4@g.us");
    await seedMessage(db, conversationId, { senderJid: "919969577769@s.whatsapp.net", senderName: "V", text: "old" });
    await seedMessage(db, conversationId, { senderJid: TARGET_LID, senderName: "V", text: "new" });

    const context = await collectWhatsAppIdentityGroupContext(db, {
      lids: [TARGET_LID],
      phoneE164: TARGET_PHONE,
    });

    expect(context.groups[0].messageCount).toBe(2);
  });

  it("labels the identity self, a resolvable sender known, and the rest unknown", async () => {
    await seedGroup(db, "g5@g.us", "Mixed");
    const conversationId = await seedConversation(db, "g5@g.us");
    const knownEntityId = await seedEntityWithContactPoint(db, "Rahul Mehta", "whatsapp_lid", OTHER_LID);
    await seedMessage(db, conversationId, { senderJid: OTHER_LID, senderName: "rm", text: "who is joining" });
    await seedMessage(db, conversationId, { senderJid: TARGET_LID, senderName: "Ved", text: "I am" });
    await seedMessage(db, conversationId, { senderJid: "77777@lid", senderName: "Stranger", text: "me too" });

    const context = await collectWhatsAppIdentityGroupContext(db, { lids: [TARGET_LID], phoneE164: null });
    const messages = context.groups[0].excerpts.flatMap((excerpt) => excerpt.messages);

    expect(messages.map((message) => message.role)).toEqual(["known", "self", "unknown"]);
    expect(messages[0].entityId).toBe(knownEntityId);
    expect(messages[0].senderName).toBe("Rahul Mehta");
    expect(messages[2].senderName).toBe("Stranger");
    expect(messages[2].entityId).toBeNull();
  });

  it("includes surrounding messages from other people as context", async () => {
    await seedGroup(db, "g6@g.us", "Context");
    const conversationId = await seedConversation(db, "g6@g.us");
    for (let index = 0; index < 6; index += 1) {
      await seedMessage(db, conversationId, { senderJid: OTHER_LID, senderName: "Other", text: `before ${index}` });
    }
    await seedMessage(db, conversationId, { senderJid: TARGET_LID, senderName: "Ved", text: "the anchor" });
    for (let index = 0; index < 6; index += 1) {
      await seedMessage(db, conversationId, { senderJid: OTHER_LID, senderName: "Other", text: `after ${index}` });
    }

    const context = await collectWhatsAppIdentityGroupContext(db, { lids: [TARGET_LID], phoneE164: null });
    const messages = context.groups[0].excerpts.flatMap((excerpt) => excerpt.messages);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.some((message) => message.role === "self")).toBe(true);
    expect(messages.some((message) => message.text.startsWith("before"))).toBe(true);
    expect(messages.some((message) => message.text.startsWith("after"))).toBe(true);
  });

  it("returns nothing when the restriction list excludes every group", async () => {
    await seedGroup(db, "g7@g.us", "Private");
    await seedParticipant(db, "g7@g.us", { jid: TARGET_LID, lid: TARGET_LID });
    const conversationId = await seedConversation(db, "g7@g.us");
    await seedMessage(db, conversationId, { senderJid: TARGET_LID, senderName: "Ved", text: "secret" });

    const context = await collectWhatsAppIdentityGroupContext(
      db,
      { lids: [TARGET_LID], phoneE164: null },
      { restrictToGroupJids: [] },
    );

    expect(context).toEqual({ groups: [], totalGroups: 0, truncated: false });
  });

  it("restricts results to the allowed groups", async () => {
    for (const jid of ["g8@g.us", "g9@g.us"]) {
      await seedGroup(db, jid, `Group ${jid}`);
      const conversationId = await seedConversation(db, jid);
      await seedMessage(db, conversationId, { senderJid: TARGET_LID, senderName: "Ved", text: "hi" });
    }

    const context = await collectWhatsAppIdentityGroupContext(
      db,
      { lids: [TARGET_LID], phoneE164: null },
      { restrictToGroupJids: ["g8@g.us"] },
    );

    expect(context.groups.map((group) => group.groupJid)).toEqual(["g8@g.us"]);
    expect(context.totalGroups).toBe(1);
  });

  it("caps the group count and reports the total", async () => {
    for (let index = 0; index < 4; index += 1) {
      const jid = `cap${index}@g.us`;
      await seedGroup(db, jid, `Cap ${index}`);
      const conversationId = await seedConversation(db, jid);
      await seedMessage(db, conversationId, { senderJid: TARGET_LID, senderName: "Ved", text: `msg ${index}` });
    }

    const context = await collectWhatsAppIdentityGroupContext(
      db,
      { lids: [TARGET_LID], phoneE164: null },
      { groupLimit: 2 },
    );

    expect(context.groups).toHaveLength(2);
    expect(context.totalGroups).toBe(4);
    expect(context.truncated).toBe(true);
  });

  it("excludes bot messages from excerpts", async () => {
    await seedGroup(db, "g10@g.us", "Bots");
    const conversationId = await seedConversation(db, "g10@g.us");
    await seedMessage(db, conversationId, { senderJid: TARGET_LID, senderName: "Ved", text: "human message" });
    await db
      .insertInto("conversation_messages")
      .values({
        conversation_id: conversationId,
        provider_message_id: "bot-1",
        sender_jid: "sketch@bot",
        sender_name: "Sketch",
        text: "bot reply",
        is_bot: 1,
        received_at: "2026-08-01T11:00:00.000Z",
        effective_at: "2026-08-01T11:00:00.000Z",
      })
      .execute();

    const context = await collectWhatsAppIdentityGroupContext(db, { lids: [TARGET_LID], phoneE164: null });
    const texts = context.groups[0].excerpts.flatMap((excerpt) => excerpt.messages).map((message) => message.text);

    expect(texts).toEqual(["human message"]);
  });

  it("returns an empty context for an identity with no lid and no phone", async () => {
    await seedGroup(db, "g11@g.us", "Empty");
    const context = await collectWhatsAppIdentityGroupContext(db, { lids: [], phoneE164: null });
    expect(context).toEqual({ groups: [], totalGroups: 0, truncated: false });
  });
});

describe("resolveWhatsAppViewerGroupJids", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    messageSequence = 0;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns the groups the user is a participant of", async () => {
    await db
      .insertInto("users")
      .values({ id: "u1", name: "Admin", type: "human", whatsapp_number: TARGET_PHONE })
      .execute();
    await seedGroup(db, "v1@g.us", "Visible");
    await seedGroup(db, "v2@g.us", "Invisible");
    await seedParticipant(db, "v1@g.us", { jid: TARGET_LID, lid: TARGET_LID, phone: TARGET_PHONE });
    await seedParticipant(db, "v2@g.us", { jid: OTHER_LID, lid: OTHER_LID });

    expect(await resolveWhatsAppViewerGroupJids(db, "u1")).toEqual(["v1@g.us"]);
  });

  it("returns nothing for a user with no linked WhatsApp identity", async () => {
    await db.insertInto("users").values({ id: "u2", name: "NoWhatsApp", type: "human" }).execute();
    await seedGroup(db, "v3@g.us", "Group");
    await seedParticipant(db, "v3@g.us", { jid: TARGET_LID, lid: TARGET_LID });

    expect(await resolveWhatsAppViewerGroupJids(db, "u2")).toEqual([]);
  });

  it("matches a user through a lid recorded in user_whatsapp_lids", async () => {
    await db.insertInto("users").values({ id: "u3", name: "LidOnly", type: "human" }).execute();
    await db.insertInto("user_whatsapp_lids").values({ user_id: "u3", lid: TARGET_LID }).execute();
    await seedGroup(db, "v4@g.us", "Group");
    await seedParticipant(db, "v4@g.us", { jid: TARGET_LID, lid: TARGET_LID });

    expect(await resolveWhatsAppViewerGroupJids(db, "u3")).toEqual(["v4@g.us"]);
  });
});
