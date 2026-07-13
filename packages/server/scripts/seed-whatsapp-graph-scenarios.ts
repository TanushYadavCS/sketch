/**
 * Seeds deterministic WhatsApp group conversations for manual verification of
 * the context-graph indexing pipeline (chunker, salience gate, identity
 * resolution, opt-in enforcement, drill). Synthetic timestamps are relative to
 * the invocation time, so default chunker knobs work without waiting.
 *
 * Points at the configured SQLITE_PATH — run against a scratch DB:
 *   SQLITE_PATH=./data/manual-verify.db pnpm --filter @sketch/server exec tsx scripts/seed-whatsapp-graph-scenarios.ts
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { loadConfig, validateConfig } from "../src/config";
import { createDatabase } from "../src/db";
import { runMigrations } from "../src/db/migrate";
import type { DB } from "../src/db/schema";
import { createLogger } from "../src/logger";

const MINUTE = 60 * 1000;
const now = Date.now();

const BUSY_GROUP_JID = "12036304@g.us";
const QUIET_GROUP_JID = "12036305@g.us";
const DISABLED_GROUP_JID = "12036306@g.us";
const EXTERNAL_ONLY_GROUP_JID = "12036307@g.us";

const TEAMMATE_ALICE = { phone: "+14155550101", name: "Alice Founder", email: "alice@canvasx-test.ai" };
const TEAMMATE_BOB = { phone: "+14155550102", name: "Bob Sales", email: "bob@canvasx-test.ai" };
const CRM_RAHUL = { phone: "+919855550201", name: "Rahul Mehta", company: "Acme Corp" };
const UNKNOWN_PRIYA = { phone: "+919855550301", pushName: "Priya" };

function jid(phone: string): string {
  return `${phone.replace(/\D/gu, "")}@s.whatsapp.net`;
}

function iso(msOffsetFromNow: number): string {
  return new Date(now + msOffsetFromNow).toISOString();
}

interface SeedMessage {
  atMinutes: number;
  senderPhone?: string;
  senderName: string;
  text: string;
  attachments?: string;
  reaction?: boolean;
}

async function insertConversation(db: Kysely<DB>, providerId: string, kind: string, name: string): Promise<number> {
  await db
    .insertInto("conversations")
    .values({
      platform: "whatsapp",
      kind,
      provider_conversation_id: providerId,
      display_name: name,
    })
    .onConflict((oc) => oc.columns(["platform", "kind", "provider_conversation_id"]).doNothing())
    .execute();
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("provider_conversation_id", "=", providerId)
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertMessages(
  db: Kysely<DB>,
  conversationId: number,
  messages: SeedMessage[],
  idPrefix: string,
): Promise<void> {
  for (const [index, message] of messages.entries()) {
    const at = iso(message.atMinutes * MINUTE);
    const senderJid = message.senderPhone ? jid(message.senderPhone) : `${randomUUID().slice(0, 8)}@lid`;
    await db
      .insertInto("conversation_messages")
      .values({
        conversation_id: conversationId,
        provider_message_id: message.reaction ? `reaction:${idPrefix}-${index}` : `${idPrefix}-${index}`,
        sender_jid: senderJid,
        sender_name: message.senderName,
        sender_user_id: null,
        is_bot: 0,
        addressed_to_sketch: 0,
        text: message.text,
        attachments: message.attachments ?? null,
        provider_timestamp: at,
        received_at: at,
        is_thread_reply: 0,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

async function main() {
  const config = loadConfig();
  validateConfig(config);
  const logger = createLogger(config);
  const db = await createDatabase(config);

  try {
    await runMigrations(db, { quiet: true });

    const aliceId = randomUUID();
    const bobId = randomUUID();
    for (const [id, teammate] of [
      [aliceId, TEAMMATE_ALICE],
      [bobId, TEAMMATE_BOB],
    ] as const) {
      const existing = await db.selectFrom("users").select("id").where("email", "=", teammate.email).executeTakeFirst();
      if (existing) continue;
      await db
        .insertInto("users")
        .values({
          id,
          name: teammate.name,
          email: teammate.email,
          whatsapp_number: teammate.phone,
        })
        .execute();
    }

    const existingRahul = await db
      .selectFrom("entities")
      .select("id")
      .where("name", "=", CRM_RAHUL.name)
      .executeTakeFirst();
    const rahulEntityId = existingRahul?.id ?? randomUUID();
    if (!existingRahul) {
      await db
        .insertInto("entities")
        .values({
          id: rahulEntityId,
          name: CRM_RAHUL.name,
          source_type: "person",
          status: "active",
          hotness: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();
      await db
        .insertInto("entity_contact_points")
        .values({
          id: randomUUID(),
          entity_id: rahulEntityId,
          kind: "phone",
          value: CRM_RAHUL.phone,
          is_primary: 1,
          source: "zoho_crm",
        })
        .execute();
    }

    const groups: Array<[string, string]> = [
      [BUSY_GROUP_JID, "Acme Deal Room"],
      [QUIET_GROUP_JID, "Quiet Advisors"],
      [DISABLED_GROUP_JID, "Never Indexed"],
      [EXTERNAL_ONLY_GROUP_JID, "Externals Only"],
    ];
    for (const [groupJid, name] of groups) {
      await db
        .insertInto("whatsapp_groups")
        .values({ jid: groupJid, name, description: null, updated_at: new Date().toISOString(), index_enabled: 0 })
        .onConflict((oc) => oc.column("jid").doNothing())
        .execute();
    }

    const rosterPhones: Array<[string, string, string | null]> = [
      [BUSY_GROUP_JID, TEAMMATE_ALICE.phone, null],
      [BUSY_GROUP_JID, TEAMMATE_BOB.phone, "admin"],
      [BUSY_GROUP_JID, CRM_RAHUL.phone, null],
      [BUSY_GROUP_JID, UNKNOWN_PRIYA.phone, null],
      [QUIET_GROUP_JID, TEAMMATE_ALICE.phone, null],
      [QUIET_GROUP_JID, CRM_RAHUL.phone, null],
      [EXTERNAL_ONLY_GROUP_JID, CRM_RAHUL.phone, null],
      [EXTERNAL_ONLY_GROUP_JID, UNKNOWN_PRIYA.phone, null],
    ];
    for (const [groupJid, phone, admin] of rosterPhones) {
      await db
        .insertInto("whatsapp_group_participants")
        .values({
          group_jid: groupJid,
          participant_jid: jid(phone),
          phone_e164: phone,
          lid: null,
          admin_role: admin,
          last_seen_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.columns(["group_jid", "participant_jid"]).doNothing())
        .execute();
    }
    for (let i = 0; i < 56; i += 1) {
      await db
        .insertInto("whatsapp_group_participants")
        .values({
          group_jid: BUSY_GROUP_JID,
          participant_jid: jid(`+9198555511${String(i).padStart(2, "0")}`),
          phone_e164: `+9198555511${String(i).padStart(2, "0")}`,
          lid: null,
          admin_role: null,
          last_seen_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.columns(["group_jid", "participant_jid"]).doNothing())
        .execute();
    }

    const busyId = await insertConversation(db, BUSY_GROUP_JID, "group", "Acme Deal Room");
    const quietId = await insertConversation(db, QUIET_GROUP_JID, "group", "Quiet Advisors");
    const disabledId = await insertConversation(db, DISABLED_GROUP_JID, "group", "Never Indexed");
    const externalOnlyId = await insertConversation(db, EXTERNAL_ONLY_GROUP_JID, "group", "Externals Only");
    const dmId = await insertConversation(db, `dm:${TEAMMATE_ALICE.phone}`, "dm", "Alice DM");

    /** Session 1 (B2/A1): banter + one commitment, closed by a long lull. Rich for salience. */
    await insertMessages(
      db,
      busyId,
      [
        { atMinutes: -300, senderPhone: TEAMMATE_ALICE.phone, senderName: TEAMMATE_ALICE.name, text: "morning all" },
        { atMinutes: -299, senderPhone: CRM_RAHUL.phone, senderName: "Rahul", text: "morning!" },
        { atMinutes: -298, senderPhone: CRM_RAHUL.phone, senderName: "Rahul", text: "haha nice weekend?" },
        {
          atMinutes: -296,
          senderPhone: TEAMMATE_ALICE.phone,
          senderName: TEAMMATE_ALICE.name,
          text: "Rahul, following up on the Acme pilot - I'll send the revised proposal by Friday",
        },
        {
          atMinutes: -295,
          senderPhone: CRM_RAHUL.phone,
          senderName: "Rahul",
          text: "sounds good, let's go with option B pricing then",
        },
        { atMinutes: -294, senderPhone: TEAMMATE_BOB.phone, senderName: TEAMMATE_BOB.name, text: "ok 👍" },
        { atMinutes: -293, senderPhone: UNKNOWN_PRIYA.phone, senderName: UNKNOWN_PRIYA.pushName, text: "🎉" },
        {
          atMinutes: -292,
          senderPhone: UNKNOWN_PRIYA.phone,
          senderName: UNKNOWN_PRIYA.pushName,
          text: "should we loop in the Acme legal team before the proposal goes out?",
        },
      ],
      "busy-s1",
    );

    /** Session 2 (B1): pure banter, separated by lulls on both sides. Expect verdict: dropped. */
    await insertMessages(
      db,
      busyId,
      [
        { atMinutes: -200, senderPhone: TEAMMATE_BOB.phone, senderName: TEAMMATE_BOB.name, text: "lunch was great" },
        { atMinutes: -199, senderPhone: CRM_RAHUL.phone, senderName: "Rahul", text: "haha same here" },
        { atMinutes: -198, senderPhone: UNKNOWN_PRIYA.phone, senderName: UNKNOWN_PRIYA.pushName, text: "lol" },
        {
          atMinutes: -197,
          senderPhone: TEAMMATE_BOB.phone,
          senderName: TEAMMATE_BOB.name,
          text: "😀",
          reaction: false,
        },
        { atMinutes: -196, senderPhone: CRM_RAHUL.phone, senderName: "Rahul", text: "ok catch you later" },
      ],
      "busy-s2",
    );

    /** Session 3 (A2/B8): burst of 60 msgs in 20 min -> max_size flushes; includes de-noise fodder. */
    const burst: SeedMessage[] = [];
    for (let i = 0; i < 60; i += 1) {
      const sender = i % 3 === 0 ? TEAMMATE_ALICE : i % 3 === 1 ? { ...CRM_RAHUL, name: "Rahul" } : TEAMMATE_BOB;
      burst.push({
        atMinutes: -140 + i * 0.33,
        senderPhone: sender.phone,
        senderName: "name" in sender ? sender.name : "Rahul",
        text:
          i === 30
            ? "decision: we commit to the March 15 launch date for the Acme rollout"
            : `burst update ${i} on the integration checklist`,
      });
    }
    burst.push({
      atMinutes: -139.5,
      senderPhone: UNKNOWN_PRIYA.phone,
      senderName: "Priya",
      text: "👍",
      reaction: true,
    });
    burst.push({
      atMinutes: -139.4,
      senderPhone: UNKNOWN_PRIYA.phone,
      senderName: "Priya",
      text: "",
      attachments: JSON.stringify([{ mimeType: "image/jpeg", fileName: "photo.jpg", path: "/tmp/photo.jpg" }]),
    });
    await insertMessages(db, busyId, burst, "busy-s3");

    /** Active tail (A4): recent messages, no lull yet -> must stay unsliced. */
    await insertMessages(
      db,
      busyId,
      [
        {
          atMinutes: -6,
          senderPhone: TEAMMATE_ALICE.phone,
          senderName: TEAMMATE_ALICE.name,
          text: "drafting the summary now",
        },
        { atMinutes: -3, senderPhone: CRM_RAHUL.phone, senderName: "Rahul", text: "waiting on it" },
      ],
      "busy-tail",
    );

    /** Late arrival (A6): old provider_timestamp inserted after newer rows (higher id). */
    await insertMessages(
      db,
      busyId,
      [
        {
          atMinutes: -297,
          senderPhone: CRM_RAHUL.phone,
          senderName: "Rahul",
          text: "(history replay) also sharing the Acme org chart for context",
        },
      ],
      "busy-late",
    );

    /** Quiet group (A1): one clean short session with a question. */
    await insertMessages(
      db,
      quietId,
      [
        {
          atMinutes: -90,
          senderPhone: TEAMMATE_ALICE.phone,
          senderName: TEAMMATE_ALICE.name,
          text: "Rahul, can you review the SOW draft this week?",
        },
        { atMinutes: -88, senderPhone: CRM_RAHUL.phone, senderName: "Rahul", text: "yes, by Thursday" },
      ],
      "quiet-s1",
    );

    /** Disabled group (D1): salient traffic that must produce ZERO slices. */
    await insertMessages(
      db,
      disabledId,
      [
        {
          atMinutes: -100,
          senderPhone: TEAMMATE_ALICE.phone,
          senderName: TEAMMATE_ALICE.name,
          text: "we decided to cancel the Globex contract",
        },
        {
          atMinutes: -99,
          senderPhone: TEAMMATE_BOB.phone,
          senderName: TEAMMATE_BOB.name,
          text: "confirmed, I'll notify them Monday",
        },
      ],
      "disabled-s1",
    );

    /** External-only group (F4): salient content, zero teammates -> must NOT be indexed. */
    await insertMessages(
      db,
      externalOnlyId,
      [
        {
          atMinutes: -80,
          senderPhone: CRM_RAHUL.phone,
          senderName: "Rahul",
          text: "we agreed to move the Acme kickoff to April 2",
        },
        { atMinutes: -79, senderPhone: UNKNOWN_PRIYA.phone, senderName: "Priya", text: "I'll book the venue tomorrow" },
      ],
      "external-s1",
    );

    /** DM (G6): must never be sliced or indexed. */
    await insertMessages(
      db,
      dmId,
      [
        {
          atMinutes: -60,
          senderPhone: TEAMMATE_ALICE.phone,
          senderName: TEAMMATE_ALICE.name,
          text: "remind me to send the Acme proposal Friday",
        },
      ],
      "dm-s1",
    );

    logger.info(
      { busyId, quietId, disabledId, externalOnlyId, dmId, aliceEmail: TEAMMATE_ALICE.email },
      "Seeded WhatsApp graph manual-verification scenarios",
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
