import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { buildFileScopedKnownEntities } from "../src/connectors/file-scope-context";
import { buildParticipantBlock } from "../src/connectors/participant-block";
import type { DB } from "../src/db/schema";

const FAILING_FILE_ID = process.argv[2] ?? "73bfad1b-0eb0-4469-b27d-af07e3250dd5";

async function main() {
  const sqliteDb = new Database("/Users/hkalra/projects/claude/sketch/data/sketch.db", { readonly: true });
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqliteDb }) });

  const file = await db
    .selectFrom("indexed_files")
    .select(["id", "file_name", "content"])
    .where("id", "=", FAILING_FILE_ID)
    .executeTakeFirstOrThrow();

  const content = file.content ?? "";
  console.log(`File: ${file.file_name}`);
  console.log(`Content chars: ${content.length}`);

  const known = await buildFileScopedKnownEntities({ db } as never, file.id, []);
  console.log(`\nknownEntities count: ${known.length}`);
  const renderKnown = (e: { name: string; type: string; description?: string }) =>
    `- ${e.name} (${e.type})${e.description ? `: ${e.description}` : ""}`;
  const knownRendered = known.map(renderKnown).join("\n");
  console.log(`knownEntities rendered chars: ${knownRendered.length}`);

  const breakdown: Record<string, number> = {};
  for (const e of known) breakdown[e.type] = (breakdown[e.type] ?? 0) + 1;
  console.log("knownEntities by type:", breakdown);

  const participantBlock = await buildParticipantBlock({ db } as never, { fileId: file.id, fileContent: content });
  console.log(`\nparticipantBlock chars: ${participantBlock.length}`);

  console.log("\n=== knownEntities (first 40 entries) ===");
  console.log(known.slice(0, 40).map(renderKnown).join("\n"));
  if (known.length > 40) console.log(`... and ${known.length - 40} more`);

  console.log("\n=== participantBlock ===");
  console.log(participantBlock);

  console.log("\n=== SIZE BREAKDOWN ===");
  console.log(`file content:        ${content.length} chars`);
  console.log(`knownEntities:       ${knownRendered.length} chars`);
  console.log(`participantBlock:    ${participantBlock.length} chars`);
  console.log("(plus ~7000-8000 chars of base prompt template)");

  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
