/**
 * Behavioral eval for PR-F8 dedup adjudication.
 *
 * Runs live extraction plus the focused dedup pass with a fixed known set:
 * {OW Tourism Recovery Dashboard, Maaden Dashboard, Maaden Sites}. Prints each
 * project/product mention's extracted name, chosen handle, and final canonical
 * name. Writes NOTHING to the database; it only reads the configured Gemini key.
 *
 * LEADS ON THE NO-OVER-MERGE CHECK: tourism short forms may resolve to the
 * tourism dashboard, Maaden Dashboard must not collapse into Maaden Sites,
 * Maaden Sites must not collapse into Maaden Dashboard, and War Dashboard must
 * not collapse into the tourism dashboard.
 *
 *   tsx scripts/eval-dedup-adjudication.ts
 */
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { createGeminiGenerator } from "../src/connectors/gemini-generate";
import { adjudicateKnownMatches, extractEntities } from "../src/connectors/smart-enrichment";
import type { DB } from "../src/db/schema";

const DB_PATH = "/Users/hkalra/projects/claude/sketch/data/sketch.db";
const EXPERIMENTAL = true;
const TOURISM = "OW Tourism Recovery Dashboard";
const MAADEN_DASHBOARD = "Maaden Dashboard";
const MAADEN_SITES = "Maaden Sites";

const KNOWN = [
  { name: TOURISM, type: "project" },
  { name: MAADEN_DASHBOARD, type: "project" },
  { name: MAADEN_SITES, type: "project" },
];

const ANCHOR_NAMES = ["Oliver Wyman", "OW", "Canvasx", "Maaden", "Ma'aden"];

type EvalMention = {
  original: string;
  finalName: string;
  matchesKnown?: string;
};

const CASES: Array<{
  label: string;
  content: string;
  isOverMerge: (mention: EvalMention) => boolean;
}> = [
  {
    label: "tourism doc",
    content: `Kickoff notes: OW Tourism Recovery Dashboard.
The team reviewed the tourism dashboard scope with Oliver Wyman. The dashboard
tracks inbound visitor arrivals, hotel occupancy, and aviation capacity for the
tourism board. Next sprint covers the arrivals data pipeline and occupancy
heatmap on the tourism dashboard.`,
    isOverMerge: (mention) => mention.finalName === MAADEN_DASHBOARD || mention.finalName === MAADEN_SITES,
  },
  {
    label: "maaden mining doc",
    content: `Kickoff notes: Maaden Dashboard and Maaden Sites.
The team reviewed the Maaden Dashboard scope with the Maaden mining group. The
dashboard tracks phosphate output, ore-grade trends, and haul-truck utilization.
The separate Maaden Sites workstream tracks site onboarding, field readiness,
and access planning across the mine sites.`,
    isOverMerge: (mention) => {
      const normalizedOriginal = mention.original.toLowerCase();
      if (mention.finalName === TOURISM) return true;
      if (normalizedOriginal.includes("dashboard") && mention.finalName === MAADEN_SITES) return true;
      return normalizedOriginal.includes("sites") && mention.finalName === MAADEN_DASHBOARD;
    },
  },
  {
    label: "war room doc",
    content: `War room operating notes.
The War Dashboard tracks incident status, escalation owners, and launch-blocking
issues for the internal release command center. It is unrelated to tourism,
Oliver Wyman, or the Maaden mining workstreams.`,
    isOverMerge: (mention) => mention.finalName === TOURISM,
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

    const result = await extractEntities(generator, file, null, KNOWN, undefined, undefined, EXPERIMENTAL);
    const rewrites = await adjudicateKnownMatches(generator, result.mentions, KNOWN, {
      fileId: file.id,
      anchorNames: ANCHOR_NAMES,
    });

    console.log(`${"#".repeat(70)}\n# ${c.label}`);
    console.log("#".repeat(70));
    const mentions = result.mentions
      .filter((m) => m.type === "project" || m.type === "product")
      .map((m) => ({
        original: m.mention,
        finalName: rewrites.get(m.mention) ?? m.mention,
        matchesKnown: m.matchesKnown,
      }));

    for (const mention of mentions) {
      console.log(
        `  [project/product] extracted="${mention.original}"  handle=${mention.matchesKnown ?? "none"}  final="${mention.finalName}"`,
      );
      if (!c.isOverMerge(mention)) continue;
      pass = false;
      console.log("  FALSE MERGE detected");
    }
    if (!mentions.some(c.isOverMerge)) {
      console.log("  no over-merge detected");
    }
    console.log("");
  }

  console.log(pass ? "RESULT: PASS (no over-merge)" : "RESULT: FAIL (over-merge detected)");
  await db.destroy();
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
