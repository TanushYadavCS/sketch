/**
 * One-off for 2026-08-21: the June "Arco" and "One stop" product entities hold
 * the real client evidence (120 and 4 files) while the declared company
 * entities hold none. Cross-type merges are blocked by design, so each pair is
 * fixed inside one transaction: flip the June entity's source_type to company,
 * then fold it into the declared company via the ledgered merge (unmerge-able
 * through entity_merges). Run with DATABASE_URL pointing at the target DB.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "../src/db/schema";
import { mergeEntitiesInTransaction } from "../src/entities/merge";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: join(ROOT, ".env") });

const PAIRS = [
  {
    label: "Arco",
    loserId: "a83cfed8-dfde-4094-a6bf-80d8335c47f3",
    survivorId: "3790a37d-c7d4-464a-a4b1-7a2184d63c15",
  },
  {
    label: "OneStop AI",
    loserId: "649cd9ce-a8ee-49c8-b9e0-40a7f1dd80f4",
    survivorId: "c9b1e0f1-8366-423c-b15f-7ff5c73200c0",
  },
];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }) }),
  });
  const record: Array<Record<string, unknown>> = [];
  try {
    for (const pair of PAIRS) {
      await db.transaction().execute(async (trx) => {
        const loser = await trx
          .selectFrom("entities")
          .select(["id", "name", "source_type", "deleted_at", "merged_into_entity_id"])
          .where("id", "=", pair.loserId)
          .executeTakeFirstOrThrow();
        const survivor = await trx
          .selectFrom("entities")
          .select(["id", "name", "source_type", "deleted_at", "merged_into_entity_id"])
          .where("id", "=", pair.survivorId)
          .executeTakeFirstOrThrow();
        if (loser.source_type !== "product" || loser.deleted_at || loser.merged_into_entity_id) {
          throw new Error(`${pair.label}: loser is not a live product entity (${loser.source_type})`);
        }
        if (survivor.source_type !== "company" || survivor.deleted_at || survivor.merged_into_entity_id) {
          throw new Error(`${pair.label}: survivor is not a live company entity (${survivor.source_type})`);
        }
        await trx
          .updateTable("entities")
          .set({ source_type: "company", updated_at: new Date().toISOString() })
          .where("id", "=", pair.loserId)
          .execute();
        const result = await mergeEntitiesInTransaction(trx, {
          survivorId: pair.survivorId,
          loserId: pair.loserId,
          mergedBy: "arco_onestop_reclassify",
        });
        record.push({
          label: pair.label,
          loser: { id: loser.id, name: loser.name, source_type_before: "product" },
          survivor: { id: survivor.id, name: survivor.name },
          mergeId: result.mergeId,
          moves: result.moves.length,
        });
        console.log(
          `${pair.label}: merged ${loser.name} (${loser.id}) -> ${survivor.name}, ${result.moves.length} moves, mergeId ${result.mergeId}`,
        );
      });
    }
    const outPath = join(ROOT, "data/cleanup-apply/arco-onestop-reclassify-merge.json");
    writeFileSync(outPath, JSON.stringify({ executedAt: new Date().toISOString(), record }, null, 2));
    console.log(`record: ${outPath}`);
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
