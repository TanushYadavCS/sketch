import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../auth/password";
import { createSettingsRepository } from "../../db/repositories/settings";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createApp } from "../../http";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const NOW = "2026-08-01T00:00:00.000Z";

const ADMIN_PHONE = "+919891688787";
const ADMIN_LID = "3878523285582@lid";
const TARGET_LID = "149916051591191@lid";
const ENTITY_ID = "entity-target";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const passwordHash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({ name: "admin", email: ADMIN_EMAIL, emailVerified: true, passwordHash, authRole: "admin" });
  await users.create({ name: "member", email: MEMBER_EMAIL, emailVerified: true, passwordHash, authRole: "member" });
  await settings.update({ onboardingCompletedAt: NOW });
  await db.updateTable("users").set({ whatsapp_number: ADMIN_PHONE }).where("email", "=", ADMIN_EMAIL).execute();
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function seedTargetEntity(db: Kysely<DB>) {
  await db
    .insertInto("entities")
    .values({
      id: ENTITY_ID,
      name: TARGET_LID,
      source_type: "person",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  await db
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: ENTITY_ID,
      kind: "whatsapp_lid",
      value: TARGET_LID,
      source: "whatsapp_identity",
    })
    .execute();
}

async function seedParticipant(db: Kysely<DB>, groupJid: string, lid: string, phone: string | null) {
  await db
    .insertInto("whatsapp_group_participants")
    .values({
      id: randomUUID(),
      group_jid: groupJid,
      observation_key: `phone:${phone ?? "-"}|lid:${lid}`,
      participant_jid: lid,
      phone_e164: phone,
      lid,
      admin_role: null,
    })
    .execute();
}

/**
 * A group containing the target, with one message from them. `adminIsMember`
 * decides whether the calling admin is also on the roster, which is what the
 * participant-scoping gate keys off.
 */
async function seedGroupWithMessage(db: Kysely<DB>, jid: string, name: string, adminIsMember: boolean) {
  await db.insertInto("whatsapp_groups").values({ jid, name, description: null, index_enabled: 1 }).execute();
  await seedParticipant(db, jid, TARGET_LID, null);
  if (adminIsMember) await seedParticipant(db, jid, ADMIN_LID, ADMIN_PHONE);

  const conversation = await db
    .insertInto("conversations")
    .values({ platform: "whatsapp", kind: "group", provider_conversation_id: jid, display_name: name })
    .returning("id")
    .executeTakeFirstOrThrow();

  await db
    .insertInto("conversation_messages")
    .values({
      conversation_id: Number(conversation.id),
      provider_message_id: `pm-${jid}`,
      sender_jid: TARGET_LID,
      sender_name: "Unknown",
      text: `hello from ${name}`,
      is_bot: 0,
      received_at: NOW,
      effective_at: NOW,
    })
    .execute();
}

describe("GET /api/entities/:id/whatsapp-context", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
    await seedTargetEntity(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("denies members", async () => {
    const res = await app.request(`/api/entities/${ENTITY_ID}/whatsapp-context`, {
      headers: { Cookie: memberCookie },
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown entity", async () => {
    const res = await app.request("/api/entities/does-not-exist/whatsapp-context", {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(404);
  });

  it("returns the group and excerpt when the admin is in the group", async () => {
    await seedGroupWithMessage(db, "shared@g.us", "Shared Group", true);

    const res = await app.request(`/api/entities/${ENTITY_ID}/whatsapp-context`, {
      headers: { Cookie: adminCookie },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entityHasWhatsAppIdentity).toBe(true);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].name).toBe("Shared Group");
    expect(body.groups[0].membership).toBe("both");
    expect(body.groups[0].excerpts[0].messages[0]).toMatchObject({
      role: "self",
      text: "hello from Shared Group",
    });
  });

  it("hides a group the admin is not a member of", async () => {
    await seedGroupWithMessage(db, "private@g.us", "Private Group", false);

    const res = await app.request(`/api/entities/${ENTITY_ID}/whatsapp-context`, {
      headers: { Cookie: adminCookie },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.groups).toEqual([]);
    expect(body.totalGroups).toBe(0);
    expect(body.entityHasWhatsAppIdentity).toBe(false);
  });

  /**
   * The existence leak: an admin sharing no group with the target must not be
   * able to tell "this person is on WhatsApp, you just can't see them" apart
   * from "this person has no WhatsApp identity". Both answers are identical.
   */
  it("is indistinguishable from an entity with no WhatsApp identity", async () => {
    await seedGroupWithMessage(db, "private@g.us", "Private Group", false);

    const hidden = await (
      await app.request(`/api/entities/${ENTITY_ID}/whatsapp-context`, { headers: { Cookie: adminCookie } })
    ).json();

    await db.deleteFrom("entity_contact_points").where("entity_id", "=", ENTITY_ID).execute();
    const absent = await (
      await app.request(`/api/entities/${ENTITY_ID}/whatsapp-context`, { headers: { Cookie: adminCookie } })
    ).json();

    expect(hidden).toEqual(absent);
  });

  it("returns only the shared group when the target is in both", async () => {
    await seedGroupWithMessage(db, "shared@g.us", "Shared Group", true);
    await seedGroupWithMessage(db, "private@g.us", "Private Group", false);

    const res = await app.request(`/api/entities/${ENTITY_ID}/whatsapp-context`, {
      headers: { Cookie: adminCookie },
    });
    const body = await res.json();

    expect(body.groups.map((group: { groupJid: string }) => group.groupJid)).toEqual(["shared@g.us"]);
  });

  it("reports when the entity has no WhatsApp identity at all", async () => {
    await db.deleteFrom("entity_contact_points").where("entity_id", "=", ENTITY_ID).execute();

    const res = await app.request(`/api/entities/${ENTITY_ID}/whatsapp-context`, {
      headers: { Cookie: adminCookie },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entityHasWhatsAppIdentity).toBe(false);
    expect(body.groups).toEqual([]);
  });

  it("rejects out-of-range query parameters", async () => {
    const res = await app.request(`/api/entities/${ENTITY_ID}/whatsapp-context?groups=999`, {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-numeric query parameter", async () => {
    const res = await app.request(`/api/entities/${ENTITY_ID}/whatsapp-context?messagesPerGroup=lots`, {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(400);
  });

  it("honours the groups query parameter", async () => {
    await seedGroupWithMessage(db, "one@g.us", "One", true);
    await seedGroupWithMessage(db, "two@g.us", "Two", true);

    const res = await app.request(`/api/entities/${ENTITY_ID}/whatsapp-context?groups=1`, {
      headers: { Cookie: adminCookie },
    });
    const body = await res.json();

    expect(body.groups).toHaveLength(1);
    expect(body.totalGroups).toBe(2);
    expect(body.truncated).toBe(true);
  });
});

describe("WhatsApp identity review queue", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
    await seedTargetEntity(db);
    await db.updateTable("entities").set({ name_status: "placeholder" }).where("id", "=", ENTITY_ID).execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("denies members", async () => {
    const res = await app.request("/api/entities/whatsapp/identities", { headers: { Cookie: memberCookie } });
    expect(res.status).toBe(403);
  });

  it("lists a placeholder contact from a group the admin is in", async () => {
    await seedGroupWithMessage(db, "shared@g.us", "Shared Group", true);

    const res = await app.request("/api/entities/whatsapp/identities", { headers: { Cookie: adminCookie } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].entityId).toBe(ENTITY_ID);
    expect(body.items[0].groups[0].groupName).toBe("Shared Group");
    expect(body.items[0].groups[0].snippet).toBe("hello from Shared Group");
  });

  it("hides a contact the admin shares no group with", async () => {
    await seedGroupWithMessage(db, "private@g.us", "Private Group", false);

    const res = await app.request("/api/entities/whatsapp/identities", { headers: { Cookie: adminCookie } });
    const body = await res.json();

    expect(body.items).toEqual([]);
  });

  it("rejects an out-of-range limit", async () => {
    const res = await app.request("/api/entities/whatsapp/identities?limit=9999", { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(400);
  });

  it("dismisses a contact and drops it from the queue", async () => {
    await seedGroupWithMessage(db, "shared@g.us", "Shared Group", true);

    const dismissed = await app.request(`/api/entities/${ENTITY_ID}/whatsapp-identity/dismissal`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(dismissed.status).toBe(200);

    const res = await app.request("/api/entities/whatsapp/identities", { headers: { Cookie: adminCookie } });
    expect((await res.json()).items).toEqual([]);
  });

  it("refuses to dismiss twice", async () => {
    await seedGroupWithMessage(db, "shared@g.us", "Shared Group", true);
    const path = `/api/entities/${ENTITY_ID}/whatsapp-identity/dismissal`;
    await app.request(path, { method: "POST", headers: { Cookie: adminCookie } });

    const second = await app.request(path, { method: "POST", headers: { Cookie: adminCookie } });
    expect(second.status).toBe(404);
  });

  it("denies dismissal for members", async () => {
    const res = await app.request(`/api/entities/${ENTITY_ID}/whatsapp-identity/dismissal`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    expect(res.status).toBe(403);
  });

  it("denies a member renaming an entity", async () => {
    const res = await app.request(`/api/entities/${ENTITY_ID}`, {
      method: "PATCH",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Tanush Yadav" }),
    });

    expect(res.status).toBe(403);
    const entity = await db
      .selectFrom("entities")
      .select(["name", "name_status"])
      .where("id", "=", ENTITY_ID)
      .executeTakeFirstOrThrow();
    expect(entity.name_status).toBe("placeholder");
  });

  it("naming the placeholder confirms it and drops it from the queue", async () => {
    await seedGroupWithMessage(db, "shared@g.us", "Shared Group", true);

    const renamed = await app.request(`/api/entities/${ENTITY_ID}`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Tanush Yadav" }),
    });
    expect(renamed.status).toBe(200);

    const entity = await db
      .selectFrom("entities")
      .select("name_status")
      .where("id", "=", ENTITY_ID)
      .executeTakeFirstOrThrow();
    expect(entity.name_status).toBe("confirmed");

    const res = await app.request("/api/entities/whatsapp/identities", { headers: { Cookie: adminCookie } });
    expect((await res.json()).items).toEqual([]);
  });
});
