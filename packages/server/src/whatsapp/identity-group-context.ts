import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DB } from "../db/schema";
import { normalizeWhatsAppIdentityLid, normalizeWhatsAppIdentityPhone } from "../identity-normalization";
import { sanitizeWhatsAppDisplayText } from "./privacy";

export interface WhatsAppIdentityRef {
  lids: string[];
  phoneE164: string | null;
}

export interface WhatsAppIdentityGroupContextOptions {
  groupLimit?: number;
  messagesPerGroup?: number;
  excerptsPerGroup?: number;
  /**
   * Group JIDs the caller may see. `null` means unrestricted, which is correct
   * only for server-side callers that have no viewer.
   */
  restrictToGroupJids?: string[] | null;
}

export type WhatsAppContextMessageRole = "self" | "known" | "unknown";

export interface WhatsAppContextMessage {
  id: number;
  at: string;
  role: WhatsAppContextMessageRole;
  entityId: string | null;
  senderName: string;
  text: string;
}

export interface WhatsAppContextExcerpt {
  startedAt: string;
  endedAt: string;
  messages: WhatsAppContextMessage[];
}

export type WhatsAppGroupMembershipSource = "roster" | "messages" | "both";

export interface WhatsAppContextGroup {
  groupJid: string;
  name: string;
  indexEnabled: boolean;
  membership: WhatsAppGroupMembershipSource;
  messageCount: number;
  firstSpokeAt: string | null;
  lastSpokeAt: string | null;
  excerpts: WhatsAppContextExcerpt[];
}

export interface WhatsAppIdentityGroupContext {
  groups: WhatsAppContextGroup[];
  totalGroups: number;
  truncated: boolean;
}

export const GROUP_LIMIT_DEFAULT = 5;
export const GROUP_LIMIT_MAX = 25;
export const MESSAGES_PER_GROUP_DEFAULT = 40;
export const MESSAGES_PER_GROUP_MAX = 200;
export const EXCERPTS_PER_GROUP_DEFAULT = 3;
export const EXCERPTS_PER_GROUP_MAX = 10;

/**
 * Ceiling on anchors across the whole response. Each anchor costs two indexed
 * range reads, so `groupLimit * excerptsPerGroup` at their maxima would issue
 * 500 queries. Clamping the product keeps the worst case near 85.
 */
const TOTAL_ANCHOR_CAP = 40;

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/**
 * Every spelling of `sender_jid` this identity can appear under.
 *
 * The same human is stored as `<lid>@lid` on live traffic and
 * `<phone>@s.whatsapp.net` on backfilled history, and WATI-sourced rows carry a
 * `wati:` prefix. A lookup that checks one spelling silently misses the others.
 */
export function whatsappIdentitySenderJids(identity: WhatsAppIdentityRef): string[] {
  const candidates: string[] = [];
  for (const lid of identity.lids) {
    const normalized = normalizeWhatsAppIdentityLid(lid);
    if (normalized) candidates.push(normalized);
  }
  const phone = normalizeWhatsAppIdentityPhone(identity.phoneE164);
  if (phone) {
    const digits = phone.replace(/\D/gu, "");
    candidates.push(phone, `wati:${phone}`);
    if (digits) candidates.push(`${digits}@s.whatsapp.net`, digits);
  }
  return [...new Set(candidates)];
}

/**
 * Backfilled history carries a `received_at` of when it was ingested, so
 * ordering and range filters use the reconciled provider time instead.
 */
const EFFECTIVE_AT = sql<string>`coalesce(effective_at, received_at)`;

interface SpokenGroupRow {
  conversationId: number;
  groupJid: string;
  messageCount: number;
  firstSpokeAt: string;
  lastSpokeAt: string;
}

async function loadSpokenGroups(
  db: Kysely<DB>,
  senderJids: string[],
  restrictToGroupJids: string[] | null,
): Promise<SpokenGroupRow[]> {
  if (senderJids.length === 0) return [];
  if (restrictToGroupJids !== null && restrictToGroupJids.length === 0) return [];

  let query = db
    .selectFrom("conversation_messages as m")
    .innerJoin("conversations as c", "c.id", "m.conversation_id")
    .select([
      "m.conversation_id as conversationId",
      "c.provider_conversation_id as groupJid",
      sql<number>`count(m.id)`.as("messageCount"),
      sql<string>`min(coalesce(m.effective_at, m.received_at))`.as("firstSpokeAt"),
      sql<string>`max(coalesce(m.effective_at, m.received_at))`.as("lastSpokeAt"),
    ])
    .where("c.platform", "=", "whatsapp")
    .where("c.kind", "=", "group")
    .where("m.is_bot", "=", 0)
    .where("m.sender_jid", "in", senderJids)
    .groupBy(["m.conversation_id", "c.provider_conversation_id"]);

  if (restrictToGroupJids !== null) {
    query = query.where("c.provider_conversation_id", "in", restrictToGroupJids);
  }

  const rows = await query.execute();
  return rows.map((row) => ({
    conversationId: Number(row.conversationId),
    groupJid: String(row.groupJid),
    messageCount: Number(row.messageCount),
    firstSpokeAt: String(row.firstSpokeAt),
    lastSpokeAt: String(row.lastSpokeAt),
  }));
}

async function loadRosterGroupJids(
  db: Kysely<DB>,
  identity: WhatsAppIdentityRef,
  senderJids: string[],
  restrictToGroupJids: string[] | null,
): Promise<string[]> {
  if (restrictToGroupJids !== null && restrictToGroupJids.length === 0) return [];
  const lids = identity.lids
    .map((lid) => normalizeWhatsAppIdentityLid(lid))
    .filter((lid): lid is string => lid !== null);
  const phone = normalizeWhatsAppIdentityPhone(identity.phoneE164);
  if (lids.length === 0 && phone === null && senderJids.length === 0) return [];

  let query = db
    .selectFrom("whatsapp_group_participants")
    .select("group_jid")
    .where((eb) => {
      const clauses = [];
      if (lids.length > 0) clauses.push(eb("lid", "in", lids));
      if (phone !== null) clauses.push(eb("phone_e164", "=", phone));
      if (senderJids.length > 0) clauses.push(eb("participant_jid", "in", senderJids));
      return eb.or(clauses);
    })
    .distinct();

  if (restrictToGroupJids !== null) {
    query = query.where("group_jid", "in", restrictToGroupJids);
  }

  const rows = await query.execute();
  return [...new Set(rows.map((row) => row.group_jid))];
}

/**
 * The WhatsApp groups a Sketch user is themselves a participant of.
 *
 * Read from the database rather than the request's `viewerIdentity` context
 * var: several auth paths populate that var differently, and an empty
 * `whatsappLids` there would silently widen or narrow a security decision.
 * A user with no linked WhatsApp identity returns an empty list, which callers
 * must treat as "sees nothing", never as "unrestricted".
 */
export async function resolveWhatsAppViewerGroupJids(db: Kysely<DB>, userId: string): Promise<string[]> {
  const [user, lidRows] = await Promise.all([
    db.selectFrom("users").select(["whatsapp_number", "whatsapp_lid"]).where("id", "=", userId).executeTakeFirst(),
    db.selectFrom("user_whatsapp_lids").select("lid").where("user_id", "=", userId).execute(),
  ]);

  const identity: WhatsAppIdentityRef = {
    lids: [...(user?.whatsapp_lid ? [user.whatsapp_lid] : []), ...lidRows.map((row) => row.lid)],
    phoneE164: user?.whatsapp_number ?? null,
  };
  if (identity.lids.length === 0 && identity.phoneE164 === null) return [];
  return loadRosterGroupJids(db, identity, whatsappIdentitySenderJids(identity), null);
}

interface WindowRow {
  id: number;
  at: string;
  senderJid: string;
  senderName: string;
  text: string;
}

function selectWindow(db: Kysely<DB>, conversationId: number) {
  return db
    .selectFrom("conversation_messages")
    .select(["id", EFFECTIVE_AT.as("at"), "sender_jid as senderJid", "sender_name as senderName", "text"])
    .where("conversation_id", "=", conversationId)
    .where("is_bot", "=", 0)
    .where("text", "!=", "");
}

function toWindowRows(rows: Array<{ id: number; at: string; senderJid: string; senderName: string; text: string }>) {
  return rows.map((row) => ({
    id: Number(row.id),
    at: String(row.at),
    senderJid: String(row.senderJid ?? ""),
    senderName: String(row.senderName ?? ""),
    text: String(row.text ?? ""),
  }));
}

/**
 * The `radius` messages either side of an anchor, anchor included.
 *
 * Two reads rather than one range read because `conversation_messages.id` is a
 * global serial: within a single conversation the ids are sparse, so `id
 * BETWEEN anchor - radius AND anchor + radius` would return an arbitrary count.
 * The result is contiguous in conversation order by construction, which is what
 * lets excerpts merge on range overlap alone.
 */
async function loadAnchorWindow(
  db: Kysely<DB>,
  conversationId: number,
  anchorId: number,
  radius: number,
): Promise<WindowRow[]> {
  const [before, after] = await Promise.all([
    selectWindow(db, conversationId)
      .where("id", "<=", anchorId)
      .orderBy("id", "desc")
      .limit(radius + 1)
      .execute(),
    selectWindow(db, conversationId).where("id", ">", anchorId).orderBy("id", "asc").limit(radius).execute(),
  ]);
  return [...toWindowRows(before).reverse(), ...toWindowRows(after)];
}

interface ResolvedSender {
  entityId: string;
  name: string;
}

/**
 * Maps each distinct sender JID in the response to a person entity, in two
 * batched reads. A `@lid` sender matches an entity's `whatsapp_lid` contact
 * point; a phone-shaped sender matches `phone` or `whatsapp`.
 */
async function resolveSenders(db: Kysely<DB>, senderJids: string[]): Promise<Map<string, ResolvedSender>> {
  const resolved = new Map<string, ResolvedSender>();
  if (senderJids.length === 0) return resolved;

  const lidByValue = new Map<string, string[]>();
  const phoneByValue = new Map<string, string[]>();
  for (const jid of senderJids) {
    if (jid.endsWith("@lid")) {
      const normalized = normalizeWhatsAppIdentityLid(jid);
      if (normalized) lidByValue.set(normalized, [...(lidByValue.get(normalized) ?? []), jid]);
      continue;
    }
    const bare = jid.replace(/^wati:/iu, "").replace(/@s\.whatsapp\.net$/iu, "");
    const normalized = normalizeWhatsAppIdentityPhone(bare.startsWith("+") ? bare : `+${bare}`);
    if (normalized) phoneByValue.set(normalized, [...(phoneByValue.get(normalized) ?? []), jid]);
  }

  async function lookup(kinds: Array<"whatsapp_lid" | "phone" | "whatsapp">, byValue: Map<string, string[]>) {
    if (byValue.size === 0) return;
    const rows = await db
      .selectFrom("entity_contact_points as cp")
      .innerJoin("entities as e", "e.id", "cp.entity_id")
      .select(["cp.value as value", "e.id as entityId", "e.name as name"])
      .where("cp.kind", "in", kinds)
      .where("cp.value", "in", [...byValue.keys()])
      .execute();
    for (const row of rows) {
      for (const jid of byValue.get(String(row.value)) ?? []) {
        resolved.set(jid, { entityId: String(row.entityId), name: String(row.name) });
      }
    }
  }

  await Promise.all([lookup(["whatsapp_lid"], lidByValue), lookup(["phone", "whatsapp"], phoneByValue)]);
  return resolved;
}

/**
 * Merges anchor windows into contiguous excerpts.
 *
 * Each window is already contiguous in conversation order, so two windows
 * overlap exactly when their id ranges intersect — no gap detection needed.
 * Windows arrive newest-anchor-first; the budget therefore drops the oldest
 * excerpts, and trims within an excerpt from its start.
 */
export function mergeAnchorWindows(windows: WindowRow[][], budget: number): WindowRow[][] {
  const ordered = windows.filter((window) => window.length > 0).sort((left, right) => left[0].id - right[0].id);
  if (ordered.length === 0) return [];

  const merged: WindowRow[][] = [];
  let current = [...ordered[0]];
  for (let index = 1; index < ordered.length; index += 1) {
    const window = ordered[index];
    if (window[0].id <= current[current.length - 1].id) {
      const seen = new Set(current.map((row) => row.id));
      for (const row of window) {
        if (!seen.has(row.id)) current.push(row);
      }
      current.sort((left, right) => left.id - right.id);
      continue;
    }
    merged.push(current);
    current = [...window];
  }
  merged.push(current);

  let remaining = budget;
  const kept: WindowRow[][] = [];
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    if (remaining <= 0) break;
    const run = merged[index];
    kept.unshift(run.length > remaining ? run.slice(run.length - remaining) : run);
    remaining -= Math.min(run.length, remaining);
  }
  return kept;
}

export async function collectWhatsAppIdentityGroupContext(
  db: Kysely<DB>,
  identity: WhatsAppIdentityRef,
  options: WhatsAppIdentityGroupContextOptions = {},
): Promise<WhatsAppIdentityGroupContext> {
  const groupLimit = clamp(options.groupLimit, GROUP_LIMIT_DEFAULT, GROUP_LIMIT_MAX);
  const messagesPerGroup = clamp(options.messagesPerGroup, MESSAGES_PER_GROUP_DEFAULT, MESSAGES_PER_GROUP_MAX);
  const excerptsPerGroup = clamp(options.excerptsPerGroup, EXCERPTS_PER_GROUP_DEFAULT, EXCERPTS_PER_GROUP_MAX);
  const restrictToGroupJids = options.restrictToGroupJids ?? null;

  const senderJids = whatsappIdentitySenderJids(identity);
  const [spoken, rosterJids] = await Promise.all([
    loadSpokenGroups(db, senderJids, restrictToGroupJids),
    loadRosterGroupJids(db, identity, senderJids, restrictToGroupJids),
  ]);

  const spokenByJid = new Map(spoken.map((row) => [row.groupJid, row]));
  const rosterSet = new Set(rosterJids);
  const allJids = [...new Set([...spokenByJid.keys(), ...rosterSet])];
  if (allJids.length === 0) return { groups: [], totalGroups: 0, truncated: false };

  const ranked = allJids.sort((left, right) => {
    const leftSpoke = spokenByJid.get(left)?.lastSpokeAt ?? "";
    const rightSpoke = spokenByJid.get(right)?.lastSpokeAt ?? "";
    if (leftSpoke === rightSpoke) return left.localeCompare(right);
    return leftSpoke < rightSpoke ? 1 : -1;
  });
  const selected = ranked.slice(0, groupLimit);

  const [groupRows, conversationRows] = await Promise.all([
    db.selectFrom("whatsapp_groups").select(["jid", "name", "index_enabled"]).where("jid", "in", selected).execute(),
    db
      .selectFrom("conversations")
      .select(["id", "provider_conversation_id"])
      .where("platform", "=", "whatsapp")
      .where("kind", "=", "group")
      .where("provider_conversation_id", "in", selected)
      .execute(),
  ]);
  const groupByJid = new Map(groupRows.map((row) => [row.jid, row]));
  const conversationByJid = new Map(conversationRows.map((row) => [row.provider_conversation_id, Number(row.id)]));

  const anchorsPerGroup = Math.min(excerptsPerGroup, Math.max(1, Math.floor(TOTAL_ANCHOR_CAP / selected.length)));
  const radius = Math.max(2, Math.floor(messagesPerGroup / (anchorsPerGroup * 2)));
  const selfJids = new Set(senderJids);

  const collected = await Promise.all(
    selected.map(async (groupJid) => {
      const conversationId = conversationByJid.get(groupJid) ?? null;
      const spokenRow = spokenByJid.get(groupJid) ?? null;
      if (conversationId === null || spokenRow === null) return { groupJid, spokenRow, windows: [] as WindowRow[][] };

      const anchors = await db
        .selectFrom("conversation_messages")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .where("is_bot", "=", 0)
        .where("sender_jid", "in", senderJids)
        .where("text", "!=", "")
        .orderBy("id", "desc")
        .limit(anchorsPerGroup)
        .execute();

      const windows = await Promise.all(
        anchors.map((anchor) => loadAnchorWindow(db, conversationId, Number(anchor.id), radius)),
      );
      return { groupJid, spokenRow, windows };
    }),
  );

  const merged = collected.map((entry) => ({
    ...entry,
    excerptRuns: mergeAnchorWindows(entry.windows, messagesPerGroup),
  }));

  const otherSenderJids = [
    ...new Set(
      merged
        .flatMap((entry) => entry.excerptRuns.flat().map((row) => row.senderJid))
        .filter((jid) => !selfJids.has(jid)),
    ),
  ];
  const resolvedSenders = await resolveSenders(db, otherSenderJids);

  const groups: WhatsAppContextGroup[] = merged.map((entry) => {
    const meta = groupByJid.get(entry.groupJid);
    const inRoster = rosterSet.has(entry.groupJid);
    const membership: WhatsAppGroupMembershipSource =
      inRoster && entry.spokenRow ? "both" : entry.spokenRow ? "messages" : "roster";

    return {
      groupJid: entry.groupJid,
      name: meta?.name ?? entry.groupJid,
      indexEnabled: meta?.index_enabled === 1,
      membership,
      messageCount: entry.spokenRow?.messageCount ?? 0,
      firstSpokeAt: entry.spokenRow?.firstSpokeAt ?? null,
      lastSpokeAt: entry.spokenRow?.lastSpokeAt ?? null,
      excerpts: entry.excerptRuns.map((run) => ({
        startedAt: run[0].at,
        endedAt: run[run.length - 1].at,
        messages: run.map((row) => {
          const resolvedSender = resolvedSenders.get(row.senderJid);
          const role: WhatsAppContextMessageRole = selfJids.has(row.senderJid)
            ? "self"
            : resolvedSender
              ? "known"
              : "unknown";
          return {
            id: row.id,
            at: row.at,
            role,
            entityId: resolvedSender?.entityId ?? null,
            senderName: sanitizeWhatsAppDisplayText(resolvedSender?.name ?? row.senderName),
            text: sanitizeWhatsAppDisplayText(row.text),
          };
        }),
      })),
    };
  });

  return {
    groups,
    totalGroups: allJids.length,
    truncated: allJids.length > selected.length,
  };
}
