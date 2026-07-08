/**
 * H4 scale check: seeds a 10k-message WhatsApp group backfill into a FRESH
 * scratch DB and times the real connector sync. Run WITHOUT an OpenRouter key
 * so the salience gate is skipped — slices must stay pending with zero LLM
 * calls, proving chunking cost is independent of judging.
 *
 *   SQLITE_PATH=./data/h4-perf.db pnpm exec tsx scripts/run-whatsapp-graph-perf.ts
 */
import { randomUUID } from "node:crypto";
import { loadConfig, validateConfig } from "../src/config";
import { runConnectorSync } from "../src/connectors/sync";
import { createDatabase } from "../src/db";
import { runMigrations } from "../src/db/migrate";
import { createConnectorRepository } from "../src/db/repositories/connectors";
import { createLogger } from "../src/logger";

const GROUP_JID = "12036399@g.us";
const MESSAGE_TOTAL = 10_000;
const SESSION_SIZE = 20;
const MINUTE = 60 * 1000;

async function main() {
  const config = loadConfig();
  validateConfig(config);
  const logger = createLogger(config);
  const db = await createDatabase(config);

  try {
    await runMigrations(db, { quiet: true });

    const adminId = randomUUID();
    await db
      .insertInto("users")
      .values({ id: adminId, name: "Perf Admin", email: "perf@canvasx-test.ai", whatsapp_number: "+14155559900" })
      .execute();
    await db
      .insertInto("whatsapp_groups")
      .values({
        jid: GROUP_JID,
        name: "Perf Group",
        description: null,
        updated_at: new Date().toISOString(),
        index_enabled: 1,
      })
      .execute();
    for (let i = 0; i < 5; i += 1) {
      await db
        .insertInto("whatsapp_group_participants")
        .values({
          group_jid: GROUP_JID,
          participant_jid: `9198555599${String(i).padStart(2, "0")}@s.whatsapp.net`,
          phone_e164: `+9198555599${String(i).padStart(2, "0")}`,
          lid: null,
          admin_role: null,
          last_seen_at: new Date().toISOString(),
        })
        .execute();
    }
    await db
      .insertInto("conversations")
      .values({ platform: "whatsapp", kind: "group", provider_conversation_id: GROUP_JID, display_name: "Perf Group" })
      .execute();
    const conversation = await db
      .selectFrom("conversations")
      .select("id")
      .where("provider_conversation_id", "=", GROUP_JID)
      .executeTakeFirstOrThrow();

    const seedStart = Date.now();
    const base = Date.now() - 14 * 24 * 60 * MINUTE;
    let cursorMs = base;
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < MESSAGE_TOTAL; i += 1) {
      if (i > 0 && i % SESSION_SIZE === 0) cursorMs += 30 * MINUTE;
      cursorMs += MINUTE;
      const at = new Date(cursorMs).toISOString();
      rows.push({
        conversation_id: conversation.id,
        provider_message_id: `perf-${i}`,
        sender_jid: `9198555599${String(i % 5).padStart(2, "0")}@s.whatsapp.net`,
        sender_name: `Member ${i % 5}`,
        sender_user_id: null,
        is_bot: 0,
        addressed_to_sketch: 0,
        text: `perf message ${i}: decision on vendor ${i % 7}, follow up next week`,
        attachments: null,
        provider_timestamp: at,
        received_at: at,
        is_thread_reply: 0,
      });
    }
    for (let offset = 0; offset < rows.length; offset += 500) {
      await db
        .insertInto("conversation_messages")
        .values(rows.slice(offset, offset + 500) as never)
        .execute();
    }
    console.log(`Seeded ${MESSAGE_TOTAL} messages in ${Date.now() - seedStart}ms`);

    const connector = await createConnectorRepository(db, config.ENCRYPTION_KEY).createConfig({
      connectorType: "whatsapp",
      authType: "system",
      credentials: JSON.stringify({ type: "system" }),
      scopeConfig: JSON.stringify({ groupJids: [GROUP_JID] }),
      createdBy: adminId,
    });

    if (process.env.OPENROUTER_API_KEY) {
      throw new Error("Run without OPENROUTER_API_KEY so the salience gate stays idle.");
    }
    const syncStart = Date.now();
    const result = await runConnectorSync(db, connector.id, logger, config);
    const syncMs = Date.now() - syncStart;
    console.log(`Sync completed in ${syncMs}ms: ${JSON.stringify(result)}`);

    const sliceStats = await db
      .selectFrom("conversation_slices")
      .select(({ fn }) => [
        fn.countAll<number>().as("total"),
        fn.count<number>("salience_verdict").as("judged"),
        fn.count<number>("indexed_file_id").as("indexed"),
      ])
      .executeTakeFirstOrThrow();
    console.log(`Slices: ${JSON.stringify(sliceStats)} (judged and indexed must be 0 — no LLM key)`);

    const rerunStart = Date.now();
    const rerun = await runConnectorSync(db, connector.id, logger, config);
    console.log(`Idempotent rerun in ${Date.now() - rerunStart}ms: ${JSON.stringify(rerun)}`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
