import { sql } from "kysely";
import { loadConfig } from "../packages/server/src/config";
import { createDatabase } from "../packages/server/src/db";
import { recreateEntityGraph } from "../packages/server/src/entities/recreate";
import { createLogger } from "../packages/server/src/logger";

const CONTENT_DERIVED_TABLES = ["chunk_embeddings", "file_embeddings", "document_chunks", "document_timeframes"];

async function snapshot(db: Awaited<ReturnType<typeof createDatabase>>) {
  const totals = await sql<{ table: string; count: number }>`
    SELECT 'entities' AS "table", count(*) AS count FROM entities
    UNION ALL SELECT 'entity_mentions', count(*) FROM entity_mentions
    UNION ALL SELECT 'entity_source_refs', count(*) FROM entity_source_refs
    UNION ALL SELECT 'document_chunks', count(*) FROM document_chunks
    UNION ALL SELECT 'chunk_embeddings', count(*) FROM chunk_embeddings
    UNION ALL SELECT 'file_embeddings', count(*) FROM file_embeddings
    UNION ALL SELECT 'document_timeframes', count(*) FROM document_timeframes
  `.execute(db);
  const counts: Record<string, number> = {};
  for (const r of totals.rows) counts[r.table] = Number(r.count);
  return counts;
}

async function mentionBreakdown(db: Awaited<ReturnType<typeof createDatabase>>) {
  const rows = await sql<{ confidence: string; source: string; count: number }>`
    SELECT confidence, source, count(*) AS count
    FROM entity_mentions
    GROUP BY confidence, source
    ORDER BY confidence, source
  `.execute(db);
  return rows.rows.map((r) => ({ ...r, count: Number(r.count) }));
}

async function sampleInferredMentions(db: Awaited<ReturnType<typeof createDatabase>>) {
  const rows = await sql<{ entity_name: string; context_snippet: string | null; source: string }>`
    SELECT e.name AS entity_name, em.context_snippet, em.source
    FROM entity_mentions em
    JOIN entities e ON e.id = em.entity_id
    WHERE em.confidence = 'INFERRED'
    ORDER BY RANDOM()
    LIMIT 5
  `.execute(db);
  return rows.rows;
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = await createDatabase(config);

  console.log("=== BEFORE recreate ===");
  const before = await snapshot(db);
  console.log(before);

  console.log("\n=== Running recreateEntityGraph ===");
  const t0 = Date.now();
  const summary = await recreateEntityGraph({
    db,
    logger,
    triggeredByUserId: "4360b91e-cc7f-47db-9d70-e99cb38b979f",
  });
  const elapsedMs = Date.now() - t0;
  console.log(`elapsed: ${elapsedMs}ms`);
  console.log("reset.deleted:", summary.reset.deleted);
  console.log("reset.factsMarkedUnmaterialized:", summary.reset.factsMarkedUnmaterialized);
  console.log("reset.filesMarkedPending:", summary.reset.filesMarkedPending);
  console.log("replay:", summary.replay);
  console.log("enrichment:", summary.enrichment);
  console.log("enrichmentIterations:", summary.enrichmentIterations);

  console.log("\n=== AFTER recreate ===");
  const after = await snapshot(db);
  console.log(after);

  console.log("\n=== Mention breakdown (confidence × source) ===");
  const breakdown = await mentionBreakdown(db);
  for (const row of breakdown) console.log(`  ${row.confidence}\t${row.source}\t${row.count}`);

  console.log("\n=== Sample INFERRED mentions ===");
  const samples = await sampleInferredMentions(db);
  for (const s of samples) {
    const snippet = s.context_snippet ? `${s.context_snippet.slice(0, 80).replace(/\s+/g, " ")}…` : "(no snippet)";
    console.log(`  [${s.source}] entity=${s.entity_name}\n      snippet: ${snippet}`);
  }

  console.log("\n=== Assertions ===");
  const issues: string[] = [];

  // TEST 2: content-derived tables preserved
  for (const table of CONTENT_DERIVED_TABLES) {
    const drift = (after[table] ?? 0) - (before[table] ?? 0);
    if (drift !== 0) issues.push(`[T2] ${table} drifted by ${drift} (before=${before[table]}, after=${after[table]})`);
    if (summary.reset.deleted[table] !== undefined) issues.push(`[T2] reset.deleted still reports ${table}`);
  }

  // TEST 2: EXTRACTED count matches PR 2 baseline (3695)
  const extracted = breakdown.filter((r) => r.confidence === "EXTRACTED").reduce((s, r) => s + r.count, 0);
  if (extracted !== 3695) issues.push(`[T2] EXTRACTED count drift: expected 3695, got ${extracted}`);

  // TEST 2: reset.factsMarkedUnmaterialized is set
  if (!(summary.reset.factsMarkedUnmaterialized > 0))
    issues.push(`[T2] factsMarkedUnmaterialized expected > 0, got ${summary.reset.factsMarkedUnmaterialized}`);

  // TEST 3: INFERRED mentions exist via deterministic_substring
  const inferredDeterministic = breakdown.find(
    (r) => r.confidence === "INFERRED" && r.source === "deterministic_substring",
  );
  if (!inferredDeterministic || inferredDeterministic.count === 0)
    issues.push(`[T3] no INFERRED mentions with source='deterministic_substring' — substring linker didn't fire`);

  // TEST 3: no INFERRED llm_extraction mentions (we haven't run smart-enrichment)
  const llmInferred = breakdown.find((r) => r.confidence === "INFERRED" && r.source === "llm_extraction");
  if (llmInferred && llmInferred.count > 0)
    issues.push(`[T3] unexpected INFERRED llm_extraction mentions: ${llmInferred.count}`);

  if (issues.length === 0) {
    console.log("ALL PASS");
  } else {
    console.log("ISSUES:");
    for (const i of issues) console.log(`  - ${i}`);
  }

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
