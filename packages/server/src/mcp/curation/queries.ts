import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import { loadAffiliationIndex, senderJidToContactValue } from "../../connectors/participant-affiliation";
import { createEntityRepository, normalizeContactPointValue, whereLiveEntity } from "../../db/repositories/entities";
import { createEntityRelationshipsRepository } from "../../db/repositories/entity-relationships";
import { createEntityReviewRepo } from "../../db/repositories/entity-review";
import { PERSON_PARTICIPANT_FACT_TYPES } from "../../db/repositories/indexed-file-facts";
import { resolvePersonEntitiesForEmails } from "../../db/repositories/user-entity-resolver";
import type { DB, EntitiesTable } from "../../db/schema";
import { isRoleAccountEmail } from "../../entities/affiliations";
import {
  buildCompanyDedupGroups,
  loadCompanyDedupMembers,
  ownOrgCompanyIds,
} from "../../entities/company-dedup-groups";
import { isPersonalOrSharedDomain } from "../../entities/personal-domains";
import { cleanEmail } from "../../entities/queue-structural";
import { resolveLiveEntityId } from "../../entities/redirect";

export type JsonResult = { content: { type: "text"; text: string }[] };

export function jsonResult(value: unknown): JsonResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function clampLimit(value: number | undefined, defaultValue: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function truncateSnippet(value: string | null): string | null {
  if (!value) return value;
  return value.length > 200 ? value.slice(0, 200) : value;
}

async function mentionCounts(db: Kysely<DB>, entityIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(entityIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom("entity_mentions")
    .select(["entity_id", db.fn.countAll<number>().as("count")])
    .where("entity_id", "in", ids)
    .groupBy("entity_id")
    .execute();
  return new Map(rows.map((row) => [row.entity_id, Number(row.count)]));
}

async function mergedInto(db: Kysely<DB>, row: Selectable<EntitiesTable>) {
  if (!row.merged_into_entity_id) return null;
  const id = await resolveLiveEntityId(db, row.id);
  const target = await db.selectFrom("entities").select(["id", "name"]).where("id", "=", id).executeTakeFirst();
  return target ? { id: target.id, name: target.name } : { id, name: null };
}

function entityPayload(
  row: Selectable<EntitiesTable>,
  mentionCount: number,
  merged: { id: string; name: string | null } | null,
) {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    subtype: row.subtype,
    aliases: parseAliases(row.aliases),
    status: row.status,
    provenanceTier: row.provenance_tier,
    mentionCount,
    tombstone: row.deleted_at || row.merged_into_entity_id ? { deletedAt: row.deleted_at, mergedInto: merged } : null,
  };
}

export async function graphOverview(db: Kysely<DB>) {
  const counts = await db
    .selectFrom("entities")
    .select(["source_type", "status", db.fn.countAll<number>().as("count")])
    .where(whereLiveEntity())
    .groupBy(["source_type", "status"])
    .orderBy("source_type", "asc")
    .orderBy("status", "asc")
    .execute();
  const pendingReviewCount = await createEntityReviewRepo(db).countPending({ isAdmin: true });
  const unlinkedProjectCount = await countUnlinkedProjects(db);
  const run = await db
    .selectFrom("weekly_mint_runs")
    .select([
      "id",
      "run_key",
      "status",
      "clock_week",
      "started_at",
      "completed_at",
      "verdicts_requested",
      "verdicts_stored",
    ])
    .orderBy("started_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  const eventCounts = run
    ? await db
        .selectFrom("weekly_mint_run_events")
        .select(["kind", db.fn.countAll<number>().as("count")])
        .where("run_id", "=", run.id)
        .groupBy("kind")
        .execute()
    : [];
  return {
    entityCounts: counts.map((row) => ({
      sourceType: row.source_type,
      status: row.status,
      count: Number(row.count),
    })),
    pendingReviewCount,
    unlinkedProjectCount,
    lastWeeklyMintRun: run
      ? {
          id: run.id,
          runKey: run.run_key,
          status: run.status,
          clockWeek: run.clock_week,
          startedAt: run.started_at,
          completedAt: run.completed_at,
          verdictsRequested: Number(run.verdicts_requested),
          verdictsStored: Number(run.verdicts_stored),
          eventCounts: Object.fromEntries(eventCounts.map((row) => [row.kind, Number(row.count)])),
          acceptedCount: eventCounts
            .filter((row) => row.kind === "accepted")
            .reduce((sum, row) => sum + Number(row.count), 0),
          rejectedCount: eventCounts
            .filter((row) => row.kind === "rejected")
            .reduce((sum, row) => sum + Number(row.count), 0),
        }
      : null,
  };
}

export async function findEntitiesForCuration(
  db: Kysely<DB>,
  args: { queries: string[]; types?: string[]; includeTombstones?: boolean },
) {
  const repo = createEntityRepository(db);
  const rows = await repo.searchEntitiesForCuration({
    queries: args.queries,
    sourceTypes: args.types,
    includeTombstones: args.includeTombstones,
  });
  const counts = await mentionCounts(
    db,
    rows.map((entry) => entry.row.id),
  );
  const results = [];
  for (const entry of rows) {
    results.push({
      query: entry.query,
      tier: entry.tier,
      ...entityPayload(entry.row, counts.get(entry.row.id) ?? 0, entry.mergedInto),
    });
  }
  return { results, total: results.length };
}

export async function rawEntityEvidence(db: Kysely<DB>, entityId: string, mentionLimit: number) {
  const entity = await db.selectFrom("entities").selectAll().where("id", "=", entityId).executeTakeFirst();
  if (!entity) return { entity: null };
  const mentions = await createEntityRepository(db).getMentionsForEntity(entityId, { limit: mentionLimit });
  const fileIds = [...new Set(mentions.map((mention) => mention.indexed_file_id))];
  const files =
    fileIds.length > 0
      ? await db
          .selectFrom("indexed_files")
          .select(["id", "file_name", "source", "source_created_at", "synced_at"])
          .where("id", "in", fileIds)
          .execute()
      : [];
  const filesById = new Map(files.map((file) => [file.id, file]));
  const stats = await db
    .selectFrom("entity_mentions")
    .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
    .select([
      sql<number>`COUNT(DISTINCT entity_mentions.indexed_file_id)`.as("file_count"),
      sql<string | null>`
        MAX(COALESCE(indexed_files.source_created_at, indexed_files.synced_at, entity_mentions.mentioned_at))
      `.as("last_activity"),
    ])
    .where("entity_mentions.entity_id", "=", entityId)
    .executeTakeFirst();
  const relations = await createEntityRelationshipsRepository(db).listRelationsForEntity(entityId, { limit: 50 });
  const tasksByParent = await db
    .selectFrom("tasks")
    .select([
      "id",
      "title",
      "status",
      "assignee_entity_id",
      "parent_entity_id",
      "source",
      "valid_to",
      "created_at",
      "updated_at",
    ])
    .where("parent_entity_id", "=", entityId)
    .orderBy("updated_at", "desc")
    .limit(20)
    .execute();
  const tasksByAssignee = await db
    .selectFrom("tasks")
    .select([
      "id",
      "title",
      "status",
      "assignee_entity_id",
      "parent_entity_id",
      "source",
      "valid_to",
      "created_at",
      "updated_at",
    ])
    .where("assignee_entity_id", "=", entityId)
    .orderBy("updated_at", "desc")
    .limit(20)
    .execute();
  const contactPoints = await createEntityRepository(db).getContactPointsForEntity(entityId);
  const domains = await db
    .selectFrom("entity_domains")
    .select(["domain", "kind", "is_primary", "confidence", "source"])
    .where("entity_id", "=", entityId)
    .orderBy("is_primary", "desc")
    .orderBy("domain", "asc")
    .execute();
  const redirect = await mergedInto(db, entity);
  return {
    entity: {
      ...entityPayload(entity, Number(stats?.file_count ?? 0), redirect),
      deletedAt: entity.deleted_at,
      mergedIntoEntityId: entity.merged_into_entity_id,
    },
    mentionStats: {
      distinctFileCount: Number(stats?.file_count ?? 0),
      lastActivity: stats?.last_activity ?? null,
      returned: mentions.length,
      limit: mentionLimit,
    },
    mentions: mentions.map((mention) => {
      const file = filesById.get(mention.indexed_file_id);
      return {
        id: mention.id,
        fileId: mention.indexed_file_id,
        fileName: file?.file_name ?? null,
        fileSource: file?.source ?? null,
        chunkIndex: mention.chunk_index,
        contextSnippet: truncateSnippet(mention.context_snippet),
        mentionedAt: mention.mentioned_at,
        activityAt: mention.source_created_at ?? file?.synced_at ?? mention.mentioned_at,
      };
    }),
    relationships: {
      outgoing: relations.outgoing.map((relation) => ({ ...relation, expired: relation.validTo !== null })),
      incoming: relations.incoming.map((relation) => ({ ...relation, expired: relation.validTo !== null })),
      totalCount: relations.totalCount,
      truncated: relations.truncated,
    },
    tasks: { byParent: tasksByParent, byAssignee: tasksByAssignee },
    contactPoints,
    domains,
  };
}

async function projectEvidenceFileIds(db: Kysely<DB>, projectId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("entity_mentions")
    .select("indexed_file_id")
    .distinct()
    .where("entity_id", "=", projectId)
    .execute();
  return rows.map((row) => row.indexed_file_id);
}

export async function companyDominance(db: Kysely<DB>, projectId: string) {
  const fileIds = await projectEvidenceFileIds(db, projectId);
  if (fileIds.length === 0) return { projectId, totalFiles: 0, companies: [] };
  const ownOrgIds = ownOrgCompanyIds(buildCompanyDedupGroups(await loadCompanyDedupMembers(db)));
  const mentionRows = await db
    .selectFrom("entity_mentions")
    .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
    .select([
      "entities.id as companyId",
      "entities.name",
      sql<number>`COUNT(DISTINCT entity_mentions.indexed_file_id)`.as("fileCount"),
    ])
    .where("entity_mentions.indexed_file_id", "in", fileIds)
    .where("entities.source_type", "=", "company")
    .where("entities.status", "!=", "archived")
    .where(whereLiveEntity())
    .$if(ownOrgIds.size > 0, (qb) => qb.where("entities.id", "not in", [...ownOrgIds]))
    .groupBy(["entities.id", "entities.name"])
    .execute();
  const participantRows = await db
    .selectFrom("indexed_file_facts")
    .select(["indexed_file_id as fileId", "subject_email as email"])
    .where("indexed_file_facts.indexed_file_id", "in", fileIds)
    .where("indexed_file_facts.fact_type", "in", [...PERSON_PARTICIPANT_FACT_TYPES])
    .where("indexed_file_facts.deleted_at", "is", null)
    .where("indexed_file_facts.subject_email", "is not", null)
    .execute();
  const emailsByFile = new Map<string, Set<string>>();
  const emailsToResolve = new Set<string>();
  for (const row of participantRows) {
    if (!row.fileId) continue;
    const email = row.email?.trim();
    if (!email || isRoleAccountEmail(email)) continue;
    const normalized = normalizeContactPointValue("email", email);
    let emails = emailsByFile.get(row.fileId);
    if (!emails) {
      emails = new Set();
      emailsByFile.set(row.fileId, emails);
    }
    emails.add(normalized);
    emailsToResolve.add(normalized);
  }
  const personsByEmail = await resolvePersonEntitiesForEmails(db, [...emailsToResolve]);
  const personByEmail = new Map<string, string>();
  for (const [email, matches] of personsByEmail) {
    if (matches.length === 1) personByEmail.set(email, matches[0].id);
  }
  const personsByFile = await loadScopedWhatsAppSenderPersonsByFile(db, fileIds);
  for (const [fileId, emails] of emailsByFile) {
    for (const email of emails) {
      const personId = personByEmail.get(email);
      if (!personId) continue;
      let personIds = personsByFile.get(fileId);
      if (!personIds) {
        personIds = new Set();
        personsByFile.set(fileId, personIds);
      }
      personIds.add(personId);
    }
  }
  const affiliation = await loadAffiliationIndex(db, ownOrgIds);
  const affiliationFiles = new Map<string, Set<string>>();
  for (const [fileId, personIds] of personsByFile) {
    for (const personId of personIds) {
      if (affiliation.ownOrgAffiliatedPersonIds.has(personId)) continue;
      for (const companyId of affiliation.companiesByPerson.get(personId) ?? []) {
        let files = affiliationFiles.get(companyId);
        if (!files) {
          files = new Set();
          affiliationFiles.set(companyId, files);
        }
        files.add(fileId);
      }
    }
  }
  const namesByCompany = new Map<string, string>();
  for (const row of mentionRows) namesByCompany.set(row.companyId, row.name);
  const missingNameIds = [...affiliationFiles.keys()].filter((id) => !namesByCompany.has(id));
  if (missingNameIds.length > 0) {
    const rows = await db.selectFrom("entities").select(["id", "name"]).where("id", "in", missingNameIds).execute();
    for (const row of rows) namesByCompany.set(row.id, row.name);
  }
  const companyIds = new Set([...mentionRows.map((row) => row.companyId), ...affiliationFiles.keys()]);
  const companies = [...companyIds]
    .map((companyId) => {
      const mentionFiles = Number(mentionRows.find((row) => row.companyId === companyId)?.fileCount ?? 0);
      const affiliationCount = affiliationFiles.get(companyId)?.size ?? 0;
      return {
        companyId,
        name: namesByCompany.get(companyId) ?? null,
        mentionFiles,
        affiliationFiles: affiliationCount,
        totalFiles: fileIds.length,
      };
    })
    .sort((a, b) => Math.max(b.mentionFiles, b.affiliationFiles) - Math.max(a.mentionFiles, a.affiliationFiles))
    .slice(0, 10);
  return { projectId, totalFiles: fileIds.length, companies };
}

export async function listAffiliations(db: Kysely<DB>, personId: string) {
  const relations = await createEntityRelationshipsRepository(db).listRelationsForEntity(personId, { limit: 50 });
  const relevant = [...relations.outgoing, ...relations.incoming].filter((relation) =>
    ["works_at", "engaged_with"].includes(relation.relationshipType),
  );
  const contactPoints = await createEntityRepository(db).getContactPointsForEntity(personId);
  const orgDomains = new Set(
    (await db.selectFrom("organization_domains").select("domain").execute()).map((row) => row.domain),
  );
  return {
    personId,
    relationships: relevant.map((relation) => ({ ...relation, expired: relation.validTo !== null })),
    emailContactPoints: contactPoints
      .filter((point) => point.kind === "email")
      .map((point) => {
        const domain = point.value.split("@")[1]?.toLowerCase() ?? "";
        return {
          ...point,
          domain,
          isPersonalOrShared: isPersonalOrSharedDomain(domain),
          knownOrgDomain: orgDomains.has(domain),
        };
      }),
  };
}

export async function sharedEvidence(db: Kysely<DB>, entityIds: string[]) {
  const uniqueIds = [...new Set(entityIds)];
  const sharedFiles = await db
    .selectFrom("entity_mentions")
    .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
    .select(["indexed_files.id", "indexed_files.file_name"])
    .where("entity_mentions.entity_id", "in", uniqueIds)
    .groupBy(["indexed_files.id", "indexed_files.file_name"])
    .having(sql<number>`COUNT(DISTINCT entity_mentions.entity_id)`, "=", uniqueIds.length)
    .orderBy("indexed_files.file_name", "asc")
    .execute();
  const coAttendeeFiles = await coParticipantFileCount(db, uniqueIds, "attendee");
  const coCorrespondentFiles = await coParticipantFileCount(db, uniqueIds, "correspondent");
  const contactRows = await db
    .selectFrom("entity_contact_points")
    .select(["kind", "value", db.fn.countAll<number>().as("count")])
    .where("entity_id", "in", uniqueIds)
    .groupBy(["kind", "value"])
    .having(sql<number>`COUNT(DISTINCT entity_id)`, "=", uniqueIds.length)
    .execute();
  const domainRows = await db
    .selectFrom("entity_domains")
    .select(["domain", "kind", db.fn.countAll<number>().as("count")])
    .where("entity_id", "in", uniqueIds)
    .groupBy(["domain", "kind"])
    .having(sql<number>`COUNT(DISTINCT entity_id)`, "=", uniqueIds.length)
    .execute();
  return {
    entityIds: uniqueIds,
    sharedFiles: {
      count: sharedFiles.length,
      files: sharedFiles.slice(0, 10).map((row) => ({ id: row.id, name: row.file_name })),
    },
    coAttendeeFiles,
    coCorrespondentFiles,
    sharedContactPoints: contactRows.map((row) => ({ kind: row.kind, value: row.value, count: Number(row.count) })),
    sharedCorporateDomains: domainRows
      .filter((row) => row.kind === "corporate")
      .map((row) => ({ domain: row.domain, kind: row.kind, count: Number(row.count) })),
  };
}

/**
 * Email-only matching, deliberately: `normalized_subject_name` is null for
 * attendee/correspondent facts (indexed-file-facts projects it only for
 * `llm_extracted` and `feature` rows), so a name branch could never fire.
 * A person entity with no email contact point contributes no matches and the
 * count returns 0 rather than guessing by display name.
 */
async function coParticipantFileCount(db: Kysely<DB>, entityIds: string[], factType: "attendee" | "correspondent") {
  const uniqueIds = [...new Set(entityIds)];
  if (uniqueIds.length === 0) return 0;
  const personCount = await db
    .selectFrom("entities")
    .select(db.fn.countAll<number>().as("count"))
    .where("id", "in", uniqueIds)
    .where("source_type", "=", "person")
    .executeTakeFirst();
  if (Number(personCount?.count ?? 0) !== uniqueIds.length) return 0;

  const emailsByEntity = new Map(uniqueIds.map((id) => [id, new Set<string>()]));
  const contactRows = await db
    .selectFrom("entity_contact_points")
    .select(["entity_id", "value"])
    .where("entity_id", "in", uniqueIds)
    .where("kind", "=", "email")
    .execute();
  for (const row of contactRows) {
    const email = cleanEmail(row.value);
    if (!email || !row.entity_id) continue;
    emailsByEntity.get(row.entity_id)?.add(email);
  }
  const emailValues = [...new Set([...emailsByEntity.values()].flatMap((emails) => [...emails]))];
  if (emailValues.length === 0 || [...emailsByEntity.values()].some((emails) => emails.size === 0)) return 0;

  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["indexed_file_id as fileId", "subject_email as email"])
    .where("fact_type", "=", factType)
    .where("indexed_file_id", "is not", null)
    .where("deleted_at", "is", null)
    .where(sql<string>`lower(trim(indexed_file_facts.subject_email))`, "in", emailValues)
    .execute();
  const emailsByFile = new Map<string, Set<string>>();
  for (const row of rows) {
    const email = cleanEmail(row.email);
    if (!row.fileId || !email) continue;
    let set = emailsByFile.get(row.fileId);
    if (!set) {
      set = new Set();
      emailsByFile.set(row.fileId, set);
    }
    set.add(email);
  }
  let count = 0;
  for (const fileEmails of emailsByFile.values()) {
    const everyEntityPresent = [...emailsByEntity.values()].every((entityEmails) =>
      [...entityEmails].some((email) => fileEmails.has(email)),
    );
    if (everyEntityPresent) count += 1;
  }
  return count;
}

export async function listCandidates(
  db: Kysely<DB>,
  args: {
    kind: "unlinked_project" | "stuck_review_rows";
    limit: number;
    offset: number;
    entityType?: string;
    candidateReason?: string;
    origin?: "tracker" | "inferred";
  },
) {
  if (args.kind === "unlinked_project") return listUnlinkedProjects(db, args.limit, args.offset);
  return listStuckReviewRows(db, args);
}

async function countUnlinkedProjects(db: Kysely<DB>) {
  const row = await db
    .selectFrom("entities")
    .select(db.fn.countAll<number>().as("count"))
    .where("source_type", "=", "project")
    .where(whereLiveEntity())
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("entity_relationships")
            .innerJoin("entities as company", "company.id", "entity_relationships.target_entity_id")
            .select("entity_relationships.id")
            .whereRef("entity_relationships.source_entity_id", "=", "entities.id")
            .where("entity_relationships.relationship_type", "=", "engagement_for")
            .where("entity_relationships.valid_to", "is", null)
            .where(whereLiveEntity("company")),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function listUnlinkedProjects(db: Kysely<DB>, limit: number, offset: number) {
  const mentionStats = db
    .selectFrom("entity_mentions")
    .select([
      "entity_id",
      db.fn.countAll<number>().as("mention_count"),
      sql<number>`COUNT(DISTINCT indexed_file_id)`.as("file_count"),
    ])
    .groupBy("entity_id")
    .as("mention_stats");
  const candidates = await db
    .selectFrom("entities")
    .leftJoin(mentionStats, "mention_stats.entity_id", "entities.id")
    .select(["entities.id", "entities.name", "entities.status", "entities.source_type"])
    .where("source_type", "=", "project")
    .where(whereLiveEntity())
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("entity_relationships")
            .innerJoin("entities as company", "company.id", "entity_relationships.target_entity_id")
            .select("entity_relationships.id")
            .whereRef("entity_relationships.source_entity_id", "=", "entities.id")
            .where("entity_relationships.relationship_type", "=", "engagement_for")
            .where("entity_relationships.valid_to", "is", null)
            .where(whereLiveEntity("company")),
        ),
      ),
    )
    .orderBy(sql`COALESCE(mention_stats.file_count, 0)`, "desc")
    .orderBy("entities.name", "asc")
    .limit(limit)
    .offset(offset)
    .execute();
  const ids = candidates.map((row) => row.id);
  const mentionRows =
    ids.length > 0
      ? await db
          .selectFrom("entity_mentions")
          .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
          .select([
            "entity_mentions.entity_id",
            db.fn.countAll<number>().as("mentionCount"),
            sql<number>`COUNT(DISTINCT entity_mentions.indexed_file_id)`.as("fileCount"),
            sql<string | null>`
              MAX(COALESCE(indexed_files.source_created_at, indexed_files.synced_at, entity_mentions.mentioned_at))
            `.as("lastActivity"),
          ])
          .where("entity_mentions.entity_id", "in", ids)
          .groupBy("entity_mentions.entity_id")
          .execute()
      : [];
  const taskRows =
    ids.length > 0
      ? await db
          .selectFrom("tasks")
          .select(["parent_entity_id", db.fn.countAll<number>().as("taskCount")])
          .where("parent_entity_id", "in", ids)
          .groupBy("parent_entity_id")
          .execute()
      : [];
  const mentions = new Map(mentionRows.map((row) => [row.entity_id, row]));
  const tasks = new Map(taskRows.map((row) => [row.parent_entity_id, Number(row.taskCount)]));
  const rows = candidates
    .map((row) => {
      const stats = mentions.get(row.id);
      return {
        id: row.id,
        name: row.name,
        sourceType: row.source_type,
        status: row.status,
        mentionCount: Number(stats?.mentionCount ?? 0),
        distinctFileCount: Number(stats?.fileCount ?? 0),
        taskCount: tasks.get(row.id) ?? 0,
        lastActivity: stats?.lastActivity ?? null,
      };
    })
    .sort((a, b) => b.distinctFileCount - a.distinctFileCount || a.name.localeCompare(b.name));
  return { kind: "unlinked_project", total: await countUnlinkedProjects(db), rows, limit, offset };
}

async function listStuckReviewRows(
  db: Kysely<DB>,
  args: {
    limit: number;
    offset: number;
    entityType?: string;
    candidateReason?: string;
    origin?: "tracker" | "inferred";
  },
) {
  const originExpr = sql<"tracker" | "inferred">`CASE WHEN source IS NOT NULL THEN 'tracker' ELSE 'inferred' END`;
  const summaryRows = await db
    .selectFrom("entity_review_queue")
    .select([
      "entity_type",
      sql<string>`COALESCE(candidate_reason, 'none')`.as("candidateReason"),
      originExpr.as("origin"),
      db.fn.countAll<number>().as("count"),
    ])
    .where("status", "=", "pending")
    .groupBy(["entity_type"])
    .groupBy(sql<string>`COALESCE(candidate_reason, 'none')`)
    .groupBy(originExpr)
    .orderBy("entity_type", "asc")
    .execute();
  let rowsQuery = db.selectFrom("entity_review_queue").selectAll().where("status", "=", "pending");
  if (args.entityType) rowsQuery = rowsQuery.where("entity_type", "=", args.entityType);
  if (args.candidateReason) {
    rowsQuery =
      args.candidateReason === "none"
        ? rowsQuery.where("candidate_reason", "is", null)
        : rowsQuery.where("candidate_reason", "=", args.candidateReason);
  }
  if (args.origin === "tracker") rowsQuery = rowsQuery.where("source", "is not", null);
  if (args.origin === "inferred") rowsQuery = rowsQuery.where("source", "is", null);
  const rows = await rowsQuery.orderBy("last_seen_at", "desc").limit(args.limit).offset(args.offset).execute();
  return {
    kind: "stuck_review_rows",
    groups: summaryRows.map((row) => ({
      entityType: row.entity_type,
      candidateReason: row.candidateReason,
      origin: row.origin,
      count: Number(row.count),
    })),
    rows,
    limit: args.limit,
    offset: args.offset,
  };
}

export async function loadScopedWhatsAppSenderPersonsByFile(db: Kysely<DB>, fileIds: string[]) {
  const slices = await db
    .selectFrom("conversation_slices")
    .select(["indexed_file_id", "conversation_id", "first_message_id", "last_message_id"])
    .where("indexed_file_id", "in", fileIds)
    .execute();
  if (slices.length === 0) return new Map<string, Set<string>>();
  const rows = await db
    .selectFrom("conversation_messages")
    .select(["conversation_id", "id", "sender_jid"])
    .where((eb) =>
      eb.or(
        slices.map((slice) =>
          eb.and([
            eb("conversation_id", "=", slice.conversation_id),
            eb("id", ">=", slice.first_message_id),
            eb("id", "<=", slice.last_message_id),
          ]),
        ),
      ),
    )
    .where("is_bot", "=", 0)
    .where("sender_jid", "is not", null)
    .execute();
  const contactValues = rows
    .map((row) => (row.sender_jid ? senderJidToContactValue(row.sender_jid) : null))
    .filter((value): value is { kind: "phone" | "lid"; value: string } => value !== null);
  if (contactValues.length === 0) return new Map<string, Set<string>>();
  const phoneValues = contactValues.filter((value) => value.kind === "phone").map((value) => value.value);
  const lidValues = contactValues.filter((value) => value.kind === "lid").map((value) => value.value);
  const personRows = await db
    .selectFrom("entity_contact_points")
    .select(["kind", "value", "entity_id"])
    .where((eb) =>
      eb.or([
        ...(phoneValues.length > 0
          ? [eb.and([eb("kind", "in", ["phone", "whatsapp"]), eb("value", "in", phoneValues)])]
          : []),
        ...(lidValues.length > 0 ? [eb.and([eb("kind", "=", "whatsapp_lid"), eb("value", "in", lidValues)])] : []),
      ]),
    )
    .execute();
  const personByValue = new Map(personRows.map((row) => [row.value, row.entity_id]));
  const out = new Map<string, Set<string>>();
  for (const slice of slices) {
    if (!slice.indexed_file_id) continue;
    for (const row of rows) {
      if (
        row.conversation_id !== slice.conversation_id ||
        row.id < slice.first_message_id ||
        row.id > slice.last_message_id
      ) {
        continue;
      }
      const contact = row.sender_jid ? senderJidToContactValue(row.sender_jid) : null;
      const personId = contact ? personByValue.get(contact.value) : undefined;
      if (!personId) continue;
      let set = out.get(slice.indexed_file_id);
      if (!set) {
        set = new Set();
        out.set(slice.indexed_file_id, set);
      }
      set.add(personId);
    }
  }
  return out;
}
