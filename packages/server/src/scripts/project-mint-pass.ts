/**
 * Runs the project-minting pass (cluster → dossier → verdict) and writes the
 * artifacts to disk so a human can read each verdict against its dossier.
 *
 * Read-only against the entity graph by construction. Verdict rows are only
 * written with --store (the table ships in migration 167 and the pass is
 * exercised against it in tests); without the flag the run leaves the
 * database untouched.
 *
 *   tsx src/scripts/project-mint-pass.ts --list                 # clusters only, no LLM
 *   tsx src/scripts/project-mint-pass.ts --dossiers-only        # stages 1–2, no LLM
 *   tsx src/scripts/project-mint-pass.ts                        # full pass, verdicts to disk
 *   tsx src/scripts/project-mint-pass.ts --company oliver       # one cluster
 *   tsx src/scripts/project-mint-pass.ts --all                  # include untriggered clusters
 *   tsx src/scripts/project-mint-pass.ts --out /tmp/somewhere   # redirect output
 *
 * Stage 3 must never run on the enrichment-tier model: the generator is
 * always OpenRouter with PROJECT_MINTING_MODEL or the workspace's configured
 * reasoning model, reasoning effort capped at medium.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config";
import { resolveOpenRouterEnrichmentConfig } from "../connectors/enrichment-providers";
import { createOpenRouterGenerator } from "../connectors/openrouter-generate";
import {
  type ClusterPassResult,
  buildClusterDossier,
  clusterClientFiles,
  runProjectMintingPass,
} from "../connectors/project-minting";
import { createDatabase } from "../db/index";
import { createSettingsRepository } from "../db/repositories/settings";
import { createLogger } from "../logger";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = await createDatabase(config);

  const listOnly = hasFlag("list");
  const dossiersOnly = hasFlag("dossiers-only");
  const store = hasFlag("store");
  const includeUntriggered = hasFlag("all");
  const minFiles = Number(arg("min-files", "2"));
  const companyTerms = arg("company")
    ?.toLowerCase()
    .split(",")
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  const companyMatches = (name: string) =>
    !companyTerms || companyTerms.some((term) => name.toLowerCase().includes(term));
  const votes = Math.max(1, Number(arg("votes", "1")));
  const limit = Number(arg("limit", "0"));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = arg("out") ?? join("data", "project-minting", stamp);

  const clusters = await clusterClientFiles(db, { minFiles });
  const selected = clusters
    .filter((cluster) => includeUntriggered || cluster.triggered)
    .filter((cluster) => companyMatches(cluster.companyName));
  const capped = limit > 0 ? selected.slice(0, limit) : selected;

  console.log(`${clusters.length} clusters (min ${minFiles} files), ${selected.length} selected\n`);
  for (const cluster of capped) {
    const signals = new Set(cluster.files.flatMap((file) => file.via));
    const shards =
      cluster.groupMembers.length > 1 ? `  shards: ${cluster.groupMembers.map((m) => m.name).join(" + ")}` : "";
    console.log(
      `  ${String(cluster.files.length).padStart(4)}  ${cluster.triggered ? "T" : " "}  ${cluster.companyName}` +
        `  [${[...signals].sort().join(", ")}]${shards}${cluster.channels.length > 0 ? `  channels: ${cluster.channels.map((c) => c.name).join(", ")}` : ""}`,
    );
  }
  if (listOnly) {
    await db.destroy();
    return;
  }

  await mkdir(outDir, { recursive: true });

  if (dossiersOnly) {
    for (const cluster of capped) {
      const dossier = await buildClusterDossier(db, cluster);
      const file = join(outDir, `${slug(cluster.companyName)}.dossier.md`);
      await writeFile(file, dossier.markdown, "utf8");
      console.log(`\n${cluster.companyName}: ${dossier.markdown.length} chars → ${file}`);
    }
    await db.destroy();
    return;
  }

  const settings = await createSettingsRepository(db, config.ENCRYPTION_KEY).get();
  const openRouterConfig = resolveOpenRouterEnrichmentConfig(settings, config.OPENROUTER_API_KEY);
  const model = arg("model") ?? config.PROJECT_MINTING_MODEL ?? openRouterConfig.openRouterModel;
  if (!openRouterConfig.openRouterApiKey || !model) {
    throw new Error(
      "Stage 3 needs an OpenRouter key and a reasoning-tier model (PROJECT_MINTING_MODEL or workspace settings)",
    );
  }
  const generator = createOpenRouterGenerator(openRouterConfig.openRouterApiKey, {
    model,
    reasoningEffort: "medium",
    timeoutMs: 300_000,
  });

  const started = Date.now();
  const pass = await runProjectMintingPass({
    db,
    logger,
    generator,
    model,
    dumpDir: join(outDir, "dumps"),
    storeVerdicts: store,
    onlyTriggered: !includeUntriggered,
    minFiles,
    votes,
    ...(companyTerms ? { companyFilter: companyMatches } : {}),
  });
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

  const summary: string[] = [
    `# Project minting pass — ${stamp}`,
    "",
    `model: ${model} · votes ${votes} · ${elapsedSec}s`,
    "",
  ];
  const takeLimit = limit > 0 ? pass.results.slice(0, limit) : pass.results;
  for (const result of takeLimit) {
    await writeResult(outDir, result);
    const verdict = result.verdict;
    const agreement = result.voteStats
      ? ` · state agreement ${result.voteStats.stateAgreement.toFixed(2)}, project set ${result.voteStats.projectSetAgreement.toFixed(2)}`
      : "";
    const tripwire = result.tripwireFlags?.length ? ` · TRIPWIRE ${result.tripwireFlags.join("; ")}` : "";
    const line = verdict
      ? `${verdict.relationshipState} · ${verdict.projects.length} projects · trackerFit ${verdict.trackerFit}${agreement}${tripwire}`
      : `ERROR ${result.error}`;
    console.log(`\n${result.companyName} (${result.fileCount} files): ${line}`);
    summary.push(`## ${result.companyName}`, "", `${result.fileCount} files · ${line}`, "");
    if (verdict) {
      for (const project of verdict.projects) {
        summary.push(`- **${project.name}** — ${project.status}, ${project.confidence}`);
        console.log(`   + ${project.name} [${project.status}, ${project.confidence}]`);
      }
      summary.push("");
    }
  }
  await writeFile(join(outDir, "summary.md"), summary.join("\n"), "utf8");
  console.log(`\n${outDir}/summary.md`);
  await db.destroy();
}

async function writeResult(outDir: string, result: ClusterPassResult): Promise<void> {
  const base = slug(result.companyName);
  await writeFile(join(outDir, `${base}.dossier.md`), result.dossier.markdown, "utf8");
  if (result.verdict) {
    await writeFile(join(outDir, `${base}.verdict.json`), JSON.stringify(result.verdict, null, 2), "utf8");
  }
  if (result.voteStats) {
    await writeFile(join(outDir, `${base}.votes.json`), JSON.stringify(result.voteStats, null, 2), "utf8");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
