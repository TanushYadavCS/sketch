import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestPgDb } from "../test-utils";
import { authorizedTargets } from "./membership";

const slackTarget = (targetId: string) => ({ platform: "slack" as const, targetId });
const whatsappTarget = (targetId: string) => ({ platform: "whatsapp" as const, targetId });

async function insertSlackParticipant(db: Kysely<DB>, channelId: string, slackUserId: string): Promise<void> {
  await db
    .insertInto("slack_channel_participants")
    .values({ channel_id: channelId, slack_user_id: slackUserId })
    .execute();
}

async function insertSlackUserSyncState(db: Kysely<DB>, slackUserId: string, email: string): Promise<void> {
  await db.insertInto("slack_user_sync_state").values({ team_id: "T1", slack_user_id: slackUserId, email }).execute();
}

async function insertWhatsAppParticipant(
  db: Kysely<DB>,
  groupJid: string,
  participantJid: string,
  phoneE164: string | null,
  lid: string | null,
): Promise<void> {
  await db.insertInto("whatsapp_groups").values({ jid: groupJid, name: groupJid }).execute();
  await db
    .insertInto("whatsapp_group_participants")
    .values({
      id: `${groupJid}:${participantJid}`,
      group_jid: groupJid,
      observation_key: `${phoneE164 ?? "-"}:${lid ?? "-"}`,
      participant_jid: participantJid,
      phone_e164: phoneE164,
      lid,
      admin_role: null,
    })
    .execute();
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    });

    afterEach(async () => {
      await db.destroy();
    });

    it("grants Slack membership from a Slack user principal without freshness", async () => {
      await insertSlackParticipant(db, "C-SLACK-USER", "U-SLACK-USER");

      await expect(
        authorizedTargets(db, [{ type: "slack_user", value: "U-SLACK-USER" }], [slackTarget("C-SLACK-USER")]),
      ).resolves.toEqual(new Set(["slack:C-SLACK-USER"]));
    });

    it("grants Slack membership from an email principal through sync state", async () => {
      await insertSlackParticipant(db, "C-SLACK-EMAIL", "U-SLACK-EMAIL");
      await insertSlackUserSyncState(db, "U-SLACK-EMAIL", "member@example.com");

      await expect(
        authorizedTargets(db, [{ type: "email", value: "member@example.com" }], [slackTarget("C-SLACK-EMAIL")]),
      ).resolves.toEqual(new Set(["slack:C-SLACK-EMAIL"]));
    });

    it("grants WhatsApp membership from a phone principal including PN-JID fallback", async () => {
      await insertWhatsAppParticipant(db, "group-phone@g.us", "15550000001@s.whatsapp.net", null, null);

      await expect(
        authorizedTargets(db, [{ type: "phone", value: "+15550000001" }], [whatsappTarget("group-phone@g.us")]),
      ).resolves.toEqual(new Set(["whatsapp:group-phone@g.us"]));
    });

    it("grants WhatsApp membership from a linked LID principal", async () => {
      await insertWhatsAppParticipant(db, "group-lid@g.us", "12345@lid", null, "12345@lid");

      await expect(
        authorizedTargets(db, [{ type: "whatsapp_lid", value: "12345@lid" }], [whatsappTarget("group-lid@g.us")]),
      ).resolves.toEqual(new Set(["whatsapp:group-lid@g.us"]));
    });

    it("denies all targets for zero principals and non-members", async () => {
      await insertSlackParticipant(db, "C-NON-MEMBER", "U-OTHER");
      await insertWhatsAppParticipant(db, "group-non-member@g.us", "15550000002@s.whatsapp.net", "+15550000002", null);

      const targets = [slackTarget("C-NON-MEMBER"), whatsappTarget("group-non-member@g.us")];
      await expect(authorizedTargets(db, [], targets)).resolves.toEqual(new Set());
      await expect(
        authorizedTargets(db, [{ type: "email", value: "not-a-member@example.com" }], targets),
      ).resolves.toEqual(new Set());
    });

    it("authorizes a Slack member in a channel with no conversations row", async () => {
      await insertSlackParticipant(db, "C-NEVER-INDEXED", "U-NEVER-INDEXED");

      const granted = await authorizedTargets(
        db,
        [{ type: "slack_user", value: "U-NEVER-INDEXED" }],
        [slackTarget("C-NEVER-INDEXED")],
      );

      expect(granted).toEqual(new Set(["slack:C-NEVER-INDEXED"]));
    });

    it("handles more target ids than one IN clause", async () => {
      const targetIds = Array.from({ length: 501 }, (_, index) => `C-CHUNK-${index}`);
      await insertSlackParticipant(db, targetIds.at(-1) as string, "U-CHUNK");

      const granted = await authorizedTargets(
        db,
        [{ type: "slack_user", value: "U-CHUNK" }],
        targetIds.map(slackTarget),
      );

      expect(granted).toEqual(new Set(["slack:C-CHUNK-500"]));
    });

    it("denies unknown platforms", async () => {
      const targets = [{ platform: "teams", targetId: "team-1" }] as unknown as Array<{
        platform: "slack" | "whatsapp";
        targetId: string;
      }>;

      await expect(authorizedTargets(db, [{ type: "email", value: "member@example.com" }], targets)).resolves.toEqual(
        new Set(),
      );
    });
  });
}

runSuite("authorizedTargets sqlite", createTestDb);
runSuite("authorizedTargets postgres", createTestPgDb);
