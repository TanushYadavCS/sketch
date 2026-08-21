/**
 * Read-only evidence report for the project-entity cleanup: for every live
 * project entity, gather where it came from, how often it is mentioned, which
 * company its mention files point at, and what references it — then bucket
 * each project mechanically (keeper / junk candidate / merge family / needs
 * judge). Decides nothing and writes nothing to the DB; the JSON output is the
 * input for the adjudication step.
 *
 *   tsx scripts/report-project-cleanup.ts [--out <file.json>]
 *
 * Reads the local Postgres directly via DATABASE_URL with its own pool —
 * createDatabase() forces ssl on Postgres, which local dev postgres refuses.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { isGenericEngagementName } from "../src/connectors/engagement-name-filter";
import { normalizeName } from "../src/connectors/name-normalize";
import { whereLiveEntity } from "../src/db/repositories/entities";
import type { DB } from "../src/db/schema";
import { buildCompanyDedupGroups, loadCompanyDedupMembers } from "../src/entities/company-dedup-groups";
import { relationshipSourceOrder } from "../src/entities/relationship-provenance";

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

type ProjectEvidence = {
  entityId: string;
  name: string;
  aliases: string[];
  createdAt: string;
  provenanceTier: string;
  lifecycleStatus: string | null;
  origin: string | null;
  learnedFacts: number;
  verdictBorn: boolean;
  engagedCompany: string | null;
  mentionCount: number;
  fileCount: number;
  lastActivity: string | null;
  companyShares: Array<{ company: string; files: number }>;
  taskCount: number;
  relationshipCount: number;
  genericName: boolean;
  family: string | null;
  bucket: "keeper" | "junk_candidate" | "merge_family" | "needs_judge";
};

function parseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseAliases(value: string | null): string[] {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed.filter((alias): alias is string => typeof alias === "string");
  try {
    const direct = JSON.parse(value ?? "[]");
    return Array.isArray(direct) ? direct.filter((alias): alias is string => typeof alias === "string") : [];
  } catch {
    return [];
  }
}

function tokens(name: string): Set<string> {
  return new Set(normalizeName(name).split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

/**
 * Family hints come from name-token overlap and shared SPECIFIC aliases only.
 * Generic aliases ("dashboard") are exactly the poison this cleanup exists
 * for, so they never contribute to clustering. Projects attributed to two
 * different companies never union either — on the goosebumps tenant, shared
 * email-subject aliases chained six unrelated clients into one family. A
 * missed real family still reaches the judge; a wrong hint poisons it.
 */
function assignFamilies(projects: ProjectEvidence[]): void {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };
  for (const project of projects) parent.set(project.entityId, project.entityId);

  const nameTokens = new Map(projects.map((project) => [project.entityId, tokens(project.name)]));
  const aliasTerms = new Map(
    projects.map((project) => [
      project.entityId,
      new Set(
        [project.name, ...project.aliases]
          .filter((term) => !isGenericEngagementName(term))
          .map((term) => normalizeName(term))
          .filter((term) => term.split(" ").length > 1 || term.length >= 4),
      ),
    ]),
  );

  const companyKey = (project: ProjectEvidence): string | null => {
    const company = project.engagedCompany ?? project.companyShares[0]?.company ?? null;
    return company ? normalizeName(company) : null;
  };

  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i];
      const b = projects[j];
      const aCompany = companyKey(a);
      const bCompany = companyKey(b);
      if (aCompany !== null && bCompany !== null && aCompany !== bCompany) continue;
      const nameOverlap = jaccard(nameTokens.get(a.entityId) ?? new Set(), nameTokens.get(b.entityId) ?? new Set());
      const aTerms = aliasTerms.get(a.entityId) ?? new Set<string>();
      const bTerms = aliasTerms.get(b.entityId) ?? new Set<string>();
      const sharedAlias = [...aTerms].some((term) => bTerms.has(term));
      if (nameOverlap >= 0.5 || sharedAlias) union(a.entityId, b.entityId);
    }
  }

  const members = new Map<string, ProjectEvidence[]>();
  for (const project of projects) {
    const root = find(project.entityId);
    const list = members.get(root);
    if (list) list.push(project);
    else members.set(root, [project]);
  }
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const label = [...list].sort((a, b) => b.mentionCount - a.mentionCount)[0].name;
    for (const project of list) project.family = label;
  }
}

function bucketOf(project: ProjectEvidence): ProjectEvidence["bucket"] {
  if (project.verdictBorn) return "keeper";
  if (project.family) return "merge_family";
  if (project.mentionCount <= 1 && project.taskCount === 0 && project.relationshipCount === 0) return "junk_candidate";
  return "needs_judge";
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }) }),
  });
  try {
    const lifecycleCheck = await sql<{ n: string }>`
      SELECT count(*) AS n FROM information_schema.columns
      WHERE table_name = 'entities' AND column_name = 'project_lifecycle_status'
    `.execute(db);
    const hasLifecycle = Number(lifecycleCheck.rows[0]?.n ?? 0) > 0;

    const rows: Array<{
      id: string;
      name: string;
      aliases: string | null;
      metadata: string | null;
      created_at: string;
      provenance_tier: string;
      project_lifecycle_status?: string | null;
    }> = await db
      .selectFrom("entities")
      .select(["id", "name", "aliases", "metadata", "created_at", "provenance_tier"])
      .$if(hasLifecycle, (qb) => qb.select("project_lifecycle_status"))
      .where("source_type", "=", "project")
      .where(whereLiveEntity())
      .execute();

    const ownOrgCompanyIds = new Set(
      buildCompanyDedupGroups(await loadCompanyDedupMembers(db))
        .filter((group) => group.ownOrg)
        .flatMap((group) => group.members.map((member) => member.entityId)),
    );

    const engagements = await db
      .selectFrom("entity_relationships as r")
      .innerJoin("entities as c", "c.id", "r.target_entity_id")
      .select(["r.source_entity_id", "r.source", "c.name as company"])
      .where("r.relationship_type", "=", "engagement_for")
      .execute();
    const engagedBy = new Map<string, string>();
    const engagedOrder = new Map<string, number>();
    for (const row of engagements) {
      const order = relationshipSourceOrder(row.source);
      const prev = engagedOrder.get(row.source_entity_id);
      if (prev === undefined || order < prev) {
        engagedOrder.set(row.source_entity_id, order);
        engagedBy.set(row.source_entity_id, row.company);
      }
    }

    const relationCounts = new Map<string, number>();
    const relations = await db
      .selectFrom("entity_relationships")
      .select(["source_entity_id", "target_entity_id"])
      .execute();
    for (const relation of relations) {
      for (const id of [relation.source_entity_id, relation.target_entity_id]) {
        relationCounts.set(id, (relationCounts.get(id) ?? 0) + 1);
      }
    }

    const taskCounts = new Map<string, number>();
    const tasks = await db
      .selectFrom("tasks")
      .select(["parent_entity_id"])
      .where("parent_entity_id", "is not", null)
      .execute();
    for (const task of tasks) {
      if (task.parent_entity_id)
        taskCounts.set(task.parent_entity_id, (taskCounts.get(task.parent_entity_id) ?? 0) + 1);
    }

    const projects: ProjectEvidence[] = [];
    for (const row of rows) {
      const mentions = await db
        .selectFrom("entity_mentions")
        .select(["indexed_file_id"])
        .where("entity_id", "=", row.id)
        .execute();
      const fileIds = [...new Set(mentions.map((mention) => mention.indexed_file_id))];

      let lastActivity: string | null = null;
      const companyFiles = new Map<string, number>();
      if (fileIds.length > 0) {
        const files = await db
          .selectFrom("indexed_files")
          .select(["id", "source_created_at", "synced_at"])
          .where("id", "in", fileIds)
          .execute();
        for (const file of files) {
          const stamp = file.source_created_at ?? file.synced_at;
          if (stamp && (lastActivity === null || stamp > lastActivity)) lastActivity = stamp;
        }
        const companyMentions = await db
          .selectFrom("entity_mentions as m")
          .innerJoin("entities as c", "c.id", "m.entity_id")
          .select(["c.id as companyId", "c.name as company", "m.indexed_file_id"])
          .where("m.indexed_file_id", "in", fileIds)
          .where("c.source_type", "=", "company")
          .where(whereLiveEntity("c"))
          .execute();
        const byCompany = new Map<string, Set<string>>();
        for (const mention of companyMentions) {
          if (ownOrgCompanyIds.has(mention.companyId)) continue;
          const set = byCompany.get(mention.company);
          if (set) set.add(mention.indexed_file_id);
          else byCompany.set(mention.company, new Set([mention.indexed_file_id]));
        }
        for (const [company, set] of byCompany) companyFiles.set(company, set.size);
      }

      const metadata = parseJson(row.metadata);
      const learnedFacts = Array.isArray(metadata.learned_facts) ? metadata.learned_facts.length : 0;
      projects.push({
        entityId: row.id,
        name: row.name,
        aliases: parseAliases(row.aliases),
        createdAt: row.created_at,
        provenanceTier: row.provenance_tier,
        lifecycleStatus: row.project_lifecycle_status ?? null,
        origin: typeof metadata.origin === "string" ? metadata.origin : null,
        learnedFacts,
        verdictBorn: engagedBy.has(row.id),
        engagedCompany: engagedBy.get(row.id) ?? null,
        mentionCount: mentions.length,
        fileCount: fileIds.length,
        lastActivity,
        companyShares: [...companyFiles.entries()]
          .map(([company, files]) => ({ company, files }))
          .sort((a, b) => b.files - a.files)
          .slice(0, 3),
        taskCount: taskCounts.get(row.id) ?? 0,
        relationshipCount: relationCounts.get(row.id) ?? 0,
        genericName: isGenericEngagementName(row.name),
        family: null,
        bucket: "needs_judge",
      });
    }

    assignFamilies(projects);
    for (const project of projects) project.bucket = bucketOf(project);
    projects.sort((a, b) => (a.family ?? "~").localeCompare(b.family ?? "~") || b.mentionCount - a.mentionCount);

    const outPath = (() => {
      const index = process.argv.indexOf("--out");
      return index >= 0 && process.argv[index + 1]
        ? process.argv[index + 1]
        : join(dirname(fileURLToPath(import.meta.url)), "../../../data/project-cleanup-report.json");
    })();
    writeFileSync(outPath, JSON.stringify({ generatedForDb: "local", projects }, null, 2));

    const byBucket = new Map<string, ProjectEvidence[]>();
    for (const project of projects) {
      const list = byBucket.get(project.bucket);
      if (list) list.push(project);
      else byBucket.set(project.bucket, [project]);
    }
    console.log(`${projects.length} live projects → ${outPath}`);
    for (const bucket of ["keeper", "merge_family", "junk_candidate", "needs_judge"]) {
      const list = byBucket.get(bucket) ?? [];
      console.log(`\n${bucket} (${list.length})`);
      for (const project of list) {
        const company = project.engagedCompany ?? project.companyShares[0]?.company ?? "?";
        const parts = [
          `${project.mentionCount} mentions`,
          `${project.fileCount} files`,
          company,
          project.taskCount > 0 ? `${project.taskCount} tasks` : null,
          project.family ? `family: ${project.family}` : null,
          project.genericName ? "GENERIC NAME" : null,
        ].filter(Boolean);
        console.log(`  ${project.name}  —  ${parts.join(" · ")}`);
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
