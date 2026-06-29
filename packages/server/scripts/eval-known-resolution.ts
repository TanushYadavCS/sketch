/**
 * Behavioral eval for PR-F7 known-entity resolution (matchesKnown).
 *
 * Runs the live `extractEntities` prompt with a fixed known set
 * {Tourism Dashboard, Maaden Dashboard} against two crafted documents — one
 * clearly about the tourism dashboard, one clearly about the Ma'aden mining
 * dashboard — and prints, per mention, the handle the model chose plus the
 * post-rewrite canonical name.
 *
 * LEADS ON THE FALSE-MERGE CHECK: the tourism doc must resolve to Tourism (not
 * Maaden) and the Ma'aden doc to Maaden (not Tourism). Never cross-mapped.
 *
 * Read-only: uses only the configured Gemini key, writes NOTHING.
 *
 *   tsx scripts/eval-known-resolution.ts
 */
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { createGeminiGenerator } from "../src/connectors/gemini-generate";
import { extractEntities } from "../src/connectors/smart-enrichment";
import type { DB } from "../src/db/schema";

const DB_PATH = "/Users/hkalra/projects/claude/sketch/data/sketch.db";
const EXPERIMENTAL = true;

const KNOWN: Array<{ name: string; type: string }> = [
  { name: "Tourism Dashboard", type: "project" },
  { name: "Maaden Dashboard", type: "project" },
];

const CASES: Array<{ label: string; content: string; expect: string; forbid: string }> = [
  {
    label: "tourism doc",
    expect: "Tourism Dashboard",
    forbid: "Maaden Dashboard",
    content: `Kickoff notes — OW x Canvasx Tourism Recovery Dashboard.
The team reviewed the tourism recovery dashboard scope with Oliver Wyman. The
dashboard tracks inbound visitor arrivals, hotel occupancy, and aviation
capacity for the tourism board. Next sprint covers the arrivals data pipeline
and the occupancy heatmap on the tourism dashboard.`,
  },
  {
    label: "ma'aden doc",
    expect: "Maaden Dashboard",
    forbid: "Tourism Dashboard",
    content: `Kickoff notes — Ma'aden Mining Operations Dashboard.
The team reviewed the Ma'aden dashboard scope with the Ma'aden mining group. The
dashboard tracks phosphate output, ore-grade trends, and haul-truck utilization
across the mine sites. Next sprint covers the production-tonnage feed and the
ore-grade chart on the Ma'aden dashboard.`,
  },
];

async function main() {
  const sqliteDb = new Database(DB_PATH, { readonly: true });
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqliteDb }) });

  const settings = await db
    .selectFrom("settings")
    .select(["gemini_api_key"])
    .where("id", "=", "default")
    .executeTakeFirstOrThrow();
  if (!settings.gemini_api_key) throw new Error("no gemini_api_key in settings");
  const generator = createGeminiGenerator(settings.gemini_api_key);

  console.log(`Known set: ${KNOWN.map((k, i) => `[K${i + 1}] ${k.name}`).join("  ")}\n`);

  let pass = true;
  for (const c of CASES) {
    const file = {
      id: `eval-${c.label}`,
      fileName: `${c.label}.txt`,
      content: c.content,
      threadContext: null,
      contentCategory: "document",
      fileType: "document",
      source: "eval",
      sourcePath: "/",
      contentHash: null,
      connectorConfigId: "eval",
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
    };

    const result = await extractEntities(generator, file as never, null, KNOWN, undefined, undefined, EXPERIMENTAL);

    console.log(`${"#".repeat(70)}\n# ${c.label} — expect resolves to "${c.expect}", never "${c.forbid}"`);
    console.log("#".repeat(70));
    const projects = result.mentions.filter((m) => m.type === "project");
    for (const m of projects) {
      console.log(`  [project] name="${m.mention}"  matchesKnown=${m.matchesKnown ?? "—"}`);
    }
    const mappedToForbidden = projects.some((m) => m.mention === c.forbid);
    const mappedToExpected = projects.some((m) => m.mention === c.expect);
    if (mappedToForbidden) {
      pass = false;
      console.log(`  ❌ FALSE MERGE: a mention resolved to "${c.forbid}"`);
    } else {
      console.log(`  ✅ no cross-map to "${c.forbid}"`);
    }
    console.log(`  ${mappedToExpected ? "✅ resolved" : "·  did not resolve"} to "${c.expect}"\n`);
  }

  console.log(pass ? "RESULT: PASS (no cross-map)" : "RESULT: FAIL (cross-map detected)");
  await db.destroy();
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
