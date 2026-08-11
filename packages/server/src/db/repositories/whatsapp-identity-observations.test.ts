import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createUserWhatsAppLidRepository } from "./user-whatsapp-lids";
import { createUserRepository } from "./users";
import { createWhatsAppGroupRepository } from "./whatsapp-groups";

describe("WhatsApp identity observations", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function group() {
    const repo = createWhatsAppGroupRepository(db);
    await repo.upsert({
      jid: "identity@g.us",
      name: "Identity",
      description: null,
      updated_at: "2026-08-10T00:00:00Z",
    });
    return repo;
  }

  it("merges one complementary partial pair and keeps unrelated complete combinations", async () => {
    const repo = await group();
    await repo.refreshParticipants("identity@g.us", [
      { participantJid: "phone@s.whatsapp.net", phoneE164: "+14155550100" },
      { participantJid: "lid@lid", lid: "lid-a@lid" },
    ]);
    await repo.refreshParticipants("identity@g.us", [
      { participantJid: "current@lid", phoneE164: "+14155550100", lid: "lid-a@lid" },
    ]);
    await repo.refreshParticipants("identity@g.us", [
      { participantJid: "old@lid", phoneE164: "+14155550100", lid: "lid-old@lid" },
    ]);

    const rows = await repo.listParticipants("identity@g.us");
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phone_e164: "+14155550100", lid: "lid-a@lid" }),
        expect.objectContaining({ phone_e164: "+14155550100", lid: "lid-old@lid" }),
      ]),
    );
  });

  it("preserves known identifiers on partial refresh and never deletes absent observations", async () => {
    const repo = await group();
    await repo.refreshParticipants("identity@g.us", [
      { participantJid: "complete@lid", phoneE164: "+14155550100", lid: "lid-a@lid" },
      { participantJid: "absent@lid", phoneE164: "+14155550200", lid: "lid-b@lid" },
    ]);
    await repo.refreshParticipants("identity@g.us", [{ participantJid: "lid-a@lid", lid: "lid-a@lid" }]);

    const rows = await repo.listParticipants("identity@g.us");
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phone_e164: "+14155550100", lid: "lid-a@lid" }),
        expect.objectContaining({ phone_e164: "+14155550200", lid: "lid-b@lid" }),
      ]),
    );
  });

  it("appends aliases, refreshes sightings, rejects conflicts, and guards stale phones", async () => {
    const users = createUserRepository(db);
    await users.create({ id: "one", name: "One", whatsappNumber: "+14155550100" });
    await users.create({ id: "two", name: "Two", whatsappNumber: "+14155550200" });
    const lids = createUserWhatsAppLidRepository(db);

    await expect(lids.attachIfPhoneUnchanged("one", "+14155550100", "LID-A@LID", "2026-08-10T01:00:00Z")).resolves.toBe(
      "attached",
    );
    await expect(lids.attachIfPhoneUnchanged("one", "+14155550100", "lid-a@lid", "2026-08-10T02:00:00Z")).resolves.toBe(
      "already-owned",
    );
    await expect(lids.attachIfPhoneUnchanged("two", "+14155550200", "lid-a@lid", "2026-08-10T03:00:00Z")).resolves.toBe(
      "ownership-conflict",
    );
    await expect(lids.attachIfPhoneUnchanged("one", "+14155550999", "lid-b@lid", "2026-08-10T03:00:00Z")).resolves.toBe(
      "stale-phone",
    );

    await expect(lids.listForUser("one")).resolves.toEqual([
      expect.objectContaining({ lid: "lid-a@lid", last_seen_at: "2026-08-10T02:00:00Z" }),
    ]);
  });

  it("projects the current phone and every retained LID onto the linked person", async () => {
    await createUserRepository(db).create({ id: "projected", name: "Projected", whatsappNumber: "+14155550400" });
    const lids = createUserWhatsAppLidRepository(db);

    await lids.attachIfPhoneUnchanged("projected", "+14155550400", "older@lid", "2026-08-10T01:00:00Z");
    await lids.attachIfPhoneUnchanged("projected", "+14155550400", "latest@lid", "2026-08-10T02:00:00Z");

    const link = await db
      .selectFrom("user_entity_links")
      .select("entity_id")
      .where("user_id", "=", "projected")
      .executeTakeFirstOrThrow();
    await expect(
      db
        .selectFrom("entity_contact_points")
        .select(["kind", "value", "is_primary", "verified_at"])
        .where("entity_id", "=", link.entity_id)
        .where("kind", "in", ["phone", "whatsapp_lid"])
        .orderBy("kind")
        .orderBy("value")
        .execute(),
    ).resolves.toEqual([
      { kind: "phone", value: "+14155550400", is_primary: 1, verified_at: null },
      { kind: "whatsapp_lid", value: "latest@lid", is_primary: 1, verified_at: null },
      { kind: "whatsapp_lid", value: "older@lid", is_primary: 0, verified_at: null },
    ]);
  });

  it("projects a complete group phone and LID observation onto its linked user entity", async () => {
    const users = createUserRepository(db);
    await users.create({ id: "group-projected", name: "Group Projected", whatsappNumber: "+14155550410" });
    const repo = await group();

    await repo.refreshParticipants(
      "identity@g.us",
      [{ participantJid: "group-projected@lid", phoneE164: "+14155550410", lid: "group-projected@lid" }],
      "2026-08-10T03:00:00Z",
    );

    await expect(createUserWhatsAppLidRepository(db).listForUser("group-projected")).resolves.toEqual([
      expect.objectContaining({ lid: "group-projected@lid", last_seen_at: "2026-08-10T03:00:00Z" }),
    ]);
    const link = await db
      .selectFrom("user_entity_links")
      .select("entity_id")
      .where("user_id", "=", "group-projected")
      .executeTakeFirstOrThrow();
    await expect(
      db
        .selectFrom("entity_contact_points")
        .select(["kind", "value"])
        .where("entity_id", "=", link.entity_id)
        .where("kind", "in", ["phone", "whatsapp_lid"])
        .orderBy("kind")
        .execute(),
    ).resolves.toEqual([
      { kind: "phone", value: "+14155550410" },
      { kind: "whatsapp_lid", value: "group-projected@lid" },
    ]);
  });

  it("does not project a delayed older LID observation from another group over a fresher phone identity", async () => {
    await createUserRepository(db).create({
      id: "stale-group-projection",
      name: "Stale Group Projection",
      whatsappNumber: "+14155550411",
    });
    const repo = await group();

    await repo.refreshParticipants(
      "identity@g.us",
      [{ participantJid: "current@lid", phoneE164: "+14155550411", lid: "current@lid" }],
      "2026-08-10T04:00:00Z",
    );
    await repo.upsert({
      jid: "identity-other@g.us",
      name: "Identity Other",
      description: null,
      updated_at: "2026-08-10T00:00:00Z",
    });
    await repo.refreshParticipants(
      "identity-other@g.us",
      [{ participantJid: "delayed@lid", phoneE164: "+14155550411", lid: "delayed@lid" }],
      "2026-08-10T03:00:00Z",
    );

    await expect(createUserWhatsAppLidRepository(db).listForUser("stale-group-projection")).resolves.toEqual([
      expect.objectContaining({ lid: "current@lid", last_seen_at: "2026-08-10T04:00:00Z" }),
    ]);
  });

  it("does not refresh another user's LID when group propagation finds an ownership conflict", async () => {
    const users = createUserRepository(db);
    await users.create({ id: "group-phone-owner", name: "Phone Owner", whatsappNumber: "+14155550412" });
    await users.create({
      id: "unlinked-lid-owner",
      name: "LID Owner",
      whatsappNumber: "+14155550413",
      skipEntityLinking: true,
    });
    const lids = createUserWhatsAppLidRepository(db);
    await lids.attachIfPhoneUnchanged("unlinked-lid-owner", "+14155550413", "owned@lid", "2026-08-10T01:00:00Z");
    const repo = await group();

    await repo.refreshParticipants(
      "identity@g.us",
      [{ participantJid: "owned@lid", phoneE164: "+14155550412", lid: "owned@lid" }],
      "2026-08-10T05:00:00Z",
    );

    await expect(lids.listForUser("unlinked-lid-owner")).resolves.toEqual([
      expect.objectContaining({ lid: "owned@lid", last_seen_at: "2026-08-10T01:00:00Z" }),
    ]);
    await expect(lids.listForUser("group-phone-owner")).resolves.toEqual([]);
  });

  it("does not regress aliases, legacy latest identity, or refresh timestamps", async () => {
    await createUserRepository(db).create({ id: "monotonic", name: "Monotonic", whatsappNumber: "+14155550300" });
    const lids = createUserWhatsAppLidRepository(db);
    await lids.attachIfPhoneUnchanged("monotonic", "+14155550300", "new@lid", "2026-08-10T05:00:00Z");
    await lids.attachIfPhoneUnchanged("monotonic", "+14155550300", "old@lid", "2026-08-10T04:00:00Z");
    await lids.attachIfPhoneUnchanged("monotonic", "+14155550300", "new@lid", "2026-08-10T03:00:00Z");
    await lids.markAttempt("monotonic", "+14155550300", "2026-08-10T06:00:00Z", true);
    await lids.markAttempt("monotonic", "+14155550300", "2026-08-10T02:00:00Z", true);

    await expect(lids.listForUser("monotonic")).resolves.toEqual([
      expect.objectContaining({ lid: "old@lid", last_seen_at: "2026-08-10T04:00:00Z" }),
      expect.objectContaining({ lid: "new@lid", last_seen_at: "2026-08-10T05:00:00Z" }),
    ]);
    await expect(
      db
        .selectFrom("users")
        .select(["whatsapp_lid", "whatsapp_lid_attempted_at", "whatsapp_lid_checked_at"])
        .where("id", "=", "monotonic")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      whatsapp_lid: "new@lid",
      whatsapp_lid_attempted_at: "2026-08-10T06:00:00Z",
      whatsapp_lid_checked_at: "2026-08-10T06:00:00Z",
    });
  });

  it("orders due refreshes portably with null checks first, then check and attempt age", async () => {
    const users = createUserRepository(db);
    for (const [index, id] of ["never", "old-check", "new-check"].entries()) {
      await users.create({ id, name: id, whatsappNumber: `+1415555010${index}` });
    }
    await db
      .updateTable("users")
      .set({ whatsapp_lid_attempted_at: "2026-08-01T00:00:00Z" })
      .where("id", "=", "old-check")
      .execute();
    await db
      .updateTable("users")
      .set({
        whatsapp_lid_attempted_at: "2026-08-02T00:00:00Z",
        whatsapp_lid_checked_at: "2026-07-01T00:00:00Z",
      })
      .where("id", "=", "new-check")
      .execute();

    const due = await createUserWhatsAppLidRepository(db).listDue("2026-08-03T00:00:00Z", 10);
    expect(due.map((row) => row.id)).toEqual(["never", "old-check", "new-check"]);
  });
});
