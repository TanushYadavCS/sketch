/**
 * Declare a domainless company and optionally repoint project engagement_for
 * edges at it. The micro version of the cleanup apply layer: idempotent (upsert
 * by name; repoint no-ops when already correct) and prints a before/after
 * manifest for every edge it touches.
 *
 *   tsx scripts/declare-company.ts --name "One Stop AI" --aliases "One Stop,OSAI" \
 *     [--repoint <projectEntityId,projectEntityId>]
 *
 * Reads the local Postgres directly via DATABASE_URL with its own pool —
 * createDatabase() forces ssl on Postgres, which local dev postgres refuses.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "../src/db/schema";
import { declareCompany, repointEngagements } from "../src/entities/declare-company";

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

async function main(): Promise<void> {
  const name = argValue("--name");
  if (!name) throw new Error("--name is required");
  const aliases = (argValue("--aliases") ?? "")
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
  const repointIds = (argValue("--repoint") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }) }),
  });
  try {
    const { entityId } = await declareCompany(db, { name, aliases });
    console.log(`declared company: ${name} → ${entityId} (aliases: ${aliases.join(", ") || "none"})`);
    if (repointIds.length > 0) {
      const results = await repointEngagements(db, { projectEntityIds: repointIds, companyEntityId: entityId });
      for (const result of results) {
        console.log(
          `repoint ${result.projectEntityId}: ${result.action}` +
            (result.action === "repointed"
              ? ` (edge ${result.relationshipId}: ${result.oldTargetId} → ${entityId})`
              : ""),
        );
      }
      const refused = results.filter((result) => result.action === "no_engagement_edge");
      if (refused.length > 0) {
        console.error(
          `refused ${refused.length} project(s) with no engagement_for edge — backfill is a cleanup decision`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
