import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository } from "./entities";
import { createUserRepository } from "./users";
import { createWhatsAppGroupRepository } from "./whatsapp-groups";
import { projectWhatsAppRosterPerson } from "./whatsapp-roster-person-projection";

type DbFactory = () => Promise<Kysely<DB>>;

function observationSuite(label: string, createDb: DbFactory) {
  describe(label, () => {
    let db: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    }, 30_000);

    afterEach(async () => {
      await db.destroy();
    });

    it("reconciles complete, partial, complementary, ambiguous, and absent observations", async () => {
      const repo = createWhatsAppGroupRepository(db);
      const seedGroup = async (name: string) => {
        const jid = `${name}-${randomUUID()}@g.us`;
        await repo.upsert({ jid, name, description: null, updated_at: "2026-08-10T00:00:00Z" });
        return jid;
      };

      const exactGroup = await seedGroup("exact");
      await repo.refreshParticipants(
        exactGroup,
        [{ participantJid: "complete-v1@lid", phoneE164: "+14155550100", lid: "exact@lid" }],
        "2026-08-10T01:00:00Z",
      );
      await repo.refreshParticipants(
        exactGroup,
        [{ participantJid: "complete-v2@lid", phoneE164: "+14155550100", lid: "exact@lid" }],
        "2026-08-10T02:00:00Z",
      );
      await repo.refreshParticipants(
        exactGroup,
        [{ participantJid: "partial@lid", lid: "exact@lid" }],
        "2026-08-10T03:00:00Z",
      );
      await repo.refreshParticipants(
        exactGroup,
        [{ participantJid: "partial-retry@lid", lid: "exact@lid" }],
        "2026-08-10T04:00:00Z",
      );
      await expect(repo.listParticipants(exactGroup)).resolves.toEqual([
        expect.objectContaining({
          participant_jid: "partial-retry@lid",
          phone_e164: "+14155550100",
          lid: "exact@lid",
          last_seen_at: "2026-08-10T04:00:00Z",
        }),
      ]);

      const deviceQualifiedGroup = await seedGroup("device-qualified");
      await repo.refreshParticipants(deviceQualifiedGroup, [{ participantJid: "12345:7@lid", lid: "12345:7@lid" }]);
      await expect(repo.listParticipants(deviceQualifiedGroup)).resolves.toEqual([
        expect.objectContaining({ participant_jid: "12345:7@lid", lid: "12345@lid" }),
      ]);

      const mergeGroup = await seedGroup("merge");
      await repo.refreshParticipants(mergeGroup, [
        { participantJid: "phone@s.whatsapp.net", phoneE164: "+14155550200" },
        { participantJid: "lid@lid", lid: "merge@lid" },
      ]);
      await repo.refreshParticipants(mergeGroup, [
        { participantJid: "merged@lid", phoneE164: "+14155550200", lid: "merge@lid" },
      ]);
      await expect(repo.listParticipants(mergeGroup)).resolves.toEqual([
        expect.objectContaining({ phone_e164: "+14155550200", lid: "merge@lid" }),
      ]);

      const ambiguousGroup = await seedGroup("ambiguous");
      await repo.refreshParticipants(ambiguousGroup, [
        { participantJid: "phone@s.whatsapp.net", phoneE164: "+14155550300" },
        { participantJid: "lid@lid", lid: "ambiguous@lid" },
        { participantJid: "other-complete@lid", phoneE164: "+14155550300", lid: "other@lid" },
      ]);
      await repo.refreshParticipants(ambiguousGroup, [
        { participantJid: "incoming@lid", phoneE164: "+14155550300", lid: "ambiguous@lid" },
      ]);
      const ambiguousRows = await repo.listParticipants(ambiguousGroup);
      expect(ambiguousRows).toHaveLength(4);
      expect(ambiguousRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phone_e164: "+14155550300", lid: null }),
          expect.objectContaining({ phone_e164: null, lid: "ambiguous@lid" }),
          expect.objectContaining({ phone_e164: "+14155550300", lid: "ambiguous@lid" }),
          expect.objectContaining({ phone_e164: "+14155550300", lid: "other@lid" }),
        ]),
      );

      const retainedGroup = await seedGroup("retained");
      await repo.refreshParticipants(retainedGroup, [
        { participantJid: "old@lid", phoneE164: "+14155550400", lid: "old@lid" },
      ]);
      await repo.refreshParticipants(retainedGroup, [
        { participantJid: "new@lid", phoneE164: "+14155550400", lid: "new@lid" },
      ]);
      await repo.refreshParticipants(retainedGroup, []);
      await expect(repo.listParticipants(retainedGroup)).resolves.toEqual([
        expect.objectContaining({ phone_e164: "+14155550400", lid: "new@lid" }),
        expect.objectContaining({ phone_e164: "+14155550400", lid: "old@lid" }),
      ]);
    }, 30_000);

    it("projects a complete participant identity to the linked user and entity", async () => {
      const userId = `participant-${randomUUID()}`;
      const phone = "+14155550991";
      await createUserRepository(db).create({ id: userId, name: "Group Participant", whatsappNumber: phone });
      const repo = createWhatsAppGroupRepository(db);
      const groupJid = `projection-${randomUUID()}@g.us`;
      const lid = `${randomUUID()}@lid`;
      await repo.upsert({ jid: groupJid, name: "Projection", description: null, updated_at: "2026-08-10T00:00:00Z" });

      await repo.refreshParticipants(
        groupJid,
        [{ participantJid: lid, phoneE164: phone, lid }],
        "2026-08-10T03:00:00Z",
      );

      const link = await db
        .selectFrom("user_entity_links")
        .select("entity_id")
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      await expect(
        db.selectFrom("user_whatsapp_lids").select("lid").where("user_id", "=", userId).execute(),
      ).resolves.toEqual([{ lid }]);
      await expect(
        db
          .selectFrom("entity_contact_points")
          .select(["kind", "value"])
          .where("entity_id", "=", link.entity_id)
          .where("kind", "in", ["phone", "whatsapp_lid"])
          .orderBy("kind")
          .execute(),
      ).resolves.toEqual([
        { kind: "phone", value: phone },
        { kind: "whatsapp_lid", value: lid },
      ]);
    }, 30_000);

    it("creates a Person for a phone-only participant in an enabled group", async () => {
      const phone = "+14155550992";
      const repo = createWhatsAppGroupRepository(db);
      const groupJid = `phone-only-${randomUUID()}@g.us`;
      await repo.upsert({ jid: groupJid, name: "Phone only", description: null, updated_at: "2026-08-10T00:00:00Z" });
      await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", groupJid).execute();

      await repo.refreshParticipants(
        groupJid,
        [{ participantJid: "14155550992@s.whatsapp.net", phoneE164: phone }],
        "2026-08-10T03:00:00Z",
      );
      await repo.refreshParticipants(
        groupJid,
        [{ participantJid: "14155550992@s.whatsapp.net", phoneE164: phone }],
        "2026-08-10T04:00:00Z",
      );

      const people = await db
        .selectFrom("entities")
        .innerJoin("entity_contact_points", "entity_contact_points.entity_id", "entities.id")
        .select(["entities.name", "entities.subtype", "entity_contact_points.kind", "entity_contact_points.value"])
        .where("entities.source_type", "=", "person")
        .where("entity_contact_points.kind", "=", "phone")
        .where("entity_contact_points.value", "=", phone)
        .execute();
      expect(people).toEqual([{ name: phone, subtype: "external", kind: "phone", value: phone }]);
    }, 30_000);

    it("promotes an observed existing phone without overriding a manual primary", async () => {
      const entities = createEntityRepository(db);
      const person = await entities.upsertEntity({ name: "Primary Person", sourceType: "person" });
      await entities.upsertContactPoint({
        entityId: person.id,
        kind: "phone",
        value: "+14155550801",
        source: "test",
        makePrimary: true,
      });
      await entities.upsertContactPoint({
        entityId: person.id,
        kind: "phone",
        value: "+14155550802",
        source: "test",
      });
      const repo = createWhatsAppGroupRepository(db);
      const groupJid = `primary-${randomUUID()}@g.us`;
      await repo.upsert({ jid: groupJid, name: "Primary", description: null, updated_at: "2026-08-10T00:00:00Z" });
      await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", groupJid).execute();

      await repo.refreshParticipants(groupJid, [
        { participantJid: "14155550802@s.whatsapp.net", phoneE164: "+14155550802" },
      ]);
      await expect(
        db
          .selectFrom("entity_contact_points")
          .select(["value", "is_primary"])
          .where("entity_id", "=", person.id)
          .where("kind", "=", "phone")
          .orderBy("value")
          .execute(),
      ).resolves.toEqual([
        { value: "+14155550801", is_primary: 0 },
        { value: "+14155550802", is_primary: 1 },
      ]);

      await db
        .updateTable("entity_contact_points")
        .set({ is_primary: 0 })
        .where("entity_id", "=", person.id)
        .where("value", "=", "+14155550802")
        .execute();
      await db
        .updateTable("entity_contact_points")
        .set({ source: "manual", is_primary: 1 })
        .where("entity_id", "=", person.id)
        .where("value", "=", "+14155550801")
        .execute();
      await repo.refreshParticipants(groupJid, [
        { participantJid: "14155550802@s.whatsapp.net", phoneE164: "+14155550802" },
      ]);
      await expect(
        db
          .selectFrom("entity_contact_points")
          .select(["value", "is_primary", "source"])
          .where("entity_id", "=", person.id)
          .where("kind", "=", "phone")
          .orderBy("value")
          .execute(),
      ).resolves.toEqual([
        { value: "+14155550801", is_primary: 1, source: "manual" },
        { value: "+14155550802", is_primary: 0, source: "whatsapp_identity" },
      ]);
    }, 30_000);

    it("creates a Person for a LID-only participant in an enabled group", async () => {
      const lid = `lid-only-${randomUUID()}@lid`;
      const repo = createWhatsAppGroupRepository(db);
      const groupJid = `lid-only-${randomUUID()}@g.us`;
      await repo.upsert({ jid: groupJid, name: "LID only", description: null, updated_at: "2026-08-10T00:00:00Z" });

      await repo.refreshParticipants(groupJid, [{ participantJid: lid, lid }], "2026-08-10T03:00:00Z");

      const person = await db
        .selectFrom("entities")
        .innerJoin("entity_contact_points", "entity_contact_points.entity_id", "entities.id")
        .select(["entities.name", "entities.subtype", "entity_contact_points.kind", "entity_contact_points.value"])
        .where("entities.source_type", "=", "person")
        .where("entity_contact_points.kind", "=", "whatsapp_lid")
        .where("entity_contact_points.value", "=", lid)
        .executeTakeFirstOrThrow();
      expect(person).toEqual({ name: lid, subtype: "external", kind: "whatsapp_lid", value: lid });
    }, 30_000);

    it("keeps a WhatsApp placeholder name while accumulating one proposal", async () => {
      const groupJid = `proposal-${randomUUID()}@g.us`;
      const phone = "+919891688787";
      const lid = "3878523285582@lid";
      await createWhatsAppGroupRepository(db).upsert({
        jid: groupJid,
        name: "sketch-whatsapp-test",
        description: null,
        updated_at: "2026-08-13T00:00:00.000Z",
      });

      await projectWhatsAppRosterPerson(db, {
        groupJid,
        phoneE164: phone,
        lid,
        displayName: "Tanush Yadav",
        observedAt: "2026-08-13T06:02:47.000Z",
      });
      await projectWhatsAppRosterPerson(db, {
        groupJid,
        phoneE164: phone,
        lid,
        displayName: "Tanush Yadav",
        observedAt: "2026-08-13T06:03:47.000Z",
      });

      const entity = await db
        .selectFrom("entities")
        .select(["id", "name", "name_status", "aliases"])
        .where("name", "=", phone)
        .executeTakeFirstOrThrow();
      expect(entity).toMatchObject({ name: phone, name_status: "placeholder" });
      expect(JSON.parse(entity.aliases ?? "[]")).toEqual(["Tanush Yadav"]);
      await expect(
        db
          .selectFrom("entity_name_proposals")
          .select(["entity_id", "source", "value", "normalized_value", "observed_count", "status"])
          .where("entity_id", "=", entity.id)
          .execute(),
      ).resolves.toEqual([
        {
          entity_id: entity.id,
          source: "whatsapp_pushname",
          value: "Tanush Yadav",
          normalized_value: "tanush yadav",
          observed_count: 2,
          status: "pending",
        },
      ]);
    }, 30_000);

    it("keeps an existing numeric-name Person confirmed", async () => {
      const groupJid = `confirmed-${randomUUID()}@g.us`;
      const phone = "+919891688788";
      await createWhatsAppGroupRepository(db).upsert({
        jid: groupJid,
        name: "Confirmed",
        description: null,
        updated_at: "2026-08-13T00:00:00.000Z",
      });
      const existing = await createEntityRepository(db).upsertPersonEntity({
        name: phone,
        email: "confirmed@example.com",
        subtype: "external",
        source: "email",
        sourceId: "confirmed@example.com",
      });

      await projectWhatsAppRosterPerson(db, {
        groupJid,
        phoneE164: phone,
        lid: null,
        observedAt: "2026-08-13T06:02:47.000Z",
      });

      await expect(
        db.selectFrom("entities").select("name_status").where("id", "=", existing.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ name_status: "confirmed" });
    }, 30_000);

    it("projects a retained participant after its group becomes enabled", async () => {
      const phone = "+14155550993";
      const repo = createWhatsAppGroupRepository(db);
      const groupJid = `enable-later-${randomUUID()}@g.us`;
      await repo.upsert({ jid: groupJid, name: "Enable later", description: null, updated_at: "2026-08-10T00:00:00Z" });
      await db.updateTable("whatsapp_groups").set({ index_enabled: 0 }).where("jid", "=", groupJid).execute();

      await repo.refreshParticipants(
        groupJid,
        [{ participantJid: "14155550993@s.whatsapp.net", phoneE164: phone }],
        "2026-08-10T03:00:00Z",
      );
      await expect(
        db
          .selectFrom("entity_contact_points")
          .select("id")
          .where("kind", "=", "phone")
          .where("value", "=", phone)
          .execute(),
      ).resolves.toEqual([]);

      await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", groupJid).execute();
      await repo.refreshParticipants(
        groupJid,
        [{ participantJid: "14155550993@s.whatsapp.net", phoneE164: phone }],
        "2026-08-10T04:00:00Z",
      );

      await expect(
        db
          .selectFrom("entity_contact_points")
          .select(["kind", "value"])
          .where("kind", "=", "phone")
          .where("value", "=", phone)
          .execute(),
      ).resolves.toEqual([{ kind: "phone", value: phone }]);
    }, 30_000);

    it("converges a phone-only observation when the complete identity arrives", async () => {
      const phone = "+14155550994";
      const lid = `converge-${randomUUID()}@lid`;
      const repo = createWhatsAppGroupRepository(db);
      const groupJid = `converge-${randomUUID()}@g.us`;
      await repo.upsert({ jid: groupJid, name: "Converge", description: null, updated_at: "2026-08-10T00:00:00Z" });

      await repo.refreshParticipants(
        groupJid,
        [{ participantJid: "14155550994@s.whatsapp.net", phoneE164: phone }],
        "2026-08-10T03:00:00Z",
      );
      await repo.refreshParticipants(
        groupJid,
        [{ participantJid: lid, phoneE164: phone, lid }],
        "2026-08-10T04:00:00Z",
      );

      const contactPoints = await db
        .selectFrom("entity_contact_points")
        .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
        .select(["entities.id", "entity_contact_points.kind", "entity_contact_points.value"])
        .where("entities.source_type", "=", "person")
        .where((eb) =>
          eb.or([eb("entity_contact_points.value", "=", phone), eb("entity_contact_points.value", "=", lid)]),
        )
        .orderBy("entity_contact_points.kind")
        .execute();
      expect(new Set(contactPoints.map((row) => row.id)).size).toBe(1);
      expect(contactPoints.map(({ kind, value }) => ({ kind, value }))).toEqual([
        { kind: "phone", value: phone },
        { kind: "whatsapp_lid", value: lid },
      ]);
    }, 30_000);

    it("does not cross-link a phone and LID that already belong to different Persons", async () => {
      const phone = "+14155550995";
      const lid = `conflict-${randomUUID()}@lid`;
      const entities = createEntityRepository(db);
      const phonePerson = await entities.upsertPersonEntity({
        name: "Phone Person",
        subtype: "external",
        source: "test",
        sourceId: `phone-person-${randomUUID()}`,
        provenanceTier: "inferred",
      });
      const lidPerson = await entities.upsertPersonEntity({
        name: "LID Person",
        subtype: "external",
        source: "test",
        sourceId: `lid-person-${randomUUID()}`,
        provenanceTier: "inferred",
      });
      await entities.upsertContactPoint({ entityId: phonePerson.id, kind: "phone", value: phone, source: "test" });
      await entities.upsertContactPoint({
        entityId: lidPerson.id,
        kind: "whatsapp_lid",
        value: lid,
        source: "test",
      });
      const groups = createWhatsAppGroupRepository(db);
      const groupJid = `conflict-${randomUUID()}@g.us`;
      await groups.upsert({ jid: groupJid, name: "Conflict", description: null, updated_at: "2026-08-10T00:00:00Z" });

      await groups.refreshParticipants(groupJid, [{ participantJid: lid, phoneE164: phone, lid }]);

      const contacts = await db
        .selectFrom("entity_contact_points")
        .select(["entity_id", "kind", "value"])
        .where("entity_id", "in", [phonePerson.id, lidPerson.id])
        .orderBy("kind")
        .execute();
      expect(contacts).toEqual([
        { entity_id: phonePerson.id, kind: "phone", value: phone },
        { entity_id: lidPerson.id, kind: "whatsapp_lid", value: lid },
      ]);
    }, 30_000);
  });
}

observationSuite("WhatsApp group observations on SQLite", createTestDb);
observationSuite("WhatsApp group observations on Postgres", createTestPgDb);
