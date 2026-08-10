/**
 * Phase-2 manual-verification driver. Extends the seeded scratch DB with the
 * scenarios the first pass could not cover, then runs the REAL connector sync
 * and prints a focused scorecard:
 *
 *   A3/A7  steady-stream group with a per-group slice_max_age override (60min)
 *   B3     decision-without-commitment session (busy group)
 *   B5     named-entity-only session (busy group)
 *   C3     manual member label surfaces in the rendered roster
 *   C7     CRM contact point added later corroborates a candidate (read path)
 *   D3     disable-mid-stream: quiet group gets new traffic but stays unindexed
 *   B8/F2/H2 transcript de-noise, roster snapshot hygiene, summary status
 *
 *   SQLITE_PATH=./data/manual-verify.db pnpm exec tsx scripts/run-whatsapp-graph-phase2.ts
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { loadConfig, validateConfig } from "../src/config";
import { runConnectorSync } from "../src/connectors/sync";
import { createDatabase } from "../src/db";
import { runMigrations } from "../src/db/migrate";
import type { DB } from "../src/db/schema";
import { createLogger } from "../src/logger";
import { stableWhatsAppParticipantJidRef } from "../src/whatsapp/identity-resolution";

const MINUTE = 60 * 1000;
const now = Date.now();

const BUSY_GROUP_JID = "12036304@g.us";
const QUIET_GROUP_JID = "12036305@g.us";
const STREAM_GROUP_JID = "12036308@g.us";

const ALICE_PHONE = "+14155550101";
const RAHUL_PHONE = "+919855550201";
const PRIYA_PHONE = "+919855550301";
const CORROBORATED_PHONE = "+919855551100";

function jid(phone: string): string {
  return `${phone.replace(/\D/gu, "")}@s.whatsapp.net`;
}

function iso(msOffsetFromNow: number): string {
  return new Date(now + msOffsetFromNow).toISOString();
}

interface SeedMessage {
  atMinutes: number;
  senderPhone: string;
  senderName: string;
  text: string;
}

async function insertMessages(
  db: Kysely<DB>,
  conversationId: number,
  messages: SeedMessage[],
  idPrefix: string,
): Promise<void> {
  for (const [index, message] of messages.entries()) {
    const at = iso(message.atMinutes * MINUTE);
    await db
      .insertInto("conversation_messages")
      .values({
        conversation_id: conversationId,
        provider_message_id: `${idPrefix}-${index}`,
        sender_jid: jid(message.senderPhone),
        sender_name: message.senderName,
        sender_user_id: null,
        is_bot: 0,
        addressed_to_sketch: 0,
        text: message.text,
        attachments: null,
        provider_timestamp: at,
        received_at: at,
        is_thread_reply: 0,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

async function conversationId(db: Kysely<DB>, providerId: string, name: string): Promise<number> {
  await db
    .insertInto("conversations")
    .values({ platform: "whatsapp", kind: "group", provider_conversation_id: providerId, display_name: name })
    .onConflict((oc) => oc.columns(["platform", "kind", "provider_conversation_id"]).doNothing())
    .execute();
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("provider_conversation_id", "=", providerId)
    .executeTakeFirstOrThrow();
  return row.id;
}

async function table(label: string, rows: unknown[]): Promise<void> {
  console.log(`\n=== ${label} (${rows.length}) ===`);
  for (const row of rows) console.log(JSON.stringify(row));
}

async function main() {
  const config = loadConfig();
  validateConfig(config);
  const logger = createLogger(config);
  const db = await createDatabase(config);

  try {
    await runMigrations(db, { quiet: true });

    const admin = await db.selectFrom("users").select(["id"]).orderBy("created_at", "asc").executeTakeFirstOrThrow();
    const connector = await db
      .selectFrom("connector_configs")
      .select("id")
      .where("connector_type", "=", "whatsapp")
      .executeTakeFirstOrThrow();

    /** A3/A7: new steady-stream group with a 60-minute max-age override (default is 120). */
    await db
      .insertInto("whatsapp_groups")
      .values({
        jid: STREAM_GROUP_JID,
        name: "Steady Standup",
        description: null,
        updated_at: new Date().toISOString(),
        index_enabled: 1,
        slice_max_age_minutes: 60,
      })
      .onConflict((oc) => oc.column("jid").doNothing())
      .execute();
    await db
      .updateTable("whatsapp_groups")
      .set({ slice_max_age_minutes: 60, index_enabled: 1 })
      .where("jid", "=", STREAM_GROUP_JID)
      .execute();
    for (const phone of [ALICE_PHONE, RAHUL_PHONE, PRIYA_PHONE]) {
      await db
        .insertInto("whatsapp_group_participants")
        .values({
          group_jid: STREAM_GROUP_JID,
          participant_jid: jid(phone),
          phone_e164: phone,
          lid: null,
          admin_role: null,
          last_seen_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.columns(["group_jid", "participant_jid"]).doNothing())
        .execute();
    }
    const streamId = await conversationId(db, STREAM_GROUP_JID, "Steady Standup");
    const streamMessages: SeedMessage[] = [];
    for (let minute = -150; minute <= -5; minute += 5) {
      streamMessages.push({
        atMinutes: minute,
        senderPhone: minute % 10 === 0 ? ALICE_PHONE : RAHUL_PHONE,
        senderName: minute % 10 === 0 ? "Alice Founder" : "Rahul",
        text: `standup update t${minute}: shipped the ${minute % 10 === 0 ? "billing" : "onboarding"} change, next is QA`,
      });
    }
    await insertMessages(db, streamId, streamMessages, "stream");

    /** B3 + B5: two fresh sessions on the busy group, each closed by a >25min lull. */
    const busyId = await conversationId(db, BUSY_GROUP_JID, "Acme Deal Room");
    await insertMessages(
      db,
      busyId,
      [
        {
          atMinutes: -70,
          senderPhone: RAHUL_PHONE,
          senderName: "Rahul",
          text: "reviewed both vendor options overnight",
        },
        { atMinutes: -69, senderPhone: ALICE_PHONE, senderName: "Alice Founder", text: "let's go with option B then" },
        { atMinutes: -68, senderPhone: RAHUL_PHONE, senderName: "Rahul", text: "ok noted" },
      ],
      "b3-decision",
    );
    await insertMessages(
      db,
      busyId,
      [
        {
          atMinutes: -40,
          senderPhone: PRIYA_PHONE,
          senderName: "Priya",
          text: "the Acme folks visited our office today",
        },
        { atMinutes: -39, senderPhone: RAHUL_PHONE, senderName: "Rahul", text: "nice, good sign" },
      ],
      "b5-entity",
    );

    /** C3: manual label for Priya on the busy group. */
    await db
      .insertInto("whatsapp_group_member_labels")
      .values({
        group_jid: BUSY_GROUP_JID,
        phone_e164: PRIYA_PHONE,
        display_name: "Priya Sharma",
        company_name: "Acme Corp",
        created_by: admin.id,
      })
      .onConflict((oc) => oc.columns(["group_jid", "phone_e164"]).doNothing())
      .execute();

    /** C7: CRM contact point arrives AFTER the candidate accumulated kept slices. */
    const existingVikram = await db
      .selectFrom("entities")
      .select("id")
      .where("name", "=", "Vikram Shah")
      .executeTakeFirst();
    if (!existingVikram) {
      const vikramId = randomUUID();
      await db
        .insertInto("entities")
        .values({
          id: vikramId,
          name: "Vikram Shah",
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
          entity_id: vikramId,
          kind: "phone",
          value: CORROBORATED_PHONE,
          is_primary: 1,
          source: "zoho_crm",
        })
        .execute();
    }

    /** D3: quiet group gets fresh salient traffic, then is disabled before the sync. */
    const quietId = await conversationId(db, QUIET_GROUP_JID, "Quiet Advisors");
    await insertMessages(
      db,
      quietId,
      [
        {
          atMinutes: -30,
          senderPhone: ALICE_PHONE,
          senderName: "Alice Founder",
          text: "Rahul, can you review the term sheet today? Deadline is tomorrow.",
        },
      ],
      "d3-after-disable",
    );
    await db.updateTable("whatsapp_groups").set({ index_enabled: 0 }).where("jid", "=", QUIET_GROUP_JID).execute();

    const quietSlicesBefore = await db
      .selectFrom("conversation_slices")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("conversation_id", "=", quietId)
      .executeTakeFirstOrThrow();

    console.log(`Running WhatsApp connector sync (${connector.id})...`);
    const result = await runConnectorSync(db, connector.id, logger, config);
    console.log(`Sync result: ${JSON.stringify(result)}`);

    const slices = await db
      .selectFrom("conversation_slices")
      .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
      .select([
        "conversations.provider_conversation_id as group",
        "conversation_slices.first_message_id",
        "conversation_slices.last_message_id",
        "conversation_slices.message_count",
        "conversation_slices.started_at",
        "conversation_slices.ended_at",
        "conversation_slices.flush_reason",
        "conversation_slices.salience_verdict",
        "conversation_slices.indexed_file_id",
        "conversation_slices.denoised_message_ids",
      ])
      .orderBy("conversations.provider_conversation_id")
      .orderBy("conversation_slices.started_at")
      .execute();
    await table(
      "all slices (stream group must show max_age flushes; quiet must show no new rows)",
      slices.map((s) => ({ ...s, denoised_message_ids: s.denoised_message_ids ? "present" : null })),
    );

    const quietSlicesAfter = await db
      .selectFrom("conversation_slices")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("conversation_id", "=", quietId)
      .executeTakeFirstOrThrow();
    console.log(
      `\n=== D3 quiet group slices before/after: ${quietSlicesBefore.count}/${quietSlicesAfter.count} (must be equal) ===`,
    );

    const files = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name", "summary_status", "content"])
      .where("source", "=", "whatsapp")
      .orderBy("indexed_at")
      .execute();
    await table(
      "indexed files (H2 summary_status)",
      files.map((f) => ({ file_name: f.file_name, summary_status: f.summary_status })),
    );

    const rawIdentifier = /(\+?[1-9]\d{9,14}\b)|([^\s"'<>()[\]{}]+@(?:s\.whatsapp\.net|lid)\b)/u;
    for (const file of files) {
      const leak = file.content ? rawIdentifier.exec(file.content) : null;
      console.log(`privacy ${leak ? `LEAK: ${leak[0]}` : "clean"} — ${file.file_name}`);
    }

    const busyFiles = files.filter((f) => f.file_name.includes("Acme Deal Room"));
    const latestBusy = busyFiles[busyFiles.length - 1];
    console.log("\n=== C3/C7 roster excerpt (latest busy file) ===");
    for (const line of (latestBusy?.content ?? "").split("\n")) {
      if (/Priya|Vikram|option B|Acme folks/u.test(line)) console.log(line);
    }

    const snapshots = await db
      .selectFrom("conversation_slices")
      .select(["id", "roster_snapshot"])
      .orderBy("created_at", "desc")
      .limit(3)
      .execute();
    console.log("\n=== F2 roster_snapshot hygiene (latest 3 slices) ===");
    for (const snap of snapshots) {
      const leak = snap.roster_snapshot ? rawIdentifier.exec(snap.roster_snapshot) : null;
      console.log(`${snap.id}: ${leak ? `LEAK: ${leak[0]}` : "clean"}`);
    }
    console.log(`\nsample roster_snapshot:\n${(snapshots[0]?.roster_snapshot ?? "").slice(0, 400)}`);

    const persons = await db
      .selectFrom("entities")
      .select(["name", "source_type"])
      .where("source_type", "=", "person")
      .execute();
    await table("person entities (must be only Rahul + Vikram, both seeded)", persons);

    const candidate = await db
      .selectFrom("whatsapp_identity_candidates")
      .selectAll()
      .where("participant_jid_ref", "=", stableWhatsAppParticipantJidRef(jid(CORROBORATED_PHONE)))
      .execute();
    await table("C7 candidate row for corroborated number (stays counter-only)", candidate);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
