import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createTestDb, createTestPgDb } from "../test-utils";
import { collectWhatsAppGroupParticipants, toParticipantInputs } from "./group-participants";
import { createWhatsAppIdentityResolutionService } from "./identity-resolution";

type DbFactory = () => Promise<Kysely<DB>>;

function runIdentityIntegrationSuite(label: string, createDb: DbFactory) {
  describe(label, () => {
    let db: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    async function seedGroup(groupJid = `${randomUUID()}@g.us`) {
      const repo = createWhatsAppGroupRepository(db);
      await repo.upsert({
        jid: groupJid,
        name: "Integration Group",
        description: null,
        updated_at: "2026-07-07T09:00:00.000Z",
      });
      return { groupJid, repo };
    }

    async function seedUser(id: string): Promise<void> {
      await createUserRepository(db).create({
        id,
        name: id,
        email: `${id}@example.com`,
      });
    }

    async function seedEntity(id: string, name: string): Promise<void> {
      const now = "2026-07-07T09:00:00.000Z";
      await db
        .insertInto("entities")
        .values({
          id,
          name,
          source_type: "person",
          subtype: "external",
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

    it("resolves CRM entity contact points through normalized phone and whatsapp values", async () => {
      const { groupJid } = await seedGroup();
      await seedEntity("entity-crm-phone", "CRM Phone Contact");
      await seedEntity("entity-crm-whatsapp", "CRM WhatsApp Contact");
      await db
        .insertInto("entity_contact_points")
        .values([
          {
            id: randomUUID(),
            entity_id: "entity-crm-phone",
            kind: "phone",
            value: "+1 555 200 0001",
            source: "test",
          },
          {
            id: randomUUID(),
            entity_id: "entity-crm-whatsapp",
            kind: "whatsapp",
            value: "+1 (555) 200-0002",
            source: "test",
          },
        ])
        .execute();

      const resolver = createWhatsAppIdentityResolutionService(db);

      await expect(resolver.resolve("+15552000001", groupJid)).resolves.toMatchObject({
        kind: "entity",
        entityId: "entity-crm-phone",
      });
      await expect(resolver.resolve("+15552000002", groupJid)).resolves.toMatchObject({
        kind: "entity",
        entityId: "entity-crm-whatsapp",
      });
    });

    it("resolves manual member labels after CRUD upserts", async () => {
      const { groupJid, repo } = await seedGroup();
      await seedUser("labeler-integration");

      await repo.upsertMemberLabel({
        groupJid,
        phoneE164: "+15553000001",
        displayName: "Initial Label",
        companyName: null,
        createdBy: "labeler-integration",
      });
      await repo.upsertMemberLabel({
        groupJid,
        phoneE164: "+1 (555) 300-0001",
        displayName: "Updated Label",
        companyName: "Label Co",
        createdBy: "labeler-integration",
      });

      await expect(createWhatsAppIdentityResolutionService(db).resolve("+15553000001", groupJid)).resolves.toEqual({
        kind: "labeled",
        name: "Updated Label",
        company: "Label Co",
      });

      await expect(repo.deleteMemberLabel(groupJid, "+1 (555) 300-0001")).resolves.toBe(true);
      await expect(createWhatsAppIdentityResolutionService(db).resolve("+15553000001", groupJid)).resolves.toEqual({
        kind: "unresolved",
      });
    });

    it("refreshes group participants by inserting, updating, bumping last_seen_at, and pruning stale rows", async () => {
      const { groupJid, repo } = await seedGroup();

      const first = await repo.refreshParticipants(
        groupJid,
        [
          { participantJid: "15554000001@s.whatsapp.net", phoneE164: "+15554000001", adminRole: null },
          { participantJid: "15554000002@s.whatsapp.net", phoneE164: "+15554000002", adminRole: "admin" },
        ],
        "2026-07-07T09:00:00.000Z",
      );
      const second = await repo.refreshParticipants(
        groupJid,
        [
          { participantJid: "15554000001@s.whatsapp.net", phoneE164: "+15554000001", adminRole: "superadmin" },
          { participantJid: "15554000003@s.whatsapp.net", phoneE164: "+15554000003", adminRole: null },
        ],
        "2026-07-07T10:00:00.000Z",
      );

      expect(first).toHaveLength(2);
      expect(second).toEqual([
        expect.objectContaining({
          participant_jid: "15554000001@s.whatsapp.net",
          phone_e164: "+15554000001",
          admin_role: "superadmin",
          last_seen_at: "2026-07-07T10:00:00.000Z",
        }),
        expect.objectContaining({
          participant_jid: "15554000003@s.whatsapp.net",
          phone_e164: "+15554000003",
          last_seen_at: "2026-07-07T10:00:00.000Z",
        }),
      ]);
    });

    it("parses Baileys participant id shapes and persists lid fields", async () => {
      const { groupJid, repo } = await seedGroup();
      const resolveLidToPhone = vi.fn().mockResolvedValue("+15559999999");
      const collected = await collectWhatsAppGroupParticipants(
        {
          participants: [
            { id: "lid-member@lid", phoneNumber: "+1 (555) 500-0002", admin: "superadmin" },
            { id: "15555000001@s.whatsapp.net", lid: "phone-shape@lid", admin: "admin" },
            { id: "not-a-whatsapp-jid", admin: "admin" },
            { id: "abc@s.whatsapp.net", admin: "admin" },
            { admin: "admin" },
          ],
        },
        resolveLidToPhone,
      );

      await repo.refreshParticipants(groupJid, toParticipantInputs(collected.participants), "2026-07-07T09:00:00.000Z");
      const rows = await repo.listParticipants(groupJid);

      expect(collected.skippedCount).toBe(2);
      expect(resolveLidToPhone).not.toHaveBeenCalled();
      expect(rows).toEqual([
        expect.objectContaining({
          participant_jid: "15555000001@s.whatsapp.net",
          phone_e164: "+15555000001",
          lid: "phone-shape@lid",
          admin_role: "admin",
        }),
        expect.objectContaining({
          participant_jid: "abc@s.whatsapp.net",
          phone_e164: null,
          lid: null,
          admin_role: "admin",
        }),
        expect.objectContaining({
          participant_jid: "lid-member@lid",
          phone_e164: "+15555000002",
          lid: "lid-member@lid",
          admin_role: "superadmin",
        }),
      ]);
    });
  });
}

runIdentityIntegrationSuite("WhatsApp identity resolution sqlite", createTestDb);
runIdentityIntegrationSuite("WhatsApp identity resolution postgres", createTestPgDb);
