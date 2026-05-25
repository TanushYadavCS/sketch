import { writeFileSync } from "node:fs";
import { sql } from "kysely";
import { loadConfig } from "../packages/server/src/config";
import { createDatabase } from "../packages/server/src/db";
import { recreateEntityGraph } from "../packages/server/src/entities/recreate";
import { createLogger } from "../packages/server/src/logger";

const outPath = process.argv[2];
if (!outPath) {
  console.error("usage: tsx scripts/equivalence-snapshot.ts <output-file>");
  process.exit(1);
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = await createDatabase(config);

  const summary = await recreateEntityGraph({
    db,
    logger,
    triggeredByUserId: "4360b91e-cc7f-47db-9d70-e99cb38b979f",
    skipLlm: true,
    skipEnrichment: true,
  });

  const entities = await sql<{ source_type: string; subtype: string | null; count: number }>`
  SELECT source_type, subtype, count(*) AS count
  FROM entities
  GROUP BY source_type, subtype
  ORDER BY source_type, subtype
`.execute(db);

  const mentions = await sql<{ confidence: string; relation: string; source: string; count: number }>`
  SELECT confidence, relation, source, count(*) AS count
  FROM entity_mentions
  GROUP BY confidence, relation, source
  ORDER BY confidence, relation, source
`.execute(db);

  const sourceRefs = await sql<{ source: string; count: number }>`
  SELECT source, count(*) AS count
  FROM entity_source_refs
  GROUP BY source
  ORDER BY source
`.execute(db);

  const review = await sql<{ status: string; count: number }>`
  SELECT status, count(*) AS count
  FROM entity_review_queue
  GROUP BY status
  ORDER BY status
`.execute(db);

  const totals = await sql<{ entities: number; mentions: number; refs: number; queue: number }>`
  SELECT
    (SELECT count(*) FROM entities) AS entities,
    (SELECT count(*) FROM entity_mentions) AS mentions,
    (SELECT count(*) FROM entity_source_refs) AS refs,
    (SELECT count(*) FROM entity_review_queue) AS queue
`.execute(db);

  const lines = [
    "=== summary ===",
    JSON.stringify(summary, null, 2),
    "=== totals ===",
    JSON.stringify(totals.rows[0], null, 2),
    "=== entities (source_type, subtype, count) ===",
    ...entities.rows.map((r) => `${r.source_type}\t${r.subtype ?? "(null)"}\t${r.count}`),
    "=== entity_mentions (confidence, relation, source, count) ===",
    ...mentions.rows.map((r) => `${r.confidence}\t${r.relation}\t${r.source}\t${r.count}`),
    "=== entity_source_refs (source, count) ===",
    ...sourceRefs.rows.map((r) => `${r.source}\t${r.count}`),
    "=== entity_review_queue (status, count) ===",
    ...review.rows.map((r) => `${r.status}\t${r.count}`),
  ];

  writeFileSync(outPath, `${lines.join("\n")}\n`);
  console.log(`snapshot written to ${outPath}`);
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
