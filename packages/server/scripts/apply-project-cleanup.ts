/**
 * Phase 2 of PROJECT_ENTITY_CLEANUP.md: apply human-approved project cleanup
 * verdicts to Postgres. Dry-run is the default and prints the resolved
 * mutation plan; --execute performs the writes in one transaction and writes
 * a rollback manifest under data/cleanup-apply/.
 *
 *   tsx scripts/apply-project-cleanup.ts [--verdicts <file>] [--manifest-dir <dir>] [--execute]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "../src/db/schema";
import type { CleanupVerdict } from "../src/entities/cleanup-adjudication";
import { applyProjectCleanup } from "../src/entities/cleanup-apply";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: join(ROOT, ".env") });

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function loadVerdicts(path: string): CleanupVerdict[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (Array.isArray(parsed)) return parsed as CleanupVerdict[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { projects?: unknown }).projects)) {
    return (parsed as { projects: CleanupVerdict[] }).projects;
  }
  throw new Error("verdict file must be an array or an object with projects");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const verdictPath = resolve(ROOT, argValue("--verdicts") ?? "data/cleanup-verdicts.json");
  const manifestDir = resolve(ROOT, argValue("--manifest-dir") ?? "data/cleanup-apply");
  const execute = process.argv.includes("--execute");
  const verdicts = loadVerdicts(verdictPath);
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }) }),
  });

  try {
    const result = await applyProjectCleanup(db, verdicts, { execute, verdictPath });
    console.log(execute ? `EXECUTE ${result.runId}` : `DRY RUN ${result.runId}`);
    for (const row of result.rows) {
      console.log(
        JSON.stringify({
          entityId: row.entityId,
          name: row.name,
          action: row.action,
          state: row.state,
          targetEntityId: row.targetEntityId,
          resolvedTargetEntityId: row.resolvedTargetEntityId,
          reason: row.reason,
          wouldChange: row.wouldChange,
        }),
      );
    }
    console.log(JSON.stringify({ counts: result.counts }, null, 2));
    if (result.manifest) {
      mkdirSync(manifestDir, { recursive: true });
      const manifestPath = join(manifestDir, `${result.runId}.json`);
      writeFileSync(manifestPath, JSON.stringify(result.manifest, null, 2));
      console.log(`manifest: ${manifestPath}`);
    } else {
      console.log("manifest: dry-run");
    }
    if (result.rows.some((row) => row.state === "failed")) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
