import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import type { Logger } from "pino";
import { mergeEntityAliases } from "../db/repositories/entity-aliases";
import { createUserWhatsAppLidRepository } from "../db/repositories/user-whatsapp-lids";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { normalizeWhatsAppIdentityLid, normalizeWhatsAppIdentityPhone } from "../identity-normalization";
import { safeWhatsAppErrorFields, sanitizeWhatsAppDisplayText, stripPersonalNumberTokens } from "./privacy";
import { phoneE164ToWhatsAppJid } from "./provider";

export { normalizeWhatsAppIdentityLid, normalizeWhatsAppIdentityPhone } from "../identity-normalization";

export type WhatsAppIdentityResolution =
  | { kind: "teammate"; userId: string; name: string }
  | { kind: "entity"; entityId: string; name: string; company?: string }
  | { kind: "labeled"; name: string; company?: string }
  | { kind: "unresolved" };

export interface WhatsAppIdentityRosterParticipant {
  participantJid: string;
  phoneE164: string | null;
  lid?: string | null;
}

export interface WhatsAppRosterParticipantSnapshot {
  participantJidRef: string;
  senderJidRefs: string[];
  displayName: string;
  resolutionKind: WhatsAppIdentityResolution["kind"];
  adminRole: "admin" | "superadmin" | null;
  userId?: string;
  entityId?: string;
  company?: string;
  pushName?: string;
}

export interface WhatsAppRosterResolutionCounts {
  totalParticipants: number;
  teammate: number;
  entity: number;
  labeled: number;
  unresolved: number;
}

export interface WhatsAppRosterSnapshot {
  participants: WhatsAppRosterParticipantSnapshot[];
  resolutionCounts: WhatsAppRosterResolutionCounts;
}

export interface WhatsAppRosterBuildResult {
  snapshot: WhatsAppRosterSnapshot;
  serializedSnapshot: string;
}

interface EntityResolutionCandidate {
  entityId: string;
  name: string;
}

interface BuildRosterSnapshotOptions {
  db: Kysely<DB>;
  groupJid: string;
  conversationId: number;
  logger: Logger;
  enrichEntityAliases?: boolean;
}

const REF_ALPHABET = "abcdefghijklmnop";

export async function captureWhatsAppLidForPhone(
  db: Kysely<DB>,
  phoneE164: string | null | undefined,
  lid: string | null | undefined,
  logger?: Pick<Logger, "warn">,
): Promise<void> {
  const phone = normalizeWhatsAppIdentityPhone(phoneE164);
  const normalizedLid = normalizeWhatsAppIdentityLid(lid);
  if (!phone || !normalizedLid) return;

  try {
    const user = await db.selectFrom("users").select("id").where("whatsapp_number", "=", phone).executeTakeFirst();
    if (!user) return;
    const result = await createUserWhatsAppLidRepository(db).attachIfPhoneUnchanged(
      user.id,
      phone,
      normalizedLid,
      new Date().toISOString(),
    );
    if (result === "ownership-conflict") {
      logger?.warn({ operation: "capture_whatsapp_lid", result }, "Skipped conflicting WhatsApp LID capture");
    }
  } catch (error) {
    logger?.warn(
      { operation: "capture_whatsapp_lid", ...safeWhatsAppErrorFields(error) },
      "WhatsApp LID capture failed",
    );
  }
}

export function stableWhatsAppParticipantJidRef(jid: string): string {
  const hash = createHash("sha256").update(jid).digest("hex").slice(0, 24);
  const encoded = [...hash].map((char) => REF_ALPHABET[Number.parseInt(char, 16)] ?? "a").join("");
  return `jid_${encoded}`;
}

function emptyCounts(totalParticipants: number): WhatsAppRosterResolutionCounts {
  return {
    totalParticipants,
    teammate: 0,
    entity: 0,
    labeled: 0,
    unresolved: 0,
  };
}

function incrementCount(counts: WhatsAppRosterResolutionCounts, kind: WhatsAppIdentityResolution["kind"]): void {
  counts[kind] += 1;
}

function formatWithCompany(name: string, company: string | undefined): string {
  return company ? `${name} (${company})` : name;
}

function unresolvedDisplayName(phoneE164: string | null): string {
  const lastTwo = phoneE164?.replace(/\D/gu, "").slice(-2);
  return lastTwo ? `External (**${lastTwo})` : "External (unknown)";
}

function safePushName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = sanitizeWhatsAppDisplayText(value);
  return isHumanReadableAlias(value, sanitized) ? sanitized : undefined;
}

function safeEntityAlias(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutControls = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const sanitized = stripPersonalNumberTokens(withoutControls).slice(0, 160).trim();
  return isHumanReadableAlias(withoutControls, sanitized) ? sanitized : undefined;
}

function isHumanReadableAlias(raw: string, sanitized: string): boolean {
  if (!sanitized || sanitized.includes("[whatsapp-id]")) return false;
  const trimmed = raw.trim();
  if (/^(?:unknown|unknown group|unresolved whatsapp participant)$/iu.test(trimmed)) return false;
  if (/^\+?\d+$/u.test(trimmed)) return false;
  return normalizeWhatsAppIdentityPhone(trimmed) === null && !/@(?:lid|s\.whatsapp\.net)$/iu.test(trimmed);
}

async function enrichResolvedEntityAliases(
  db: Kysely<DB>,
  groupJid: string,
  participants: Array<{ phone_e164: string | null; resolution: WhatsAppIdentityResolution; aliasName?: string }>,
): Promise<void> {
  const candidates = participants.filter(
    (
      participant,
    ): participant is typeof participant & { resolution: Extract<WhatsAppIdentityResolution, { kind: "entity" }> } =>
      participant.resolution.kind === "entity",
  );
  if (candidates.length === 0) return;

  const labels = await createWhatsAppGroupRepository(db).listMemberLabels(groupJid);
  const labelByPhone = new Map(
    labels.map((label) => [normalizeWhatsAppIdentityPhone(label.phone_e164), safeEntityAlias(label.display_name)]),
  );
  const additionsByEntityId = new Map<string, string[]>();
  for (const candidate of candidates) {
    const phone = normalizeWhatsAppIdentityPhone(candidate.phone_e164);
    const additions = additionsByEntityId.get(candidate.resolution.entityId) ?? [];
    additions.push(candidate.aliasName ?? "", phone ? (labelByPhone.get(phone) ?? "") : "");
    additionsByEntityId.set(candidate.resolution.entityId, additions);
  }

  for (const [entityId, additions] of additionsByEntityId) {
    await mergeEntityAliases(db, entityId, additions);
  }
}

function displayNameForResolution(
  resolution: WhatsAppIdentityResolution,
  phoneE164: string | null,
  pushName: string | undefined,
): string {
  if (resolution.kind === "teammate") return resolution.name;
  if (resolution.kind === "entity") return formatWithCompany(resolution.name, resolution.company);
  if (resolution.kind === "labeled") return formatWithCompany(resolution.name, resolution.company);
  if (pushName) return pushName;
  return unresolvedDisplayName(phoneE164);
}

function snapshotParticipant(
  participant: {
    participant_jid: string;
    phone_e164: string | null;
    admin_role: string | null;
  },
  resolution: WhatsAppIdentityResolution,
  pushName: string | undefined,
): WhatsAppRosterParticipantSnapshot {
  const senderJidRefs = [stableWhatsAppParticipantJidRef(participant.participant_jid)];
  const normalizedPhone = normalizeWhatsAppIdentityPhone(participant.phone_e164);
  if (normalizedPhone) {
    const phoneJidRef = stableWhatsAppParticipantJidRef(phoneE164ToWhatsAppJid(normalizedPhone));
    if (!senderJidRefs.includes(phoneJidRef)) senderJidRefs.push(phoneJidRef);
  }
  const safeParticipantPushName = safePushName(pushName);
  const displayName = sanitizeWhatsAppDisplayText(
    displayNameForResolution(resolution, normalizedPhone, safeParticipantPushName),
  );
  const company =
    "company" in resolution && resolution.company ? sanitizeWhatsAppDisplayText(resolution.company) : undefined;

  return {
    participantJidRef: stableWhatsAppParticipantJidRef(participant.participant_jid),
    senderJidRefs,
    displayName: displayName.length > 0 ? displayName : unresolvedDisplayName(normalizedPhone),
    resolutionKind: resolution.kind,
    adminRole:
      participant.admin_role === "admin" || participant.admin_role === "superadmin" ? participant.admin_role : null,
    ...(resolution.kind === "teammate" ? { userId: resolution.userId } : {}),
    ...(resolution.kind === "entity" ? { entityId: resolution.entityId } : {}),
    ...(company ? { company } : {}),
    ...(safeParticipantPushName ? { pushName: safeParticipantPushName } : {}),
  };
}

function uniqueNormalizedPhones(participants: WhatsAppIdentityRosterParticipant[]): string[] {
  return [
    ...new Set(
      participants
        .map((participant) => normalizeWhatsAppIdentityPhone(participant.phoneE164))
        .filter((phone): phone is string => phone !== null),
    ),
  ];
}

function unresolvedMap(participants: WhatsAppIdentityRosterParticipant[]): Map<string, WhatsAppIdentityResolution> {
  return new Map(participants.map((participant) => [participant.participantJid, { kind: "unresolved" }]));
}

function firstByNormalizedPhone<T>(
  rows: T[],
  getPhone: (row: T) => string | null | undefined,
  getValue: (row: T) => WhatsAppIdentityResolution | null,
): Map<string, WhatsAppIdentityResolution> {
  const out = new Map<string, WhatsAppIdentityResolution>();
  for (const row of rows) {
    const normalized = normalizeWhatsAppIdentityPhone(getPhone(row));
    if (!normalized || out.has(normalized)) continue;
    const value = getValue(row);
    if (value) out.set(normalized, value);
  }
  return out;
}

export function createWhatsAppIdentityResolutionService(db: Kysely<DB>) {
  async function resolve(phoneE164: string, groupJid: string): Promise<WhatsAppIdentityResolution> {
    const normalized = normalizeWhatsAppIdentityPhone(phoneE164);
    if (!normalized) return { kind: "unresolved" };

    const teammate = await createUserRepository(db).findByWhatsappNumber(normalized);
    if (teammate) return { kind: "teammate", userId: teammate.id, name: teammate.name };

    const resolved = await resolveRoster(groupJid, [{ participantJid: "single", phoneE164: normalized }]);
    return resolved.get("single") ?? { kind: "unresolved" };
  }

  async function resolveRoster(
    groupJid: string,
    participants: WhatsAppIdentityRosterParticipant[],
  ): Promise<Map<string, WhatsAppIdentityResolution>> {
    const resolutions = unresolvedMap(participants);
    const phones = uniqueNormalizedPhones(participants);
    const lids = [
      ...new Set(
        participants
          .map((participant) => normalizeWhatsAppIdentityLid(participant.lid ?? participant.participantJid))
          .filter((lid): lid is string => lid !== null),
      ),
    ];
    if (phones.length === 0 && lids.length === 0) return resolutions;

    const teammateByPhone = await loadTeammatesByPhone(phones);
    const teammateByLid = await loadTeammatesByLid(lids);
    const entityByPhone = await loadEntitiesByPhone(phones);
    const labelByPhone = await loadLabelsByPhone(groupJid, phones);

    for (const participant of participants) {
      const phone = normalizeWhatsAppIdentityPhone(participant.phoneE164);
      const lid = normalizeWhatsAppIdentityLid(participant.lid ?? participant.participantJid);
      resolutions.set(
        participant.participantJid,
        (phone ? teammateByPhone.get(phone) : undefined) ??
          (lid ? teammateByLid.get(lid) : undefined) ??
          (phone ? entityByPhone.get(phone) : undefined) ??
          (phone ? labelByPhone.get(phone) : undefined) ?? { kind: "unresolved" },
      );
    }

    return resolutions;
  }

  async function loadTeammatesByLid(lids: string[]): Promise<Map<string, WhatsAppIdentityResolution>> {
    if (lids.length === 0) return new Map();
    const [rows, legacyRows] = await Promise.all([
      db
        .selectFrom("user_whatsapp_lids")
        .innerJoin("users", "users.id", "user_whatsapp_lids.user_id")
        .select(["user_whatsapp_lids.lid", "users.id", "users.name"])
        .where("user_whatsapp_lids.lid", "in", lids)
        .execute(),
      db.selectFrom("users").select(["id", "name", "whatsapp_lid"]).where("whatsapp_lid", "in", lids).execute(),
    ]);
    return new Map([
      ...legacyRows
        .filter((row): row is typeof row & { whatsapp_lid: string } => row.whatsapp_lid !== null)
        .map((row) => [row.whatsapp_lid, { kind: "teammate" as const, userId: row.id, name: row.name }] as const),
      ...rows.map((row) => [row.lid, { kind: "teammate" as const, userId: row.id, name: row.name }] as const),
    ]);
  }

  async function loadTeammatesByPhone(phones: string[]): Promise<Map<string, WhatsAppIdentityResolution>> {
    const phoneSet = new Set(phones);
    const rows = await db
      .selectFrom("users")
      .select(["id", "name", "whatsapp_number"])
      .where("whatsapp_number", "in", phones)
      .orderBy("name", "asc")
      .orderBy("id", "asc")
      .execute();

    return firstByNormalizedPhone(
      rows.filter((row) => phoneSet.has(normalizeWhatsAppIdentityPhone(row.whatsapp_number) ?? "")),
      (row) => row.whatsapp_number,
      (row) => ({ kind: "teammate", userId: row.id, name: row.name }),
    );
  }

  async function loadEntitiesByPhone(phones: string[]): Promise<Map<string, WhatsAppIdentityResolution>> {
    const phoneSet = new Set(phones);
    const rows = await db
      .selectFrom("entity_contact_points")
      .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
      .select(["entity_contact_points.value", "entities.id as entity_id", "entities.name as entity_name"])
      .where("entity_contact_points.kind", "in", ["phone", "whatsapp"])
      .where("entities.status", "!=", "archived")
      .where("entities.deleted_at", "is", null)
      .orderBy("entities.name", "asc")
      .orderBy("entities.id", "asc")
      .execute();

    const candidatesByPhone = new Map<string, Map<string, EntityResolutionCandidate>>();
    for (const row of rows) {
      const phone = normalizeWhatsAppIdentityPhone(row.value);
      if (!phone || !phoneSet.has(phone)) continue;
      const candidates = candidatesByPhone.get(phone) ?? new Map<string, EntityResolutionCandidate>();
      candidates.set(row.entity_id, { entityId: row.entity_id, name: row.entity_name });
      candidatesByPhone.set(phone, candidates);
    }

    const uniqueEntityIds = [
      ...new Set([...candidatesByPhone.values()].flatMap((candidates) => [...candidates.keys()])),
    ];
    const companyByEntityId = await loadCompaniesByEntityId(uniqueEntityIds);
    const out = new Map<string, WhatsAppIdentityResolution>();
    for (const [phone, candidates] of candidatesByPhone) {
      if (candidates.size !== 1) continue;
      const candidate = [...candidates.values()][0];
      if (!candidate) continue;
      const company = companyByEntityId.get(candidate.entityId);
      out.set(phone, {
        kind: "entity",
        entityId: candidate.entityId,
        name: candidate.name,
        ...(company ? { company } : {}),
      });
    }
    return out;
  }

  async function loadCompaniesByEntityId(entityIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (entityIds.length === 0) return out;

    const rows = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as company", "company.id", "entity_relationships.target_entity_id")
      .select(["entity_relationships.source_entity_id as entity_id", "company.name as company_name"])
      .where("entity_relationships.source_entity_id", "in", entityIds)
      .where("entity_relationships.relationship_type", "=", "works_at")
      .where("entity_relationships.valid_to", "is", null)
      .where("company.status", "!=", "archived")
      .where("company.deleted_at", "is", null)
      .orderBy("company.name", "asc")
      .orderBy("company.id", "asc")
      .execute();

    for (const row of rows) {
      if (!out.has(row.entity_id)) out.set(row.entity_id, row.company_name);
    }
    return out;
  }

  async function loadLabelsByPhone(
    groupJid: string,
    phones: string[],
  ): Promise<Map<string, WhatsAppIdentityResolution>> {
    const phoneSet = new Set(phones);
    const rows = await db
      .selectFrom("whatsapp_group_member_labels")
      .select(["phone_e164", "display_name", "company_name"])
      .where("group_jid", "=", groupJid)
      .where("phone_e164", "in", phones)
      .orderBy("display_name", "asc")
      .orderBy("phone_e164", "asc")
      .execute();

    return firstByNormalizedPhone(
      rows.filter((row) => phoneSet.has(normalizeWhatsAppIdentityPhone(row.phone_e164) ?? "")),
      (row) => row.phone_e164,
      (row) => ({
        kind: "labeled",
        name: row.display_name,
        ...(row.company_name ? { company: row.company_name } : {}),
      }),
    );
  }

  return { resolve, resolveRoster };
}

async function loadPushNamesBySenderJid(db: Kysely<DB>, conversationId: number): Promise<Map<string, string>> {
  const ranked = db
    .selectFrom("conversation_messages")
    .select(["sender_jid", "sender_name", "received_at", "id"])
    .select(
      sql<number>`row_number() over (partition by sender_jid order by received_at desc, id desc)`.as("sender_rank"),
    )
    .where("conversation_id", "=", conversationId)
    .where("is_bot", "=", 0);
  const rows = await db
    .selectFrom(ranked.as("ranked_messages"))
    .select(["sender_jid", "sender_name"])
    .where("sender_rank", "=", 1)
    .execute();

  const out = new Map<string, string>();
  for (const row of rows) {
    const senderJid = row.sender_jid.trim();
    const senderName = row.sender_name.trim();
    if (senderJid && senderName) out.set(senderJid, senderName);
  }
  return out;
}

function rawPushNameForParticipant(
  pushNamesBySenderJid: Map<string, string>,
  participantJid: string,
  phoneE164: string | null,
): string | undefined {
  const direct = pushNamesBySenderJid.get(participantJid);
  if (direct) return direct;
  const normalizedPhone = normalizeWhatsAppIdentityPhone(phoneE164);
  if (!normalizedPhone) return undefined;
  return pushNamesBySenderJid.get(phoneE164ToWhatsAppJid(normalizedPhone));
}

export async function buildWhatsAppRosterSnapshot({
  db,
  groupJid,
  conversationId,
  logger,
  enrichEntityAliases = false,
}: BuildRosterSnapshotOptions): Promise<WhatsAppRosterBuildResult> {
  const participantRepo = createWhatsAppGroupRepository(db);
  const participants = await participantRepo.listParticipants(groupJid);
  const resolver = createWhatsAppIdentityResolutionService(db);
  const resolutions = await resolver.resolveRoster(
    groupJid,
    participants.map((participant) => ({
      participantJid: participant.participant_jid,
      phoneE164: participant.phone_e164,
      lid: participant.lid,
    })),
  );
  const pushNamesBySenderJid = await loadPushNamesBySenderJid(db, conversationId);
  const counts = emptyCounts(participants.length);

  const snapshotInputs = participants.map((participant) => {
    const resolution = resolutions.get(participant.participant_jid) ?? { kind: "unresolved" };
    const rawPushName = rawPushNameForParticipant(
      pushNamesBySenderJid,
      participant.participant_jid,
      participant.phone_e164,
    );
    return { participant, resolution, pushName: safePushName(rawPushName), aliasName: safeEntityAlias(rawPushName) };
  });
  if (enrichEntityAliases) {
    try {
      await enrichResolvedEntityAliases(
        db,
        groupJid,
        snapshotInputs.map(({ participant, resolution, aliasName }) => ({
          phone_e164: participant.phone_e164,
          resolution,
          aliasName,
        })),
      );
    } catch (err) {
      logger.warn(
        { ...safeWhatsAppErrorFields(err), groupJid },
        "WhatsApp entity alias enrichment failed without blocking roster resolution",
      );
    }
  }

  const snapshotParticipants = snapshotInputs.map(({ participant, resolution, pushName }) => {
    incrementCount(counts, resolution.kind);
    return snapshotParticipant(participant, resolution, pushName);
  });

  logger.info(
    {
      conversationId,
      totalParticipants: counts.totalParticipants,
      teammate: counts.teammate,
      entity: counts.entity,
      labeled: counts.labeled,
      unresolved: counts.unresolved,
    },
    "whatsapp_roster_resolution_rate",
  );

  const snapshot = {
    participants: snapshotParticipants,
    resolutionCounts: counts,
  };

  return {
    snapshot,
    serializedSnapshot: JSON.stringify(snapshot),
  };
}
