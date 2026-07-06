import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type {
  DB,
  EntitiesTable,
  EntityAliasRejectionsTable,
  EntityCandidatesTable,
  EntityContactPointsTable,
  EntityDomainsTable,
  EntityMentionsTable,
  EntityProjectBindingsTable,
  EntityProjectMemberOverridesTable,
  EntityRelationshipsTable,
  EntityReviewQueueTable,
  EntityShareEmailsTable,
} from "../db/schema";
import { parseAliasesString } from "./materialize-json";
import { normalizeStrict } from "./name-dedup";

type Entity = Selectable<EntitiesTable>;
type Mention = Selectable<EntityMentionsTable>;
type Relationship = Selectable<EntityRelationshipsTable>;
type ContactPoint = Selectable<EntityContactPointsTable>;
type AliasRejection = Selectable<EntityAliasRejectionsTable>;
type EntityCandidate = Selectable<EntityCandidatesTable>;
type ReviewQueueRow = Selectable<EntityReviewQueueTable>;
type ShareEmail = Selectable<EntityShareEmailsTable>;
type Domain = Selectable<EntityDomainsTable>;
type ProjectBinding = Selectable<EntityProjectBindingsTable>;
type MemberOverride = Selectable<EntityProjectMemberOverridesTable>;

export type EntityMergeMove =
  | { table: string; rowId: string; repoint: Record<string, { from: string | null; to: string | null }> }
  | { table: string; collided: true; payload: Record<string, unknown> }
  | { table: "entity_relationships"; rowId: string; selfLoopDropped: true; payload: Record<string, unknown> }
  | {
      table: "entity_candidates";
      rowId: string;
      colChanges: Record<string, { before: string | null; after: string | null }>;
    }
  | { kind: "alias_added"; value: string; normalizedKey: string };

export type EntityMergeErrorCode =
  | "ENTITY_NOT_FOUND"
  | "SELF_MERGE"
  | "TYPE_MISMATCH"
  | "ALREADY_MERGED"
  | "MERGE_CONFLICT"
  | "MERGE_NOT_FOUND"
  | "MERGE_SUPERSEDED";

export class EntityMergeError extends Error {
  constructor(
    public readonly code: EntityMergeErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EntityMergeError";
  }
}

export interface MergeEntitiesInput {
  survivorId: string;
  loserId: string;
  userId: string;
}

export interface UnmergeEntitiesInput {
  mergeId: string;
  userId: string;
}

export interface MergeEntitiesResult {
  mergeId: string;
  moves: EntityMergeMove[];
}

export interface MergePreview {
  survivorId: string;
  loserId: string;
  blocked?: EntityMergeErrorCode;
  counts: {
    sourceRefs: number;
    mentions: number;
    relationships: number;
    contactPoints: number;
    shareEmails: number;
    aliasRejections: number;
    domains: number;
    candidates: number;
    reviewQueue: number;
  };
  collisions: {
    mentions: number;
    contactPoints: number;
    shareEmails: number;
    aliasRejections: number;
    domains: number;
    relationships: number;
  };
  selfLoopsDropped: number;
}

function rowPayload(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

function isAliasAddedMove(move: EntityMergeMove): move is Extract<EntityMergeMove, { kind: "alias_added" }> {
  return "kind" in move && move.kind === "alias_added";
}

function updatedCount(result: { numUpdatedRows?: bigint | number | string } | undefined): number {
  return Number(result?.numUpdatedRows ?? 0);
}

async function fetchRawEntity(db: Kysely<DB>, entityId: string): Promise<Entity | undefined> {
  return db.selectFrom("entities").selectAll().where("id", "=", entityId).executeTakeFirst();
}

function mergeBlocker(
  survivor: Entity | undefined,
  loser: Entity | undefined,
  input: { survivorId: string; loserId: string },
): EntityMergeError | null {
  if (!survivor || !loser) {
    return new EntityMergeError("ENTITY_NOT_FOUND", "survivor or loser entity was not found", {
      survivorId: input.survivorId,
      loserId: input.loserId,
    });
  }
  if (survivor.id === loser.id) {
    return new EntityMergeError("SELF_MERGE", "cannot merge an entity into itself", { entityId: survivor.id });
  }
  if (survivor.source_type !== loser.source_type) {
    return new EntityMergeError("TYPE_MISMATCH", "entities must have the same source_type to merge", {
      survivorType: survivor.source_type,
      loserType: loser.source_type,
    });
  }
  if (survivor.deleted_at || survivor.merged_into_entity_id) {
    return new EntityMergeError("ALREADY_MERGED", "survivor must be live", { survivorId: survivor.id });
  }
  if (loser.deleted_at || loser.merged_into_entity_id) {
    return new EntityMergeError("ALREADY_MERGED", "loser is already merged", { loserId: loser.id });
  }
  return null;
}

function assertMergeable(survivor: Entity | undefined, loser: Entity | undefined, input: MergeEntitiesInput): void {
  const blocker = mergeBlocker(survivor, loser, input);
  if (blocker) throw blocker;
}

async function findMentionCollision(
  db: Kysely<DB>,
  survivorId: string,
  row: Mention,
): Promise<{ id: string } | undefined> {
  return db
    .selectFrom("entity_mentions")
    .select("id")
    .where("entity_id", "=", survivorId)
    .where("indexed_file_id", "=", row.indexed_file_id)
    .where("relation", "=", row.relation)
    .executeTakeFirst();
}

async function findContactPointCollision(
  db: Kysely<DB>,
  survivorId: string,
  row: ContactPoint,
): Promise<{ id: string } | undefined> {
  return db
    .selectFrom("entity_contact_points")
    .select("id")
    .where("entity_id", "=", survivorId)
    .where("kind", "=", row.kind)
    .where("value", "=", row.value)
    .executeTakeFirst();
}

async function findAliasRejectionCollision(
  db: Kysely<DB>,
  survivorId: string,
  row: AliasRejection,
): Promise<{ id: string } | undefined> {
  return db
    .selectFrom("entity_alias_rejections")
    .select("id")
    .where("entity_id", "=", survivorId)
    .where("normalized_rejected_name", "=", row.normalized_rejected_name)
    .executeTakeFirst();
}

async function findShareEmailCollision(
  db: Kysely<DB>,
  survivorId: string,
  row: ShareEmail,
): Promise<{ entity_id: string } | undefined> {
  return db
    .selectFrom("entity_share_emails")
    .select("entity_id")
    .where("entity_id", "=", survivorId)
    .where("email", "=", row.email)
    .executeTakeFirst();
}

async function findDomainCollision(
  db: Kysely<DB>,
  survivorId: string,
  row: Domain,
): Promise<{ id: string } | undefined> {
  return db
    .selectFrom("entity_domains")
    .select("id")
    .where("entity_id", "=", survivorId)
    .where("domain", "=", row.domain)
    .executeTakeFirst();
}

function repointedRelationship(row: Relationship, loserId: string, survivorId: string) {
  return {
    source: row.source_entity_id === loserId ? survivorId : row.source_entity_id,
    target: row.target_entity_id === loserId ? survivorId : row.target_entity_id,
  };
}

async function findRelationshipCollision(
  db: Kysely<DB>,
  row: Relationship,
  sourceEntityId: string,
  targetEntityId: string,
): Promise<{ id: string } | undefined> {
  return db
    .selectFrom("entity_relationships")
    .select("id")
    .where("source_entity_id", "=", sourceEntityId)
    .where("target_entity_id", "=", targetEntityId)
    .where("relationship_type", "=", row.relationship_type)
    .where("valid_from", "=", row.valid_from)
    .where("id", "!=", row.id)
    .executeTakeFirst();
}

async function repointSourceRefs(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db.selectFrom("entity_source_refs").selectAll().where("entity_id", "=", loserId).execute();
  for (const row of rows) {
    await db.updateTable("entity_source_refs").set({ entity_id: survivorId }).where("id", "=", row.id).execute();
    moves.push({
      table: "entity_source_refs",
      rowId: row.id,
      repoint: { entity_id: { from: loserId, to: survivorId } },
    });
  }
}

async function repointEntityScopedRows<Row extends { id: string; entity_id: string }>(
  db: Kysely<DB>,
  opts: {
    table:
      | "entity_mentions"
      | "entity_contact_points"
      | "entity_alias_rejections"
      | "entity_project_bindings"
      | "entity_project_member_overrides";
    loserId: string;
    survivorId: string;
    rows: Row[];
    findCollision: (row: Row) => Promise<{ id: string } | undefined>;
    moves: EntityMergeMove[];
  },
): Promise<void> {
  for (const row of opts.rows) {
    const collision = await opts.findCollision(row);
    if (collision) {
      opts.moves.push({ table: opts.table, collided: true, payload: rowPayload(row) });
      await db.deleteFrom(opts.table).where("id", "=", row.id).execute();
      continue;
    }
    await db.updateTable(opts.table).set({ entity_id: opts.survivorId }).where("id", "=", row.id).execute();
    opts.moves.push({
      table: opts.table,
      rowId: row.id,
      repoint: { entity_id: { from: opts.loserId, to: opts.survivorId } },
    });
  }
}

async function repointMentions(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", loserId).execute();
  await repointEntityScopedRows<Mention>(db, {
    table: "entity_mentions",
    loserId,
    survivorId,
    rows,
    moves,
    findCollision: (row) => findMentionCollision(db, survivorId, row),
  });
}

async function repointContactPoints(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db.selectFrom("entity_contact_points").selectAll().where("entity_id", "=", loserId).execute();
  const movedIds = new Set(rows.map((row) => row.id));
  await repointEntityScopedRows<ContactPoint>(db, {
    table: "entity_contact_points",
    loserId,
    survivorId,
    rows,
    moves,
    findCollision: (row) => findContactPointCollision(db, survivorId, row),
  });
  await rebalancePrimaryContactPoints(db, survivorId, movedIds);
}

async function rebalancePrimaryContactPoints(db: Kysely<DB>, entityId: string, movedIds: Set<string>): Promise<void> {
  const primaries = await db
    .selectFrom("entity_contact_points")
    .select(["id", "kind", "created_at"])
    .where("entity_id", "=", entityId)
    .where("is_primary", "=", 1)
    .orderBy("kind")
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const byKind = new Map<string, typeof primaries>();
  for (const row of primaries) {
    byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);
  }
  const demoteIds: string[] = [];
  for (const rows of byKind.values()) {
    if (rows.length <= 1) continue;
    const keep = rows.find((row) => !movedIds.has(row.id)) ?? rows[0];
    for (const row of rows) {
      if (row.id !== keep.id) demoteIds.push(row.id);
    }
  }
  if (demoteIds.length > 0) {
    await db.updateTable("entity_contact_points").set({ is_primary: 0 }).where("id", "in", demoteIds).execute();
  }
}

async function repointAliasRejections(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db.selectFrom("entity_alias_rejections").selectAll().where("entity_id", "=", loserId).execute();
  await repointEntityScopedRows<AliasRejection>(db, {
    table: "entity_alias_rejections",
    loserId,
    survivorId,
    rows,
    moves,
    findCollision: (row) => findAliasRejectionCollision(db, survivorId, row),
  });
}

async function repointShareEmails(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db.selectFrom("entity_share_emails").selectAll().where("entity_id", "=", loserId).execute();
  for (const row of rows) {
    const collision = await findShareEmailCollision(db, survivorId, row);
    if (collision) {
      moves.push({ table: "entity_share_emails", collided: true, payload: rowPayload(row) });
      await db
        .deleteFrom("entity_share_emails")
        .where("entity_id", "=", row.entity_id)
        .where("email", "=", row.email)
        .execute();
      continue;
    }
    await db
      .updateTable("entity_share_emails")
      .set({ entity_id: survivorId })
      .where("entity_id", "=", row.entity_id)
      .where("email", "=", row.email)
      .execute();
    moves.push({
      table: "entity_share_emails",
      rowId: `${row.entity_id}:${row.email}`,
      repoint: { entity_id: { from: loserId, to: survivorId } },
    });
  }
}

async function repointDomains(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db.selectFrom("entity_domains").selectAll().where("entity_id", "=", loserId).execute();
  for (const row of rows) {
    const collision = await findDomainCollision(db, survivorId, row);
    if (collision) {
      moves.push({ table: "entity_domains", collided: true, payload: rowPayload(row) });
      await db.deleteFrom("entity_domains").where("id", "=", row.id).execute();
      continue;
    }
    await db.updateTable("entity_domains").set({ entity_id: survivorId }).where("id", "=", row.id).execute();
    moves.push({
      table: "entity_domains",
      rowId: row.id,
      repoint: { entity_id: { from: loserId, to: survivorId } },
    });
  }
}

async function findProjectBindingCollision(
  db: Kysely<DB>,
  survivorId: string,
  row: { source: string; container_id: string },
): Promise<{ id: string } | undefined> {
  return db
    .selectFrom("entity_project_bindings")
    .select("id")
    .where("entity_id", "=", survivorId)
    .where("source", "=", row.source)
    .where("container_id", "=", row.container_id)
    .executeTakeFirst();
}

async function repointProjectBindings(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db.selectFrom("entity_project_bindings").selectAll().where("entity_id", "=", loserId).execute();
  await repointEntityScopedRows<ProjectBinding>(db, {
    table: "entity_project_bindings",
    loserId,
    survivorId,
    rows,
    moves,
    findCollision: (row) => findProjectBindingCollision(db, survivorId, row),
  });
}

async function findMemberOverrideCollision(
  db: Kysely<DB>,
  survivorId: string,
  row: { indexed_file_id: string },
): Promise<{ id: string } | undefined> {
  return db
    .selectFrom("entity_project_member_overrides")
    .select("id")
    .where("entity_id", "=", survivorId)
    .where("indexed_file_id", "=", row.indexed_file_id)
    .executeTakeFirst();
}

async function repointMemberOverrides(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db
    .selectFrom("entity_project_member_overrides")
    .selectAll()
    .where("entity_id", "=", loserId)
    .execute();
  await repointEntityScopedRows<MemberOverride>(db, {
    table: "entity_project_member_overrides",
    loserId,
    survivorId,
    rows,
    moves,
    findCollision: (row) => findMemberOverrideCollision(db, survivorId, row),
  });
}

async function moveRelationshipEvidence(
  db: Kysely<DB>,
  oldRelationshipId: string,
  newRelationshipId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db
    .selectFrom("entity_relationship_evidence")
    .selectAll()
    .where("relationship_id", "=", oldRelationshipId)
    .execute();
  for (const row of rows) {
    const collision = await db
      .selectFrom("entity_relationship_evidence")
      .select("id")
      .where("relationship_id", "=", newRelationshipId)
      .where("evidence_key", "=", row.evidence_key)
      .executeTakeFirst();
    if (collision) {
      moves.push({ table: "entity_relationship_evidence", collided: true, payload: rowPayload(row) });
      await db.deleteFrom("entity_relationship_evidence").where("id", "=", row.id).execute();
      continue;
    }
    await db
      .updateTable("entity_relationship_evidence")
      .set({ relationship_id: newRelationshipId })
      .where("id", "=", row.id)
      .execute();
    moves.push({
      table: "entity_relationship_evidence",
      rowId: row.id,
      repoint: { relationship_id: { from: oldRelationshipId, to: newRelationshipId } },
    });
  }
}

async function dropRelationshipWithEvidence(
  db: Kysely<DB>,
  relationship: Relationship,
  moves: EntityMergeMove[],
): Promise<void> {
  const evidence = await db
    .selectFrom("entity_relationship_evidence")
    .selectAll()
    .where("relationship_id", "=", relationship.id)
    .execute();
  for (const row of evidence) {
    moves.push({ table: "entity_relationship_evidence", collided: true, payload: rowPayload(row) });
  }
  moves.push({
    table: "entity_relationships",
    rowId: relationship.id,
    selfLoopDropped: true,
    payload: rowPayload(relationship),
  });
  await db.deleteFrom("entity_relationships").where("id", "=", relationship.id).execute();
}

async function repointRelationships(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db
    .selectFrom("entity_relationships")
    .selectAll()
    .where((eb) => eb.or([eb("source_entity_id", "=", loserId), eb("target_entity_id", "=", loserId)]))
    .execute();

  for (const row of rows) {
    const { source: nextSource, target: nextTarget } = repointedRelationship(row, loserId, survivorId);

    if (nextSource === nextTarget) {
      await dropRelationshipWithEvidence(db, row, moves);
      continue;
    }

    const collision = await findRelationshipCollision(db, row, nextSource, nextTarget);

    if (collision) {
      await moveRelationshipEvidence(db, row.id, collision.id, moves);
      moves.push({ table: "entity_relationships", collided: true, payload: rowPayload(row) });
      await db.deleteFrom("entity_relationships").where("id", "=", row.id).execute();
      continue;
    }

    const repoint: Record<string, { from: string | null; to: string | null }> = {};
    if (row.source_entity_id !== nextSource) repoint.source_entity_id = { from: row.source_entity_id, to: nextSource };
    if (row.target_entity_id !== nextTarget) repoint.target_entity_id = { from: row.target_entity_id, to: nextTarget };
    await db
      .updateTable("entity_relationships")
      .set({ source_entity_id: nextSource, target_entity_id: nextTarget, updated_at: new Date().toISOString() })
      .where("id", "=", row.id)
      .execute();
    moves.push({ table: "entity_relationships", rowId: row.id, repoint });
  }
}

function rewriteObservedPeople(raw: string | null, loserId: string, survivorId: string): string | null {
  if (!raw) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!Array.isArray(parsed)) return raw;
  const next: string[] = [];
  let changed = false;
  for (const value of parsed) {
    if (typeof value !== "string") continue;
    const rewritten = value === loserId ? survivorId : value;
    if (rewritten !== value) changed = true;
    if (!next.includes(rewritten)) next.push(rewritten);
  }
  if (!changed) return raw;
  return JSON.stringify(next);
}

async function repointCandidates(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db.selectFrom("entity_candidates").selectAll().execute();
  for (const row of rows) {
    const changes: Record<string, { before: string | null; after: string | null }> = {};
    const updates: Partial<EntityCandidate> = {};
    if (row.promoted_entity_id === loserId) {
      changes.promoted_entity_id = { before: loserId, after: survivorId };
      updates.promoted_entity_id = survivorId;
    }
    const rewrittenObserved = rewriteObservedPeople(row.observed_person_entity_ids, loserId, survivorId);
    if (rewrittenObserved !== row.observed_person_entity_ids) {
      changes.observed_person_entity_ids = { before: row.observed_person_entity_ids, after: rewrittenObserved };
      updates.observed_person_entity_ids = rewrittenObserved;
    }
    if (Object.keys(changes).length === 0) continue;
    await db.updateTable("entity_candidates").set(updates).where("id", "=", row.id).execute();
    moves.push({ table: "entity_candidates", rowId: row.id, colChanges: changes });
  }
}

async function repointReviewQueue(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  const rows = await db
    .selectFrom("entity_review_queue")
    .selectAll()
    .where((eb) => eb.or([eb("candidate_entity_id", "=", loserId), eb("resolved_entity_id", "=", loserId)]))
    .execute();
  for (const row of rows) {
    const repoint: Record<string, { from: string | null; to: string | null }> = {};
    const updates: Partial<ReviewQueueRow> = {};
    if (row.candidate_entity_id === loserId) {
      repoint.candidate_entity_id = { from: loserId, to: survivorId };
      updates.candidate_entity_id = survivorId;
    }
    if (row.resolved_entity_id === loserId) {
      repoint.resolved_entity_id = { from: loserId, to: survivorId };
      updates.resolved_entity_id = survivorId;
    }
    await db.updateTable("entity_review_queue").set(updates).where("id", "=", row.id).execute();
    moves.push({ table: "entity_review_queue", rowId: row.id, repoint });
  }
}

async function applyMergeMoves(
  db: Kysely<DB>,
  loserId: string,
  survivorId: string,
  moves: EntityMergeMove[],
): Promise<void> {
  await repointSourceRefs(db, loserId, survivorId, moves);
  await repointMentions(db, loserId, survivorId, moves);
  await repointRelationships(db, loserId, survivorId, moves);
  await repointContactPoints(db, loserId, survivorId, moves);
  await repointShareEmails(db, loserId, survivorId, moves);
  await repointAliasRejections(db, loserId, survivorId, moves);
  await repointDomains(db, loserId, survivorId, moves);
  await repointProjectBindings(db, loserId, survivorId, moves);
  await repointMemberOverrides(db, loserId, survivorId, moves);
  await repointCandidates(db, loserId, survivorId, moves);
  await repointReviewQueue(db, loserId, survivorId, moves);
}

async function carryLoserAliasesToSurvivor(
  db: Kysely<DB>,
  loser: Entity,
  survivor: Entity,
  moves: EntityMergeMove[],
): Promise<void> {
  const aliases = parseAliasesString(survivor.aliases);
  const existingKeys = new Set<string>();
  const survivorNameKey = normalizeStrict(survivor.name);
  if (survivorNameKey) existingKeys.add(survivorNameKey);
  for (const alias of aliases) {
    const key = normalizeStrict(alias);
    if (key) existingKeys.add(key);
  }

  const added: string[] = [];
  for (const raw of [loser.name, ...parseAliasesString(loser.aliases)]) {
    const value = raw.trim();
    const normalizedKey = normalizeStrict(value);
    if (!value || !normalizedKey || existingKeys.has(normalizedKey)) continue;
    existingKeys.add(normalizedKey);
    aliases.push(value);
    added.push(value);
    moves.push({ kind: "alias_added", value, normalizedKey });
  }

  if (added.length === 0) return;
  await db
    .updateTable("entities")
    .set({ aliases: JSON.stringify(aliases), updated_at: new Date().toISOString() })
    .where("id", "=", survivor.id)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .execute();
}

function emptyMergePreview(
  input: { survivorId: string; loserId: string },
  blocked?: EntityMergeErrorCode,
): MergePreview {
  return {
    survivorId: input.survivorId,
    loserId: input.loserId,
    ...(blocked ? { blocked } : {}),
    counts: {
      sourceRefs: 0,
      mentions: 0,
      relationships: 0,
      contactPoints: 0,
      shareEmails: 0,
      aliasRejections: 0,
      domains: 0,
      candidates: 0,
      reviewQueue: 0,
    },
    collisions: {
      mentions: 0,
      contactPoints: 0,
      shareEmails: 0,
      aliasRejections: 0,
      domains: 0,
      relationships: 0,
    },
    selfLoopsDropped: 0,
  };
}

async function countCollisions<Row>(
  rows: Row[],
  findCollision: (row: Row) => Promise<unknown | undefined>,
): Promise<number> {
  let count = 0;
  for (const row of rows) {
    if (await findCollision(row)) count += 1;
  }
  return count;
}

export async function previewMerge(
  db: Kysely<DB>,
  input: { survivorId: string; loserId: string },
): Promise<MergePreview> {
  const survivor = await fetchRawEntity(db, input.survivorId);
  const loser = await fetchRawEntity(db, input.loserId);
  const blocker = mergeBlocker(survivor, loser, input);
  if (blocker) return emptyMergePreview(input, blocker.code);

  const preview = emptyMergePreview(input);
  const sourceRefs = await db
    .selectFrom("entity_source_refs")
    .select("id")
    .where("entity_id", "=", input.loserId)
    .execute();
  const mentions = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", input.loserId).execute();
  const relationships = await db
    .selectFrom("entity_relationships")
    .selectAll()
    .where((eb) => eb.or([eb("source_entity_id", "=", input.loserId), eb("target_entity_id", "=", input.loserId)]))
    .execute();
  const contactPoints = await db
    .selectFrom("entity_contact_points")
    .selectAll()
    .where("entity_id", "=", input.loserId)
    .execute();
  const shareEmails = await db
    .selectFrom("entity_share_emails")
    .selectAll()
    .where("entity_id", "=", input.loserId)
    .execute();
  const aliasRejections = await db
    .selectFrom("entity_alias_rejections")
    .selectAll()
    .where("entity_id", "=", input.loserId)
    .execute();
  const domains = await db.selectFrom("entity_domains").selectAll().where("entity_id", "=", input.loserId).execute();
  const candidates = await db.selectFrom("entity_candidates").selectAll().execute();
  const reviewQueue = await db
    .selectFrom("entity_review_queue")
    .select("id")
    .where((eb) => eb.or([eb("candidate_entity_id", "=", input.loserId), eb("resolved_entity_id", "=", input.loserId)]))
    .execute();

  preview.counts.sourceRefs = sourceRefs.length;
  preview.counts.mentions = mentions.length;
  preview.counts.relationships = relationships.length;
  preview.counts.contactPoints = contactPoints.length;
  preview.counts.shareEmails = shareEmails.length;
  preview.counts.aliasRejections = aliasRejections.length;
  preview.counts.domains = domains.length;
  preview.counts.candidates = candidates.filter((row) => {
    if (row.promoted_entity_id === input.loserId) return true;
    return (
      rewriteObservedPeople(row.observed_person_entity_ids, input.loserId, input.survivorId) !==
      row.observed_person_entity_ids
    );
  }).length;
  preview.counts.reviewQueue = reviewQueue.length;

  preview.collisions.mentions = await countCollisions(mentions, (row) =>
    findMentionCollision(db, input.survivorId, row),
  );
  preview.collisions.contactPoints = await countCollisions(contactPoints, (row) =>
    findContactPointCollision(db, input.survivorId, row),
  );
  preview.collisions.shareEmails = await countCollisions(shareEmails, (row) =>
    findShareEmailCollision(db, input.survivorId, row),
  );
  preview.collisions.aliasRejections = await countCollisions(aliasRejections, (row) =>
    findAliasRejectionCollision(db, input.survivorId, row),
  );
  preview.collisions.domains = await countCollisions(domains, (row) => findDomainCollision(db, input.survivorId, row));

  for (const row of relationships) {
    const { source, target } = repointedRelationship(row, input.loserId, input.survivorId);
    if (source === target) {
      preview.selfLoopsDropped += 1;
      continue;
    }
    if (await findRelationshipCollision(db, row, source, target)) preview.collisions.relationships += 1;
  }

  return preview;
}

async function insertPayload(db: Kysely<DB>, table: string, payload: Record<string, unknown>): Promise<void> {
  await db
    .insertInto(table as never)
    .values(payload as never)
    .execute();
}

async function reverseMove(db: Kysely<DB>, move: EntityMergeMove): Promise<void> {
  if (isAliasAddedMove(move)) return;
  if ("collided" in move) {
    await insertPayload(db, move.table, move.payload);
    return;
  }
  if ("selfLoopDropped" in move) {
    await insertPayload(db, move.table, move.payload);
    return;
  }
  if ("colChanges" in move) {
    const updates: Record<string, string | null> = {};
    for (const [column, change] of Object.entries(move.colChanges)) updates[column] = change.before;
    await db.updateTable("entity_candidates").set(updates).where("id", "=", move.rowId).execute();
    return;
  }
  const updates: Record<string, string | null> = {};
  for (const [column, change] of Object.entries(move.repoint)) updates[column] = change.from;
  if (move.table === "entity_share_emails") {
    const email = move.rowId.slice(move.rowId.indexOf(":") + 1);
    const entityId = updates.entity_id;
    if (!entityId) return;
    await db
      .updateTable("entity_share_emails")
      .set({ entity_id: entityId })
      .where("entity_id", "=", move.repoint.entity_id.to)
      .where("email", "=", email)
      .execute();
    return;
  }
  if (move.table === "entity_source_refs" && updates.entity_id) {
    const result = await db
      .updateTable("entity_source_refs")
      .set({ entity_id: updates.entity_id })
      .where("id", "=", move.rowId)
      .where("entity_id", "=", move.repoint.entity_id.to)
      .executeTakeFirst();
    if (updatedCount(result) === 0) {
      throw new EntityMergeError("MERGE_CONFLICT", "source ref changed owner after merge", {
        table: move.table,
        rowId: move.rowId,
      });
    }
    return;
  }
  if (move.table === "entity_mentions" && updates.entity_id) {
    await db
      .updateTable("entity_mentions")
      .set({ entity_id: updates.entity_id })
      .where("id", "=", move.rowId)
      .execute();
    return;
  }
  if (move.table === "entity_contact_points" && updates.entity_id) {
    await db
      .updateTable("entity_contact_points")
      .set({ entity_id: updates.entity_id })
      .where("id", "=", move.rowId)
      .execute();
    return;
  }
  if (move.table === "entity_alias_rejections" && updates.entity_id) {
    await db
      .updateTable("entity_alias_rejections")
      .set({ entity_id: updates.entity_id })
      .where("id", "=", move.rowId)
      .execute();
    return;
  }
  if (move.table === "entity_project_bindings" && updates.entity_id) {
    await db
      .updateTable("entity_project_bindings")
      .set({ entity_id: updates.entity_id })
      .where("id", "=", move.rowId)
      .execute();
    return;
  }
  if (move.table === "entity_project_member_overrides" && updates.entity_id) {
    await db
      .updateTable("entity_project_member_overrides")
      .set({ entity_id: updates.entity_id })
      .where("id", "=", move.rowId)
      .execute();
    return;
  }
  if (move.table === "entity_domains") {
    await db
      .updateTable("entity_domains")
      .set({ entity_id: updates.entity_id ?? null })
      .where("id", "=", move.rowId)
      .execute();
    return;
  }
  if (move.table === "entity_relationship_evidence" && updates.relationship_id) {
    await db
      .updateTable("entity_relationship_evidence")
      .set({ relationship_id: updates.relationship_id })
      .where("id", "=", move.rowId)
      .execute();
    return;
  }
  if (move.table === "entity_relationships") {
    await db
      .updateTable("entity_relationships")
      .set({
        source_entity_id: updates.source_entity_id ?? undefined,
        target_entity_id: updates.target_entity_id ?? undefined,
      })
      .where("id", "=", move.rowId)
      .execute();
    return;
  }
  if (move.table === "entity_review_queue") {
    await db
      .updateTable("entity_review_queue")
      .set({
        candidate_entity_id: updates.candidate_entity_id,
        resolved_entity_id: updates.resolved_entity_id,
      })
      .where("id", "=", move.rowId)
      .execute();
  }
}

async function reverseAliasAdditions(db: Kysely<DB>, survivorId: string, moves: EntityMergeMove[]): Promise<void> {
  const aliasMoves = moves.filter(isAliasAddedMove);
  if (aliasMoves.length === 0) return;

  const row = await db
    .selectFrom("entities")
    .select("aliases")
    .where("id", "=", survivorId)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .executeTakeFirst();
  if (!row) return;

  const toRemove = new Set(aliasMoves.map((move) => `${move.normalizedKey}\0${move.value}`));
  const aliases = parseAliasesString(row.aliases);
  const next = aliases.filter((alias) => !toRemove.has(`${normalizeStrict(alias)}\0${alias}`));
  if (next.length === aliases.length) return;

  await db
    .updateTable("entities")
    .set({ aliases: next.length > 0 ? JSON.stringify(next) : null, updated_at: new Date().toISOString() })
    .where("id", "=", survivorId)
    .execute();
}

export async function mergeEntitiesInTransaction(
  db: Kysely<DB>,
  input: MergeEntitiesInput,
): Promise<MergeEntitiesResult> {
  const survivor = await fetchRawEntity(db, input.survivorId);
  const loser = await fetchRawEntity(db, input.loserId);
  assertMergeable(survivor, loser, input);

  const moves: EntityMergeMove[] = [];
  await applyMergeMoves(db, input.loserId, input.survivorId, moves);
  if (survivor && loser) await carryLoserAliasesToSurvivor(db, loser, survivor, moves);

  const now = new Date().toISOString();
  const tombstone = await db
    .updateTable("entities")
    .set({ deleted_at: now, merged_into_entity_id: input.survivorId, updated_at: now })
    .where("id", "=", input.loserId)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .executeTakeFirst();
  if (updatedCount(tombstone) !== 1) {
    throw new EntityMergeError("MERGE_CONFLICT", "loser was concurrently merged", { loserId: input.loserId });
  }

  const mergeId = randomUUID();
  await db
    .insertInto("entity_merges")
    .values({
      id: mergeId,
      survivor_entity_id: input.survivorId,
      merged_entity_id: input.loserId,
      entity_type: survivor?.source_type ?? "",
      moves: JSON.stringify(moves),
      merged_by_user_id: input.userId,
    })
    .execute();

  return { mergeId, moves };
}

export async function mergeEntities(db: Kysely<DB>, input: MergeEntitiesInput): Promise<MergeEntitiesResult> {
  return db.transaction().execute((trx) => mergeEntitiesInTransaction(trx, input));
}

export async function unmergeEntities(db: Kysely<DB>, input: UnmergeEntitiesInput): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const merge = await trx
      .selectFrom("entity_merges")
      .selectAll()
      .where("id", "=", input.mergeId)
      .where("unmerged_at", "is", null)
      .executeTakeFirst();
    if (!merge) throw new EntityMergeError("MERGE_NOT_FOUND", "active merge not found", { mergeId: input.mergeId });

    const survivor = await fetchRawEntity(trx, merge.survivor_entity_id);
    if (!survivor || survivor.deleted_at || survivor.merged_into_entity_id) {
      throw new EntityMergeError("MERGE_SUPERSEDED", "merge survivor is no longer live", {
        survivorId: merge.survivor_entity_id,
      });
    }

    const later = await trx
      .selectFrom("entity_merges")
      .select("id")
      .where("merged_entity_id", "=", merge.survivor_entity_id)
      .where("unmerged_at", "is", null)
      .executeTakeFirst();
    if (later) {
      throw new EntityMergeError("MERGE_SUPERSEDED", "a later active merge supersedes this merge", {
        mergeId: input.mergeId,
        laterMergeId: later.id,
      });
    }

    const revived = await trx
      .updateTable("entities")
      .set({ deleted_at: null, merged_into_entity_id: null, updated_at: new Date().toISOString() })
      .where("id", "=", merge.merged_entity_id)
      .where("merged_into_entity_id", "=", merge.survivor_entity_id)
      .executeTakeFirst();
    if (updatedCount(revived) !== 1) {
      throw new EntityMergeError("MERGE_CONFLICT", "merged entity could not be revived", {
        mergedEntityId: merge.merged_entity_id,
      });
    }

    const moves = JSON.parse(merge.moves) as EntityMergeMove[];
    await reverseAliasAdditions(trx, merge.survivor_entity_id, moves);
    for (const move of [...moves].reverse()) {
      await reverseMove(trx, move);
    }

    await trx
      .updateTable("entity_merges")
      .set({ unmerged_at: new Date().toISOString(), unmerged_by_user_id: input.userId })
      .where("id", "=", input.mergeId)
      .where("unmerged_at", "is", null)
      .execute();
  });
}
