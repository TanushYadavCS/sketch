import { randomUUID } from "node:crypto";
/**
 * Phase 1 of PROJECT_ENTITY_CLEANUP.md: run the agentic judge over the
 * Phase-0 report and write one verdict per live project to a JSON file the
 * human reviews (flip `approved` to true) before the Phase-2 apply CLI ever
 * mutates anything. This script writes NOTHING to the database — its only
 * outputs are the verdict file and per-group transcript files under
 * data/cleanup-traces/ (local files instead of the dev-tools trace table, so
 * the adjudication pass stays strictly read-only against prod).
 *
 *   tsx scripts/adjudicate-project-cleanup.ts [--report <file>] [--out <file>]
 *     [--group <substring>] [--dry-prompt]
 *
 * --group limits the run to groups whose key or company label contains the
 * substring (case-insensitive) — for cheap spot runs. --dry-prompt prints the
 * prompts and exits without calling the model.
 *
 * The lookup_name tool runs with exact-name matching only (no embedding
 * provider is constructed here); the judge still sees every in-group sibling
 * in full, so fuzzy lookup is an upgrade, not a requirement.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { resolveOpenRouterEnrichmentConfig } from "../src/connectors/enrichment-providers";
import { type AgenticToolStep, createOpenRouterGenerator } from "../src/connectors/openrouter-generate";
import { lookupNameForJudge } from "../src/connectors/weekly-mint";
import { whereLiveEntity } from "../src/db/repositories/entities";
import { createSettingsRepository } from "../src/db/repositories/settings";
import type { DB } from "../src/db/schema";
import {
  type CleanupReportProject,
  type CleanupVerdict,
  type TargetContext,
  UNKNOWN_GROUP_KEY,
  buildAdjudicationPrompt,
  groupForAdjudication,
  makeGroupKeyForCompany,
  splitMechanicalKeepers,
  validateGroupVerdicts,
} from "../src/entities/cleanup-adjudication";
import { buildCompanyDedupGroups, loadCompanyDedupMembers } from "../src/entities/company-dedup-groups";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: join(ROOT, ".env") });

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const reportPath = argValue("--report") ?? join(ROOT, "data/project-cleanup-report.json");
  const outPath = argValue("--out") ?? join(ROOT, "data/cleanup-verdicts.json");
  const groupFilter = argValue("--group")?.toLowerCase() ?? null;
  const dryPrompt = process.argv.includes("--dry-prompt");

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { projects: CleanupReportProject[] };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }) }),
  });
  try {
    const settings = await createSettingsRepository(db, process.env.ENCRYPTION_KEY).get();
    const openRouter = resolveOpenRouterEnrichmentConfig(settings, process.env.OPENROUTER_API_KEY);
    const model = process.env.PROJECT_MINTING_MODEL ?? openRouter.openRouterModel;
    if (!dryPrompt && (!openRouter.openRouterApiKey || !model)) {
      throw new Error(
        "No OpenRouter key/model resolved from settings or env (OPENROUTER_API_KEY, PROJECT_MINTING_MODEL)",
      );
    }
    const generator =
      !dryPrompt && openRouter.openRouterApiKey
        ? createOpenRouterGenerator(openRouter.openRouterApiKey, {
            model: model ?? undefined,
            reasoningEffort: "medium",
            timeoutMs: 300_000,
          })
        : null;

    const dedupGroups = buildCompanyDedupGroups(await loadCompanyDedupMembers(db));
    const memberNamesByGroup = new Map<string, string[]>();
    dedupGroups.forEach((group, index) => {
      memberNamesByGroup.set(
        `g${index}`,
        group.members.map((member) => member.name),
      );
    });
    const groupKeyForCompany = makeGroupKeyForCompany(memberNamesByGroup);

    const { mechanical, judged } = splitMechanicalKeepers(report.projects);
    const allGroups = groupForAdjudication(judged, groupKeyForCompany);
    const groups = groupFilter
      ? allGroups.filter(
          (group) =>
            group.key.toLowerCase().includes(groupFilter) || group.companyLabel.toLowerCase().includes(groupFilter),
        )
      : allGroups;

    const snippetRows = judged.length
      ? await db
          .selectFrom("entity_mentions")
          .select(["entity_id", "context_snippet"])
          .where(
            "entity_id",
            "in",
            judged.map((project) => project.entityId),
          )
          .where("context_snippet", "is not", null)
          .orderBy("mentioned_at", "desc")
          .execute()
      : [];
    const snippets = new Map<string, string[]>();
    for (const row of snippetRows) {
      if (!row.context_snippet) continue;
      const list = snippets.get(row.entity_id) ?? [];
      if (list.length < 3) list.push(row.context_snippet);
      snippets.set(row.entity_id, list);
    }

    const liveRows = await db
      .selectFrom("entities")
      .select(["id", "name"])
      .where("source_type", "=", "project")
      .where(whereLiveEntity())
      .execute();
    const engagements = await db
      .selectFrom("entity_relationships as r")
      .innerJoin("entities as c", "c.id", "r.target_entity_id")
      .select(["r.source_entity_id as projectId", "c.name as company"])
      .where("r.relationship_type", "=", "engagement_for")
      .execute();
    const groupKeyByProject = new Map<string, string>();
    for (const edge of engagements) groupKeyByProject.set(edge.projectId, groupKeyForCompany(edge.company));
    const liveTargets: TargetContext["liveTargets"] = new Map(
      liveRows.map((row) => [row.id, { name: row.name, groupKey: groupKeyByProject.get(row.id) ?? null }]),
    );

    const partOfRows = await db
      .selectFrom("entity_relationships")
      .select(["source_entity_id", "target_entity_id"])
      .where("relationship_type", "=", "part_of")
      .execute();
    const partOfParent = new Map(partOfRows.map((row) => [row.source_entity_id, row.target_entity_id]));

    if (dryPrompt) {
      for (const group of groups) {
        console.log(`\n===== group ${group.key} (${group.companyLabel}, ${group.projects.length} projects) =====`);
        console.log(buildAdjudicationPrompt(group, snippets));
      }
      console.log(`\n${mechanical.length} mechanical keepers, ${groups.length} groups would be judged.`);
      return;
    }
    if (!generator || !model) throw new Error("generator unavailable");

    const runId = randomUUID();
    const tracesDir = join(ROOT, "data/cleanup-traces");
    mkdirSync(tracesDir, { recursive: true });

    const verdicts: CleanupVerdict[] = [...mechanical];
    for (const group of groups) {
      const prompt = buildAdjudicationPrompt(group, snippets);
      const toolSteps: AgenticToolStep[] = [];
      const surfacedIds = new Set<string>();
      let raw: unknown = null;
      let failure: string | null = null;
      try {
        const outcome = await generator.generateAgenticJSON<unknown>(prompt, {
          maxTokens: 12_000,
          label: `cleanupAdjudicate:${group.key}`,
          model,
          reasoningEffort: "medium",
          thinkingBudget: null,
          tools: [
            {
              name: "lookup_name",
              description:
                "Look up a project name across all live projects and the pending candidate pool. Returns matching projects with entity ids usable as targetEntityId.",
              parameters: {
                type: "object",
                properties: { name: { type: "string", description: "the project name to look up" } },
                required: ["name"],
              },
              run: async (args) => {
                const name =
                  args && typeof args === "object" && typeof (args as { name?: unknown }).name === "string"
                    ? (args as { name: string }).name
                    : null;
                if (!name) throw new Error("lookup_name requires a name argument");
                const result = await lookupNameForJudge(db, null, name);
                for (const project of result.projects) surfacedIds.add(project.entityId);
                return JSON.stringify(result);
              },
            },
          ],
          maxToolRounds: 4,
          onToolStep: (step) => {
            toolSteps.push(step);
          },
        });
        raw = outcome.value;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }

      const verifiedSurfaced = new Set<string>([...surfacedIds].filter((id) => liveTargets.has(id)));
      const groupVerdicts = failure
        ? validateGroupVerdicts(group, null, { liveTargets, surfacedIds: verifiedSurfaced, partOfParent })
        : validateGroupVerdicts(group, raw, { liveTargets, surfacedIds: verifiedSurfaced, partOfParent });
      verdicts.push(...groupVerdicts);

      writeFileSync(
        join(tracesDir, `${group.key.replace(/[^a-z0-9_-]/gi, "_")}.json`),
        JSON.stringify({ runId, group: group.key, prompt, toolSteps, raw, failure }, null, 2),
      );
      const flagged = groupVerdicts.filter((verdict) => verdict.validation === "needs_human_fix").length;
      console.log(
        `${group.key} (${group.companyLabel}): ${groupVerdicts.length} verdicts${flagged ? `, ${flagged} needs_human_fix` : ""}${failure ? ` — MODEL FAILURE: ${failure}` : ""}`,
      );
    }

    writeFileSync(
      outPath,
      JSON.stringify({ runId, generatedAt: new Date().toISOString(), model, reportPath, projects: verdicts }, null, 2),
    );

    const byAction = new Map<string, number>();
    for (const verdict of verdicts) byAction.set(verdict.action, (byAction.get(verdict.action) ?? 0) + 1);
    console.log(`\n${verdicts.length} verdicts → ${outPath}`);
    for (const [action, count] of [...byAction.entries()].sort()) console.log(`  ${action}: ${count}`);
    const unknownGroup = groups.find((group) => group.key === UNKNOWN_GROUP_KEY);
    if (unknownGroup) console.log(`  (unknown-company group held ${unknownGroup.projects.length} projects)`);
    console.log("\nReview the file, flip approved: true on verdicts to execute, then run the Phase-2 apply CLI.");
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
