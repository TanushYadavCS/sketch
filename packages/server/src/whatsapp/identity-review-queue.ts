import type { Kysely } from "kysely";
import { sql } from "kysely";
import { listPendingNameProposalsByEntity } from "../db/repositories/entity-aliases";
import type { DB } from "../db/schema";
import { normalizeWhatsAppIdentityLid, normalizeWhatsAppIdentityPhone } from "../identity-normalization";
import { whatsappIdentitySenderJids } from "./identity-group-context";
import { sanitizeWhatsAppDisplayText } from "./privacy";

export interface WhatsAppGroupSighting {
  groupJid: string;
  groupName: string;
  messageCount: number;
  lastMessageAt: string;
  snippet: string | null;
}

export interface WhatsAppIdentitySuggestion {
  entityId: string | null;
  name: string;
  confidence: "likely" | "possibly";
  reason: string;
}

export interface WhatsAppIdentityReviewItem {
  id: string;
  entityId: string;
  phoneE164: string | null;
  lid: string | null;
  groups: WhatsAppGroupSighting[];
  suggestion: WhatsAppIdentitySuggestion | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export const IDENTITY_QUEUE_LIMIT_DEFAULT = 25;
export const IDENTITY_QUEUE_LIMIT_MAX = 100;

type RosterRow = { participant_jid: string; phone_e164: string | null; lid: string | null };

function participantLid(row: RosterRow): string | null {
  return normalizeWhatsAppIdentityLid(row.lid ?? (row.participant_jid.endsWith("@lid") ? row.participant_jid : null));
}

/**
 * The participant's phone, falling back to whatever `participant_jid` spells.
 *
 * `phone_e164` is the normalized column, but it is nullable and older rows —
 * plus anything sourced through WATI — carry the number only inside
 * `participant_jid`, as `<digits>@s.whatsapp.net`, `wati:+<e164>`, or bare
 * digits. Reading the column alone drops those participants, and with them the
 * placeholder entities they would have matched.
 */
function participantPhone(row: RosterRow): string | null {
  const normalized = normalizeWhatsAppIdentityPhone(row.phone_e164);
  if (normalized) return normalized;
  const jid = row.participant_jid;
  if (jid.endsWith("@lid")) return null;
  const bare = jid
    .replace(/^wati:/iu, "")
    .replace(/@s\.whatsapp\.net$/iu, "")
    .split(":")[0]
    .trim();
  if (!bare) return null;
  return normalizeWhatsAppIdentityPhone(bare.startsWith("+") ? bare : `+${bare}`);
}

/**
 * Placeholder-named WhatsApp people the caller can actually identify.
 *
 * Scoping runs group-first rather than entity-first: we start from the rosters
 * of the groups the caller belongs to and match those participants back to
 * placeholder entities. Starting from entities would mean scanning every
 * unnamed contact in the org and discarding most of them, and any pre-scope
 * limit would silently drop the ones the caller could have named.
 *
 * The queue therefore only ever offers someone a contact they share a group
 * with — the same rule `collectWhatsAppIdentityGroupContext` enforces for
 * excerpts. A contact nobody in the org shares a group with is unnameable here
 * by construction, which is correct: there is no evidence to name them from.
 */
export async function listUnidentifiedWhatsAppContacts(
  db: Kysely<DB>,
  viewerGroupJids: string[],
  options: { limit?: number } = {},
): Promise<WhatsAppIdentityReviewItem[]> {
  const limit = Math.min(IDENTITY_QUEUE_LIMIT_MAX, Math.max(1, options.limit ?? IDENTITY_QUEUE_LIMIT_DEFAULT));
  if (viewerGroupJids.length === 0) return [];

  const participants = await db
    .selectFrom("whatsapp_group_participants")
    .select(["group_jid", "participant_jid", "phone_e164", "lid", "last_seen_at"])
    .where("group_jid", "in", viewerGroupJids)
    .execute();
  if (participants.length === 0) return [];

  const lidValues = [...new Set(participants.map(participantLid).filter((value): value is string => value !== null))];
  const phoneValues = [
    ...new Set(participants.map(participantPhone).filter((value): value is string => value !== null)),
  ];
  if (lidValues.length === 0 && phoneValues.length === 0) return [];

  const contactPoints = await db
    .selectFrom("entity_contact_points as cp")
    .innerJoin("entities as e", "e.id", "cp.entity_id")
    .select(["cp.entity_id as entityId", "cp.kind as kind", "cp.value as value"])
    .where("e.source_type", "=", "person")
    .where("e.name_status", "=", "placeholder")
    .where("e.deleted_at", "is", null)
    .where("e.merged_into_entity_id", "is", null)
    .where((eb) => {
      const clauses = [];
      if (lidValues.length > 0)
        clauses.push(eb.and([eb("cp.kind", "=", "whatsapp_lid"), eb("cp.value", "in", lidValues)]));
      if (phoneValues.length > 0) {
        clauses.push(eb.and([eb("cp.kind", "in", ["phone", "whatsapp"]), eb("cp.value", "in", phoneValues)]));
      }
      return eb.or(clauses);
    })
    .execute();
  if (contactPoints.length === 0) return [];

  const identityByEntity = new Map<string, { lids: string[]; phoneE164: string | null }>();
  for (const row of contactPoints) {
    const current = identityByEntity.get(row.entityId) ?? { lids: [], phoneE164: null };
    if (row.kind === "whatsapp_lid") current.lids.push(row.value);
    else current.phoneE164 ??= row.value;
    identityByEntity.set(row.entityId, current);
  }

  /**
   * A contact-point value can belong to more than one placeholder entity — the
   * dedup gap that predates this queue. Mapping a value to a single owner would
   * make one of them silently vanish from the queue, so a shared value is
   * attributed to every entity holding it and the admin sees both.
   */
  const lidOwners = new Map<string, string[]>();
  const phoneOwners = new Map<string, string[]>();
  for (const [entityId, identity] of identityByEntity) {
    for (const lid of identity.lids) lidOwners.set(lid, [...(lidOwners.get(lid) ?? []), entityId]);
    if (identity.phoneE164) {
      phoneOwners.set(identity.phoneE164, [...(phoneOwners.get(identity.phoneE164) ?? []), entityId]);
    }
  }

  const groupsByEntity = new Map<string, Map<string, { lastSeenAt: string }>>();
  for (const row of participants) {
    const lid = participantLid(row);
    const phone = participantPhone(row);
    const owners = new Set([
      ...(lid ? (lidOwners.get(lid) ?? []) : []),
      ...(phone ? (phoneOwners.get(phone) ?? []) : []),
    ]);
    for (const entityId of owners) {
      const groups = groupsByEntity.get(entityId) ?? new Map();
      const existing = groups.get(row.group_jid);
      if (!existing || existing.lastSeenAt < row.last_seen_at) {
        groups.set(row.group_jid, { lastSeenAt: row.last_seen_at });
      }
      groupsByEntity.set(entityId, groups);
    }
  }
  if (groupsByEntity.size === 0) return [];

  const senderJidOwner = new Map<string, string>();
  for (const [entityId, identity] of identityByEntity) {
    if (!groupsByEntity.has(entityId)) continue;
    for (const jid of whatsappIdentitySenderJids({ lids: identity.lids, phoneE164: identity.phoneE164 })) {
      senderJidOwner.set(jid, entityId);
    }
  }

  const activity = await loadSenderActivity(db, [...senderJidOwner.keys()], viewerGroupJids);
  const snippets = await loadSnippets(
    db,
    activity.map((row) => row.latestMessageId),
  );

  const groupJids = [...new Set([...groupsByEntity.values()].flatMap((groups) => [...groups.keys()]))];
  const groupRows = await db
    .selectFrom("whatsapp_groups")
    .select(["jid", "name"])
    .where("jid", "in", groupJids)
    .execute();
  const groupNameByJid = new Map(groupRows.map((row) => [row.jid, row.name]));

  const activityByEntityGroup = new Map<
    string,
    { messageCount: number; lastMessageAt: string; snippet: string | null }
  >();
  for (const row of activity) {
    const entityId = senderJidOwner.get(row.senderJid);
    if (!entityId) continue;
    const key = `${entityId}\0${row.groupJid}`;
    const existing = activityByEntityGroup.get(key);
    const snippet = snippets.get(row.latestMessageId) ?? null;
    if (existing) {
      existing.messageCount += row.messageCount;
      if (row.lastMessageAt > existing.lastMessageAt) {
        existing.lastMessageAt = row.lastMessageAt;
        existing.snippet = snippet;
      }
      continue;
    }
    activityByEntityGroup.set(key, { messageCount: row.messageCount, lastMessageAt: row.lastMessageAt, snippet });
  }

  const items: WhatsAppIdentityReviewItem[] = [];
  for (const [entityId, groups] of groupsByEntity) {
    const identity = identityByEntity.get(entityId);
    if (!identity) continue;

    const sightings: WhatsAppGroupSighting[] = [...groups.entries()].map(([groupJid, roster]) => {
      const seen = activityByEntityGroup.get(`${entityId}\0${groupJid}`);
      return {
        groupJid,
        groupName: groupNameByJid.get(groupJid) ?? groupJid,
        messageCount: seen?.messageCount ?? 0,
        lastMessageAt: seen?.lastMessageAt ?? roster.lastSeenAt,
        snippet: seen?.snippet ?? null,
      };
    });
    sightings.sort((left, right) => (left.lastMessageAt < right.lastMessageAt ? 1 : -1));

    const timestamps = sightings.map((sighting) => sighting.lastMessageAt).sort();
    items.push({
      id: entityId,
      entityId,
      phoneE164: identity.phoneE164,
      lid: identity.lids[0] ?? null,
      groups: sightings,
      suggestion: null,
      firstSeenAt: timestamps[0] ?? new Date(0).toISOString(),
      lastSeenAt: timestamps[timestamps.length - 1] ?? new Date(0).toISOString(),
    });
  }

  items.sort((left, right) => (left.lastSeenAt < right.lastSeenAt ? 1 : -1));
  const page = items.slice(0, limit);

  const proposals = await listPendingNameProposalsByEntity(
    db,
    page.map((item) => item.entityId),
  );
  for (const item of page) {
    const proposed = proposals.get(item.entityId);
    if (!proposed) continue;
    item.suggestion = {
      entityId: null,
      name: proposed,
      confidence: "likely",
      reason: "This is the name they use on WhatsApp.",
    };
  }
  return page;
}

interface SenderActivityRow {
  senderJid: string;
  groupJid: string;
  messageCount: number;
  lastMessageAt: string;
  latestMessageId: number;
}

/**
 * Per (sender, group): how much they said, when they last said it, and the id of
 * their most recent message so a snippet can be fetched for it.
 *
 * `max(id)` anchors the snippet rather than the row matching `max(effective_at)`
 * — picking the latter would need a window function or a correlated subquery for
 * no visible gain, since both identify a recent message by the same person.
 */
async function loadSenderActivity(
  db: Kysely<DB>,
  senderJids: string[],
  groupJids: string[],
): Promise<SenderActivityRow[]> {
  if (senderJids.length === 0 || groupJids.length === 0) return [];
  const rows = await db
    .selectFrom("conversation_messages as m")
    .innerJoin("conversations as c", "c.id", "m.conversation_id")
    .select([
      "m.sender_jid as senderJid",
      "c.provider_conversation_id as groupJid",
      sql<number>`count(m.id)`.as("messageCount"),
      sql<string>`max(coalesce(m.effective_at, m.received_at))`.as("lastMessageAt"),
      sql<number>`max(m.id)`.as("latestMessageId"),
    ])
    .where("c.platform", "=", "whatsapp")
    .where("c.kind", "=", "group")
    .where("c.provider_conversation_id", "in", groupJids)
    .where("m.is_bot", "=", 0)
    .where("m.text", "!=", "")
    .where("m.sender_jid", "in", senderJids)
    .groupBy(["m.sender_jid", "c.provider_conversation_id"])
    .execute();

  return rows.map((row) => ({
    senderJid: String(row.senderJid),
    groupJid: String(row.groupJid),
    messageCount: Number(row.messageCount),
    lastMessageAt: String(row.lastMessageAt),
    latestMessageId: Number(row.latestMessageId),
  }));
}

const SNIPPET_MAX_LENGTH = 160;

async function loadSnippets(db: Kysely<DB>, messageIds: number[]): Promise<Map<number, string>> {
  const snippets = new Map<number, string>();
  if (messageIds.length === 0) return snippets;
  const rows = await db
    .selectFrom("conversation_messages")
    .select(["id", "text"])
    .where("id", "in", [...new Set(messageIds)])
    .execute();
  for (const row of rows) {
    const text = sanitizeWhatsAppDisplayText(row.text);
    if (!text) continue;
    snippets.set(
      Number(row.id),
      text.length > SNIPPET_MAX_LENGTH ? `${text.slice(0, SNIPPET_MAX_LENGTH).trimEnd()}…` : text,
    );
  }
  return snippets;
}

/**
 * Whether the caller shares at least one group with this identity.
 *
 * The read endpoints get this for free — they only ever return rows sourced
 * from the caller's own groups. A mutation addressed by entity id does not, so
 * it has to ask the question directly, otherwise an admin could act on a
 * contact they were never shown by guessing an id from another listing.
 */
export async function viewerSharesGroupWithIdentity(
  db: Kysely<DB>,
  viewerGroupJids: string[],
  identity: { lids: string[]; phoneE164: string | null },
): Promise<boolean> {
  if (viewerGroupJids.length === 0) return false;
  const lids = identity.lids
    .map((lid) => normalizeWhatsAppIdentityLid(lid))
    .filter((lid): lid is string => lid !== null);
  const phone = normalizeWhatsAppIdentityPhone(identity.phoneE164);
  if (lids.length === 0 && phone === null) return false;

  const senderJids = whatsappIdentitySenderJids({ lids, phoneE164: phone });
  const match = await db
    .selectFrom("whatsapp_group_participants")
    .select("group_jid")
    .where("group_jid", "in", viewerGroupJids)
    .where((eb) => {
      const clauses = [];
      if (lids.length > 0) clauses.push(eb("lid", "in", lids));
      if (phone !== null) clauses.push(eb("phone_e164", "=", phone));
      if (senderJids.length > 0) clauses.push(eb("participant_jid", "in", senderJids));
      return eb.or(clauses);
    })
    .limit(1)
    .executeTakeFirst();
  return match !== undefined;
}

/**
 * Takes a placeholder contact out of the review queue without naming them.
 *
 * Recorded on `entities.name_status` rather than a new column: the value already
 * models how an entity came by its name (`confirmed` / `placeholder`), and
 * `dismissed` is a third state of that same question. Any pending name proposals
 * are resolved at the same time so the entity stops offering a suggestion.
 *
 * Both writes run in one transaction. Split across two statements they can
 * interleave with a concurrent rename: the rename observes `placeholder` and
 * sets `confirmed`, then this call marks the proposals `dismissed`, leaving a
 * named entity whose proposals were retired by a dismissal that did not win.
 */
export async function dismissWhatsAppIdentity(db: Kysely<DB>, entityId: string, userId: string): Promise<boolean> {
  const now = new Date().toISOString();
  return db.transaction().execute(async (tx) => {
    const updated = await tx
      .updateTable("entities")
      .set({ name_status: "dismissed", updated_at: now })
      .where("id", "=", entityId)
      .where("name_status", "=", "placeholder")
      .executeTakeFirst();

    if (Number(updated.numUpdatedRows ?? 0) === 0) return false;

    await tx
      .updateTable("entity_name_proposals")
      .set({ status: "dismissed", resolved_by_user_id: userId, resolved_at: now })
      .where("entity_id", "=", entityId)
      .where("status", "=", "pending")
      .execute();
    return true;
  });
}
