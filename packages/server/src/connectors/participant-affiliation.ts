/**
 * Participant-affiliation resolution for the fourth cluster-membership signal
 * and the file-scope anchor resolver: a file belongs with a company when one
 * of its participants is a person holding a high-trust `works_at` edge to it.
 *
 * Trust gates (deliberate, confirmed 2026-08-20):
 * - `works_at` only — `engaged_with` means "deals with", not "belongs to".
 * - Edge source `declared` (human tier) or `email_domain` (deterministic).
 *   Never LLM-inferred sources: one bad inferred edge would attach a
 *   stranger's whole file history to a client.
 * - A person affiliated with the own org never generates the signal, even if
 *   they also hold a client edge — otherwise every internal meeting they
 *   attend would attach to that client.
 * - WhatsApp participants are the non-bot senders of messages inside the
 *   slice, resolved through phone/LID contact points. Never the group roster:
 *   roster scope would attach every slice of a 20-person group to every
 *   represented company.
 */
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { whereLiveEntity } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { normalizeWhatsAppIdentityLid, normalizeWhatsAppIdentityPhone } from "../identity-normalization";

export const AFFILIATION_EDGE_SOURCES: readonly string[] = ["declared", "email_domain"];

export interface AffiliationIndex {
  companiesByPerson: Map<string, Set<string>>;
  ownOrgAffiliatedPersonIds: Set<string>;
}

/**
 * One pass-level load of every high-trust works_at edge. Targets inside
 * `ownOrgCompanyIds` mark the person as own-org (excluded at use sites)
 * instead of contributing companies. A person with a corporate email contact
 * point on an organization domain is also own-org — an internal person
 * resolved through a personal email or a WhatsApp phone must not attach files
 * to a stray client edge either.
 */
export async function loadAffiliationIndex(db: Kysely<DB>, ownOrgCompanyIds: Set<string>): Promise<AffiliationIndex> {
  const rows = await db
    .selectFrom("entity_relationships as r")
    .innerJoin("entities as c", "c.id", "r.target_entity_id")
    .select(["r.source_entity_id as personId", "r.target_entity_id as companyId"])
    .where("r.relationship_type", "=", "works_at")
    .where("r.source", "in", [...AFFILIATION_EDGE_SOURCES])
    .where("r.valid_to", "is", null)
    .where("c.source_type", "=", "company")
    .where("c.status", "!=", "archived")
    .where(whereLiveEntity("c"))
    .execute();
  const companiesByPerson = new Map<string, Set<string>>();
  const ownOrgAffiliatedPersonIds = new Set<string>();
  for (const row of rows) {
    if (ownOrgCompanyIds.has(row.companyId)) {
      ownOrgAffiliatedPersonIds.add(row.personId);
      continue;
    }
    let companies = companiesByPerson.get(row.personId);
    if (!companies) {
      companies = new Set();
      companiesByPerson.set(row.personId, companies);
    }
    companies.add(row.companyId);
  }
  for (const personId of await personsWithOrgDomainEmail(db, [...companiesByPerson.keys()])) {
    ownOrgAffiliatedPersonIds.add(personId);
    companiesByPerson.delete(personId);
  }
  return { companiesByPerson, ownOrgAffiliatedPersonIds };
}

async function personsWithOrgDomainEmail(db: Kysely<DB>, personIds: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (personIds.length === 0) return found;
  const orgDomainRows = await db.selectFrom("organization_domains").select("domain").execute();
  const orgDomains = new Set(orgDomainRows.map((row) => row.domain.toLowerCase()));
  if (orgDomains.size === 0) return found;
  for (const idChunk of chunk(personIds, QUERY_CHUNK)) {
    const rows = await db
      .selectFrom("entity_contact_points")
      .select(["entity_id", "value"])
      .where("kind", "=", "email")
      .where("entity_id", "in", idChunk)
      .execute();
    for (const row of rows) {
      if (!row.entity_id) continue;
      const domain = row.value.split("@")[1]?.trim().toLowerCase();
      if (domain && orgDomains.has(domain)) found.add(row.entity_id);
    }
  }
  return found;
}

/**
 * Own-org companies detectable without the dedup-group module: holders of a
 * corporate entity_domain that is one of the organization's own domains. The
 * weekly pass uses the richer group-level ownOrg flag instead (it also covers
 * domainless own-org shards); this is the per-file-cheap variant for the
 * anchor resolver.
 */
export async function loadOwnOrgCompanyIdsByDomain(db: Kysely<DB>): Promise<Set<string>> {
  const rows = await db
    .selectFrom("entity_domains")
    .innerJoin("organization_domains", "organization_domains.domain", "entity_domains.domain")
    .select("entity_domains.entity_id")
    .where("entity_domains.kind", "=", "corporate")
    .where("entity_domains.entity_id", "is not", null)
    .execute();
  return new Set(rows.map((row) => row.entity_id).filter((id): id is string => id !== null));
}

export function senderJidToContactValue(jid: string): { kind: "phone" | "lid"; value: string } | null {
  const trimmed = jid.trim().toLowerCase();
  if (trimmed.endsWith("@lid")) {
    const lid = normalizeWhatsAppIdentityLid(trimmed);
    return lid ? { kind: "lid", value: lid } : null;
  }
  if (trimmed.endsWith("@s.whatsapp.net")) {
    const bare = trimmed.slice(0, trimmed.indexOf("@"));
    const withoutDevice = bare.includes(":") ? bare.slice(0, bare.indexOf(":")) : bare;
    const phone = normalizeWhatsAppIdentityPhone(`+${withoutDevice}`);
    return phone ? { kind: "phone", value: phone } : null;
  }
  return null;
}

async function resolveContactValuesToPersons(
  db: Kysely<DB>,
  values: { kind: "phone" | "lid"; value: string }[],
): Promise<Map<string, string>> {
  const phones = [...new Set(values.filter((v) => v.kind === "phone").map((v) => v.value))];
  const lids = [...new Set(values.filter((v) => v.kind === "lid").map((v) => v.value))];
  if (phones.length === 0 && lids.length === 0) return new Map();
  const rows = await db
    .selectFrom("entity_contact_points")
    .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
    .select(["entity_contact_points.value", "entity_contact_points.kind", "entities.id as entityId"])
    .where((eb) =>
      eb.or([
        ...(phones.length > 0
          ? [
              eb.and([
                eb("entity_contact_points.kind", "in", ["phone", "whatsapp"]),
                eb("entity_contact_points.value", "in", phones),
              ]),
            ]
          : []),
        ...(lids.length > 0
          ? [
              eb.and([
                eb("entity_contact_points.kind", "=", "whatsapp_lid"),
                eb("entity_contact_points.value", "in", lids),
              ]),
            ]
          : []),
      ]),
    )
    .where("entities.source_type", "=", "person")
    .where("entities.status", "!=", "archived")
    .where(whereLiveEntity())
    .execute();
  const candidates = new Map<string, Set<string>>();
  for (const row of rows) {
    let set = candidates.get(row.value);
    if (!set) {
      set = new Set();
      candidates.set(row.value, set);
    }
    set.add(row.entityId);
  }
  const resolved = new Map<string, string>();
  for (const [value, entityIds] of candidates) {
    if (entityIds.size === 1) resolved.set(value, [...entityIds][0]);
  }
  return resolved;
}

const QUERY_CHUNK = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * fileId → person entity ids of the non-bot senders inside each indexed
 * WhatsApp slice. Batched: one slice scan, chunked message scans bounded per
 * conversation to the min–max id range its indexed slices cover (a long group
 * history outside any slice is never read), one contact-point lookup.
 * Ambiguous numbers (shared by two person entities) resolve to nobody rather
 * than guessing; unresolved and ambiguous senders are logged as coverage
 * gaps (counts only, never identifiers).
 */
export async function loadWhatsAppSenderPersonsByFile(
  db: Kysely<DB>,
  logger?: Logger,
): Promise<Map<string, Set<string>>> {
  const slices = await db
    .selectFrom("conversation_slices")
    .select(["indexed_file_id", "conversation_id", "first_message_id", "last_message_id"])
    .where("indexed_file_id", "is not", null)
    .execute();
  if (slices.length === 0) return new Map();

  const boundsByConversation = new Map<number, { min: number; max: number }>();
  for (const slice of slices) {
    const bounds = boundsByConversation.get(slice.conversation_id);
    if (!bounds) {
      boundsByConversation.set(slice.conversation_id, { min: slice.first_message_id, max: slice.last_message_id });
    } else {
      bounds.min = Math.min(bounds.min, slice.first_message_id);
      bounds.max = Math.max(bounds.max, slice.last_message_id);
    }
  }
  const messagesByConversation = new Map<number, { id: number; senderJid: string }[]>();
  for (const boundsChunk of chunk([...boundsByConversation.entries()], QUERY_CHUNK)) {
    const rows = await db
      .selectFrom("conversation_messages")
      .select(["id", "conversation_id", "sender_jid"])
      .where((eb) =>
        eb.or(
          boundsChunk.map(([conversationId, bounds]) =>
            eb.and([
              eb("conversation_id", "=", conversationId),
              eb("id", ">=", bounds.min),
              eb("id", "<=", bounds.max),
            ]),
          ),
        ),
      )
      .where("is_bot", "=", 0)
      .where("sender_jid", "is not", null)
      .execute();
    for (const row of rows) {
      if (!row.sender_jid) continue;
      let list = messagesByConversation.get(row.conversation_id);
      if (!list) {
        list = [];
        messagesByConversation.set(row.conversation_id, list);
      }
      list.push({ id: row.id, senderJid: row.sender_jid });
    }
  }

  const jidsByFile = new Map<string, Set<string>>();
  const allValues: { kind: "phone" | "lid"; value: string }[] = [];
  const valueByJid = new Map<string, string>();
  let unparsableJids = 0;
  for (const slice of slices) {
    if (!slice.indexed_file_id) continue;
    const messages = messagesByConversation.get(slice.conversation_id) ?? [];
    for (const message of messages) {
      if (message.id < slice.first_message_id || message.id > slice.last_message_id) continue;
      let set = jidsByFile.get(slice.indexed_file_id);
      if (!set) {
        set = new Set();
        jidsByFile.set(slice.indexed_file_id, set);
      }
      if (set.has(message.senderJid)) continue;
      set.add(message.senderJid);
      if (!valueByJid.has(message.senderJid)) {
        const contact = senderJidToContactValue(message.senderJid);
        if (contact) {
          valueByJid.set(message.senderJid, contact.value);
          allValues.push(contact);
        } else {
          unparsableJids += 1;
        }
      }
    }
  }

  const personByValue = await resolveContactValuesToPersons(db, allValues);
  const out = new Map<string, Set<string>>();
  for (const [fileId, jids] of jidsByFile) {
    for (const jid of jids) {
      const value = valueByJid.get(jid);
      if (!value) continue;
      const personId = personByValue.get(value);
      if (!personId) continue;
      let set = out.get(fileId);
      if (!set) {
        set = new Set();
        out.set(fileId, set);
      }
      set.add(personId);
    }
  }
  const unresolvedValues = allValues.filter((value) => !personByValue.has(value.value)).length;
  if (logger && (unparsableJids > 0 || unresolvedValues > 0)) {
    logger.info(
      { unparsableSenderJids: unparsableJids, unresolvedSenderContacts: unresolvedValues },
      "participant_affiliation: WhatsApp senders without a unique person entity",
    );
  }
  return out;
}

/**
 * Companies the given persons are affiliated with, under exactly the gates
 * `loadAffiliationIndex` enforces — one implementation for both the weekly
 * pass and this per-file anchor path, so the exclusions can never drift.
 * Own-org here is the domain-based variant (corporate entity_domains on org
 * domains, plus persons with org-domain email contact points); domainless
 * own-org shards and duplicate-shard canonicalisation need the weekly pass's
 * dedup groups, which are too expensive to build per file — anchor ids stay
 * raw entity ids, like every other anchor this resolver returns.
 */
export async function companiesForAffiliatedPersons(
  db: Kysely<DB>,
  personIds: string[],
): Promise<{ id: string; name: string; source_type: string; hotness: number | null }[]> {
  if (personIds.length === 0) return [];
  const index = await loadAffiliationIndex(db, await loadOwnOrgCompanyIdsByDomain(db));
  const companyIds = new Set<string>();
  for (const personId of personIds) {
    if (index.ownOrgAffiliatedPersonIds.has(personId)) continue;
    for (const companyId of index.companiesByPerson.get(personId) ?? []) {
      companyIds.add(companyId);
    }
  }
  if (companyIds.size === 0) return [];
  return db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "hotness"])
    .where("id", "in", [...companyIds])
    .execute();
}

/** Per-file variant of the sender resolution, for the anchor resolver. */
export async function resolveWhatsAppSenderPersonsForFile(db: Kysely<DB>, fileId: string): Promise<Set<string>> {
  const slice = await db
    .selectFrom("conversation_slices")
    .select(["conversation_id", "first_message_id", "last_message_id"])
    .where("indexed_file_id", "=", fileId)
    .executeTakeFirst();
  if (!slice) return new Set();
  const rows = await db
    .selectFrom("conversation_messages")
    .select("sender_jid")
    .distinct()
    .where("conversation_id", "=", slice.conversation_id)
    .where("id", ">=", slice.first_message_id)
    .where("id", "<=", slice.last_message_id)
    .where("is_bot", "=", 0)
    .where("sender_jid", "is not", null)
    .execute();
  const values: { kind: "phone" | "lid"; value: string }[] = [];
  for (const row of rows) {
    const contact = row.sender_jid ? senderJidToContactValue(row.sender_jid) : null;
    if (contact) values.push(contact);
  }
  const personByValue = await resolveContactValuesToPersons(db, values);
  return new Set(personByValue.values());
}
