import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { DuplicateDrainRunSnapshot } from "../db/repositories/graph-pass-runs";
import type { DB, EntitiesTable, EntityReviewQueueTable } from "../db/schema";
import { yieldToEventLoop } from "../lib/event-loop";
import {
  type CompanyDedupGroup,
  buildCompanyDedupGroups,
  chooseCanonicalCompany,
  loadCompanyDedupMembers,
} from "./company-dedup-groups";
import { parseAliasesString, readPersonEmailFromMetadata } from "./materialize-json";
import { withMaterializeReplayQueue } from "./materialize-replay";
import { mergeEntities } from "./merge";
import { normalizeStrict, normalizeTokenSet } from "./name-dedup";
import { compactEntityNameKey, normalizeName } from "./name-keys";

const PASS_ID = "duplicate-drain";
const PASS_VERSION = 2;
const STATE_ROW_ID = `${PASS_ID}:v${PASS_VERSION}`;
const ACTOR = `correction:${PASS_ID}@${PASS_VERSION}`;
const DEFAULT_PAGE_SIZE = 250;
const HARD_COMPANY_EDGES = new Set(["domain", "name"] as const);

type Entity = Selectable<EntitiesTable>;
type QueueRow = Selectable<EntityReviewQueueTable>;

export interface DuplicateDrainOptions {
  logger?: Logger;
  pageSize?: number;
  shouldStop?: () => boolean;
}

export interface DuplicateDrainHandle {
  done: Promise<void>;
  stop: () => void;
}

export type DuplicateDrainSummary = DuplicateDrainRunSnapshot;

function emptySummary(status: "running" | "complete" = "running"): DuplicateDrainSummary {
  return {
    kind: "duplicate_drain",
    passId: PASS_ID,
    version: PASS_VERSION,
    status,
    cursorCreatedAt: null,
    cursorId: null,
    scannedEntities: 0,
    merged: 0,
    groupIds: [],
    m5SkippedPassReason: 0,
    m3EmailVetoes: 0,
    m5EmailVetoes: 0,
    aliasOnlyQueued: 0,
    aliasOnlyDropped: 0,
  };
}

function parseSummary(raw: string): DuplicateDrainSummary {
  try {
    const parsed = JSON.parse(raw) as Partial<DuplicateDrainSummary>;
    if (parsed.kind !== "duplicate_drain" || parsed.version !== PASS_VERSION) return emptySummary();
    return {
      ...emptySummary(parsed.status === "complete" ? "complete" : "running"),
      cursorCreatedAt: typeof parsed.cursorCreatedAt === "string" ? parsed.cursorCreatedAt : null,
      cursorId: typeof parsed.cursorId === "string" ? parsed.cursorId : null,
      scannedEntities: typeof parsed.scannedEntities === "number" ? parsed.scannedEntities : 0,
      merged: typeof parsed.merged === "number" ? parsed.merged : 0,
      groupIds: Array.isArray(parsed.groupIds) ? parsed.groupIds.filter((id) => typeof id === "string") : [],
      m5SkippedPassReason: typeof parsed.m5SkippedPassReason === "number" ? parsed.m5SkippedPassReason : 0,
      m3EmailVetoes: typeof parsed.m3EmailVetoes === "number" ? parsed.m3EmailVetoes : 0,
      m5EmailVetoes: typeof parsed.m5EmailVetoes === "number" ? parsed.m5EmailVetoes : 0,
      aliasOnlyQueued: typeof parsed.aliasOnlyQueued === "number" ? parsed.aliasOnlyQueued : 0,
      aliasOnlyDropped: typeof parsed.aliasOnlyDropped === "number" ? parsed.aliasOnlyDropped : 0,
    };
  } catch {
    return emptySummary();
  }
}

async function writeState(db: Kysely<DB>, summary: DuplicateDrainSummary): Promise<void> {
  const now = new Date().toISOString();
  const status = summary.status === "complete" ? "complete" : "running";
  const row = {
    id: STATE_ROW_ID,
    status,
    started_at: now,
    finished_at: status === "complete" ? now : null,
    error_message: null,
    input_snapshot_json: JSON.stringify(summary),
  };
  await db
    .insertInto("graph_pass_runs")
    .values(row)
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        status,
        finished_at: row.finished_at,
        error_message: null,
        input_snapshot_json: row.input_snapshot_json,
      }),
    )
    .execute();
}

async function failState(db: Kysely<DB>, error: unknown): Promise<void> {
  await db
    .updateTable("graph_pass_runs")
    .set({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: error instanceof Error ? error.message : "duplicate drain failed",
    })
    .where("id", "=", STATE_ROW_ID)
    .execute();
}

async function readState(db: Kysely<DB>): Promise<DuplicateDrainSummary> {
  const row = await db
    .selectFrom("graph_pass_runs")
    .select(["status", "input_snapshot_json"])
    .where("id", "=", STATE_ROW_ID)
    .executeTakeFirst();
  if (!row) return emptySummary();
  const summary = parseSummary(row.input_snapshot_json);
  return row.status === "complete" ? { ...summary, status: "complete" } : summary;
}

async function loadLiveEntitiesFromCursor(
  db: Kysely<DB>,
  cursor: { createdAt: string; id: string },
  limit: number,
): Promise<Entity[]> {
  return db
    .selectFrom("entities")
    .selectAll()
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .where((eb) =>
      eb.or([
        eb("created_at", ">", cursor.createdAt),
        eb.and([eb("created_at", "=", cursor.createdAt), eb("id", ">", cursor.id)]),
      ]),
    )
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
}

async function loadLiveEntities(
  db: Kysely<DB>,
  opts: DuplicateDrainOptions,
  summary: DuplicateDrainSummary,
): Promise<Entity[] | null> {
  const entities: Entity[] = [];
  let cursor = { createdAt: summary.cursorCreatedAt ?? "", id: summary.cursorId ?? "" };
  for (;;) {
    if (opts.shouldStop?.()) {
      await writeState(db, { ...summary, status: "running" });
      return null;
    }
    const rows = await loadLiveEntitiesFromCursor(db, cursor, opts.pageSize ?? DEFAULT_PAGE_SIZE);
    if (rows.length === 0) break;
    entities.push(...rows);
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
    summary.cursorCreatedAt = cursor.createdAt;
    summary.cursorId = cursor.id;
    summary.scannedEntities += rows.length;
    await writeState(db, summary);
    await yieldToEventLoop();
  }
  return entities;
}

function emailsFromEntity(entity: Entity): Set<string> {
  const emails = new Set<string>();
  const metadataEmail = readPersonEmailFromMetadata(entity.metadata);
  if (metadataEmail?.trim()) emails.add(metadataEmail.trim().toLowerCase());
  for (const alias of parseAliasesString(entity.aliases)) {
    if (alias.includes("@")) emails.add(alias.trim().toLowerCase());
  }
  return emails;
}

async function loadContactPointEmails(db: Kysely<DB>, entities: Entity[]): Promise<Map<string, Set<string>>> {
  const byEntity = new Map<string, Set<string>>();
  for (const entity of entities) byEntity.set(entity.id, emailsFromEntity(entity));
  const ids = entities.map((entity) => entity.id);
  if (ids.length === 0) return byEntity;
  const points = await db
    .selectFrom("entity_contact_points")
    .select(["entity_id", "value"])
    .where("entity_id", "in", ids)
    .where("kind", "=", "email")
    .execute();
  for (const point of points) {
    const value = point.value.trim().toLowerCase();
    if (!value) continue;
    byEntity.get(point.entity_id)?.add(value);
  }
  return byEntity;
}

function disjoint(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return false;
  return true;
}

function hasDisjointEmails(left: Set<string>, right: Set<string>): boolean {
  return left.size > 0 && right.size > 0 && disjoint(left, right);
}

function emailsForEntity(entity: Entity, emails: Map<string, Set<string>>): Set<string> {
  return emails.get(entity.id) ?? emailsFromEntity(entity);
}

function groupEntities(entities: Entity[], keyFor: (entity: Entity) => string): Entity[][] {
  const groups = new Map<string, Entity[]>();
  for (const entity of entities) {
    const key = keyFor(entity);
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(entity);
    groups.set(key, bucket);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function chooseGenericSurvivor(group: Entity[]): Entity {
  return [...group].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
}

function spacedCompanyName(group: CompanyDedupGroup, survivorName: string): string | undefined {
  const compact = compactEntityNameKey("company", survivorName);
  const choices = group.members.filter((member) => compactEntityNameKey("company", member.name) === compact);
  if (choices.length !== group.members.length) return undefined;
  return [...choices].sort((a, b) => {
    const aSpaced = Number(/\s/.test(a.name));
    const bSpaced = Number(/\s/.test(b.name));
    if (aSpaced !== bSpaced) return bSpaced - aSpaced;
    if (a.name.length !== b.name.length) return b.name.length - a.name.length;
    return a.name.localeCompare(b.name);
  })[0]?.name;
}

async function liveEntity(db: Kysely<DB>, id: string): Promise<Entity | undefined> {
  return db
    .selectFrom("entities")
    .selectAll()
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .executeTakeFirst();
}

async function applyEntityGroup(
  db: Kysely<DB>,
  groupId: string,
  survivorId: string,
  loserIds: string[],
  summary: DuplicateDrainSummary,
  survivorName?: string,
): Promise<void> {
  let first = true;
  let recordedGroup = false;
  for (const loserId of loserIds) {
    if (!(await liveEntity(db, survivorId)) || !(await liveEntity(db, loserId))) continue;
    await mergeEntities(db, {
      survivorId,
      loserId,
      groupId,
      mergedBy: ACTOR,
      survivorName: first ? survivorName : undefined,
    });
    if (!recordedGroup) {
      summary.groupIds.push(groupId);
      recordedGroup = true;
    }
    summary.merged++;
    first = false;
  }
}

async function applyCompanyHardGroups(db: Kysely<DB>, summary: DuplicateDrainSummary): Promise<void> {
  const members = await loadCompanyDedupMembers(db);
  const groups = buildCompanyDedupGroups(members, HARD_COMPANY_EDGES);
  for (const group of groups.filter((candidate) => candidate.members.length > 1)) {
    const survivor = chooseCanonicalCompany(group);
    const survivorName = group.ownOrg ? undefined : spacedCompanyName(group, survivor.name);
    const losers = group.members
      .filter((member) => member.entityId !== survivor.entityId)
      .map((member) => member.entityId);
    await applyEntityGroup(
      db,
      `duplicate-drain:v2:m1:${compactEntityNameKey("company", survivorName ?? survivor.name)}`,
      survivor.entityId,
      losers,
      summary,
      survivorName,
    );
  }
}

async function queueAliasOnlyCompanyGroups(db: Kysely<DB>, summary: DuplicateDrainSummary): Promise<void> {
  const members = await loadCompanyDedupMembers(db);
  const hardGroups = buildCompanyDedupGroups(members, HARD_COMPANY_EDGES).filter((group) => group.members.length > 1);
  const hardSurvivorByMember = new Map<string, string>();
  for (const group of hardGroups) {
    const survivor = chooseCanonicalCompany(group);
    for (const member of group.members) hardSurvivorByMember.set(member.entityId, survivor.entityId);
  }
  const aliasGroups = buildCompanyDedupGroups(members).filter(
    (group) => group.members.length > 1 && group.edges.some((edge) => edge.kind === "name_alias"),
  );
  const repo = createEntityReviewRepo(db);
  for (const group of aliasGroups) {
    const memberById = new Map(group.members.map((member) => [member.entityId, member]));
    const rows = new Map<string, { member: (typeof group.members)[number]; candidateEntityId: string }>();
    for (const edge of group.edges.filter((candidate) => candidate.kind === "name_alias")) {
      const candidateIds = [
        ...new Set(
          edge.entityIds.map((entityId) => hardSurvivorByMember.get(entityId)).filter((id) => id !== undefined),
        ),
      ];
      for (const entityId of edge.entityIds) {
        if (hardSurvivorByMember.has(entityId)) continue;
        const member = memberById.get(entityId);
        if (!member) continue;
        for (const candidateEntityId of candidateIds) {
          rows.set(`${entityId}:${candidateEntityId}`, { member, candidateEntityId });
        }
      }
    }
    if (rows.size === 0 && !group.members.some((member) => hardSurvivorByMember.has(member.entityId))) {
      const survivor = chooseCanonicalCompany(group);
      for (const member of group.members) {
        if (member.entityId !== survivor.entityId)
          rows.set(`${member.entityId}:${survivor.entityId}`, { member, candidateEntityId: survivor.entityId });
      }
    }
    for (const { member, candidateEntityId } of rows.values()) {
      const candidateEntityIds = [...new Set([member.entityId, candidateEntityId])];
      if (candidateEntityIds.length < 2) {
        summary.aliasOnlyDropped++;
        continue;
      }
      await repo.upsertQueueRow({
        proposedName: member.name,
        normalizedName: normalizeName(member.name),
        entityType: "company",
        source: PASS_ID,
        sourceId: `v2:alias:${member.entityId}:${candidateEntityId}`,
        candidateEntityId,
        candidateEntityIds,
        candidateScore: 1,
        candidateReason: "name_alias",
        triggeredByUserId: "system",
      });
      summary.aliasOnlyQueued++;
    }
  }
}

async function applyProductGroups(db: Kysely<DB>, entities: Entity[], summary: DuplicateDrainSummary): Promise<void> {
  for (const group of groupEntities(
    entities.filter((entity) => entity.source_type === "product"),
    (entity) => compactEntityNameKey("product", entity.name),
  )) {
    const survivor = chooseGenericSurvivor(group);
    const losers = group.filter((entity) => entity.id !== survivor.id).map((entity) => entity.id);
    await applyEntityGroup(
      db,
      `duplicate-drain:v2:m2:${compactEntityNameKey("product", survivor.name)}`,
      survivor.id,
      losers,
      summary,
    );
  }
}

async function applyPersonTokenSetGroups(
  db: Kysely<DB>,
  entities: Entity[],
  emails: Map<string, Set<string>>,
  summary: DuplicateDrainSummary,
): Promise<void> {
  for (const group of groupEntities(
    entities.filter((entity) => entity.source_type === "person"),
    (entity) => normalizeTokenSet(entity.name),
  )) {
    const strictKeys = new Set(group.map((entity) => normalizeStrict(entity.name)));
    if (strictKeys.size < 2) continue;
    let vetoed = false;
    for (let i = 0; i < group.length && !vetoed; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (hasDisjointEmails(emailsForEntity(group[i], emails), emailsForEntity(group[j], emails))) {
          vetoed = true;
          summary.m3EmailVetoes++;
          break;
        }
      }
    }
    if (vetoed) continue;
    const survivor = chooseGenericSurvivor(group);
    const losers = group.filter((entity) => entity.id !== survivor.id).map((entity) => entity.id);
    await applyEntityGroup(
      db,
      `duplicate-drain:v2:m3:${normalizeTokenSet(survivor.name)}`,
      survivor.id,
      losers,
      summary,
    );
  }
}

async function applyPersonStrictGroups(
  db: Kysely<DB>,
  entities: Entity[],
  emails: Map<string, Set<string>>,
  summary: DuplicateDrainSummary,
): Promise<void> {
  for (const group of groupEntities(
    entities.filter((entity) => entity.source_type === "person"),
    (entity) => normalizeStrict(entity.name),
  )) {
    const withEmail = group.filter((entity) => (emails.get(entity.id)?.size ?? 0) > 0);
    if (withEmail.length > 1) continue;
    const survivor = chooseGenericSurvivor(group);
    const losers = group.filter((entity) => entity.id !== survivor.id).map((entity) => entity.id);
    await applyEntityGroup(db, `duplicate-drain:v2:m4:${normalizeStrict(survivor.name)}`, survivor.id, losers, summary);
  }
}

async function loadM5Rows(db: Kysely<DB>): Promise<{ mergeable: QueueRow[]; skippedPassReason: number }> {
  const rows = await db
    .selectFrom("entity_review_queue")
    .selectAll()
    .where("status", "=", "pending")
    .where("candidate_entity_id", "is not", null)
    .execute();
  return {
    mergeable: rows.filter((row) => row.pass_reason === null),
    skippedPassReason: rows.filter((row) => row.pass_reason !== null).length,
  };
}

async function applyM5Rows(
  db: Kysely<DB>,
  emails: Map<string, Set<string>>,
  summary: DuplicateDrainSummary,
): Promise<void> {
  const { mergeable, skippedPassReason } = await loadM5Rows(db);
  summary.m5SkippedPassReason += skippedPassReason;
  for (const row of mergeable) {
    if (!row.candidate_entity_id) continue;
    const candidate = await liveEntity(db, row.candidate_entity_id);
    const tokenSetKey = normalizeTokenSet(row.proposed_name);
    if (!candidate || !tokenSetKey || tokenSetKey !== normalizeTokenSet(candidate.name)) continue;
    const proposal = await db
      .selectFrom("entities")
      .selectAll()
      .where("source_type", "=", row.entity_type)
      .where("deleted_at", "is", null)
      .where("merged_into_entity_id", "is", null)
      .where("id", "!=", candidate.id)
      .where((eb) => eb(eb.fn("lower", ["name"]), "=", row.proposed_name.trim().toLowerCase()))
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .executeTakeFirst();
    if (!proposal) continue;
    if (
      candidate.source_type === "person" &&
      proposal.source_type === "person" &&
      hasDisjointEmails(emailsForEntity(candidate, emails), emailsForEntity(proposal, emails))
    ) {
      summary.m5EmailVetoes++;
      continue;
    }
    const groupId = `duplicate-drain:v2:m5:${row.id}`;
    await applyEntityGroup(db, groupId, candidate.id, [proposal.id], summary);
    await db
      .updateTable("entity_review_queue")
      .set({
        status: "confirmed",
        resolved_by: ACTOR,
        resolved_at: new Date().toISOString(),
        resolved_entity_id: candidate.id,
      })
      .where("id", "=", row.id)
      .where("status", "=", "pending")
      .where("pass_reason", "is", null)
      .execute();
  }
}

export async function runDuplicateDrain(
  db: Kysely<DB>,
  opts: DuplicateDrainOptions = {},
): Promise<DuplicateDrainSummary> {
  return withMaterializeReplayQueue(async () => {
    const state = await readState(db);
    if (state.status === "complete") return state;
    await writeState(db, state);
    try {
      const entities = await loadLiveEntities(db, opts, state);
      if (!entities) return state;
      const emails = await loadContactPointEmails(
        db,
        entities.filter((entity) => entity.source_type === "person"),
      );
      await queueAliasOnlyCompanyGroups(db, state);
      await applyCompanyHardGroups(db, state);
      await applyProductGroups(db, entities, state);
      await applyPersonTokenSetGroups(db, entities, emails, state);
      await applyPersonStrictGroups(db, entities, emails, state);
      await applyM5Rows(db, emails, state);
      const complete = { ...state, status: "complete" as const, cursorCreatedAt: null, cursorId: null };
      await writeState(db, complete);
      opts.logger?.info(complete, "duplicate drain complete");
      return complete;
    } catch (err) {
      await failState(db, err);
      throw err;
    }
  });
}

export function startDuplicateDrain(db: Kysely<DB>, logger?: Logger): DuplicateDrainHandle {
  let stopped = false;
  const done = runDuplicateDrain(db, { logger, shouldStop: () => stopped })
    .then(() => undefined)
    .catch((err) => {
      logger?.error({ err }, "duplicate drain failed");
    });
  return {
    done,
    stop: () => {
      stopped = true;
    },
  };
}

export const duplicateDrainActor = ACTOR;
export const duplicateDrainStateRowId = STATE_ROW_ID;
