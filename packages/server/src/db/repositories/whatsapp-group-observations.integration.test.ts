import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createWhatsAppGroupRepository } from "./whatsapp-groups";

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
  });
}

observationSuite("WhatsApp group observations on SQLite", createTestDb);
observationSuite("WhatsApp group observations on Postgres", createTestPgDb);
