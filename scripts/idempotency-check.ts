import { sql } from "kysely";
import { loadConfig } from "../packages/server/src/config";
import { createDatabase } from "../packages/server/src/db";
import { recreateEntityGraph } from "../packages/server/src/entities/recreate";
import { createLogger } from "../packages/server/src/logger";

async function counts(db: Awaited<ReturnType<typeof createDatabase>>) {
  const row = await sql<{
    entities: number;
    mentions: number;
    refs: number;
    queue: number;
  }>`
    SELECT
      (SELECT count(*) FROM entities) AS entities,
      (SELECT count(*) FROM entity_mentions) AS mentions,
      (SELECT count(*) FROM entity_source_refs) AS refs,
      (SELECT count(*) FROM entity_review_queue) AS queue
  `.execute(db);
  return row.rows[0];
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = await createDatabase(config);

  console.log("Step 1: clean baseline (reset + replay)");
  const baseline = await recreateEntityGraph({
    db,
    logger,
    triggeredByUserId: "4360b91e-cc7f-47db-9d70-e99cb38b979f",
    skipLlm: true,
    skipEnrichment: true,
  });
  const after1 = await counts(db);
  console.log("  baseline replay:", baseline.replay);
  console.log("  DB counts:", after1);

  console.log("Step 2: re-run replay WITHOUT reset (idempotency)");
  const replay2 = await recreateEntityGraph({
    db,
    logger,
    triggeredByUserId: "4360b91e-cc7f-47db-9d70-e99cb38b979f",
    skipLlm: true,
    skipEnrichment: true,
    skipReset: true,
  });
  const after2 = await counts(db);
  console.log("  replay2:", replay2.replay);
  console.log("  DB counts:", after2);

  const drift = {
    entities: after2.entities - after1.entities,
    mentions: after2.mentions - after1.mentions,
    refs: after2.refs - after1.refs,
    queue: after2.queue - after1.queue,
  };
  console.log("Step 3: drift between runs:", drift);

  const allZero = Object.values(drift).every((v) => v === 0);
  if (allZero) {
    console.log("PASS — replay is idempotent.");
  } else {
    console.log("FAIL — second replay changed DB state.");
    process.exit(1);
  }

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
