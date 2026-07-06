/**
 * Read-only LLM extraction probe.
 *
 * Runs the live `extractEntities` prompt against real indexed files using the
 * configured Gemini key, and prints raw mentions + relations. Writes NOTHING:
 * no DB mutations, no materialization, no dumps — so it never pollutes the
 * entity graph. Used to score the extraction prompt's DO-NOT / disambiguation
 * rules against natural data.
 *
 *   tsx scripts/probe-extraction.ts <fileId> [<fileId> ...]
 */
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { buildFileScopedKnownEntities } from "../src/connectors/file-scope-context";
import { createGeminiGenerator } from "../src/connectors/gemini-generate";
import { buildParticipantBlock } from "../src/connectors/participant-block";
import { extractEntities } from "../src/connectors/smart-enrichment";
import type { DB } from "../src/db/schema";
import { parseOrgContext } from "../src/db/repositories/settings";

const DB_PATH = "/Users/hkalra/projects/claude/sketch/data/sketch.db";
const EXPERIMENTAL = true;

async function main() {
  const fileIds = process.argv.slice(2);
  if (fileIds.length === 0) {
    console.error("usage: tsx scripts/probe-extraction.ts <fileId> [<fileId> ...]");
    process.exit(1);
  }

  const sqliteDb = new Database(DB_PATH, { readonly: true });
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqliteDb }) });

  const settings = await db
    .selectFrom("settings")
    .select(["org_name", "org_context", "gemini_api_key"])
    .where("id", "=", "default")
    .executeTakeFirstOrThrow();

  if (!settings.gemini_api_key) throw new Error("no gemini_api_key in settings");
  const parsed = parseOrgContext(settings.org_context);
  const orgContext = settings.org_context
    ? {
        orgName: settings.org_name ?? undefined,
        description: parsed?.description,
        industry: parsed?.industry,
        disambiguationGuidance: parsed?.disambiguationGuidance,
      }
    : null;

  const generator = createGeminiGenerator(settings.gemini_api_key);

  for (const fileId of fileIds) {
    const file = await db
      .selectFrom("indexed_files")
      .select([
        "id",
        "file_name",
        "content",
        "content_category",
        "file_type",
        "source_path",
        "content_hash",
        "connector_config_id",
        "source_created_at",
        "source_updated_at",
      ])
      .where("id", "=", fileId)
      .executeTakeFirst();

    if (!file || !file.content) {
      console.log(`\n##### ${fileId} — NOT FOUND or empty content`);
      continue;
    }

    const knownEntities = await buildFileScopedKnownEntities(
      { db, experimentalFlag: EXPERIMENTAL } as never,
      file.id,
      [],
      file.content,
    );
    const participantBlock = await buildParticipantBlock({ db } as never, {
      fileId: file.id,
      fileContent: file.content,
    });

    const fileContext = {
      id: file.id,
      fileName: file.file_name,
      content: file.content,
      threadContext: null,
      contentCategory: file.content_category,
      fileType: file.file_type,
      source: file.source_path?.split("/")[0] ?? "unknown",
      sourcePath: file.source_path,
      contentHash: file.content_hash,
      connectorConfigId: file.connector_config_id,
      sourceCreatedAt: file.source_created_at,
      sourceUpdatedAt: file.source_updated_at,
    };

    const result = await extractEntities(
      generator,
      fileContext as never,
      orgContext,
      knownEntities,
      participantBlock,
      undefined,
      EXPERIMENTAL,
    );

    console.log(`\n${"#".repeat(78)}`);
    console.log(`# ${file.file_type} | ${file.file_name}`);
    console.log(`# id=${file.id} chars=${file.content.length} known=${knownEntities.length}`);
    console.log("#".repeat(78));
    console.log("\nMENTIONS:");
    for (const m of result.mentions) {
      console.log(`  [${m.type}] ${m.mention}  (conf ${m.confidence})`);
    }
    console.log("\nRELATIONS:");
    for (const r of result.relations) {
      console.log(`  ${r.source.name} (${r.source.type}) --${r.type}--> ${r.target.name} (${r.target.type})  (conf ${r.confidence})`);
    }
  }

  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
