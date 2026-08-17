import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { dismissWhatsAppIdentity, listUnidentifiedWhatsAppContacts } from "./identity-review-queue";

const TARGET_LID = "149916051591191@lid";
const TARGET_PHONE = "+919969577769";
const SHARED_GROUP = "shared@g.us";
const PRIVATE_GROUP = "private@g.us";

let sequence = 0;

async function seedGroup(db: Kysely<DB>, jid: string, name: string) {
  await db.insertInto("whatsapp_groups").values({ jid, name, description: null, index_enabled: 1 }).execute();
}

async function seedParticipant(db: Kysely<DB>, groupJid: string, lid: string | null, phone: string | null) {
  await db
    .insertInto("whatsapp_group_participants")
    .values({
      id: randomUUID(),
      group_jid: groupJid,
      observation_key: `phone:${phone ?? "-"}|lid:${lid ?? "-"}`,
      participant_jid: lid ?? `${(phone ?? "").replace(/\D/gu, "")}@s.whatsapp.net`,
      phone_e164: phone,
      lid,
      admin_role: null,
      last_seen_at: "2026-08-01T00:00:00.000Z",
    })
    .execute();
}

/**
 * A roster row whose only identifying value is the raw `participant_jid`.
 * Older rows and anything sourced through WATI arrive with `phone_e164` and
 * `lid` both null.
 */
async function seedRawParticipant(db: Kysely<DB>, groupJid: string, participantJid: string) {
  await db
    .insertInto("whatsapp_group_participants")
    .values({
      id: randomUUID(),
      group_jid: groupJid,
      observation_key: `raw:${participantJid}`,
      participant_jid: participantJid,
      phone_e164: null,
      lid: null,
      admin_role: null,
      last_seen_at: "2026-08-01T00:00:00.000Z",
    })
    .execute();
}

async function seedPlaceholderEntity(
  db: Kysely<DB>,
  name: string,
  points: Array<{ kind: string; value: string }>,
  nameStatus = "placeholder",
): Promise<string> {
  const entityId = randomUUID();
  const now = "2026-08-01T00:00:00.000Z";
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
      name_status: nameStatus,
      hotness: 0,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  for (const point of points) {
    await db
      .insertInto("entity_contact_points")
      .values({
        id: randomUUID(),
        entity_id: entityId,
        kind: point.kind,
        value: point.value,
        source: "whatsapp_identity",
      })
      .execute();
  }
  return entityId;
}

async function seedMessage(db: Kysely<DB>, groupJid: string, senderJid: string, text: string) {
  sequence += 1;
  const at = `2026-08-05T10:${String(sequence % 60).padStart(2, "0")}:00.000Z`;
  let conversation = await db
    .selectFrom("conversations")
    .select("id")
    .where("provider_conversation_id", "=", groupJid)
    .executeTakeFirst();
  if (!conversation) {
    conversation = await db
      .insertInto("conversations")
      .values({ platform: "whatsapp", kind: "group", provider_conversation_id: groupJid, display_name: groupJid })
      .returning("id")
      .executeTakeFirstOrThrow();
  }
  await db
    .insertInto("conversation_messages")
    .values({
      conversation_id: Number(conversation.id),
      provider_message_id: `pm-${sequence}`,
      sender_jid: senderJid,
      sender_name: "Unknown",
      text,
      is_bot: 0,
      received_at: at,
      effective_at: at,
    })
    .execute();
}

describe("listUnidentifiedWhatsAppContacts", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    sequence = 0;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns a placeholder contact the viewer shares a group with", async () => {
    await seedGroup(db, SHARED_GROUP, "Shared Group");
    await seedParticipant(db, SHARED_GROUP, TARGET_LID, TARGET_PHONE);
    const entityId = await seedPlaceholderEntity(db, TARGET_PHONE, [{ kind: "whatsapp_lid", value: TARGET_LID }]);
    await seedMessage(db, SHARED_GROUP, TARGET_LID, "hello from the shared group");

    const items = await listUnidentifiedWhatsAppContacts(db, [SHARED_GROUP]);

    expect(items).toHaveLength(1);
    expect(items[0].entityId).toBe(entityId);
    expect(items[0].groups[0].groupName).toBe("Shared Group");
    expect(items[0].groups[0].messageCount).toBe(1);
    expect(items[0].groups[0].snippet).toBe("hello from the shared group");
  });

  it("returns nothing when the viewer shares no groups", async () => {
    await seedGroup(db, PRIVATE_GROUP, "Private Group");
    await seedParticipant(db, PRIVATE_GROUP, TARGET_LID, TARGET_PHONE);
    await seedPlaceholderEntity(db, TARGET_PHONE, [{ kind: "whatsapp_lid", value: TARGET_LID }]);

    expect(await listUnidentifiedWhatsAppContacts(db, [])).toEqual([]);
  });

  it("excludes groups the viewer is not in from a contact's sightings", async () => {
    await seedGroup(db, SHARED_GROUP, "Shared Group");
    await seedGroup(db, PRIVATE_GROUP, "Private Group");
    await seedParticipant(db, SHARED_GROUP, TARGET_LID, TARGET_PHONE);
    await seedParticipant(db, PRIVATE_GROUP, TARGET_LID, TARGET_PHONE);
    await seedPlaceholderEntity(db, TARGET_PHONE, [{ kind: "whatsapp_lid", value: TARGET_LID }]);

    const items = await listUnidentifiedWhatsAppContacts(db, [SHARED_GROUP]);

    expect(items[0].groups.map((group) => group.groupJid)).toEqual([SHARED_GROUP]);
  });

  it("ignores entities whose name is already confirmed", async () => {
    await seedGroup(db, SHARED_GROUP, "Shared Group");
    await seedParticipant(db, SHARED_GROUP, TARGET_LID, TARGET_PHONE);
    await seedPlaceholderEntity(db, "Rahul Mehta", [{ kind: "whatsapp_lid", value: TARGET_LID }], "confirmed");

    expect(await listUnidentifiedWhatsAppContacts(db, [SHARED_GROUP])).toEqual([]);
  });

  it("ignores entities that were dismissed", async () => {
    await seedGroup(db, SHARED_GROUP, "Shared Group");
    await seedParticipant(db, SHARED_GROUP, TARGET_LID, TARGET_PHONE);
    await seedPlaceholderEntity(db, TARGET_PHONE, [{ kind: "whatsapp_lid", value: TARGET_LID }], "dismissed");

    expect(await listUnidentifiedWhatsAppContacts(db, [SHARED_GROUP])).toEqual([]);
  });

  it("matches a contact by phone contact point as well as by lid", async () => {
    await seedGroup(db, SHARED_GROUP, "Shared Group");
    await seedParticipant(db, SHARED_GROUP, null, TARGET_PHONE);
    await seedPlaceholderEntity(db, TARGET_PHONE, [{ kind: "phone", value: TARGET_PHONE }]);

    const items = await listUnidentifiedWhatsAppContacts(db, [SHARED_GROUP]);

    expect(items).toHaveLength(1);
    expect(items[0].phoneE164).toBe(TARGET_PHONE);
  });

  it.each([
    ["wati", `wati:${TARGET_PHONE}`],
    ["bare digits", TARGET_PHONE.replace(/\D/gu, "")],
    ["pn jid", `${TARGET_PHONE.replace(/\D/gu, "")}@s.whatsapp.net`],
  ])("matches a roster row whose phone is only spelled in participant_jid (%s)", async (_label, participantJid) => {
    await seedGroup(db, SHARED_GROUP, "Shared Group");
    await seedRawParticipant(db, SHARED_GROUP, participantJid);
    const entityId = await seedPlaceholderEntity(db, TARGET_PHONE, [{ kind: "phone", value: TARGET_PHONE }]);

    const items = await listUnidentifiedWhatsAppContacts(db, [SHARED_GROUP]);

    expect(items).toHaveLength(1);
    expect(items[0].entityId).toBe(entityId);
  });

  it("attributes a shared phone value to every entity that holds it", async () => {
    await seedGroup(db, SHARED_GROUP, "Shared Group");
    await seedParticipant(db, SHARED_GROUP, null, TARGET_PHONE);
    const first = await seedPlaceholderEntity(db, TARGET_PHONE, [{ kind: "phone", value: TARGET_PHONE }]);
    const second = await seedPlaceholderEntity(db, `${TARGET_PHONE} (dup)`, [{ kind: "phone", value: TARGET_PHONE }]);

    const items = await listUnidentifiedWhatsAppContacts(db, [SHARED_GROUP]);

    expect(items.map((item) => item.entityId).sort()).toEqual([first, second].sort());
  });

  it("keeps a roster-only contact with no messages and no snippet", async () => {
    await seedGroup(db, SHARED_GROUP, "Shared Group");
    await seedParticipant(db, SHARED_GROUP, TARGET_LID, TARGET_PHONE);
    await seedPlaceholderEntity(db, TARGET_PHONE, [{ kind: "whatsapp_lid", value: TARGET_LID }]);

    const items = await listUnidentifiedWhatsAppContacts(db, [SHARED_GROUP]);

    expect(items[0].groups[0].messageCount).toBe(0);
    expect(items[0].groups[0].snippet).toBeNull();
    expect(items[0].groups[0].lastMessageAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("surfaces a pending pushName proposal as the suggestion", async () => {
    await seedGroup(db, SHARED_GROUP, "Shared Group");
    await seedParticipant(db, SHARED_GROUP, TARGET_LID, TARGET_PHONE);
    const entityId = await seedPlaceholderEntity(db, TARGET_PHONE, [{ kind: "whatsapp_lid", value: TARGET_LID }]);
    await db
      .insertInto("entity_name_proposals")
      .values({
        id: randomUUID(),
        entity_id: entityId,
        source: "push_name",
        value: "Tanush Yadav",
        normalized_value: "tanush yadav",
        first_seen_at: "2026-08-01T00:00:00.000Z",
        last_seen_at: "2026-08-01T00:00:00.000Z",
        resolved_by_user_id: null,
        resolved_at: null,
      })
      .execute();

    const items = await listUnidentifiedWhatsAppContacts(db, [SHARED_GROUP]);

    expect(items[0].suggestion).toMatchObject({ name: "Tanush Yadav", confidence: "likely", entityId: null });
  });

  it("honours the limit", async () => {
    await seedGroup(db, SHARED_GROUP, "Shared Group");
    for (let index = 0; index < 3; index += 1) {
      const lid = `9999${index}@lid`;
      await seedParticipant(db, SHARED_GROUP, lid, null);
      await seedPlaceholderEntity(db, lid, [{ kind: "whatsapp_lid", value: lid }]);
    }

    expect(await listUnidentifiedWhatsAppContacts(db, [SHARED_GROUP], { limit: 2 })).toHaveLength(2);
  });
});

describe("dismissWhatsAppIdentity", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insertInto("users").values({ id: "admin", name: "Admin", type: "human" }).execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("marks the entity dismissed and resolves its pending proposals", async () => {
    const entityId = await seedPlaceholderEntity(db, TARGET_PHONE, [{ kind: "whatsapp_lid", value: TARGET_LID }]);
    await db
      .insertInto("entity_name_proposals")
      .values({
        id: randomUUID(),
        entity_id: entityId,
        source: "push_name",
        value: "Someone",
        normalized_value: "someone",
        first_seen_at: "2026-08-01T00:00:00.000Z",
        last_seen_at: "2026-08-01T00:00:00.000Z",
        resolved_by_user_id: null,
        resolved_at: null,
      })
      .execute();

    expect(await dismissWhatsAppIdentity(db, entityId, "admin")).toBe(true);

    const entity = await db
      .selectFrom("entities")
      .select("name_status")
      .where("id", "=", entityId)
      .executeTakeFirstOrThrow();
    const proposal = await db
      .selectFrom("entity_name_proposals")
      .select(["status", "resolved_by_user_id"])
      .where("entity_id", "=", entityId)
      .executeTakeFirstOrThrow();

    expect(entity.name_status).toBe("dismissed");
    expect(proposal.status).toBe("dismissed");
    expect(proposal.resolved_by_user_id).toBe("admin");
  });

  it("refuses to dismiss an entity whose name is already confirmed", async () => {
    const entityId = await seedPlaceholderEntity(
      db,
      "Rahul",
      [{ kind: "whatsapp_lid", value: TARGET_LID }],
      "confirmed",
    );
    expect(await dismissWhatsAppIdentity(db, entityId, "admin")).toBe(false);
  });
});
