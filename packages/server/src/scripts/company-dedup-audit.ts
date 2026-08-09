/**
 * Read-only audit of duplicate company entities.
 *
 * Groups every live company by the three deterministic edge types in
 * `entities/company-dedup-groups` and prints each multi-entity group with the
 * evidence behind it. With `--plan` it also emits, per group, the canonical
 * survivor and the merge operations the existing merge machinery would run —
 * `previewMerge` counts plus the `entity_review_queue` row the dedup
 * adjudication backfill (`scripts/entity-dedup-backfill.ts`) would upsert.
 *
 * The script never writes: no migrations, no inserts, no merges. It is an
 * artifact for human review, and the plan is input for `entity-dedup-backfill`.
 */
import { parseArgs } from "node:util";
import type { Kysely } from "kysely";
import { loadConfig, validateConfig } from "../config";
import { createDatabase } from "../db";
import type { DB } from "../db/schema";
import {
  type CompanyDedupGroup,
  buildCompanyDedupGroups,
  chooseCanonicalCompany,
  loadCompanyDedupMembers,
  ownOrgCompanyIds,
} from "../entities/company-dedup-groups";
import { type MergePreview, previewMerge } from "../entities/merge";
import { normalizeStrict } from "../entities/name-dedup";

const BACKFILL_SOURCE = "entity_dedup_backfill";
const DEFAULT_MIN_GROUP_SIZE = 2;

interface QueueRowPlan {
  proposedName: string;
  normalizedName: string;
  entityType: string;
  source: string;
  sourceId: string;
  candidateEntityId: string;
  candidateScore: number;
  candidateReason: string;
}

interface MergePlanStep {
  survivorId: string;
  survivorName: string;
  loserId: string;
  loserName: string;
  preview: MergePreview;
  queueRow: QueueRowPlan;
}

interface GroupPlan {
  survivorId: string;
  survivorName: string;
  steps: MergePlanStep[];
}

function persistedPairKey(a: string, b: string): string {
  return [a, b].sort().map(encodeURIComponent).join("~");
}

function edgeReason(group: CompanyDedupGroup): string {
  const kinds = new Set(group.edges.map((edge) => edge.kind));
  if (kinds.has("domain")) return "shared-corporate-domain";
  if (kinds.has("name")) return "strict-normalized";
  return "committed-alias";
}

async function buildGroupPlan(db: Kysely<DB>, group: CompanyDedupGroup): Promise<GroupPlan> {
  const survivor = chooseCanonicalCompany(group);
  const reason = edgeReason(group);
  const steps: MergePlanStep[] = [];
  for (const member of group.members) {
    if (member.entityId === survivor.entityId) continue;
    steps.push({
      survivorId: survivor.entityId,
      survivorName: survivor.name,
      loserId: member.entityId,
      loserName: member.name,
      preview: await previewMerge(db, { survivorId: survivor.entityId, loserId: member.entityId }),
      queueRow: {
        proposedName: member.name,
        normalizedName: `${BACKFILL_SOURCE}:company:${normalizeStrict(survivor.name || member.name)}`,
        entityType: "company",
        source: BACKFILL_SOURCE,
        sourceId: persistedPairKey(survivor.entityId, member.entityId),
        candidateEntityId: survivor.entityId,
        candidateScore: 1,
        candidateReason: reason,
      },
    });
  }
  return { survivorId: survivor.entityId, survivorName: survivor.name, steps };
}

function describeGroup(group: CompanyDedupGroup, index: number, plan: GroupPlan | null): string[] {
  const lines: string[] = [];
  lines.push(
    `Group ${index + 1} — ${group.members.length} entities${group.ownOrg ? " — OWN ORG (group-wide exclusion)" : ""}`,
  );
  for (const member of group.members) {
    const marker = plan && member.entityId === plan.survivorId ? "*" : " ";
    lines.push(`  ${marker} ${member.name}  [${member.entityId}]`);
    lines.push(
      `      files=${member.mentionFileCount} status=${member.status} created=${member.createdAt}` +
        `${member.ownOrgSeed ? " own-org-domain-holder" : ""}`,
    );
    lines.push(`      domains: ${member.corporateDomains.length > 0 ? member.corporateDomains.join(", ") : "(none)"}`);
    lines.push(`      aliases: ${member.aliases.length > 0 ? member.aliases.join(" | ") : "(none)"}`);
  }
  lines.push("    evidence:");
  for (const edge of group.edges) {
    lines.push(`      ${edge.kind}="${edge.value}" -> ${edge.entityIds.join(", ")}`);
  }
  if (plan) {
    lines.push(`    plan: survivor ${plan.survivorName} [${plan.survivorId}]`);
    for (const step of plan.steps) {
      const counts = step.preview.counts;
      const collisions = step.preview.collisions;
      lines.push(
        `      merge ${step.loserName} [${step.loserId}] -> survivor` +
          `${step.preview.blocked ? ` BLOCKED(${step.preview.blocked})` : ""}`,
      );
      lines.push(
        `        moves: mentions=${counts.mentions} relationships=${counts.relationships} domains=${counts.domains}` +
          ` sourceRefs=${counts.sourceRefs} contactPoints=${counts.contactPoints} shareEmails=${counts.shareEmails}` +
          ` aliasRejections=${counts.aliasRejections} candidates=${counts.candidates} reviewQueue=${counts.reviewQueue}`,
      );
      lines.push(
        `        collisions: mentions=${collisions.mentions} relationships=${collisions.relationships}` +
          ` domains=${collisions.domains} contactPoints=${collisions.contactPoints}` +
          ` shareEmails=${collisions.shareEmails} aliasRejections=${collisions.aliasRejections}` +
          ` selfLoopsDropped=${step.preview.selfLoopsDropped}`,
      );
      lines.push(`        queueRow: ${JSON.stringify(step.queueRow)}`);
    }
  }
  return lines;
}

export async function runCompanyDedupAudit(
  db: Kysely<DB>,
  options: { plan?: boolean; minGroupSize?: number } = {},
): Promise<{
  totalCompanies: number;
  groups: CompanyDedupGroup[];
  plans: Map<string, GroupPlan>;
  ownOrgExcludedIds: string[];
  ownOrgSeedIds: string[];
}> {
  const members = await loadCompanyDedupMembers(db);
  const allGroups = buildCompanyDedupGroups(members);
  const minGroupSize = options.minGroupSize ?? DEFAULT_MIN_GROUP_SIZE;
  const groups = allGroups.filter((group) => group.members.length >= minGroupSize);

  const plans = new Map<string, GroupPlan>();
  if (options.plan) {
    for (const group of groups) {
      plans.set(group.members[0].entityId, await buildGroupPlan(db, group));
    }
  }

  return {
    totalCompanies: members.length,
    groups,
    plans,
    ownOrgExcludedIds: [...ownOrgCompanyIds(allGroups)].sort(),
    ownOrgSeedIds: members
      .filter((member) => member.ownOrgSeed)
      .map((member) => member.entityId)
      .sort(),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      plan: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "min-group-size": { type: "string", default: String(DEFAULT_MIN_GROUP_SIZE) },
    },
  });
  const config = loadConfig();
  validateConfig(config);
  const db = await createDatabase(config);
  try {
    const result = await runCompanyDedupAudit(db, {
      plan: parsed.values.plan === true,
      minGroupSize: Number(parsed.values["min-group-size"]),
    });

    if (parsed.values.json === true) {
      console.log(
        JSON.stringify(
          {
            totalCompanies: result.totalCompanies,
            groupCount: result.groups.length,
            ownOrgSeedIds: result.ownOrgSeedIds,
            ownOrgExcludedIds: result.ownOrgExcludedIds,
            groups: result.groups.map((group) => ({
              ownOrg: group.ownOrg,
              members: group.members,
              edges: group.edges,
              plan: result.plans.get(group.members[0].entityId) ?? null,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`Live companies: ${result.totalCompanies}`);
    console.log(`Duplicate groups: ${result.groups.length}`);
    console.log(
      `Own-org companies: ${result.ownOrgSeedIds.length} domain holders -> ${result.ownOrgExcludedIds.length} after group expansion`,
    );
    console.log("");
    result.groups.forEach((group, index) => {
      for (const line of describeGroup(group, index, result.plans.get(group.members[0].entityId) ?? null)) {
        console.log(line);
      }
      console.log("");
    });
    console.log("Read-only audit. Nothing was written.");
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
