import { Buffer } from "node:buffer";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { AccessPrincipal } from "../../connectors/types";
import { accessPrincipalPredicateSql } from "../../db/repositories/connectors";
import type { StoredConversationMessage } from "../../db/repositories/conversations";
import type { ConversationSlicesTable, DB } from "../../db/schema";
import type { Attachment } from "../../files";
import {
  type WhatsAppRosterParticipantSnapshot,
  type WhatsAppRosterSnapshot,
  stableWhatsAppParticipantJidRef,
} from "../../whatsapp/identity-resolution";
import { stripPersonalNumberTokens } from "../../whatsapp/privacy";
import { resolveUserPrincipals } from "./search";
import type { SketchMcpDeps, ToolResult } from "./types";

export const WHATSAPP_GROUP_HISTORY_TOOL_NAME = "WhatsAppGroupHistory";
export const WHATSAPP_GROUP_HISTORY_DENIED_TEXT = "WhatsApp group history is not available for this request.";
export const DEFAULT_WHATSAPP_GROUP_HISTORY_EXPAND_MINUTES = 30;
export const MAX_WHATSAPP_GROUP_HISTORY_EXPAND_MINUTES = 240;
export const DEFAULT_WHATSAPP_GROUP_HISTORY_LIMIT = 100;
export const MAX_WHATSAPP_GROUP_HISTORY_LIMIT = 200;
export const MAX_WHATSAPP_GROUP_HISTORY_WINDOW_MINUTES = 24 * 60;

const INVALID_INPUT_TEXT =
  "Provide either { sliceId } or { groupRef, startedAt, endedAt }. groupRef must be a conversation reference returned by this tool.";
const LOCAL_PATH_PATTERN = /(?:\/(?:tmp|private\/tmp|var\/folders|Users|data\/workspaces)\/[^\s"'<>()[\]{}]*)/giu;

const whatsappGroupHistorySchema = {
  sliceId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("WhatsApp conversation slice id from a Search result providerId."),
  groupRef: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Stable group reference returned by this tool, formatted as "conversation:<id>".'),
  startedAt: z.string().trim().min(1).optional().describe("ISO timestamp for the start of a direct group window."),
  endedAt: z.string().trim().min(1).optional().describe("ISO timestamp for the end of a direct group window."),
  expandMinutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Minutes to expand before and after the anchor window. Default 30, capped at 240."),
  limit: z.number().int().positive().optional().describe("Maximum messages to return. Default 100, capped at 200."),
  pageToken: z.string().trim().min(1).optional().describe("Continuation token returned by a prior call."),
};

interface WhatsAppGroupHistoryArgs {
  sliceId?: string;
  groupRef?: string;
  startedAt?: string;
  endedAt?: string;
  expandMinutes?: number;
  limit?: number;
  pageToken?: string;
}

interface DrillAnchor {
  sliceId: string;
  conversationId: number;
  groupJid: string;
  firstMessageId: number;
  lastMessageId: number;
  startedAt: string;
  endedAt: string;
  rosterSnapshot: WhatsAppRosterSnapshot;
  indexedFileId: string | null;
}

interface MessageCursor {
  receivedAt: string;
  messageId: number;
}

interface AuthorizedMessageWindow {
  start: string;
  end: string;
}

export interface WhatsAppGroupHistoryWindow {
  start: string;
  end: string;
  expandMinutes: number;
}

interface GroupWindowAuthorization {
  anchor: DrillAnchor;
  window: WhatsAppGroupHistoryWindow;
  messageWindows: AuthorizedMessageWindow[];
}

type SliceAnchorRow = Pick<
  ConversationSlicesTable,
  | "id"
  | "conversation_id"
  | "first_message_id"
  | "last_message_id"
  | "started_at"
  | "ended_at"
  | "roster_snapshot"
  | "indexed_file_id"
> & {
  group_jid: string;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function deniedResult(): ToolResult {
  return textResult(WHATSAPP_GROUP_HISTORY_DENIED_TEXT);
}

export function normalizeWhatsAppGroupHistoryExpandMinutes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WHATSAPP_GROUP_HISTORY_EXPAND_MINUTES;
  return Math.max(0, Math.min(value, MAX_WHATSAPP_GROUP_HISTORY_EXPAND_MINUTES));
}

export function normalizeWhatsAppGroupHistoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WHATSAPP_GROUP_HISTORY_LIMIT;
  return Math.max(1, Math.min(value, MAX_WHATSAPP_GROUP_HISTORY_LIMIT));
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(date: Date): string {
  return date.toISOString();
}

export function buildWhatsAppGroupHistoryWindow(
  startedAt: string,
  endedAt: string,
  expandMinutesInput: number | undefined,
  options: { maxWindowMinutes?: number } = {},
): WhatsAppGroupHistoryWindow | null {
  const start = parseDate(startedAt);
  const end = parseDate(endedAt);
  if (!start || !end || end.getTime() < start.getTime()) return null;

  const expandMinutes = normalizeWhatsAppGroupHistoryExpandMinutes(expandMinutesInput);
  const expandMs = expandMinutes * 60 * 1000;
  const expandedStart = new Date(start.getTime() - expandMs);
  let expandedEnd = new Date(end.getTime() + expandMs);

  if (options.maxWindowMinutes !== undefined) {
    const maxEnd = new Date(expandedStart.getTime() + options.maxWindowMinutes * 60 * 1000);
    if (expandedEnd.getTime() > maxEnd.getTime()) expandedEnd = maxEnd;
  }

  return {
    start: toIso(expandedStart),
    end: toIso(expandedEnd),
    expandMinutes,
  };
}

function afterExclusiveForInclusiveStart(startIso: string): string {
  const start = parseDate(startIso);
  if (!start) return startIso;
  return toIso(new Date(start.getTime() - 1));
}

export function parseWhatsAppGroupRosterSnapshot(raw: string): WhatsAppRosterSnapshot {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { participants?: unknown; resolutionCounts?: unknown };
      if (Array.isArray(record.participants)) {
        return {
          participants: record.participants as WhatsAppRosterParticipantSnapshot[],
          resolutionCounts:
            record.resolutionCounts &&
            typeof record.resolutionCounts === "object" &&
            !Array.isArray(record.resolutionCounts)
              ? (record.resolutionCounts as WhatsAppRosterSnapshot["resolutionCounts"])
              : { totalParticipants: record.participants.length, teammate: 0, entity: 0, labeled: 0, unresolved: 0 },
        };
      }
    }
  } catch {
    return emptyRosterSnapshot();
  }

  return emptyRosterSnapshot();
}

function emptyRosterSnapshot(): WhatsAppRosterSnapshot {
  return {
    participants: [],
    resolutionCounts: { totalParticipants: 0, teammate: 0, entity: 0, labeled: 0, unresolved: 0 },
  };
}

function toDrillAnchor(row: SliceAnchorRow): DrillAnchor {
  return {
    sliceId: row.id,
    conversationId: row.conversation_id,
    groupJid: row.group_jid,
    firstMessageId: row.first_message_id,
    lastMessageId: row.last_message_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    rosterSnapshot: parseWhatsAppGroupRosterSnapshot(row.roster_snapshot),
    indexedFileId: row.indexed_file_id,
  };
}

function baseSliceAnchorQuery(db: Kysely<DB>) {
  return db
    .selectFrom("conversation_slices")
    .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
    .innerJoin("whatsapp_groups", "whatsapp_groups.jid", "conversations.provider_conversation_id")
    .select([
      "conversation_slices.id",
      "conversation_slices.conversation_id",
      "conversation_slices.first_message_id",
      "conversation_slices.last_message_id",
      "conversation_slices.started_at",
      "conversation_slices.ended_at",
      "conversation_slices.roster_snapshot",
      "conversation_slices.indexed_file_id",
      "conversations.provider_conversation_id as group_jid",
    ])
    .where("conversations.platform", "=", "whatsapp")
    .where("conversations.kind", "=", "group")
    .where("whatsapp_groups.index_enabled", "=", 1);
}

function authorizedSliceAnchorQuery(db: Kysely<DB>, userPrincipals: AccessPrincipal[]) {
  return baseSliceAnchorQuery(db)
    .innerJoin("indexed_files", "indexed_files.id", "conversation_slices.indexed_file_id")
    .innerJoin("access_scopes", "access_scopes.id", "indexed_files.access_scope_id")
    .innerJoin("access_scope_members", "access_scope_members.access_scope_id", "access_scopes.id")
    .where("indexed_files.source", "=", "whatsapp")
    .where("indexed_files.is_archived", "=", 0)
    .where("indexed_files.share_with_everyone", "=", 0)
    .whereRef("indexed_files.provider_file_id", "=", "conversation_slices.id")
    .where("access_scopes.scope_type", "=", "whatsapp_group")
    .whereRef("access_scopes.provider_scope_id", "=", "conversations.provider_conversation_id")
    .where(accessPrincipalPredicateSql("access_scope_members", userPrincipals));
}

async function loadAuthorizedSliceAnchor(
  db: Kysely<DB>,
  sliceId: string,
  userPrincipals: AccessPrincipal[],
): Promise<DrillAnchor | null> {
  const row = await authorizedSliceAnchorQuery(db, userPrincipals)
    .where("conversation_slices.id", "=", sliceId)
    .limit(1)
    .executeTakeFirst();
  return row ? toDrillAnchor(row) : null;
}

function parseGroupRef(groupRef: string): number | null {
  const trimmed = groupRef.trim();
  const match = /^(?:conversation:|whatsapp:\/\/conversation\/)?(\d+)$/iu.exec(trimmed);
  if (!match?.[1]) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function accessibleGroupAnchorQuery(db: Kysely<DB>, conversationId: number, userPrincipals: AccessPrincipal[]) {
  return authorizedSliceAnchorQuery(db, userPrincipals)
    .where("conversation_slices.conversation_id", "=", conversationId)
    .where("conversation_slices.salience_verdict", "=", "kept");
}

function intersectMessageWindow(
  left: AuthorizedMessageWindow,
  right: AuthorizedMessageWindow,
): AuthorizedMessageWindow | null {
  const start = Date.parse(left.start) > Date.parse(right.start) ? left.start : right.start;
  const end = Date.parse(left.end) < Date.parse(right.end) ? left.end : right.end;
  return Date.parse(start) <= Date.parse(end) ? { start, end } : null;
}

function mergeMessageWindows(windows: AuthorizedMessageWindow[]): AuthorizedMessageWindow[] {
  const sorted = [...windows].sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const merged: AuthorizedMessageWindow[] = [];

  for (const window of sorted) {
    const current = merged[merged.length - 1];
    if (!current || Date.parse(window.start) > Date.parse(current.end)) {
      merged.push({ ...window });
      continue;
    }

    if (Date.parse(window.end) > Date.parse(current.end)) current.end = window.end;
  }

  return merged;
}

async function loadGroupWindowAuthorization(
  db: Kysely<DB>,
  conversationId: number,
  userPrincipals: AccessPrincipal[],
  window: WhatsAppGroupHistoryWindow,
): Promise<GroupWindowAuthorization | null> {
  const overlappingRows = await accessibleGroupAnchorQuery(db, conversationId, userPrincipals)
    .where("conversation_slices.started_at", "<=", window.end)
    .where("conversation_slices.ended_at", ">=", window.start)
    .orderBy("conversation_slices.started_at", "asc")
    .orderBy("conversation_slices.id", "asc")
    .execute();

  if (overlappingRows.length === 0) return null;

  const requestedWindow = { start: window.start, end: window.end };
  const messageWindows = mergeMessageWindows(
    overlappingRows
      .map((row) => buildWhatsAppGroupHistoryWindow(row.started_at, row.ended_at, window.expandMinutes))
      .filter((rowWindow): rowWindow is WhatsAppGroupHistoryWindow => rowWindow !== null)
      .map((rowWindow) => intersectMessageWindow(requestedWindow, rowWindow))
      .filter((rowWindow): rowWindow is AuthorizedMessageWindow => rowWindow !== null),
  );

  if (messageWindows.length === 0) return null;

  return {
    anchor: toDrillAnchor(overlappingRows[0]),
    window: {
      start: messageWindows[0].start,
      end: messageWindows[messageWindows.length - 1].end,
      expandMinutes: window.expandMinutes,
    },
    messageWindows,
  };
}

/**
 * Continuation tokens are intentionally unsigned. They carry only cursor
 * position and request bounds: within-window skipping is already reachable via
 * legal parameters, authorization is enforced on every query, and decode rejects
 * tokens that cross conversation or window bounds.
 */
function encodePageToken(
  message: StoredConversationMessage,
  conversationId: number,
  window: WhatsAppGroupHistoryWindow,
): string {
  return Buffer.from(
    JSON.stringify({
      conversationId,
      windowStart: window.start,
      windowEnd: window.end,
      receivedAt: message.receivedAt,
      messageId: message.id,
    }),
    "utf8",
  ).toString("base64url");
}

function parsePageToken(
  pageToken: string | undefined,
  conversationId: number,
  window: WhatsAppGroupHistoryWindow,
): MessageCursor | null {
  if (!pageToken) return null;
  try {
    const parsed = JSON.parse(Buffer.from(pageToken, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as {
      conversationId?: unknown;
      windowStart?: unknown;
      windowEnd?: unknown;
      receivedAt?: unknown;
      messageId?: unknown;
    };
    if (
      record.conversationId !== conversationId ||
      record.windowStart !== window.start ||
      record.windowEnd !== window.end
    ) {
      return null;
    }
    if (typeof record.receivedAt !== "string" || typeof record.messageId !== "number") return null;
    if (!parseDate(record.receivedAt) || !Number.isSafeInteger(record.messageId) || record.messageId <= 0) return null;
    return { receivedAt: record.receivedAt, messageId: record.messageId };
  } catch {
    return null;
  }
}

async function listRawMessagesInWindow(
  db: Kysely<DB>,
  conversationId: number,
  window: WhatsAppGroupHistoryWindow,
  messageWindows: AuthorizedMessageWindow[],
  limit: number,
  cursor: MessageCursor | null,
): Promise<{ messages: StoredConversationMessage[]; hasMore: boolean; nextPageToken?: string }> {
  let query = db
    .selectFrom("conversation_messages")
    .selectAll()
    .where("conversation_id", "=", conversationId)
    .where((eb) =>
      eb.or(
        messageWindows.map((messageWindow) =>
          eb.and([
            eb("received_at", ">", afterExclusiveForInclusiveStart(messageWindow.start)),
            eb("received_at", "<=", messageWindow.end),
          ]),
        ),
      ),
    );

  if (cursor) {
    query = query.where((eb) =>
      eb.or([
        eb("received_at", ">", cursor.receivedAt),
        eb.and([eb("received_at", "=", cursor.receivedAt), eb("id", ">", cursor.messageId)]),
      ]),
    );
  }

  const rows = await query
    .orderBy("received_at", "asc")
    .orderBy("id", "asc")
    .limit(limit + 1)
    .execute();
  const stored = rows.slice(0, limit).map(toStoredConversationMessage);
  const hasMore = rows.length > limit;
  const last = stored[stored.length - 1];
  return {
    messages: stored,
    hasMore,
    nextPageToken: hasMore && last ? encodePageToken(last, conversationId, window) : undefined,
  };
}

function parseAttachments(value: string | null): Attachment[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as Attachment[]) : [];
  } catch {
    return [];
  }
}

function toStoredConversationMessage(row: {
  id: number;
  conversation_id: number;
  provider_message_id: string;
  sender_jid: string;
  sender_name: string;
  sender_user_id: string | null;
  is_bot: number;
  addressed_to_sketch: number;
  text: string;
  attachments: string | null;
  provider_thread_id: string | null;
  provider_parent_message_id: string | null;
  is_thread_reply: number;
  provider_timestamp: string | null;
  provider_from_me: number;
  received_at: string;
  source: string;
  effective_at: string | null;
  connection_key: string | null;
  backfill_range_id: string | null;
  created_at: string;
}): StoredConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    providerMessageId: row.provider_message_id,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    senderUserId: row.sender_user_id,
    isBot: row.is_bot === 1,
    addressedToSketch: row.addressed_to_sketch === 1,
    text: row.text,
    attachments: parseAttachments(row.attachments),
    providerThreadId: row.provider_thread_id,
    providerParentMessageId: row.provider_parent_message_id,
    isThreadReply: row.is_thread_reply === 1,
    providerTimestamp: row.provider_timestamp,
    providerFromMe: row.provider_from_me === 1,
    receivedAt: row.received_at,
    source: row.source === "history" ? "history" : "live",
    effectiveAt: row.effective_at ?? row.received_at,
    connectionKey: row.connection_key,
    backfillRangeId: row.backfill_range_id,
    createdAt: row.created_at,
  };
}

function rosterBySenderRef(snapshot: WhatsAppRosterSnapshot): Map<string, WhatsAppRosterParticipantSnapshot> {
  const out = new Map<string, WhatsAppRosterParticipantSnapshot>();
  for (const participant of snapshot.participants) {
    for (const senderRef of participant.senderJidRefs ?? []) out.set(senderRef, participant);
  }
  return out;
}

function safeSenderFallback(message: StoredConversationMessage): string {
  return `External (${stableWhatsAppParticipantJidRef(message.senderJid).slice(0, 12)})`;
}

function sanitizeWhatsAppHistoryDisplayName(value: string): string {
  return stripPersonalNumberTokens(value)
    .replace(LOCAL_PATH_PATTERN, "[file]")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function sanitizeWhatsAppHistoryText(value: string): string {
  return stripPersonalNumberTokens(value)
    .replace(LOCAL_PATH_PATTERN, "[file]")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function renderAttachmentPlaceholder(attachment: Attachment): string {
  const mimeType = attachment.mimeType.toLowerCase();
  if (mimeType.startsWith("image/")) return "[image]";
  if (mimeType.startsWith("audio/")) return "[audio]";
  if (mimeType.startsWith("video/")) return "[video]";
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) return "[document]";
  return "[attachment]";
}

export function renderWhatsAppGroupHistoryMessages(
  snapshot: WhatsAppRosterSnapshot,
  messages: StoredConversationMessage[],
): Array<Record<string, unknown>> {
  const bySenderRef = rosterBySenderRef(snapshot);
  return messages.map((message) => {
    const senderRef = stableWhatsAppParticipantJidRef(message.senderJid);
    const participant = bySenderRef.get(senderRef);
    const sender = participant?.displayName
      ? sanitizeWhatsAppHistoryDisplayName(participant.displayName)
      : safeSenderFallback(message);
    const attachments = message.attachments.map(renderAttachmentPlaceholder);
    return {
      id: message.id,
      timestamp: message.providerTimestamp ?? message.receivedAt,
      sender: sender.length > 0 ? sender : safeSenderFallback(message),
      text: sanitizeWhatsAppHistoryText(message.text),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  });
}

function formatGroupRef(conversationId: number): string {
  return `conversation:${conversationId}`;
}

export async function handleWhatsAppGroupHistory(
  args: WhatsAppGroupHistoryArgs,
  deps: SketchMcpDeps,
): Promise<ToolResult> {
  if (!deps.db) return deniedResult();

  const userPrincipals = await resolveUserPrincipals(deps);
  if (userPrincipals.length === 0) return deniedResult();

  const limit = normalizeWhatsAppGroupHistoryLimit(args.limit);

  let anchor: DrillAnchor | null = null;
  let window: WhatsAppGroupHistoryWindow | null = null;
  let messageWindows: AuthorizedMessageWindow[] = [];

  if (args.sliceId) {
    anchor = await loadAuthorizedSliceAnchor(deps.db, args.sliceId, userPrincipals);
    if (!anchor) return deniedResult();
    window = buildWhatsAppGroupHistoryWindow(anchor.startedAt, anchor.endedAt, args.expandMinutes);
    if (window) messageWindows = [{ start: window.start, end: window.end }];
  } else if (args.groupRef && args.startedAt && args.endedAt) {
    const conversationId = parseGroupRef(args.groupRef) ?? -1;
    window = buildWhatsAppGroupHistoryWindow(args.startedAt, args.endedAt, args.expandMinutes, {
      maxWindowMinutes: MAX_WHATSAPP_GROUP_HISTORY_WINDOW_MINUTES,
    });
    if (!window) return textResult(INVALID_INPUT_TEXT);
    const authorization = await loadGroupWindowAuthorization(deps.db, conversationId, userPrincipals, window);
    if (!authorization) return deniedResult();
    anchor = authorization.anchor;
    window = authorization.window;
    messageWindows = authorization.messageWindows;
  } else {
    return textResult(INVALID_INPUT_TEXT);
  }

  if (!window) return textResult(INVALID_INPUT_TEXT);
  const cursor = parsePageToken(args.pageToken, anchor.conversationId, window);
  if (args.pageToken && !cursor) return textResult("Invalid pageToken.");

  const result = await listRawMessagesInWindow(deps.db, anchor.conversationId, window, messageWindows, limit, cursor);
  const payload = {
    groupRef: formatGroupRef(anchor.conversationId),
    anchor: {
      sliceId: anchor.sliceId,
      startedAt: anchor.startedAt,
      endedAt: anchor.endedAt,
      firstMessageId: anchor.firstMessageId,
      lastMessageId: anchor.lastMessageId,
    },
    window,
    messages: renderWhatsAppGroupHistoryMessages(anchor.rosterSnapshot, result.messages),
    hasMore: result.hasMore,
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  };

  return textResult(JSON.stringify(payload, null, 2));
}

export function createWhatsAppGroupHistoryTool(deps: SketchMcpDeps) {
  return tool(
    WHATSAPP_GROUP_HISTORY_TOOL_NAME,
    "Read raw WhatsApp group messages around an indexed WhatsApp slice, including adjacent messages that were dropped from indexing. Use this after Search finds a WhatsApp slice and the user asks what exactly was said before, during, or after it. Requires sliceId, or groupRef with startedAt and endedAt from a prior WhatsAppGroupHistory result. Use pageToken as a continuation token for additional pages. Returns display-name-only senders and type-only attachment placeholders.",
    whatsappGroupHistorySchema,
    (args) => handleWhatsAppGroupHistory(args, deps),
  );
}
