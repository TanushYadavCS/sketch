import { parseArgs } from "node:util";
import type { Kysely } from "kysely";
import { loadConfig, validateConfig } from "../config";
import { createDatabase } from "../db";
import { runMigrations } from "../db/migrate";
import type { DB } from "../db/schema";

export interface FeatureSubEntityCleanupOptions {
  execute?: boolean;
}

export interface FeatureSubEntityCleanupResult {
  mode: "dry-run" | "execute";
  counts: {
    featureSubEntities: number;
    featureEvidenceRowsBefore: number;
    deletedSubEntities: number;
    remainingFeatureSubEntities: number;
    featureEvidenceRowsAfter: number;
  };
}

export async function runFeatureSubEntityCleanup(
  db: Kysely<DB>,
  options: FeatureSubEntityCleanupOptions = {},
): Promise<FeatureSubEntityCleanupResult> {
  const execute = options.execute === true;
  const beforeIds = await listFeatureSubEntityIds(db);
  const featureEvidenceRowsBefore = await countEvidenceRows(db, beforeIds);
  let deletedSubEntities = 0;

  if (execute && beforeIds.length > 0) {
    const result = await db.deleteFrom("sub_entities").where("kind", "=", "feature").executeTakeFirst();
    deletedSubEntities = Number(result.numDeletedRows ?? 0);
  }

  const afterIds = await listFeatureSubEntityIds(db);
  const featureEvidenceRowsAfter = await countEvidenceRows(db, beforeIds);

  return {
    mode: execute ? "execute" : "dry-run",
    counts: {
      featureSubEntities: beforeIds.length,
      featureEvidenceRowsBefore,
      deletedSubEntities,
      remainingFeatureSubEntities: afterIds.length,
      featureEvidenceRowsAfter,
    },
  };
}

async function listFeatureSubEntityIds(db: Kysely<DB>): Promise<string[]> {
  const rows = await db.selectFrom("sub_entities").select("id").where("kind", "=", "feature").execute();
  return rows.map((row) => row.id);
}

async function countEvidenceRows(db: Kysely<DB>, subEntityIds: string[]): Promise<number> {
  if (subEntityIds.length === 0) return 0;
  const row = await db
    .selectFrom("sub_entity_evidence")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("sub_entity_id", "in", subEntityIds)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

function printResult(result: FeatureSubEntityCleanupResult): void {
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      execute: { type: "boolean", default: false },
    },
  });
  const config = loadConfig();
  validateConfig(config);
  const db = await createDatabase(config);
  try {
    await runMigrations(db);
    printResult(await runFeatureSubEntityCleanup(db, { execute: parsed.values.execute }));
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
