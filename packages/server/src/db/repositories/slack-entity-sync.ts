import { randomUUID } from "node:crypto";
import { type ExpressionBuilder, type Kysely, type Selectable, type SqlBool, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import type { DB, EntitiesTable, SlackUserSyncStateTable } from "../schema";
import { createEntityRepository, isHumanSubtypeOverride, normalizeContactPointValue } from "./entities";
import { createEntityReviewRepo } from "./entity-review";

export interface SlackUserProfile {
  teamId: string;
  slackUserId: string;
  name: string;
  realName: string;
  displayName?: string | null;
  email: string | null;
  phone: string | null;
  profileTeamId: string | null;
  isBot: boolean;
  isGuest: boolean;
  isStranger: boolean;
  isRestricted: boolean;
  isUltraRestricted: boolean;
  deleted: boolean;
  providerUpdatedAt: string | null;
  fetchedAt: string;
  profile?: Record<string, unknown> | null;
}

export interface SlackEntitySyncLogger {
  warn: (bindings: Record<string, unknown>, message: string) => void;
}

export interface SlackEntitySyncOptions {
  logger?: SlackEntitySyncLogger;
  teamRoster?: SlackRosterProof;
}

export interface SlackRosterProof {
  slackUserIds: ReadonlySet<string>;
  emails: ReadonlySet<string>;
}

export type SlackEntitySyncResult = {
  entity: Selectable<EntitiesTable> | null;
  state: Selectable<SlackUserSyncStateTable>;
  applied: boolean;
};

const inflightByDb = new WeakMap<object, Map<string, Promise<SlackEntitySyncResult>>>();

function normalizeEmail(email: string | null): string | null {
  if (!email?.trim() || !email.includes("@")) return null;
  return normalizeContactPointValue("email", email);
}

function normalizePhone(phone: string | null): string | null {
  if (!phone?.trim()) return null;
  try {
    return normalizeContactPointValue("phone", phone);
  } catch {
    return null;
  }
}

function tupleIsAtLeast(
  incoming: { providerUpdatedAt: string | null; fetchedAt: string },
  stored: { provider_updated_at: string | null; fetched_at: string | null },
): boolean {
  if (incoming.providerUpdatedAt === null) {
    if (stored.provider_updated_at !== null) return false;
    return stored.fetched_at === null || incoming.fetchedAt >= stored.fetched_at;
  }
  if (stored.provider_updated_at === null) return true;
  if (incoming.providerUpdatedAt !== stored.provider_updated_at) {
    return incoming.providerUpdatedAt > stored.provider_updated_at;
  }
  return stored.fetched_at === null || incoming.fetchedAt >= stored.fetched_at;
}

function versionPredicate(
  eb: ExpressionBuilder<DB, "slack_user_sync_state">,
  incoming: { providerUpdatedAt: string | null; fetchedAt: string },
) {
  if (incoming.providerUpdatedAt === null) {
    return eb.and([
      eb("provider_updated_at", "is", null),
      eb.or([eb("fetched_at", "is", null), eb("fetched_at", "<=", incoming.fetchedAt)]),
    ]);
  }
  return eb.or([
    eb("provider_updated_at", "is", null),
    eb("provider_updated_at", "<", incoming.providerUpdatedAt),
    eb.and([
      eb("provider_updated_at", "=", incoming.providerUpdatedAt),
      eb.or([eb("fetched_at", "is", null), eb("fetched_at", "<=", incoming.fetchedAt)]),
    ]),
  ]);
}

type SlackClassification = {
  classification: "internal" | "external";
  source: string | null;
};

function classifyProfile(
  profile: SlackUserProfile,
  organizationDomains: Set<string>,
  teamRosterMatch: boolean,
): SlackClassification {
  const email = normalizeEmail(profile.email);
  const emailDomain = email?.split("@").pop() ?? null;
  const foreignTeam = Boolean(profile.profileTeamId && profile.profileTeamId !== profile.teamId);
  if (profile.isGuest || profile.isStranger || foreignTeam || profile.isRestricted || profile.isUltraRestricted) {
    return { classification: "external", source: "provider_flag" };
  }
  if (emailDomain && organizationDomains.has(emailDomain)) {
    return { classification: "internal", source: "organization_domain" };
  }
  if (emailDomain && organizationDomains.size > 0) {
    return { classification: "external", source: "email_domain" };
  }
  if (teamRosterMatch) {
    return { classification: "internal", source: "team_roster" };
  }
  return { classification: "external", source: "default_no_evidence" };
}

function profileName(profile: SlackUserProfile): string | null {
  const name = profile.realName.trim() || profile.displayName?.trim() || profile.name.trim() || "";
  return name.length > 0 ? name : null;
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function resolveSlackSourceRefEntity(
  trx: Kysely<DB>,
  entityId: string,
): Promise<{ entity: Selectable<EntitiesTable> | null; redirected: boolean; suppressed: boolean }> {
  let currentId = entityId;
  let redirected = false;
  for (let depth = 0; depth < 32; depth += 1) {
    const entity = await trx.selectFrom("entities").selectAll().where("id", "=", currentId).executeTakeFirst();
    if (!entity) return { entity: null, redirected, suppressed: true };
    if (entity.deleted_at === null && entity.merged_into_entity_id === null) {
      return {
        entity: entity.source_type === "person" ? entity : null,
        redirected,
        suppressed: false,
      };
    }
    if (entity.merged_into_entity_id) {
      currentId = entity.merged_into_entity_id;
      redirected = true;
      continue;
    }
    return { entity: null, redirected, suppressed: true };
  }
  return { entity: null, redirected, suppressed: true };
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function updateSlackContactPoint(
  trx: Kysely<DB>,
  entityId: string,
  kind: "email" | "phone",
  value: string,
  connectorConfigId: string | null,
  overwriteSlackOwnedValue: boolean,
  now: string,
): Promise<void> {
  if (overwriteSlackOwnedValue) {
    await trx
      .deleteFrom("entity_contact_points")
      .where("entity_id", "=", entityId)
      .where("kind", "=", kind)
      .where("source", "=", "slack_user")
      .where("value", "!=", value)
      .execute();
  }

  const hasPrimary = await trx
    .selectFrom("entity_contact_points")
    .select("id")
    .where("entity_id", "=", entityId)
    .where("kind", "=", kind)
    .where("is_primary", "=", 1)
    .executeTakeFirst();

  await trx
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      kind,
      value,
      display_value: value,
      label: null,
      is_primary: hasPrimary ? 0 : 1,
      source: "slack_user",
      connector_config_id: connectorConfigId,
      created_by_user_id: null,
      verified_at: null,
      last_contacted_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["entity_id", "kind", "value"]).doUpdateSet({
        display_value: value,
        connector_config_id: sql`COALESCE(excluded.connector_config_id, entity_contact_points.connector_config_id)`,
        updated_at: now,
      }),
    )
    .execute();
}

async function updateEntityFromSlackProfile(
  trx: Kysely<DB>,
  entity: Selectable<EntitiesTable>,
  profile: SlackUserProfile,
  classification: "internal" | "external",
  email: string | null,
  phone: string | null,
  connectorConfigId: string | null,
  slackOwned: boolean,
  now: string,
): Promise<Selectable<EntitiesTable>> {
  const metadata = parseMetadata(entity.metadata);
  if (slackOwned && email) metadata.email = email;
  const updates: Record<string, unknown> = {
    updated_at: now,
  };
  if (!isHumanSubtypeOverride(entity.provenance_tier)) updates.subtype = classification;
  if (slackOwned) updates.name = profileName(profile) ?? entity.name;
  if (slackOwned && email) updates.metadata = JSON.stringify(metadata);

  await trx.updateTable("entities").set(updates).where("id", "=", entity.id).execute();
  if (email) {
    await updateSlackContactPoint(trx, entity.id, "email", email, connectorConfigId, slackOwned, now);
  }
  if (phone) {
    await updateSlackContactPoint(trx, entity.id, "phone", phone, connectorConfigId, slackOwned, now);
  }
  return trx.selectFrom("entities").selectAll().where("id", "=", entity.id).executeTakeFirstOrThrow();
}

export async function loadSlackRosterProof(db: Kysely<DB>): Promise<SlackRosterProof> {
  const users = await db
    .selectFrom("users")
    .select(["slack_user_id", "email"])
    .where("type", "!=", "external")
    .execute();
  return {
    slackUserIds: new Set(users.map((user) => user.slack_user_id).filter((id): id is string => Boolean(id))),
    emails: new Set(users.map((user) => normalizeEmail(user.email)).filter((email): email is string => Boolean(email))),
  };
}

async function findSlackConnectorAdmin(trx: Kysely<DB>): Promise<{ id: string; createdBy: string } | null> {
  const row = await trx
    .selectFrom("connector_configs")
    .select(["connector_configs.id", "connector_configs.created_by"])
    .where("connector_configs.connector_type", "=", "slack")
    .orderBy("connector_configs.created_at", "asc")
    .orderBy("connector_configs.id", "asc")
    .executeTakeFirst();
  return row ? { id: row.id, createdBy: row.created_by } : null;
}

async function writeReviewRow(
  trx: Kysely<DB>,
  profile: SlackUserProfile,
  candidateEntityId: string | null,
  candidateEntityIds: string[] | null,
  candidateReason: string,
  connector: { id: string; createdBy: string } | null,
  logger: SlackEntitySyncLogger | undefined,
): Promise<void> {
  if (!connector) {
    logger?.warn(
      { slackUserId: profile.slackUserId },
      "Skipping Slack entity review row because no admin connector owner exists",
    );
    return;
  }
  const name = profileName(profile);
  if (!name) return;
  await createEntityReviewRepo(trx).upsertQueueRow({
    proposedName: name,
    normalizedName: normalizeName(name),
    entityType: "person",
    source: "slack_user",
    sourceId: `${profile.teamId}:${profile.slackUserId}`,
    sourceScoped: true,
    proposedEmail: normalizeEmail(profile.email),
    candidateEntityId,
    candidateEntityIds,
    candidateScore: candidateEntityId ? 1 : null,
    candidateReason,
    triggeredByUserId: connector.createdBy,
  });
}

async function runUpsertBody(
  trx: Kysely<DB>,
  profile: SlackUserProfile,
  options: SlackEntitySyncOptions,
): Promise<SlackEntitySyncResult> {
  const now = profile.fetchedAt;
  const sourceId = `${profile.teamId}:${profile.slackUserId}`;
  const email = normalizeEmail(profile.email);
  const phone = normalizePhone(profile.phone);
  const domains = await trx.selectFrom("organization_domains").select("domain").execute();
  const teamRoster = options.teamRoster ?? (await loadSlackRosterProof(trx));
  const teamRosterMatch =
    teamRoster.slackUserIds.has(profile.slackUserId) || Boolean(email && teamRoster.emails.has(email));
  const baseClassification = classifyProfile(
    profile,
    new Set(domains.map((row) => row.domain.toLowerCase())),
    teamRosterMatch,
  );

  await trx
    .insertInto("slack_user_sync_state")
    .values({
      team_id: profile.teamId,
      slack_user_id: profile.slackUserId,
      name: profile.name || null,
      real_name: profile.realName || null,
      display_name: profile.displayName ?? null,
      email,
      profile_team_id: profile.profileTeamId,
      profile_json: profile.profile ? JSON.stringify(profile.profile) : null,
      is_bot: profile.isBot ? 1 : 0,
      is_guest: profile.isGuest ? 1 : 0,
      is_stranger: profile.isStranger ? 1 : 0,
      is_restricted: profile.isRestricted ? 1 : 0,
      is_ultra_restricted: profile.isUltraRestricted ? 1 : 0,
      deleted: profile.deleted ? 1 : 0,
      classification: baseClassification.classification,
      classification_source: baseClassification.source,
      provider_updated_at: profile.providerUpdatedAt,
      fetched_at: profile.fetchedAt,
      entity_id: null,
      entity_created_by_sync: 0,
      inactive_at: profile.deleted ? profile.fetchedAt : null,
      last_roster_seen_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(["team_id", "slack_user_id"]).doNothing())
    .execute();

  const beforeState = await trx
    .selectFrom("slack_user_sync_state")
    .selectAll()
    .where("team_id", "=", profile.teamId)
    .where("slack_user_id", "=", profile.slackUserId)
    .executeTakeFirstOrThrow();
  const existingStateEntity = beforeState.entity_id
    ? (await resolveSlackSourceRefEntity(trx, beforeState.entity_id)).entity
    : null;
  const classification: SlackClassification =
    baseClassification.classification === "external" &&
    baseClassification.source === "default_no_evidence" &&
    (beforeState.classification === "internal" ||
      ((beforeState.classification === null || beforeState.classification_source === "default_no_evidence") &&
        existingStateEntity?.subtype === "internal"))
      ? { classification: "internal", source: beforeState.classification_source }
      : baseClassification;
  const applied = tupleIsAtLeast(
    { providerUpdatedAt: profile.providerUpdatedAt, fetchedAt: profile.fetchedAt },
    beforeState,
  );

  if (!applied) {
    const staleEntity = beforeState.entity_id
      ? await trx.selectFrom("entities").selectAll().where("id", "=", beforeState.entity_id).executeTakeFirst()
      : null;
    return { entity: staleEntity ?? null, state: beforeState, applied: false };
  }

  const updatedState = await trx
    .updateTable("slack_user_sync_state")
    .set({
      name: profile.name || null,
      real_name: profile.realName || null,
      display_name: profile.displayName ?? null,
      email,
      profile_team_id: profile.profileTeamId,
      profile_json: profile.profile ? JSON.stringify(profile.profile) : null,
      is_bot: profile.isBot ? 1 : 0,
      is_guest: profile.isGuest ? 1 : 0,
      is_stranger: profile.isStranger ? 1 : 0,
      is_restricted: profile.isRestricted ? 1 : 0,
      is_ultra_restricted: profile.isUltraRestricted ? 1 : 0,
      deleted: profile.deleted ? 1 : 0,
      classification: classification.classification,
      classification_source: classification.source,
      provider_updated_at: profile.providerUpdatedAt,
      fetched_at: profile.fetchedAt,
      inactive_at: profile.deleted ? profile.fetchedAt : null,
      updated_at: now,
    })
    .where("team_id", "=", profile.teamId)
    .where("slack_user_id", "=", profile.slackUserId)
    .where((eb) => versionPredicate(eb, { providerUpdatedAt: profile.providerUpdatedAt, fetchedAt: profile.fetchedAt }))
    .executeTakeFirst();

  if (updatedState.numUpdatedRows === 0n) {
    const current = await trx
      .selectFrom("slack_user_sync_state")
      .selectAll()
      .where("team_id", "=", profile.teamId)
      .where("slack_user_id", "=", profile.slackUserId)
      .executeTakeFirstOrThrow();
    const currentEntity = current.entity_id
      ? await trx.selectFrom("entities").selectAll().where("id", "=", current.entity_id).executeTakeFirst()
      : null;
    return { entity: currentEntity ?? null, state: current, applied: false };
  }

  if (profile.isBot || profile.deleted) {
    const state = await trx
      .selectFrom("slack_user_sync_state")
      .selectAll()
      .where("team_id", "=", profile.teamId)
      .where("slack_user_id", "=", profile.slackUserId)
      .executeTakeFirstOrThrow();
    return { entity: null, state, applied: true };
  }

  const existingRef = await trx
    .selectFrom("entity_source_refs")
    .select(["id", "entity_id"])
    .where("source", "=", "slack_user")
    .where("source_id", "=", sourceId)
    .executeTakeFirst();
  let entity: Selectable<EntitiesTable> | null = null;
  let slackOwned = beforeState.entity_created_by_sync === 1;
  const sourceRefBlocksCreation = Boolean(existingRef);
  let reviewReason: { candidateEntityId: string | null; candidateEntityIds: string[] | null; reason: string } | null =
    null;

  if (existingRef) {
    const resolvedRef = await resolveSlackSourceRefEntity(trx, existingRef.entity_id);
    entity = resolvedRef.entity;
    if (entity && resolvedRef.redirected) {
      await trx
        .updateTable("entity_source_refs")
        .set({ entity_id: entity.id })
        .where("id", "=", existingRef.id)
        .execute();
      slackOwned = false;
    }
    if (!entity) slackOwned = false;
  } else {
    if (email) {
      const matches = await createEntityRepository(trx).getPersonEntitiesByEmail(email);
      if (matches.length === 1) {
        entity = matches[0];
      } else if (matches.length > 1) {
        reviewReason = {
          candidateEntityId: null,
          candidateEntityIds: matches.map((match) => match.id),
          reason: "ambiguous-email",
        };
      }
    }
    if (!entity && !reviewReason && phone) {
      const matches = await createEntityRepository(trx).getPersonEntitiesByContactPointKinds(phone, [
        "phone",
        "whatsapp",
      ]);
      if (matches.length === 1) {
        entity = matches[0];
      } else if (matches.length > 1) {
        reviewReason = {
          candidateEntityId: null,
          candidateEntityIds: matches.map((match) => match.id),
          reason: "ambiguous-phone",
        };
      }
    }
  }

  const name = profileName(profile);
  if (reviewReason && !name) {
    options.logger?.warn(
      { candidateEntityIds: reviewReason.candidateEntityIds ?? [], slackUserId: profile.slackUserId },
      "Skipping Slack entity review row because the profile has no usable name",
    );
  }
  let suppressed = false;
  if (!entity && name) {
    suppressed = Boolean(
      await trx
        .selectFrom("entity_creation_suppressions")
        .select("id")
        .where("normalized_name", "=", normalizeName(name))
        .where("entity_type", "=", "person")
        .executeTakeFirst(),
    );
    if (suppressed) reviewReason = null;
  }
  const existingSourceReview =
    name && !suppressed
      ? await trx
          .selectFrom("entity_review_queue")
          .selectAll()
          .where("source", "=", "slack_user")
          .where("source_id", "=", sourceId)
          .executeTakeFirst()
      : undefined;
  const hasSourceReview = !entity && !reviewReason && Boolean(existingSourceReview);
  if (!entity && !reviewReason && name && !suppressed && !hasSourceReview && !sourceRefBlocksCreation) {
    const escapedName = escapeLikePattern(name.toLowerCase());
    const candidates = await trx
      .selectFrom("entities")
      .select(["id", "name", "aliases"])
      .where("source_type", "=", "person")
      .where("deleted_at", "is", null)
      .where("merged_into_entity_id", "is", null)
      .where(
        sql<SqlBool>`(
          lower(${sql.ref("name")}) = ${name.toLowerCase()}
          OR lower(${sql.ref("aliases")}) LIKE ${`%${escapedName}%`} ESCAPE '\\'
        )`,
      )
      .limit(100)
      .execute();
    if (candidates.length === 100) {
      options.logger?.warn(
        { slackUserId: profile.slackUserId, candidateLimit: 100 },
        "Slack entity name candidate scan reached its safety limit",
      );
    }
    const normalizedProfileName = normalizeName(name);
    const exactCandidates = candidates.filter(
      (candidate) =>
        normalizeName(candidate.name) === normalizedProfileName ||
        parseAliases(candidate.aliases).some((alias) => normalizeName(alias) === normalizedProfileName),
    );
    if (exactCandidates.length > 0) {
      reviewReason = {
        candidateEntityId: exactCandidates.length === 1 ? exactCandidates[0].id : null,
        candidateEntityIds: exactCandidates.map((candidate) => candidate.id),
        reason: "exact-name-match",
      };
    }
  }

  let createdInThisTransaction = false;
  if (!entity && name && !suppressed && !sourceRefBlocksCreation) {
    const candidateId = randomUUID();
    await trx
      .insertInto("entities")
      .values({
        id: candidateId,
        name,
        source_type: "person",
        subtype: classification.classification,
        aliases: email ? JSON.stringify([email]) : null,
        metadata: JSON.stringify(email ? { email } : {}),
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "structural",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    entity = await trx.selectFrom("entities").selectAll().where("id", "=", candidateId).executeTakeFirstOrThrow();
    slackOwned = true;
    createdInThisTransaction = true;
  }

  if (entity) {
    const connector = await findSlackConnectorAdmin(trx);
    entity = await updateEntityFromSlackProfile(
      trx,
      entity,
      profile,
      classification.classification,
      email,
      phone,
      connector?.id ?? null,
      slackOwned,
      now,
    );
    await trx
      .insertInto("entity_source_refs")
      .values({
        id: randomUUID(),
        entity_id: entity.id,
        source: "slack_user",
        source_id: sourceId,
        source_url: null,
        last_seen_at: now,
      })
      .onConflict((oc) => oc.columns(["source", "source_id"]).doNothing())
      .execute();
    const winner = await trx
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("source", "=", "slack_user")
      .where("source_id", "=", sourceId)
      .executeTakeFirstOrThrow();
    if (winner.entity_id !== entity.id && createdInThisTransaction) {
      await trx.deleteFrom("entities").where("id", "=", entity.id).execute();
    }
    if (winner.entity_id !== entity.id) {
      const winnerResolution = await resolveSlackSourceRefEntity(trx, winner.entity_id);
      entity = winnerResolution.entity;
      if (winnerResolution.redirected && entity) {
        await trx
          .updateTable("entity_source_refs")
          .set({ entity_id: entity.id })
          .where("source", "=", "slack_user")
          .where("source_id", "=", sourceId)
          .execute();
      }
      slackOwned = false;
    }
    if (entity) {
      await trx
        .updateTable("entity_source_refs")
        .set({ last_seen_at: now })
        .where("source", "=", "slack_user")
        .where("source_id", "=", sourceId)
        .execute();
    }
    if (reviewReason) {
      await writeReviewRow(
        trx,
        profile,
        reviewReason.candidateEntityId,
        reviewReason.candidateEntityIds,
        reviewReason.reason,
        connector,
        options.logger,
      );
    }
  }
  if (existingSourceReview && !reviewReason) {
    await trx
      .updateTable("entity_review_queue")
      .set({ last_seen_at: new Date().toISOString(), occurrence_count: sql<number>`occurrence_count + 1` })
      .where("id", "=", existingSourceReview.id)
      .where("status", "not in", ["confirmed", "rejected", "confirming", "dismissed"])
      .execute();
  }

  await trx
    .updateTable("slack_user_sync_state")
    .set({ entity_id: entity?.id ?? null, entity_created_by_sync: entity && slackOwned ? 1 : 0 })
    .where("team_id", "=", profile.teamId)
    .where("slack_user_id", "=", profile.slackUserId)
    .execute();
  const state = await trx
    .selectFrom("slack_user_sync_state")
    .selectAll()
    .where("team_id", "=", profile.teamId)
    .where("slack_user_id", "=", profile.slackUserId)
    .executeTakeFirstOrThrow();
  return { entity, state, applied: true };
}

async function runUpsert(
  db: Kysely<DB>,
  profile: SlackUserProfile,
  options: SlackEntitySyncOptions,
): Promise<SlackEntitySyncResult> {
  return db.transaction().execute((trx) => runUpsertBody(trx, profile, options));
}

export function upsertSlackPersonEntityInTransaction(
  trx: Kysely<DB>,
  profile: SlackUserProfile,
  options: SlackEntitySyncOptions = {},
): Promise<SlackEntitySyncResult> {
  return runUpsertBody(trx, profile, options);
}
export function upsertSlackPersonEntity(
  db: Kysely<DB>,
  profile: SlackUserProfile,
  options: SlackEntitySyncOptions = {},
): Promise<SlackEntitySyncResult> {
  const key = `${profile.teamId}:${profile.slackUserId}`;
  let dbInflight = inflightByDb.get(db);
  if (!dbInflight) {
    dbInflight = new Map();
    inflightByDb.set(db, dbInflight);
  }
  const existing = dbInflight.get(key);
  const pending = (existing ?? Promise.resolve()).then(
    () => runUpsert(db, profile, options),
    () => runUpsert(db, profile, options),
  );
  dbInflight.set(key, pending);
  pending
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (dbInflight?.get(key) === pending) dbInflight.delete(key);
    });
  return pending;
}
