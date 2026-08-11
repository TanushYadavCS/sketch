import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNoRawWhatsAppIdentifiers,
  renderWhatsAppRosterBlock,
  renderWhatsAppTranscript,
} from "../connectors/whatsapp-salience";
import { createConversationRepository } from "../db/repositories/conversations";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import {
  buildWhatsAppRosterSnapshot,
  captureWhatsAppLidForPhone,
  createWhatsAppIdentityResolutionService,
  normalizeWhatsAppIdentityLid,
} from "./identity-resolution";

const RAW_PRIVATE_IDENTIFIER_PATTERN =
  /(?:[^\s"'<>()[\]{}]+@(?:s\.whatsapp\.net|lid)\b|(?:\+|00)?(?=(?:[\d\s().-]*\d){7})[1-9][\d\s().-]*\d)/iu;

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

async function seedUser(id: string, name: string, whatsappNumber?: string | null): Promise<void> {
  await createUserRepository(db).create({
    id,
    name,
    email: `${id}@example.com`,
    whatsappNumber: whatsappNumber ?? undefined,
  });
}

async function seedLabeler(): Promise<void> {
  await seedUser("labeler", "Labeler");
}

async function seedGroup(groupJid = "120363000000001@g.us") {
  const repo = createWhatsAppGroupRepository(db);
  await repo.upsert({
    jid: groupJid,
    name: "Deal Room",
    description: null,
    updated_at: "2026-07-07T09:00:00.000Z",
  });
  return repo;
}

async function seedEntity(args: { id: string; name: string; sourceType?: string }): Promise<void> {
  const now = "2026-07-07T09:00:00.000Z";
  await db
    .insertInto("entities")
    .values({
      id: args.id,
      name: args.name,
      source_type: args.sourceType ?? "person",
      subtype: args.sourceType === "company" ? null : "external",
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
}

async function seedContactPoint(entityId: string, value: string, kind: "phone" | "whatsapp" = "phone"): Promise<void> {
  await db
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      kind,
      value,
      source: "test",
    })
    .execute();
}

function expectNoRawPrivateIdentifiers(serializedSnapshot: string): void {
  expect(serializedSnapshot).not.toMatch(RAW_PRIVATE_IDENTIFIER_PATTERN);
}

describe("WhatsApp identity resolution", () => {
  it("resolves a roster teammate through a non-legacy LID alias", async () => {
    await seedUser("alias-teammate", "Alias Teammate", null);
    await db.updateTable("users").set({ whatsapp_lid: "old-alias@lid" }).where("id", "=", "alias-teammate").execute();
    await db
      .insertInto("user_whatsapp_lids")
      .values({
        user_id: "alias-teammate",
        lid: "new-alias@lid",
        first_seen_at: "2026-07-07T09:00:00.000Z",
        last_seen_at: "2026-07-07T09:00:00.000Z",
      })
      .execute();

    const result = await createWhatsAppIdentityResolutionService(db).resolveRoster("group@g.us", [
      { participantJid: "new-alias@lid", phoneE164: null, lid: "new-alias@lid" },
    ]);

    expect(result.get("new-alias@lid")).toEqual({
      kind: "teammate",
      userId: "alias-teammate",
      name: "Alias Teammate",
    });
  });
  it("normalizes LIDs by removing device suffixes", () => {
    expect(normalizeWhatsAppIdentityLid("12345:7@lid")).toBe("12345@lid");
    expect(normalizeWhatsAppIdentityLid("12345@LID")).toBe("12345@lid");
  });

  it("appends LID aliases, dual-writes the latest legacy value, and skips ownership conflicts", async () => {
    await seedUser("lid-owner", "LID Owner", "+15550000011");
    await seedUser("lid-other", "Other", "+15550000012");
    const warn = vi.fn();

    await captureWhatsAppLidForPhone(db, "+1 (555) 000-0011", "12345:7@lid", { warn });
    await captureWhatsAppLidForPhone(db, "+15550000011", "67890@lid", { warn });
    expect(warn).not.toHaveBeenCalled();
    await expect(
      db.selectFrom("users").select("whatsapp_lid").where("id", "=", "lid-owner").executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      whatsapp_lid: "67890@lid",
    });
    await expect(
      db.selectFrom("user_whatsapp_lids").select("lid").where("user_id", "=", "lid-owner").orderBy("lid").execute(),
    ).resolves.toEqual([{ lid: "12345@lid" }, { lid: "67890@lid" }]);

    await captureWhatsAppLidForPhone(db, "+15550000012", "12345@lid", { warn });
    await expect(
      db.selectFrom("users").select("whatsapp_lid").where("id", "=", "lid-other").executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      whatsapp_lid: null,
    });
    expect(warn).toHaveBeenCalledWith(
      { operation: "capture_whatsapp_lid", result: "ownership-conflict" },
      "Skipped conflicting WhatsApp LID capture",
    );
    await expect(
      db.selectFrom("user_whatsapp_lids").select("lid").where("user_id", "=", "lid-other").execute(),
    ).resolves.toEqual([]);
  });

  it("treats a concurrent LID capture race as a benign conflict", async () => {
    await seedUser("lid-race-a", "Race A", "+15550000021");
    await seedUser("lid-race-b", "Race B", "+15550000022");
    const warn = vi.fn();

    await expect(
      Promise.all([
        captureWhatsAppLidForPhone(db, "+15550000021", "race@lid", { warn }),
        captureWhatsAppLidForPhone(db, "+15550000022", "race@lid", { warn }),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    const owners = await db
      .selectFrom("user_whatsapp_lids")
      .select(["user_id", "lid"])
      .where("lid", "=", "race@lid")
      .execute();
    expect(owners).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.any(Object), "Skipped conflicting WhatsApp LID capture");
  });

  it("resolves rungs in teammate, entity, label, unresolved order", async () => {
    const groupJid = "120363000000001@g.us";
    const groups = await seedGroup(groupJid);
    await seedLabeler();
    await seedUser("teammate", "Tara Teammate", "+15550000001");
    await seedEntity({ id: "entity-teammate-shadow", name: "CRM Tara" });
    await seedContactPoint("entity-teammate-shadow", "+15550000001");
    await groups.upsertMemberLabel({
      groupJid,
      phoneE164: "+15550000001",
      displayName: "Label Tara",
      companyName: "Label Co",
      createdBy: "labeler",
    });

    await seedEntity({ id: "entity-contact", name: "Esha Entity" });
    await seedContactPoint("entity-contact", "+15550000002");
    await groups.upsertMemberLabel({
      groupJid,
      phoneE164: "+15550000002",
      displayName: "Label Esha",
      companyName: "Label Co",
      createdBy: "labeler",
    });

    await groups.upsertMemberLabel({
      groupJid,
      phoneE164: "+15550000003",
      displayName: "Lina Label",
      companyName: "Acme",
      createdBy: "labeler",
    });

    const resolver = createWhatsAppIdentityResolutionService(db);

    await expect(resolver.resolve("+15550000001", groupJid)).resolves.toMatchObject({
      kind: "teammate",
      userId: "teammate",
      name: "Tara Teammate",
    });
    await expect(resolver.resolve("+15550000002", groupJid)).resolves.toMatchObject({
      kind: "entity",
      entityId: "entity-contact",
      name: "Esha Entity",
    });
    await expect(resolver.resolve("+15550000003", groupJid)).resolves.toEqual({
      kind: "labeled",
      name: "Lina Label",
      company: "Acme",
    });
    await expect(resolver.resolve("+15550000004", groupJid)).resolves.toEqual({ kind: "unresolved" });
  });

  it("matches CRM contact points after normalizing E.164-like formatting on both sides", async () => {
    const groupJid = "120363000000002@g.us";
    await seedGroup(groupJid);
    await seedEntity({ id: "entity-formatted", name: "Formatted Buyer" });
    await seedContactPoint("entity-formatted", "+1 (555) 111-2222", "whatsapp");

    const resolver = createWhatsAppIdentityResolutionService(db);

    await expect(resolver.resolve("+15551112222", groupJid)).resolves.toMatchObject({
      kind: "entity",
      entityId: "entity-formatted",
      name: "Formatted Buyer",
    });
  });

  it("falls through to unresolved when no rung matches", async () => {
    const groupJid = "120363000000003@g.us";
    await seedGroup(groupJid);

    await expect(createWhatsAppIdentityResolutionService(db).resolve("+15559999999", groupJid)).resolves.toEqual({
      kind: "unresolved",
    });
  });
});

describe("WhatsApp roster snapshot", () => {
  it("serializes display context without raw phone numbers or phone JIDs", async () => {
    const groupJid = "120363000000004@g.us";
    const groups = await seedGroup(groupJid);
    await seedUser("teammate-roster", "Tina Teammate", "+15551234567");
    await seedLabeler();
    await groups.upsertMemberLabel({
      groupJid,
      phoneE164: "+15557654321",
      displayName: "Labeled Buyer",
      companyName: "Buyer Co",
      createdBy: "labeler",
    });
    await groups.refreshParticipants(groupJid, [
      { participantJid: "15551234567@s.whatsapp.net", phoneE164: "+15551234567", adminRole: "admin" },
      { participantJid: "15557654321@s.whatsapp.net", phoneE164: "+15557654321", adminRole: null },
      { participantJid: "15559876543@s.whatsapp.net", phoneE164: "+15559876543", adminRole: null },
    ]);

    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: "m1",
      senderJid: "15557654321@s.whatsapp.net",
      senderName: "Push Buyer",
      text: "hello",
      receivedAt: "2026-07-07T09:00:00.000Z",
    });

    const logger = { info: vi.fn() } as unknown as Logger;
    const result = await buildWhatsAppRosterSnapshot({ db, groupJid, conversationId: conversation.id, logger });

    expectNoRawPrivateIdentifiers(result.serializedSnapshot);
    expect(result.snapshot.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: "Tina Teammate",
          resolutionKind: "teammate",
          adminRole: "admin",
        }),
        expect.objectContaining({
          displayName: "Labeled Buyer (Buyer Co)",
          resolutionKind: "labeled",
          pushName: "Push Buyer",
        }),
        expect.objectContaining({
          displayName: "External (**43)",
          resolutionKind: "unresolved",
        }),
      ]),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.id,
        totalParticipants: 3,
        teammate: 1,
        labeled: 1,
        unresolved: 1,
      }),
      "whatsapp_roster_resolution_rate",
    );
  });

  it("sanitizes labeled display names before serializing roster snapshots", async () => {
    const groupJid = "120363000000005@g.us";
    const groups = await seedGroup(groupJid);
    await seedLabeler();
    await groups.upsertMemberLabel({
      groupJid,
      phoneE164: "+919876543210",
      displayName: "Rahul +91 98765 43210",
      companyName: null,
      createdBy: "labeler",
    });
    await groups.refreshParticipants(groupJid, [
      { participantJid: "919876543210@s.whatsapp.net", phoneE164: "+919876543210", adminRole: null },
    ]);
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const logger = { info: vi.fn() } as unknown as Logger;

    const result = await buildWhatsAppRosterSnapshot({ db, groupJid, conversationId: conversation.id, logger });

    expectNoRawPrivateIdentifiers(result.serializedSnapshot);
    expect(result.snapshot.participants).toEqual([
      expect.objectContaining({
        displayName: "Rahul +**********10",
        resolutionKind: "labeled",
      }),
    ]);
  });

  it("uses sanitized push names for unresolved participant display names in roster snapshots and transcripts", async () => {
    const groupJid = "120363000000006@g.us";
    const groups = await seedGroup(groupJid);
    await groups.refreshParticipants(groupJid, [
      { participantJid: "15550000601@s.whatsapp.net", phoneE164: "+15550000601", adminRole: null },
    ]);
    const conversations = createConversationRepository(db);
    const conversation = await conversations.getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const message = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "push-name-unresolved",
      senderJid: "15550000601@s.whatsapp.net",
      senderName: "Ravi Vendor",
      text: "I can send the invoice today.",
      receivedAt: "2026-07-07T09:00:00.000Z",
    });
    const logger = { info: vi.fn() } as unknown as Logger;

    const result = await buildWhatsAppRosterSnapshot({ db, groupJid, conversationId: conversation.id, logger });
    const transcript = renderWhatsAppTranscript(result.snapshot, [
      {
        id: message.row.id,
        senderJid: "15550000601@s.whatsapp.net",
        senderName: "Ravi Vendor",
        text: message.row.text,
      },
    ]);

    expect(result.snapshot.participants).toEqual([
      expect.objectContaining({
        displayName: "Ravi Vendor",
        resolutionKind: "unresolved",
        pushName: "Ravi Vendor",
      }),
    ]);
    expect(result.serializedSnapshot).toContain("Ravi Vendor");
    expect(result.serializedSnapshot).not.toContain("External (**01)");
    expect(transcript).toContain("Ravi Vendor: I can send the invoice today.");
    expect(transcript).not.toContain("External (**01): I can send the invoice today.");
  });

  it("keeps resolved teammate names ahead of push names in roster snapshots and transcripts", async () => {
    const groupJid = "120363000000007@g.us";
    const groups = await seedGroup(groupJid);
    await seedUser("push-shadowed-teammate", "Tara Teammate", "+15550000701");
    await groups.refreshParticipants(groupJid, [
      { participantJid: "15550000701@s.whatsapp.net", phoneE164: "+15550000701", adminRole: null },
    ]);
    const conversations = createConversationRepository(db);
    const conversation = await conversations.getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const message = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "push-name-teammate",
      senderJid: "15550000701@s.whatsapp.net",
      senderName: "Push Alias",
      text: "I reviewed the proposal.",
      receivedAt: "2026-07-07T09:00:00.000Z",
    });
    const logger = { info: vi.fn() } as unknown as Logger;

    const result = await buildWhatsAppRosterSnapshot({ db, groupJid, conversationId: conversation.id, logger });
    const transcript = renderWhatsAppTranscript(result.snapshot, [
      {
        id: message.row.id,
        senderJid: "15550000701@s.whatsapp.net",
        senderName: "Push Alias",
        text: message.row.text,
      },
    ]);

    expect(result.snapshot.participants).toEqual([
      expect.objectContaining({
        displayName: "Tara Teammate",
        resolutionKind: "teammate",
        pushName: "Push Alias",
      }),
    ]);
    expect(transcript).toContain("Tara Teammate: I reviewed the proposal.");
    expect(transcript).not.toContain("Push Alias: I reviewed the proposal.");
  });

  it("masks phone-like digit runs in unresolved push names before roster and transcript rendering", async () => {
    const groupJid = "120363000000008@g.us";
    const groups = await seedGroup(groupJid);
    await groups.refreshParticipants(groupJid, [
      { participantJid: "15550000801@s.whatsapp.net", phoneE164: "+15550000801", adminRole: null },
    ]);
    const conversations = createConversationRepository(db);
    const conversation = await conversations.getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const message = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "push-name-private",
      senderJid: "15550000801@s.whatsapp.net",
      senderName: "Ravi +91 99804 70200",
      text: "Please mark this done.",
      receivedAt: "2026-07-07T09:00:00.000Z",
    });
    const logger = { info: vi.fn() } as unknown as Logger;

    const result = await buildWhatsAppRosterSnapshot({ db, groupJid, conversationId: conversation.id, logger });
    const rosterBlock = renderWhatsAppRosterBlock(result.snapshot);
    const transcript = renderWhatsAppTranscript(result.snapshot, [
      {
        id: message.row.id,
        senderJid: "15550000801@s.whatsapp.net",
        senderName: "Ravi +91 99804 70200",
        text: message.row.text,
      },
    ]);

    expect(result.snapshot.participants).toEqual([
      expect.objectContaining({
        displayName: "Ravi +**********00",
        resolutionKind: "unresolved",
        pushName: "Ravi +**********00",
      }),
    ]);
    expect(rosterBlock).toContain("Ravi +**********00");
    expect(transcript).toContain("Ravi +**********00: Please mark this done.");
    expect(`${rosterBlock}\n${transcript}`).not.toContain("99804 70200");
    assertNoRawWhatsAppIdentifiers(`${rosterBlock}\n${transcript}`);
  });
});
