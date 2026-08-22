/**
 * Weekly-pass eval harness: scores a persisted weekly mint run against a
 * goldens file, from what the run itself recorded (disposition trace payloads
 * plus the verdict JSON they point to). Current graph or queue state is never
 * judge evidence — acceptance resolving rows cannot mask a judge miss.
 * Pre-existing accepted entities are reported as a separate context line.
 *
 *   tsx scripts/eval-weekly-pass.ts --goldens <path> [--run <runId>]
 *   tsx scripts/eval-weekly-pass.ts --export <file> [--run <runId>]
 *   tsx scripts/eval-weekly-pass.ts --goldens <path> --baseline <exported.json>
 *
 * A/B protocol (runs are week-keyed; a rerun deletes the prior attempt's
 * events and traces, so two configurations can never coexist in one DB):
 *   1. restore the pre-run DB dump
 *   2. run config A (dev-tools → Run pass), then --export a.json
 *   3. restore the dump again, run config B
 *   4. --goldens <path> --baseline a.json  → per-metric delta
 *
 * Reads the local Postgres directly via DATABASE_URL with its own pool —
 * createDatabase() forces ssl on Postgres, which local dev postgres refuses.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { GroupDisposition } from "../src/connectors/weekly-mint";
import {
  type ContainerEvidence,
  type RunEvidence,
  type WeeklyPassGoldens,
  type WeeklyPassScores,
  diffScores,
  scoreRun,
} from "../src/connectors/weekly-pass-eval";
import { whereLiveEntity } from "../src/db/repositories/entities";
import type { DB } from "../src/db/schema";
import { normalizeName } from "../src/entities/name-keys";

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function parsePayload(payload: string | null): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function gatherEvidence(db: Kysely<DB>, runId: string | null): Promise<RunEvidence> {
  const run = runId
    ? await db.selectFrom("weekly_mint_runs").selectAll().where("id", "=", runId).executeTakeFirst()
    : await db
        .selectFrom("weekly_mint_runs")
        .selectAll()
        .where("status", "=", "completed")
        .orderBy("clock_week", "desc")
        .limit(1)
        .executeTakeFirst();
  if (!run) throw new Error(runId ? `run ${runId} not found` : "no completed weekly mint run found");

  const traces = await db
    .selectFrom("weekly_mint_traces")
    .selectAll()
    .where("run_id", "=", run.id)
    .orderBy("container_key", "asc")
    .orderBy("seq", "asc")
    .execute();

  const byContainer = new Map<string, typeof traces>();
  for (const trace of traces) {
    const rows = byContainer.get(trace.container_key);
    if (rows) rows.push(trace);
    else byContainer.set(trace.container_key, [trace]);
  }

  let judgeMode: string | null = null;
  let model: string | null = null;
  let promptVersion: string | null = null;
  const containers: ContainerEvidence[] = [];
  for (const [containerKey, rows] of byContainer) {
    const promptPayload = parsePayload(rows.find((row) => row.kind === "prompt")?.payload ?? null);
    judgeMode = typeof promptPayload.judgeMode === "string" ? promptPayload.judgeMode : judgeMode;
    model = typeof promptPayload.model === "string" ? promptPayload.model : model;
    promptVersion = typeof promptPayload.promptVersion === "string" ? promptPayload.promptVersion : promptVersion;
    const dispositionPayload = parsePayload(rows.find((row) => row.kind === "disposition")?.payload ?? null);
    const dispositions = Array.isArray(dispositionPayload.groups)
      ? (dispositionPayload.groups as GroupDisposition[])
      : [];
    const verdictId = typeof dispositionPayload.verdictId === "string" ? dispositionPayload.verdictId : null;
    let verdictProjects: ContainerEvidence["verdictProjects"] = [];
    let companyName: string | null = null;
    if (verdictId) {
      const verdictRow = await db
        .selectFrom("project_minting_verdicts")
        .select(["verdict", "company_name"])
        .where("id", "=", verdictId)
        .executeTakeFirst();
      companyName = verdictRow?.company_name ?? null;
      const verdict = parsePayload(verdictRow?.verdict ?? null);
      if (Array.isArray(verdict.projects)) {
        verdictProjects = (verdict.projects as Array<{ name?: unknown; parentName?: unknown }>)
          .filter((project) => typeof project.name === "string")
          .map((project) => ({
            name: project.name as string,
            parentName: typeof project.parentName === "string" ? project.parentName : null,
          }));
      }
    }
    containers.push({
      containerKey,
      companyName,
      dispositions,
      verdictId,
      verdictProjects,
      toolCalls: rows.filter((row) => row.kind === "tool_call").length,
      rounds: null,
    });
  }
  return { runId: run.id, judgeMode, model, promptVersion, containers };
}

async function acceptedContext(db: Kysely<DB>, goldens: WeeklyPassGoldens): Promise<string[]> {
  const rows = await db
    .selectFrom("entities")
    .select(["name"])
    .where("source_type", "=", "project")
    .where(whereLiveEntity())
    .execute();
  const accepted = new Set(rows.map((row) => normalizeName(row.name)));
  return goldens.projects
    .filter((golden) => [golden.name, ...(golden.aliases ?? [])].some((name) => accepted.has(normalizeName(name))))
    .map((golden) => golden.name);
}

function printScores(scores: WeeklyPassScores): void {
  const line = (label: string, metric: { hit: number; total: number; failing: string[] }) =>
    console.log(
      `  ${label}: ${metric.hit}/${metric.total}${metric.failing.length ? `  failing: ${metric.failing.join(", ")}` : ""}`,
    );
  line("recall        ", scores.recall);
  line("junk          ", scores.junk);
  line("nesting       ", scores.nesting);
  line("alias judgment", scores.aliasJudgment);
  console.log(
    `  tool usage    : ${scores.toolUsage.totalToolCalls} calls across ${scores.toolUsage.containersWithTools} containers, ${scores.toolUsage.dispositionsCitingLookup} dispositions via lookup`,
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }) }),
  });
  try {
    const evidence = await gatherEvidence(db, argValue("--run"));
    console.log(
      `run ${evidence.runId}  judgeMode=${evidence.judgeMode ?? "single"}  model=${evidence.model ?? "?"}  prompt=${evidence.promptVersion ?? "?"}`,
    );

    const exportPath = argValue("--export");
    if (exportPath) {
      writeFileSync(exportPath, JSON.stringify(evidence, null, 2));
      console.log(`exported evidence to ${exportPath}`);
      return;
    }

    const goldensPath = argValue("--goldens");
    if (!goldensPath) throw new Error("--goldens <path> is required unless --export is used");
    const goldens = JSON.parse(readFileSync(goldensPath, "utf8")) as WeeklyPassGoldens;
    const scores = scoreRun(evidence, goldens);
    console.log(`scores vs ${goldens.company} goldens:`);
    printScores(scores);

    const context = await acceptedContext(db, goldens);
    if (context.length > 0) {
      console.log(`  context: already accepted in graph (not judge credit): ${context.join(", ")}`);
    }

    const baselinePath = argValue("--baseline");
    if (baselinePath) {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as RunEvidence;
      const baselineScores = scoreRun(baseline, goldens);
      console.log(`baseline run ${baseline.runId} (judgeMode=${baseline.judgeMode ?? "single"}):`);
      printScores(baselineScores);
      console.log("delta (current - baseline):");
      for (const delta of diffScores(scores, baselineScores)) {
        console.log(
          `  ${delta.metric}: ${delta.current} vs ${delta.baseline} (${delta.delta >= 0 ? "+" : ""}${delta.delta})`,
        );
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
