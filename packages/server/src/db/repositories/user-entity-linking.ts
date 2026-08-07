import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, type Transaction, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import type { DB, EntitiesTable, UsersTable } from "../schema";
import { isHumanSubtypeOverride, normalizeContactPointValue } from "./entities";
import { createEntityReviewRepo } from "./entity-review";

type LinkDb = Kysely<DB> | Transaction<DB>;
type Entity = Selectable<EntitiesTable>;
type User = Selectable<UsersTable>;

export type UserEntityLinkOutcome =
  | {
      outcome: "linked";
      userId: string;
      entityId: string;
      matchedVia: "email" | "phone" | "review" | "provisioning" | "user_creation";
    }
  | { outcome: "review_queued"; entityId: string; reason: string }
  | { outcome: "skipped"; entityId: string; reason: string }
  | { outcome: "already_linked"; userId: string; entityId: string };

type UserProvisioner = {
  findByEmail(email: string): Promise<{ id: string; type?: string } | undefined>;
  create(data: {
    name: string;
    email: string;
    emailVerified?: boolean;
    skipEntityLinking?: boolean;
  }): Promise<{ id: string; type?: string; slack_user_id: string | null }>;
};

const TERMINAL_REVIEW_STATUSES = ["confirmed", "rejected", "dismissed"];
const INTERNAL_EVIDENCE_SOURCES = ["organization_domain", "team_roster"];

function normalizeEmail(value: string): string {
  return normalizeContactPointValue("email", value);
}

function normalizePhone(value: string): string | null {
  try {
    return normalizeContactPointValue("phone", value);
  } catch {
    return null;
  }
}

function readMetadataEmail(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const email = (parsed as Record<string, unknown>).email;
    return typeof email === "string" && email.trim() ? normalizeEmail(email) : null;
  } catch {
    return null;
  }
}

function readAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function contactPointValues(
  entity: Entity,
  points: Array<{ kind: string; value: string }>,
): {
  emails: string[];
  phones: string[];
} {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const metadataEmail = readMetadataEmail(entity.metadata);
  if (metadataEmail) emails.add(metadataEmail);
  for (const point of points) {
    if (point.kind === "email") emails.add(normalizeEmail(point.value));
    if (point.kind === "phone" || point.kind === "whatsapp") {
      const phone = normalizePhone(point.value);
      if (phone) phones.add(phone);
    }
  }
  return { emails: [...emails], phones: [...phones] };
}

function reviewTouchesEntity(
  review: {
    source: string | null;
    source_id: string | null;
    candidate_entity_id: string | null;
    candidate_entity_ids: string | null;
  },
  entityId: string,
): boolean {
  if (review.source === "user_entity_link" && review.source_id === entityId) return true;
  if (review.candidate_entity_id === entityId) return true;
  if (!review.candidate_entity_ids) return false;
  try {
    const candidates = JSON.parse(review.candidate_entity_ids) as unknown;
    return Array.isArray(candidates) && candidates.includes(entityId);
  } catch {
    return false;
  }
}

type MatchableUser = Pick<User, "id" | "name" | "email" | "whatsapp_number" | "type">;
type LoadedEntity = { entity: Entity; emails: string[]; phones: string[] };

type EntityLinkBatchContext = {
  linksByEntity: Map<string, Selectable<DB["user_entity_links"]>>;
  linksByUser: Map<string, Selectable<DB["user_entity_links"]>>;
  openReviewEntityIds: Set<string>;
  agentAnchoredEntityIds: Set<string>;
  evidenceBackedEntityIds: Set<string>;
  users: MatchableUser[];
  nameCandidatesByEntity: Map<string, string[]>;
  triggeredByUserId: string;
};

async function findActorUserId(db: LinkDb): Promise<string> {
  const admin = await db
    .selectFrom("users")
    .select("id")
    .where("type", "=", "human")
    .where("auth_role", "=", "admin")
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  if (admin) return admin.id;
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("type", "=", "human")
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  return user?.id ?? "system";
}

async function writeLink(
  db: LinkDb,
  input: {
    userId: string;
    entityId: string;
    matchedVia: "email" | "phone" | "review" | "provisioning" | "user_creation";
    confirmedByUserId?: string | null;
  },
): Promise<{ winner: boolean; existingUserEntityId: string | null; existingEntityUserId: string | null }> {
  await db
    .insertInto("user_entity_links")
    .values({
      id: randomUUID(),
      user_id: input.userId,
      entity_id: input.entityId,
      matched_via: input.matchedVia,
      confirmed_by_user_id: input.confirmedByUserId ?? null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  const byUser = await db
    .selectFrom("user_entity_links")
    .select("entity_id")
    .where("user_id", "=", input.userId)
    .executeTakeFirst();
  const byEntity = await db
    .selectFrom("user_entity_links")
    .select("user_id")
    .where("entity_id", "=", input.entityId)
    .executeTakeFirst();
  return {
    winner: byUser?.entity_id === input.entityId && byEntity?.user_id === input.userId,
    existingUserEntityId: byUser?.entity_id ?? null,
    existingEntityUserId: byEntity?.user_id ?? null,
  };
}

async function queueIdentityReview(
  db: LinkDb,
  entity: Entity,
  input: {
    reason: string;
    candidateUserIds?: string[];
    candidateEntityIds?: string[];
    triggeredByUserId?: string;
  },
): Promise<UserEntityLinkOutcome> {
  await createEntityReviewRepo(db).upsertUserEntityLinkReview({
    entityId: entity.id,
    proposedName: entity.name,
    candidateUserIds: input.candidateUserIds ?? [],
    candidateEntityIds: input.candidateEntityIds ?? [],
    candidateReason: input.reason,
    triggeredByUserId: input.triggeredByUserId ?? (await findActorUserId(db)),
  });
  return { outcome: "review_queued", entityId: entity.id, reason: input.reason };
}

async function findNameCandidates(db: LinkDb, entity: Entity): Promise<string[]> {
  const normalized = normalizeName(entity.name);
  const aliasPattern = `%${normalized}%`;
  const entities = await db
    .selectFrom("entities")
    .select(["id", "name", "aliases"])
    .where("source_type", "=", "person")
    .where("deleted_at", "is", null)
    .where("id", "!=", entity.id)
    .where(sql<boolean>`lower(trim(name)) = ${normalized} OR lower(aliases) LIKE ${aliasPattern}`)
    .execute();
  return entities
    .filter(
      (candidate) =>
        normalizeName(candidate.name) === normalized ||
        readAliases(candidate.aliases).some((alias) => normalizeName(alias) === normalized),
    )
    .map((candidate) => candidate.id);
}

async function findCandidateEntityIdsForUsers(db: LinkDb, users: MatchableUser[]): Promise<Set<string>> {
  const emails = [...new Set(users.flatMap((user) => (user.email ? [normalizeEmail(user.email)] : [])))];
  const phones = [
    ...new Set(
      users.flatMap((user) => {
        const phone = user.whatsapp_number ? normalizePhone(user.whatsapp_number) : null;
        return phone ? [phone] : [];
      }),
    ),
  ];
  const names = [...new Set(users.map((user) => normalizeName(user.name)).filter(Boolean))];
  const candidateIds = new Set<string>();

  const entityPredicates = [
    ...names.map((name) => {
      const pattern = `%${name}%`;
      return sql<boolean>`lower(trim(name)) = ${name} OR lower(aliases) LIKE ${pattern}`;
    }),
    ...emails.map((email) => {
      const pattern = `%${email}%`;
      return sql<boolean>`lower(metadata) LIKE ${pattern}`;
    }),
  ];
  if (entityPredicates.length > 0) {
    const entities = await db
      .selectFrom("entities")
      .select("id")
      .where("source_type", "=", "person")
      .where("deleted_at", "is", null)
      .where(sql<boolean>`${sql.join(entityPredicates, sql` OR `)}`)
      .execute();
    for (const entity of entities) candidateIds.add(entity.id);
  }

  const contactPredicates = [];
  if (emails.length > 0) {
    contactPredicates.push(sql<boolean>`kind = 'email' AND lower(trim(value)) in (${sql.join(emails)})`);
  }
  if (phones.length > 0) {
    contactPredicates.push(sql<boolean>`kind in ('phone', 'whatsapp') AND value in (${sql.join(phones)})`);
  }
  if (contactPredicates.length > 0) {
    const points = await db
      .selectFrom("entity_contact_points")
      .select("entity_id")
      .where(sql<boolean>`${sql.join(contactPredicates, sql` OR `)}`)
      .execute();
    for (const point of points) candidateIds.add(point.entity_id);
  }

  const sourceRefs = await db
    .selectFrom("entity_source_refs")
    .select("entity_id")
    .where("source", "=", "sketch_user")
    .where(
      "source_id",
      "in",
      users.map((user) => user.id),
    )
    .execute();
  for (const sourceRef of sourceRefs) candidateIds.add(sourceRef.entity_id);
  return candidateIds;
}

async function loadEntityBatch(db: LinkDb, entityIds: string[]): Promise<Map<string, LoadedEntity>> {
  if (entityIds.length === 0) return new Map();
  const entities = await db
    .selectFrom("entities")
    .selectAll()
    .where("id", "in", entityIds)
    .where("source_type", "=", "person")
    .where("deleted_at", "is", null)
    .execute();
  const points = await db
    .selectFrom("entity_contact_points")
    .select(["entity_id", "kind", "value"])
    .where("entity_id", "in", entityIds)
    .execute();
  const pointsByEntity = new Map<string, Array<{ kind: string; value: string }>>();
  for (const point of points) {
    pointsByEntity.set(point.entity_id, [...(pointsByEntity.get(point.entity_id) ?? []), point]);
  }
  return new Map(
    entities.map((entity) => {
      const values = contactPointValues(entity, pointsByEntity.get(entity.id) ?? []);
      return [entity.id, { entity, ...values }];
    }),
  );
}

async function loadEntityLinkBatchContext(
  db: LinkDb,
  entityIds: string[],
  loadedEntities: LoadedEntity[],
  targetUsers: MatchableUser[] = [],
): Promise<EntityLinkBatchContext> {
  const entities = loadedEntities.map((loaded) => loaded.entity);
  const emails = [...new Set(loadedEntities.flatMap((loaded) => loaded.emails))];
  const phones = [...new Set(loadedEntities.flatMap((loaded) => loaded.phones))];
  const userPredicates = [
    ...emails.map((email) => sql<boolean>`lower(trim(email)) = ${email}`),
    ...phones.map((phone) => sql<boolean>`whatsapp_number = ${phone}`),
  ];
  const relevantUserRows =
    userPredicates.length === 0
      ? []
      : await db
          .selectFrom("users")
          .select(["id", "name", "email", "whatsapp_number", "type"])
          .where(sql<boolean>`${sql.join(userPredicates, sql` OR `)}`)
          .execute();
  const users = [...new Map([...targetUsers, ...relevantUserRows].map((user) => [user.id, user])).values()];
  const relevantUserIds = users.map((user) => user.id);
  const linkPredicates = [
    ...(entityIds.length > 0 ? [sql<boolean>`entity_id in (${sql.join(entityIds)})`] : []),
    ...(relevantUserIds.length > 0 ? [sql<boolean>`user_id in (${sql.join(relevantUserIds)})`] : []),
  ];
  const reviewPredicates =
    entityIds.length === 0
      ? []
      : [
          sql<boolean>`source = 'user_entity_link' AND source_id in (${sql.join(entityIds)})`,
          sql<boolean>`candidate_entity_id in (${sql.join(entityIds)})`,
          ...entityIds.map((entityId) => {
            const pattern = `%${entityId}%`;
            return sql<boolean>`candidate_entity_ids LIKE ${pattern}`;
          }),
        ];
  const namePredicates = entities.flatMap((entity) => {
    const normalized = normalizeName(entity.name);
    const pattern = `%${normalized}%`;
    return [sql<boolean>`lower(trim(name)) = ${normalized}`, sql<boolean>`lower(aliases) LIKE ${pattern}`];
  });
  const [links, openReviews, sourceRefs, slackRefs, evidenceRows, allPeople] = await Promise.all([
    linkPredicates.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("user_entity_links")
          .selectAll()
          .where(sql<boolean>`${sql.join(linkPredicates, sql` OR `)}`)
          .execute(),
    db
      .selectFrom("entity_review_queue")
      .select(["source", "source_id", "candidate_entity_id", "candidate_entity_ids"])
      .where("status", "not in", TERMINAL_REVIEW_STATUSES)
      .where(reviewPredicates.length > 0 ? sql<boolean>`${sql.join(reviewPredicates, sql` OR `)}` : sql<boolean>`1 = 0`)
      .execute(),
    entityIds.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("entity_source_refs")
          .innerJoin("users", "users.id", "entity_source_refs.source_id")
          .select("entity_source_refs.entity_id")
          .where("entity_source_refs.source", "=", "sketch_user")
          .where("users.type", "=", "agent")
          .where("entity_source_refs.entity_id", "in", entityIds)
          .execute(),
    entityIds.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("slack_user_sync_state")
          .innerJoin("users", "users.slack_user_id", "slack_user_sync_state.slack_user_id")
          .select("slack_user_sync_state.entity_id")
          .where("users.type", "=", "agent")
          .where("slack_user_sync_state.entity_id", "in", entityIds)
          .execute(),
    entityIds.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("slack_user_sync_state")
          .select("entity_id")
          .where("classification", "=", "internal")
          .where("classification_source", "in", INTERNAL_EVIDENCE_SOURCES)
          .where("entity_id", "in", entityIds)
          .execute(),
    namePredicates.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("entities")
          .select(["id", "name", "aliases"])
          .where("source_type", "=", "person")
          .where("deleted_at", "is", null)
          .where(sql<boolean>`${sql.join(namePredicates, sql` OR `)}`)
          .execute(),
  ]);
  const linksByEntity = new Map(links.map((link) => [link.entity_id, link]));
  const linksByUser = new Map(links.map((link) => [link.user_id, link]));
  const nameCandidatesByEntity = new Map<string, string[]>();
  for (const entity of entities) {
    const normalized = normalizeName(entity.name);
    nameCandidatesByEntity.set(
      entity.id,
      allPeople
        .filter(
          (candidate) =>
            candidate.id !== entity.id &&
            (normalizeName(candidate.name) === normalized ||
              readAliases(candidate.aliases).some((alias) => normalizeName(alias) === normalized)),
        )
        .map((candidate) => candidate.id),
    );
  }
  const evidenceBackedEntityIds = new Set(
    entities.filter((entity) => isHumanSubtypeOverride(entity.provenance_tier)).map((entity) => entity.id),
  );
  for (const row of evidenceRows) {
    if (row.entity_id) evidenceBackedEntityIds.add(row.entity_id);
  }
  return {
    linksByEntity,
    linksByUser,
    openReviewEntityIds: new Set<string>(
      entityIds.filter((entityId) => openReviews.some((review) => reviewTouchesEntity(review, entityId))),
    ),
    agentAnchoredEntityIds: new Set<string>(
      [...sourceRefs.map((row) => row.entity_id), ...slackRefs.map((row) => row.entity_id)].filter((id): id is string =>
        Boolean(id),
      ),
    ),
    evidenceBackedEntityIds,
    users,
    nameCandidatesByEntity,
    triggeredByUserId: await findActorUserId(db),
  };
}

function findMatchingUsersFromRows(
  users: MatchableUser[],
  emails: string[],
  phones: string[],
): {
  emailUserIds: Set<string>;
  phoneUserIds: Set<string>;
  nonHumanMatch: boolean;
} {
  const emailUserIds = new Set<string>();
  const phoneUserIds = new Set<string>();
  let nonHumanMatch = false;
  for (const user of users) {
    const userEmail = user.email ? normalizeEmail(user.email) : null;
    const userPhone = user.whatsapp_number ? normalizePhone(user.whatsapp_number) : null;
    const emailMatch = Boolean(userEmail && emails.includes(userEmail));
    const phoneMatch = Boolean(userPhone && phones.includes(userPhone));
    if (!emailMatch && !phoneMatch) continue;
    if (user.type !== "human") {
      nonHumanMatch = true;
      continue;
    }
    if (emailMatch) emailUserIds.add(user.id);
    if (phoneMatch) phoneUserIds.add(user.id);
  }
  return { emailUserIds, phoneUserIds, nonHumanMatch };
}

export async function provisionUnverifiedUser(
  users: UserProvisioner,
  input: { name: string; email: string },
): Promise<User> {
  const email = normalizeEmail(input.email);
  const existing = await users.findByEmail(email);
  if (existing?.type === "human") return existing as User;
  try {
    return (await users.create({
      name: input.name.trim(),
      email,
      emailVerified: false,
      skipEntityLinking: true,
    })) as User;
  } catch (error) {
    const isUniqueViolation =
      (error instanceof Error && /unique constraint|duplicate key|unique violation/i.test(error.message)) ||
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ["23505", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"].includes(String(error.code)));
    if (!isUniqueViolation) throw error;
    const owner = await users.findByEmail(email);
    if (!owner) throw error;
    if (owner.type !== "human") throw new Error("provisioning email belongs to a non-human user");
    return owner as User;
  }
}

export async function ensureUserEntityLinkForEntity(
  db: LinkDb,
  entityId: string,
  options: { users?: UserProvisioner; teamId?: string | null } = {},
): Promise<UserEntityLinkOutcome> {
  const outcomes = await ensureUserEntityLinksForEntities(db, [entityId], { users: options.users });
  return outcomes[0] ?? { outcome: "skipped", entityId, reason: "not_live_person" };
}

async function ensureLoadedEntityLink(
  db: LinkDb,
  loaded: { entity: Entity; emails: string[]; phones: string[] },
  options: { users?: UserProvisioner },
  context: EntityLinkBatchContext,
  matchedViaOverride?: "user_creation",
  preferredUserId?: string,
): Promise<UserEntityLinkOutcome> {
  const { entity, emails, phones } = loaded;
  const existingEntityLink = context.linksByEntity.get(entity.id);
  if (existingEntityLink) return { outcome: "already_linked", userId: existingEntityLink.user_id, entityId: entity.id };
  if (context.openReviewEntityIds.has(entity.id))
    return { outcome: "skipped", entityId: entity.id, reason: "open_review" };
  if (context.agentAnchoredEntityIds.has(entity.id))
    return { outcome: "skipped", entityId: entity.id, reason: "agent_anchored" };

  const matches = findMatchingUsersFromRows(context.users, emails, phones);
  if (matches.nonHumanMatch) return { outcome: "skipped", entityId: entity.id, reason: "non_human_identifier" };
  const candidateUserIds = [...new Set([...matches.emailUserIds, ...matches.phoneUserIds])];
  if (candidateUserIds.length > 0) {
    if (candidateUserIds.length > 1) {
      return queueIdentityReview(db, entity, {
        reason: "identifier-ambiguity",
        candidateUserIds,
        triggeredByUserId: context.triggeredByUserId,
      });
    }
    const userId = candidateUserIds[0];
    const linked = context.linksByUser.get(userId);
    if (linked && linked.entity_id !== entity.id) {
      return queueIdentityReview(db, entity, {
        reason: "user-already-linked",
        candidateUserIds: [userId],
        candidateEntityIds: [entity.id, linked.entity_id],
        triggeredByUserId: context.triggeredByUserId,
      });
    }
    const matchedVia = matchedViaOverride ?? (matches.emailUserIds.has(userId) ? "email" : "phone");
    const result = await writeLink(db, { userId, entityId: entity.id, matchedVia });
    if (!result.winner) {
      return queueIdentityReview(db, entity, {
        reason: "link-conflict",
        candidateUserIds: [userId],
        candidateEntityIds: [entity.id, result.existingUserEntityId, result.existingEntityUserId].filter(
          (value): value is string => Boolean(value),
        ),
        triggeredByUserId: context.triggeredByUserId,
      });
    }
    const link = { user_id: userId, entity_id: entity.id } as Selectable<DB["user_entity_links"]>;
    context.linksByEntity.set(entity.id, link);
    context.linksByUser.set(userId, link);
    return { outcome: "linked", userId, entityId: entity.id, matchedVia };
  }

  const nameCandidates = context.nameCandidatesByEntity.get(entity.id) ?? [];
  if (nameCandidates.length > 0) {
    return queueIdentityReview(db, entity, {
      reason: "name-only-similarity",
      candidateEntityIds: [entity.id, ...nameCandidates],
      triggeredByUserId: context.triggeredByUserId,
    });
  }
  if (preferredUserId) {
    const linked = context.linksByUser.get(preferredUserId);
    if (linked && linked.entity_id !== entity.id) {
      return queueIdentityReview(db, entity, {
        reason: "user-already-linked",
        candidateUserIds: [preferredUserId],
        candidateEntityIds: [entity.id, linked.entity_id],
        triggeredByUserId: context.triggeredByUserId,
      });
    }
    const result = await writeLink(db, {
      userId: preferredUserId,
      entityId: entity.id,
      matchedVia: matchedViaOverride ?? "user_creation",
    });
    if (!result.winner) {
      return queueIdentityReview(db, entity, {
        reason: "link-conflict",
        candidateUserIds: [preferredUserId],
        candidateEntityIds: [entity.id, result.existingUserEntityId, result.existingEntityUserId].filter(
          (value): value is string => Boolean(value),
        ),
        triggeredByUserId: context.triggeredByUserId,
      });
    }
    const link = { user_id: preferredUserId, entity_id: entity.id } as Selectable<DB["user_entity_links"]>;
    context.linksByEntity.set(entity.id, link);
    context.linksByUser.set(preferredUserId, link);
    return {
      outcome: "linked",
      userId: preferredUserId,
      entityId: entity.id,
      matchedVia: matchedViaOverride ?? "user_creation",
    };
  }
  if (entity.subtype === "internal" && emails.length > 0) {
    if (!context.evidenceBackedEntityIds.has(entity.id))
      return { outcome: "skipped", entityId: entity.id, reason: "internal_without_evidence" };
    if (!options.users) return { outcome: "skipped", entityId: entity.id, reason: "provisioner_unavailable" };
    const user = await provisionUnverifiedUser(options.users, { name: entity.name, email: emails[0] });
    context.users.push(user);
    const result = await writeLink(db, { userId: user.id, entityId: entity.id, matchedVia: "provisioning" });
    if (!result.winner) {
      return queueIdentityReview(db, entity, {
        reason: "link-conflict",
        candidateUserIds: [user.id],
        candidateEntityIds: [entity.id, result.existingUserEntityId, result.existingEntityUserId].filter(
          (value): value is string => Boolean(value),
        ),
        triggeredByUserId: context.triggeredByUserId,
      });
    }
    const link = { user_id: user.id, entity_id: entity.id } as Selectable<DB["user_entity_links"]>;
    context.linksByEntity.set(entity.id, link);
    context.linksByUser.set(user.id, link);
    return { outcome: "linked", userId: user.id, entityId: entity.id, matchedVia: "provisioning" };
  }
  if (entity.subtype === "internal" && emails.length === 0) {
    return queueIdentityReview(db, entity, {
      reason: "internal-without-email",
      triggeredByUserId: context.triggeredByUserId,
    });
  }
  return { outcome: "skipped", entityId: entity.id, reason: "no_identifier_match" };
}

export async function ensureUserEntityLinksForEntities(
  db: LinkDb,
  entityIds: string[],
  options: { users?: UserProvisioner } = {},
): Promise<UserEntityLinkOutcome[]> {
  if (entityIds.length === 0) return [];
  const loadedById = await loadEntityBatch(db, entityIds);
  const context = await loadEntityLinkBatchContext(db, entityIds, [...loadedById.values()]);
  const outcomes: UserEntityLinkOutcome[] = [];
  for (const entityId of entityIds) {
    const loaded = loadedById.get(entityId);
    outcomes.push(
      loaded
        ? await ensureLoadedEntityLink(db, loaded, options, context)
        : { outcome: "skipped", entityId, reason: "not_live_person" },
    );
  }
  return outcomes;
}

async function createUserEntity(db: LinkDb, user: User): Promise<Entity> {
  const now = new Date().toISOString();
  const entityId = randomUUID();
  const email = user.email ? normalizeEmail(user.email) : null;
  await db
    .insertInto("entities")
    .values({
      id: entityId,
      name: user.name,
      source_type: "person",
      subtype: "internal",
      aliases: email ? JSON.stringify([email]) : null,
      metadata: JSON.stringify(email ? { email } : {}),
      source_ref_id: null,
      status: "confirmed",
      provenance_tier: "declared",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto("entity_source_refs")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      source: "sketch_user",
      source_id: user.id,
      source_url: null,
      last_seen_at: now,
    })
    .execute();
  if (email) {
    await db
      .insertInto("entity_contact_points")
      .values({
        id: randomUUID(),
        entity_id: entityId,
        kind: "email",
        value: email,
        display_value: email,
        label: null,
        is_primary: 1,
        source: "sketch_user",
        connector_config_id: null,
        created_by_user_id: user.id,
        verified_at: null,
        last_contacted_at: null,
      })
      .execute();
  }
  if (user.whatsapp_number) {
    const phone = normalizePhone(user.whatsapp_number);
    if (phone) {
      await db
        .insertInto("entity_contact_points")
        .values({
          id: randomUUID(),
          entity_id: entityId,
          kind: "phone",
          value: phone,
          display_value: user.whatsapp_number,
          label: null,
          is_primary: 1,
          source: "sketch_user",
          connector_config_id: null,
          created_by_user_id: user.id,
          verified_at: null,
          last_contacted_at: null,
        })
        .execute();
    }
  }
  return db.selectFrom("entities").selectAll().where("id", "=", entityId).executeTakeFirstOrThrow();
}

export type EnsuredUserEntity = {
  entity: Entity | null;
  outcome: UserEntityLinkOutcome;
};

export async function ensureEntitiesForUsersWithOutcomes(
  db: LinkDb,
  userIds: string[],
): Promise<Map<string, EnsuredUserEntity>> {
  if (userIds.length === 0) return new Map();
  const users = await db.selectFrom("users").selectAll().where("id", "in", userIds).execute();
  const existingLinks = await db.selectFrom("user_entity_links").selectAll().where("user_id", "in", userIds).execute();
  const existingLinkByUser = new Map(existingLinks.map((link) => [link.user_id, link]));
  const result = new Map<string, EnsuredUserEntity>();
  for (const user of users) {
    if (user.type !== "human") {
      result.set(user.id, {
        entity: null,
        outcome: { outcome: "skipped", entityId: user.id, reason: "non_human_user" },
      });
      continue;
    }
    const existingLink = existingLinkByUser.get(user.id);
    if (existingLink) {
      result.set(user.id, {
        entity: null,
        outcome: { outcome: "already_linked", userId: user.id, entityId: existingLink.entity_id },
      });
    }
  }
  const pendingUsers = users.filter((user) => user.type === "human" && !existingLinkByUser.has(user.id));
  if (pendingUsers.length === 0) {
    return new Map(
      userIds.map((userId) => [
        userId,
        result.get(userId) ?? {
          entity: null,
          outcome: { outcome: "skipped", entityId: userId, reason: "user_not_found" },
        },
      ]),
    );
  }
  const sourceRefs = await db
    .selectFrom("entity_source_refs")
    .select(["source_id", "entity_id"])
    .where("source", "=", "sketch_user")
    .where(
      "source_id",
      "in",
      pendingUsers.map((user) => user.id),
    )
    .execute();
  const sourceEntityIdByUser = new Map(sourceRefs.map((sourceRef) => [sourceRef.source_id, sourceRef.entity_id]));
  const candidateEntityIds = await findCandidateEntityIdsForUsers(db, pendingUsers);
  for (const entityId of sourceEntityIdByUser.values()) candidateEntityIds.add(entityId);
  const loadedById = await loadEntityBatch(db, [...candidateEntityIds]);
  const context = await loadEntityLinkBatchContext(db, [...candidateEntityIds], [...loadedById.values()], pendingUsers);

  for (const user of pendingUsers) {
    const sourceEntityId = sourceEntityIdByUser.get(user.id);
    if (sourceEntityId) {
      const loaded = loadedById.get(sourceEntityId);
      if (!loaded) {
        result.set(user.id, {
          entity: null,
          outcome: { outcome: "skipped", entityId: sourceEntityId, reason: "not_live_person" },
        });
        continue;
      }
      const outcome = await ensureLoadedEntityLink(db, loaded, {}, context, "user_creation", user.id);
      result.set(user.id, {
        entity:
          (outcome.outcome === "linked" || outcome.outcome === "already_linked") && outcome.userId === user.id
            ? loaded.entity
            : null,
        outcome,
      });
      continue;
    }
    const emails = user.email ? [normalizeEmail(user.email)] : [];
    const phones = user.whatsapp_number
      ? [normalizePhone(user.whatsapp_number)].filter((value): value is string => Boolean(value))
      : [];
    const matches = [...loadedById.values()].filter((loaded) => {
      return Boolean(
        loaded.emails.some((email) => emails.includes(email)) || loaded.phones.some((phone) => phones.includes(phone)),
      );
    });
    if (matches.length > 1) {
      const identifierMatches = findMatchingUsersFromRows(context.users, emails, phones);
      if (
        identifierMatches.nonHumanMatch ||
        matches.some((loaded) => context.agentAnchoredEntityIds.has(loaded.entity.id))
      ) {
        result.set(user.id, {
          entity: null,
          outcome: {
            outcome: "skipped",
            entityId: matches[0].entity.id,
            reason: identifierMatches.nonHumanMatch ? "non_human_identifier" : "agent_anchored",
          },
        });
        continue;
      }
      const first = matches[0];
      if (context.openReviewEntityIds.has(first.entity.id)) {
        result.set(user.id, {
          entity: null,
          outcome: { outcome: "skipped", entityId: first.entity.id, reason: "open_review" },
        });
        continue;
      }
      const outcome = await queueIdentityReview(db, first.entity, {
        reason: "user-identifier-ambiguity",
        candidateUserIds: [user.id],
        candidateEntityIds: matches.map((loaded) => loaded.entity.id),
        triggeredByUserId: context.triggeredByUserId,
      });
      result.set(user.id, { entity: null, outcome });
      continue;
    }
    if (matches.length === 1) {
      const loaded = matches[0];
      const outcome = await ensureLoadedEntityLink(db, loaded, {}, context);
      result.set(user.id, {
        entity: outcome.outcome === "linked" && outcome.userId === user.id ? loaded.entity : null,
        outcome,
      });
      continue;
    }
    const entity = await createUserEntity(db, user);
    const loaded = (await loadEntityBatch(db, [entity.id])).get(entity.id);
    if (!loaded) {
      result.set(user.id, {
        entity: null,
        outcome: { outcome: "skipped", entityId: entity.id, reason: "not_live_person" },
      });
      continue;
    }
    context.nameCandidatesByEntity.set(entity.id, await findNameCandidates(db, entity));
    if (isHumanSubtypeOverride(entity.provenance_tier)) context.evidenceBackedEntityIds.add(entity.id);
    const outcome = await ensureLoadedEntityLink(db, loaded, {}, context, "user_creation", user.id);
    result.set(user.id, {
      entity: outcome.outcome === "linked" && outcome.userId === user.id ? entity : null,
      outcome,
    });
  }
  return new Map(
    userIds.map((userId) => [
      userId,
      result.get(userId) ?? {
        entity: null,
        outcome: { outcome: "skipped", entityId: userId, reason: "user_not_found" },
      },
    ]),
  );
}

export async function ensureEntitiesForUsers(db: LinkDb, userIds: string[]): Promise<Map<string, Entity | null>> {
  const ensured = await ensureEntitiesForUsersWithOutcomes(db, userIds);
  return new Map(userIds.map((userId) => [userId, ensured.get(userId)?.entity ?? null]));
}

async function ensureEntityForUserOnce(db: LinkDb, userId: string): Promise<Entity | null> {
  return (await ensureEntitiesForUsers(db, [userId])).get(userId) ?? null;
}

const inflightByDb = new WeakMap<object, Map<string, Promise<Entity | null>>>();

export function ensureEntityForUser(db: LinkDb, userId: string): Promise<Entity | null> {
  let inflight = inflightByDb.get(db);
  if (!inflight) {
    inflight = new Map();
    inflightByDb.set(db, inflight);
  }
  const existing = inflight.get(userId);
  const pending = (existing ?? Promise.resolve()).then(
    () => ensureEntityForUserOnce(db, userId),
    () => ensureEntityForUserOnce(db, userId),
  );
  inflight.set(userId, pending);
  void pending.then(
    () => {
      if (inflight?.get(userId) === pending) inflight.delete(userId);
    },
    () => {
      if (inflight?.get(userId) === pending) inflight.delete(userId);
    },
  );
  return pending;
}

export async function confirmUserEntityLink(
  db: LinkDb,
  input: { reviewId: string; confirmingUserId: string; linkUserId?: string; candidateGeneratedAt: string },
): Promise<{ row: Selectable<DB["entity_review_queue"]>; targetEntityId: string; idempotent: boolean }> {
  const review = await db
    .selectFrom("entity_review_queue")
    .selectAll()
    .where("id", "=", input.reviewId)
    .executeTakeFirstOrThrow();
  if (review.status === "confirmed") {
    if (!review.resolved_entity_id) throw new Error("confirmed identity-link review has no entity");
    return { row: review, targetEntityId: review.resolved_entity_id, idempotent: true };
  }
  if (review.source !== "user_entity_link") throw new Error("review is not an identity-link review");
  if (review.candidate_generated_at !== input.candidateGeneratedAt)
    throw new Error("identity-link review candidate drift");
  const entityId = review.source_id;
  if (!entityId) throw new Error("identity-link review has no entity");
  const candidateUserIds = review.candidate_user_ids ? (JSON.parse(review.candidate_user_ids) as string[]) : [];
  const userId = input.linkUserId ?? (candidateUserIds.length === 1 ? candidateUserIds[0] : null);
  if (!userId || !candidateUserIds.includes(userId)) throw new Error("identity-link review requires a candidate user");
  const user = await db.selectFrom("users").select(["id", "type"]).where("id", "=", userId).executeTakeFirst();
  if (!user || user.type !== "human") throw new Error("identity-link candidate is not a human user");
  const entity = await db
    .selectFrom("entities")
    .select(["id", "source_type", "deleted_at"])
    .where("id", "=", entityId)
    .executeTakeFirst();
  if (!entity || entity.source_type !== "person" || entity.deleted_at !== null)
    throw new Error("identity-link entity is unavailable");
  const result = await writeLink(db, {
    userId,
    entityId,
    matchedVia: "review",
    confirmedByUserId: input.confirmingUserId,
  });
  if (!result.winner) throw new Error("identity-link candidate is already linked");
  await db
    .updateTable("entity_review_queue")
    .set({
      status: "confirmed",
      resolved_entity_id: entityId,
      resolved_by: input.confirmingUserId,
      resolved_at: new Date().toISOString(),
    })
    .where("id", "=", input.reviewId)
    .where("status", "=", "pending")
    .execute();
  const row = await db
    .selectFrom("entity_review_queue")
    .selectAll()
    .where("id", "=", input.reviewId)
    .executeTakeFirstOrThrow();
  return { row, targetEntityId: entityId, idempotent: false };
}
