import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { normalizeContactPointValue } from "../db/repositories/entities";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { sanitizeWhatsAppDisplayText } from "./privacy";
import { phoneE164ToWhatsAppJid } from "./provider";

export type WhatsAppIdentityResolution =
  | { kind: "teammate"; userId: string; name: string }
  | { kind: "entity"; entityId: string; name: string; company?: string }
  | { kind: "labeled"; name: string; company?: string }
  | { kind: "unresolved" };

export interface WhatsAppIdentityRosterParticipant {
  participantJid: string;
  phoneE164: string | null;
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
}

const REF_ALPHABET = "abcdefghijklmnop";

export function normalizeWhatsAppIdentityPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeContactPointValue("whatsapp", value);
  } catch {
    return null;
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
  return sanitized.length > 0 ? sanitized : undefined;
}

function displayNameForResolution(resolution: WhatsAppIdentityResolution, phoneE164: string | null): string {
  if (resolution.kind === "teammate") return resolution.name;
  if (resolution.kind === "entity") return formatWithCompany(resolution.name, resolution.company);
  if (resolution.kind === "labeled") return formatWithCompany(resolution.name, resolution.company);
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
  const displayName = sanitizeWhatsAppDisplayText(displayNameForResolution(resolution, normalizedPhone));
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
    ...(pushName ? { pushName } : {}),
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
    if (phones.length === 0) return resolutions;

    const teammateByPhone = await loadTeammatesByPhone(phones);
    const entityByPhone = await loadEntitiesByPhone(phones);
    const labelByPhone = await loadLabelsByPhone(groupJid, phones);

    for (const participant of participants) {
      const phone = normalizeWhatsAppIdentityPhone(participant.phoneE164);
      if (!phone) continue;
      resolutions.set(
        participant.participantJid,
        teammateByPhone.get(phone) ?? entityByPhone.get(phone) ?? labelByPhone.get(phone) ?? { kind: "unresolved" },
      );
    }

    return resolutions;
  }

  async function loadTeammatesByPhone(phones: string[]): Promise<Map<string, WhatsAppIdentityResolution>> {
    const phoneSet = new Set(phones);
    const rows = await db
      .selectFrom("users")
      .select(["id", "name", "whatsapp_number"])
      .where("whatsapp_number", "is not", null)
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
  const rows = await db
    .selectFrom("conversation_messages")
    .select(["sender_jid", "sender_name", "received_at", "id"])
    .where("conversation_id", "=", conversationId)
    .where("is_bot", "=", 0)
    .orderBy("received_at", "asc")
    .orderBy("id", "asc")
    .execute();

  const out = new Map<string, string>();
  for (const row of rows) {
    const senderJid = row.sender_jid.trim();
    const senderName = row.sender_name.trim();
    if (senderJid && senderName) out.set(senderJid, senderName);
  }
  return out;
}

function pushNameForParticipant(
  pushNamesBySenderJid: Map<string, string>,
  participantJid: string,
  phoneE164: string | null,
): string | undefined {
  const direct = pushNamesBySenderJid.get(participantJid);
  if (direct) return safePushName(direct);
  const normalizedPhone = normalizeWhatsAppIdentityPhone(phoneE164);
  if (!normalizedPhone) return undefined;
  return safePushName(pushNamesBySenderJid.get(phoneE164ToWhatsAppJid(normalizedPhone)));
}

export async function buildWhatsAppRosterSnapshot({
  db,
  groupJid,
  conversationId,
  logger,
}: BuildRosterSnapshotOptions): Promise<WhatsAppRosterBuildResult> {
  const participantRepo = createWhatsAppGroupRepository(db);
  const participants = await participantRepo.listParticipants(groupJid);
  const resolver = createWhatsAppIdentityResolutionService(db);
  const resolutions = await resolver.resolveRoster(
    groupJid,
    participants.map((participant) => ({
      participantJid: participant.participant_jid,
      phoneE164: participant.phone_e164,
    })),
  );
  const pushNamesBySenderJid = await loadPushNamesBySenderJid(db, conversationId);
  const counts = emptyCounts(participants.length);

  const snapshotParticipants = participants.map((participant) => {
    const resolution = resolutions.get(participant.participant_jid) ?? { kind: "unresolved" };
    incrementCount(counts, resolution.kind);
    return snapshotParticipant(
      participant,
      resolution,
      pushNameForParticipant(pushNamesBySenderJid, participant.participant_jid, participant.phone_e164),
    );
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
