/**
 * Manual-verification driver for WhatsApp context-graph indexing. Runs the REAL
 * connector sync (chunker, LLM salience gate, emission, enrichment entry) against
 * the seeded scratch DB, then prints a per-scenario scorecard of observed DB state.
 *
 *   SQLITE_PATH=./data/manual-verify.db pnpm --filter @sketch/server exec tsx scripts/run-whatsapp-graph-manual.ts [--sync-only]
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { loadConfig, validateConfig } from "../src/config";
import { runConnectorSync } from "../src/connectors/sync";
import { createDatabase } from "../src/db";
import { runMigrations } from "../src/db/migrate";
import { createConnectorRepository } from "../src/db/repositories/connectors";
import type { DB } from "../src/db/schema";
import { createLogger } from "../src/logger";

const ENABLED_GROUPS = ["12036304@g.us", "12036305@g.us", "12036307@g.us"];
const DISABLED_GROUP = "12036306@g.us";

async function ensureWhatsAppConnector(db: Kysely<DB>, encryptionKey: string, adminUserId: string): Promise<string> {
  const repo = createConnectorRepository(db, encryptionKey);
  const existing = await db
    .selectFrom("connector_configs")
    .select("id")
    .where("connector_type", "=", "whatsapp")
    .executeTakeFirst();
  if (existing) return existing.id;
  const created = await repo.createConfig({
    connectorType: "whatsapp",
    authType: "system",
    credentials: JSON.stringify({ type: "system" }),
    scopeConfig: JSON.stringify({ groupJids: ENABLED_GROUPS }),
    createdBy: adminUserId,
  });
  return created.id;
}

async function table(db: Kysely<DB>, label: string, rows: unknown[]): Promise<void> {
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
    await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "in", ENABLED_GROUPS).execute();
    await db.updateTable("whatsapp_groups").set({ index_enabled: 0 }).where("jid", "=", DISABLED_GROUP).execute();

    const connectorId = await ensureWhatsAppConnector(db, config.ENCRYPTION_KEY, admin.id);
    console.log(`Running WhatsApp connector sync (${connectorId})...`);
    const result = await runConnectorSync(db, connectorId, logger, config);
    console.log(`Sync result: ${JSON.stringify(result)}`);

    if (process.argv.includes("--sync-only")) return;

    const slices = await db
      .selectFrom("conversation_slices")
      .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
      .select([
        "conversation_slices.id",
        "conversations.provider_conversation_id as group",
        "conversation_slices.first_message_id",
        "conversation_slices.last_message_id",
        "conversation_slices.message_count",
        "conversation_slices.flush_reason",
        "conversation_slices.salience_verdict",
        "conversation_slices.indexed_file_id",
      ])
      .orderBy("conversations.provider_conversation_id")
      .orderBy("conversation_slices.started_at")
      .execute();
    await table(db, "conversation_slices", slices);

    const files = await db
      .selectFrom("indexed_files")
      .leftJoin("access_scopes", "access_scopes.id", "indexed_files.access_scope_id")
      .select([
        "indexed_files.id",
        "indexed_files.file_name",
        "indexed_files.source",
        "indexed_files.is_archived",
        "indexed_files.share_with_everyone",
        "access_scopes.scope_type",
        "access_scopes.provider_scope_id",
      ])
      .where("indexed_files.source", "=", "whatsapp")
      .execute();
    await table(db, "indexed_files (whatsapp)", files);

    const scopeMembers = await db
      .selectFrom("access_scope_members")
      .innerJoin("access_scopes", "access_scopes.id", "access_scope_members.access_scope_id")
      .select([
        "access_scopes.provider_scope_id",
        "access_scope_members.principal_type",
        "access_scope_members.principal_value",
      ])
      .where("access_scopes.scope_type", "=", "whatsapp_group")
      .execute();
    await table(db, "access_scope_members", scopeMembers);

    const candidates = await db.selectFrom("whatsapp_identity_candidates").selectAll().execute();
    await table(db, "whatsapp_identity_candidates", candidates);

    const cursors = await db.selectFrom("conversation_slice_cursors").selectAll().execute();
    await table(db, "slice_cursors", cursors);

    const tasks = await db.selectFrom("tasks").select(["id", "title", "source"]).execute();
    await table(db, "tasks (must have zero whatsapp-derived)", tasks);

    const persons = await db
      .selectFrom("entities")
      .select(["id", "name", "source_type", "provenance_tier"])
      .where("source_type", "=", "person")
      .execute();
    await table(db, "person entities (must be only seeded Rahul)", persons);

    const contentRows = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name", "content"])
      .where("source", "=", "whatsapp")
      .execute();
    const rawIdentifier = /(\+?[1-9]\d{9,14}\b)|([^\s"'<>()[\]{}]+@(?:s\.whatsapp\.net|lid)\b)/u;
    for (const row of contentRows) {
      const leak = row.content ? rawIdentifier.exec(row.content) : null;
      console.log(`\n=== content privacy check: ${row.file_name} ===`);
      console.log(leak ? `LEAK FOUND: ${leak[0]}` : "clean (no raw numbers/JIDs)");
    }
    if (contentRows[0]?.content) {
      console.log(`\n=== sample indexed content (first file) ===\n${contentRows[0].content.slice(0, 1200)}`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
