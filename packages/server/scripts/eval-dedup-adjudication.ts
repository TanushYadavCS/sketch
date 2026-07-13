/**
 * Behavioral eval for PR-F8 dedup adjudication.
 *
 * Runs live extraction plus the focused dedup pass with fixed and retrieved
 * known sets. Prints each project/product mention's extracted name, chosen
 * handle, and final canonical name. Writes NOTHING to the production database;
 * it only reads the configured Gemini key and uses an in-memory eval database.
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
import type { Config } from "../src/config";
import { createGeminiEmbeddingProvider } from "../src/connectors/embeddings/gemini";
import {
  reconcileMissingNameEmbeddings,
  retrieveNameDedupCandidates,
} from "../src/connectors/embeddings/trunk-name-embeddings";
import type { EmbeddingProvider } from "../src/connectors/embeddings/types";
import { createGeminiGenerator } from "../src/connectors/gemini-generate";
import {
  adjudicateKnownMatches,
  extractEntities,
  mergeKnownEntities,
  projectProductMentionNames,
} from "../src/connectors/smart-enrichment";
import { createDatabase } from "../src/db";
import { runMigrations } from "../src/db/migrate";
import type { DB } from "../src/db/schema";

const DB_PATH = "/Users/hkalra/projects/claude/sketch/data/sketch.db";
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

interface EvalDeps {
  generator: ReturnType<typeof createGeminiGenerator>;
  retrievalDb: Kysely<DB>;
  embeddingProvider: EmbeddingProvider;
}

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

function evalFile(label: string, content: string) {
  return {
    id: `eval-${label}`,
    fileName: `${label}.txt`,
    content,
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
}

function mentionSummaries(
  mentions: Array<{ mention: string; type: string; matchesKnown?: string }>,
  rewrites: Map<string, string>,
): EvalMention[] {
  return mentions
    .filter((m) => m.type === "project" || m.type === "product")
    .map((m) => ({
      original: m.mention,
      finalName: rewrites.get(`${m.type}:${m.mention}`) ?? m.mention,
      matchesKnown: m.matchesKnown,
    }));
}

async function seedProject(db: Kysely<DB>, id: string, name: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function createRetrievalDb(embeddingProvider: EmbeddingProvider): Promise<Kysely<DB>> {
  const db = await createDatabase({ DB_TYPE: "sqlite", SQLITE_PATH: ":memory:" } as Config);
  await runMigrations(db, { quiet: true });
  await seedProject(db, "eval-tourism", TOURISM);
  await seedProject(db, "eval-maaden-dashboard", MAADEN_DASHBOARD);
  await seedProject(db, "eval-maaden-sites", MAADEN_SITES);
  await reconcileMissingNameEmbeddings(db, embeddingProvider);
  return db;
}

async function runKnownCase(
  deps: EvalDeps,
  label: string,
  content: string,
  known = KNOWN,
  anchorNames = ANCHOR_NAMES,
): Promise<EvalMention[]> {
  const file = evalFile(label, content);
  const result = await extractEntities(deps.generator, file, null, known, undefined, undefined, EXPERIMENTAL);
  const rewrites = await adjudicateKnownMatches(deps.generator, result.mentions, known, {
    fileId: file.id,
    anchorNames,
  });
  return mentionSummaries(result.mentions, rewrites);
}

async function runRetrievedCase(
  deps: EvalDeps,
  label: string,
  content: string,
  provider: EmbeddingProvider,
  known = [] as typeof KNOWN,
  anchorNames = ANCHOR_NAMES,
): Promise<EvalMention[]> {
  const file = evalFile(label, content);
  const result = await extractEntities(deps.generator, file, null, known, undefined, undefined, EXPERIMENTAL);
  const retrieved = await retrieveNameDedupCandidates(
    deps.retrievalDb,
    provider,
    projectProductMentionNames(result.mentions),
  );
  const widened = mergeKnownEntities(known, retrieved);
  const rewrites = await adjudicateKnownMatches(deps.generator, result.mentions, widened, {
    fileId: file.id,
    anchorNames,
  });
  return mentionSummaries(result.mentions, rewrites);
}

function printMentions(label: string, mentions: EvalMention[]): void {
  console.log(`${"#".repeat(70)}\n# ${label}`);
  console.log("#".repeat(70));
  for (const mention of mentions) {
    console.log(
      `  [project/product] extracted="${mention.original}"  handle=${mention.matchesKnown ?? "none"}  final="${mention.finalName}"`,
    );
  }
}

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
  const embeddingProvider = createGeminiEmbeddingProvider(settings.gemini_api_key);
  const retrievalDb = await createRetrievalDb(embeddingProvider);
  const deps = { generator, retrievalDb, embeddingProvider };

  console.log(`Known set: ${KNOWN.map((k, i) => `[K${i + 1}] ${k.name}`).join("  ")}\n`);

  let pass = true;
  for (const c of CASES) {
    const mentions = await runKnownCase(deps, c.label, c.content);
    printMentions(c.label, mentions);
    for (const mention of mentions) {
      if (!c.isOverMerge(mention)) continue;
      pass = false;
      console.log("  FALSE MERGE detected");
    }
    if (!mentions.some(c.isOverMerge)) {
      console.log("  no over-merge detected");
    }
    console.log("");
  }

  const crossFileContent = `Weekly delivery notes.
The tourism dashboard team reviewed destination arrivals, hotel occupancy, and
aviation capacity. The next sprint for the tourism dashboard focuses on arrivals
data quality and occupancy drilldowns.`;
  const crossFileWithRetrieval = await runRetrievedCase(
    deps,
    "cross-file fold-in with retrieval",
    crossFileContent,
    embeddingProvider,
    [],
    [],
  );
  printMentions("cross-file fold-in with retrieval", crossFileWithRetrieval);
  const folded = crossFileWithRetrieval.some((mention) => mention.finalName === TOURISM);
  if (!folded) {
    pass = false;
    console.log("  F9 retrieval did not fold the short tourism mention");
  }

  const emptyProvider: EmbeddingProvider = {
    name: "empty",
    dimensions: 3072,
    supportsImages: false,
    embedTexts: async () => [],
  };
  const crossFileControl = await runRetrievedCase(
    deps,
    "cross-file false-green control",
    crossFileContent,
    emptyProvider,
    [],
    [],
  );
  printMentions("cross-file false-green control", crossFileControl);
  if (crossFileControl.some((mention) => mention.finalName === TOURISM)) {
    pass = false;
    console.log("  pure F8 control folded without retrieval");
  }

  const maadenRetrieval = await runRetrievedCase(
    deps,
    "maaden retrieval over-merge guard",
    `Maaden Dashboard notes.
The Maaden Dashboard tracks mining output, ore-grade trends, and haul-truck
utilization for the Maaden operating team.`,
    embeddingProvider,
    [],
    ["Maaden"],
  );
  printMentions("maaden retrieval over-merge guard", maadenRetrieval);
  if (
    maadenRetrieval.some(
      (mention) => mention.original.toLowerCase().includes("dashboard") && mention.finalName === MAADEN_SITES,
    )
  ) {
    pass = false;
    console.log("  Maaden Dashboard folded into Maaden Sites");
  }

  const throwingProvider: EmbeddingProvider = {
    name: "throwing",
    dimensions: 3072,
    supportsImages: false,
    embedTexts: async () => {
      throw new Error("embedding unavailable");
    },
  };
  const failOpen = await runRetrievedCase(deps, "retrieval fail-open", crossFileContent, throwingProvider, [], []);
  printMentions("retrieval fail-open", failOpen);
  if (failOpen.some((mention) => mention.finalName === TOURISM)) {
    pass = false;
    console.log("  fail-open provider unexpectedly folded the short tourism mention");
  }

  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  await retrievalDb.destroy();
  await db.destroy();
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
