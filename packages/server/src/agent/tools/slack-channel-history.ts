import { Buffer } from "node:buffer";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { StoredConversationMessage } from "../../db/repositories/conversations";
import type { ConversationSlicesTable, DB } from "../../db/schema";
import type { Attachment } from "../../files";
import { type SlackRosterSnapshot, parseSlackRosterSnapshot } from "../../slack/identity-resolution";
import { resolveUserEmails } from "./search";
import type { SketchMcpDeps, ToolResult } from "./types";

export const SLACK_CHANNEL_HISTORY_TOOL_NAME = "SlackChannelHistory";
export const SLACK_CHANNEL_HISTORY_DENIED_TEXT = "Slack channel history is not available for this request.";
export const DEFAULT_SLACK_CHANNEL_HISTORY_EXPAND_MINUTES = 30;
export const MAX_SLACK_CHANNEL_HISTORY_EXPAND_MINUTES = 240;
export const DEFAULT_SLACK_CHANNEL_HISTORY_LIMIT = 100;
export const MAX_SLACK_CHANNEL_HISTORY_LIMIT = 200;
export const MAX_SLACK_CHANNEL_HISTORY_WINDOW_MINUTES = 24 * 60;

const INVALID_INPUT_TEXT =
  "Provide either { sliceId } or { channelRef, startedAt, endedAt }. channelRef must be a conversation reference returned by this tool.";
const LOCAL_PATH_PATTERN = /(?:\/(?:tmp|private\/tmp|var\/folders|Users|data\/workspaces)\/[^\s"'<>()[\]{}]*)/giu;
const MENTION_TOKEN_PATTERN = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g;

const slackChannelHistorySchema = {
  sliceId: z.string().trim().min(1).optional().describe("Slack conversation slice id from a Search result providerId."),
  channelRef: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Stable channel reference returned by this tool, formatted as "conversation:<id>".'),
  startedAt: z.string().trim().min(1).optional().describe("ISO timestamp for the start of a direct channel window."),
  endedAt: z.string().trim().min(1).optional().describe("ISO timestamp for the end of a direct channel window."),
  expandMinutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Minutes to expand before and after the anchor window. Default 30, capped at 240."),
  limit: z.number().int().positive().optional().describe("Maximum messages to return. Default 100, capped at 200."),
  pageToken: z.string().trim().min(1).optional().describe("Continuation token returned by a prior call."),
};

interface SlackChannelHistoryArgs {
  sliceId?: string;
  channelRef?: string;
  startedAt?: string;
  endedAt?: string;
  expandMinutes?: number;
  limit?: number;
  pageToken?: string;
}

interface DrillAnchor {
  sliceId: string;
  conversationId: number;
  channelId: string;
  providerThreadId: string | null;
  firstMessageId: number;
  lastMessageId: number;
  startedAt: string;
  endedAt: string;
  rosterSnapshot: SlackRosterSnapshot | null;
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

export interface SlackChannelHistoryWindow {
  start: string;
  end: string;
  expandMinutes: number;
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
  | "provider_thread_id"
> & {
  channel_id: string;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function deniedResult(): ToolResult {
  return textResult(SLACK_CHANNEL_HISTORY_DENIED_TEXT);
}

function normalizeEmails(emails: string[]): string[] {
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0))];
}

export function normalizeSlackChannelHistoryExpandMinutes(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) return DEFAULT_SLACK_CHANNEL_HISTORY_EXPAND_MINUTES;
  return Math.min(value, MAX_SLACK_CHANNEL_HISTORY_EXPAND_MINUTES);
}

export function normalizeSlackChannelHistoryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return DEFAULT_SLACK_CHANNEL_HISTORY_LIMIT;
  return Math.min(value, MAX_SLACK_CHANNEL_HISTORY_LIMIT);
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIso(date: Date): string {
  return date.toISOString();
}

export function buildSlackChannelHistoryWindow(
  startedAt: string,
  endedAt: string,
  expandMinutes: number | undefined,
  options?: { maxWindowMinutes?: number },
): SlackChannelHistoryWindow | null {
  const start = parseDate(startedAt);
  const end = parseDate(endedAt);
  if (!start || !end || start.getTime() > end.getTime()) return null;
  if (options?.maxWindowMinutes !== undefined && end.getTime() - start.getTime() > options.maxWindowMinutes * 60_000) {
    return null;
  }
  const expand = normalizeSlackChannelHistoryExpandMinutes(expandMinutes);
  return {
    start: toIso(new Date(start.getTime() - expand * 60_000)),
    end: toIso(new Date(end.getTime() + expand * 60_000)),
    expandMinutes: expand,
  };
}

function afterExclusiveForInclusiveStart(startIso: string): string {
  const start = parseDate(startIso);
  if (!start) return startIso;
  return toIso(new Date(start.getTime() - 1));
}

function toDrillAnchor(row: SliceAnchorRow): DrillAnchor {
  return {
    sliceId: row.id,
    conversationId: row.conversation_id,
    channelId: row.channel_id,
    providerThreadId: row.provider_thread_id,
    firstMessageId: row.first_message_id,
    lastMessageId: row.last_message_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    rosterSnapshot: parseSlackRosterSnapshot(row.roster_snapshot),
    indexedFileId: row.indexed_file_id,
  };
}

/**
 * Authorization is the load-bearing part of this tool: a slice is readable
 * only when it is linked to a live (unarchived) indexed file whose
 * slack_channel access scope contains one of the caller's verified emails.
 * A thread filter or guessed slice id is never a substitute — every query
 * path below goes through this join.
 */
function authorizedSliceAnchorQuery(db: Kysely<DB>, userEmails: string[]) {
  return db
    .selectFrom("conversation_slices")
    .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
    .innerJoin("indexed_files", "indexed_files.id", "conversation_slices.indexed_file_id")
    .innerJoin("access_scopes", "access_scopes.id", "indexed_files.access_scope_id")
    .innerJoin("access_scope_members", "access_scope_members.access_scope_id", "access_scopes.id")
    .select([
      "conversation_slices.id",
      "conversation_slices.conversation_id",
      "conversation_slices.first_message_id",
      "conversation_slices.last_message_id",
      "conversation_slices.started_at",
      "conversation_slices.ended_at",
      "conversation_slices.roster_snapshot",
      "conversation_slices.indexed_file_id",
      "conversation_slices.provider_thread_id",
      "conversations.provider_conversation_id as channel_id",
    ])
    .where("conversations.platform", "=", "slack")
    .where("conversations.kind", "=", "channel")
    .where("indexed_files.source", "=", "slack")
    .where("indexed_files.is_archived", "=", 0)
    .where("indexed_files.share_with_everyone", "=", 0)
    .whereRef("indexed_files.provider_file_id", "=", "conversation_slices.id")
    .where("access_scopes.scope_type", "=", "slack_channel")
    .whereRef("access_scopes.provider_scope_id", "=", "conversations.provider_conversation_id")
    .where("access_scope_members.email", "in", userEmails);
}

async function loadAuthorizedSliceAnchor(
  db: Kysely<DB>,
  sliceId: string,
  userEmails: string[],
): Promise<DrillAnchor | null> {
  const row = await authorizedSliceAnchorQuery(db, userEmails)
    .where("conversation_slices.id", "=", sliceId)
    .limit(1)
    .executeTakeFirst();
  return row ? toDrillAnchor(row) : null;
}

function parseChannelRef(channelRef: string): number | null {
  const trimmed = channelRef.trim();
  const match = /^(?:conversation:|slack:\/\/conversation\/)?(\d+)$/iu.exec(trimmed);
  if (!match?.[1]) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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

interface ChannelWindowAuthorization {
  anchor: DrillAnchor;
  window: SlackChannelHistoryWindow;
  messageWindows: AuthorizedMessageWindow[];
}

async function loadChannelWindowAuthorization(
  db: Kysely<DB>,
  conversationId: number,
  userEmails: string[],
  window: SlackChannelHistoryWindow,
): Promise<ChannelWindowAuthorization | null> {
  const overlappingRows = await authorizedSliceAnchorQuery(db, userEmails)
    .where("conversation_slices.conversation_id", "=", conversationId)
    .where("conversation_slices.salience_verdict", "=", "kept")
    .where("conversation_slices.started_at", "<=", window.end)
    .where("conversation_slices.ended_at", ">=", window.start)
    .orderBy("conversation_slices.started_at", "asc")
    .orderBy("conversation_slices.id", "asc")
    .execute();

  if (overlappingRows.length === 0) return null;

  const requestedWindow = { start: window.start, end: window.end };
  const messageWindows = mergeMessageWindows(
    overlappingRows
      .map((row) => buildSlackChannelHistoryWindow(row.started_at, row.ended_at, window.expandMinutes))
      .filter((rowWindow): rowWindow is SlackChannelHistoryWindow => rowWindow !== null)
      .map((rowWindow) => intersectMessageWindow(requestedWindow, rowWindow))
      .filter((rowWindow): rowWindow is AuthorizedMessageWindow => rowWindow !== null),
  );

  if (messageWindows.length === 0) return null;

  const firstRow = overlappingRows[0];
  if (!firstRow) return null;
  const firstWindow = messageWindows[0];
  const lastWindow = messageWindows[messageWindows.length - 1];
  if (!firstWindow || !lastWindow) return null;
  return {
    anchor: toDrillAnchor(firstRow),
    window: { start: firstWindow.start, end: lastWindow.end, expandMinutes: window.expandMinutes },
    messageWindows,
  };
}

/**
 * Continuation tokens are intentionally unsigned, mirroring
 * WhatsAppGroupHistory: they carry only cursor position and request bounds,
 * authorization re-runs on every call, and decode rejects tokens that cross
 * conversation or window bounds.
 */
function encodePageToken(
  message: StoredConversationMessage,
  conversationId: number,
  window: SlackChannelHistoryWindow,
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
  window: SlackChannelHistoryWindow,
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

function parseAttachments(value: string | null): Attachment[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as Attachment[]) : [];
  } catch {
    return [];
  }
}

interface RawMessageRow {
  id: number;
  provider_message_id: string;
  sender_jid: string;
  sender_name: string;
  is_bot: number;
  text: string;
  attachments: string | null;
  provider_thread_id: string | null;
  is_thread_reply: number;
  provider_timestamp: string | null;
  received_at: string;
}

async function listRawMessagesInWindow(
  db: Kysely<DB>,
  anchor: DrillAnchor,
  window: SlackChannelHistoryWindow,
  messageWindows: AuthorizedMessageWindow[],
  limit: number,
  cursor: MessageCursor | null,
): Promise<{ messages: RawMessageRow[]; hasMore: boolean; nextPageToken?: string }> {
  let query = db
    .selectFrom("conversation_messages")
    .select([
      "id",
      "provider_message_id",
      "sender_jid",
      "sender_name",
      "is_bot",
      "text",
      "attachments",
      "provider_thread_id",
      "is_thread_reply",
      "provider_timestamp",
      "received_at",
    ])
    .where("conversation_id", "=", anchor.conversationId)
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

  /**
   * A thread slice scopes raw reads to its own thread (replies plus the root
   * message). Channel-stream slices read the top-level flow and thread roots
   * that fall inside the window, matching what the slice indexed.
   */
  if (anchor.providerThreadId) {
    const threadTs = anchor.providerThreadId;
    query = query.where((eb) =>
      eb.or([eb("provider_thread_id", "=", threadTs), eb("provider_message_id", "=", threadTs)]),
    );
  } else {
    query = query.where("is_thread_reply", "=", 0);
  }

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
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  return {
    messages: page,
    hasMore,
    nextPageToken:
      hasMore && last
        ? encodePageToken(
            { receivedAt: last.received_at, id: last.id } as StoredConversationMessage,
            anchor.conversationId,
            window,
          )
        : undefined,
  };
}

function sanitizeHistoryText(value: string): string {
  return value
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

export function renderSlackChannelHistoryMessages(
  roster: SlackRosterSnapshot | null,
  messages: RawMessageRow[],
): Array<Record<string, unknown>> {
  const displayNames = new Map(
    (roster?.participants ?? []).map((participant) => [participant.slackUserId, participant.displayName]),
  );
  return messages.map((message) => {
    const sender = displayNames.get(message.sender_jid) ?? message.sender_name;
    const text = sanitizeHistoryText(
      message.text.replace(MENTION_TOKEN_PATTERN, (_match, slackUserId: string) => {
        const name = displayNames.get(slackUserId);
        return name ? `@${name}` : "@unknown";
      }),
    );
    const attachments = parseAttachments(message.attachments).map(renderAttachmentPlaceholder);
    return {
      id: message.id,
      timestamp: message.provider_timestamp ?? message.received_at,
      sender: sanitizeHistoryText(sender) || "unknown",
      ...(message.is_thread_reply === 1 && message.provider_thread_id ? { threadTs: message.provider_thread_id } : {}),
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  });
}

function formatChannelRef(conversationId: number): string {
  return `conversation:${conversationId}`;
}

export async function handleSlackChannelHistory(
  args: SlackChannelHistoryArgs,
  deps: SketchMcpDeps,
): Promise<ToolResult> {
  if (!deps.db) return deniedResult();

  const userEmails = normalizeEmails(await resolveUserEmails(deps));
  if (userEmails.length === 0) return deniedResult();

  const limit = normalizeSlackChannelHistoryLimit(args.limit);

  let anchor: DrillAnchor | null = null;
  let window: SlackChannelHistoryWindow | null = null;
  let messageWindows: AuthorizedMessageWindow[] = [];

  if (args.sliceId) {
    anchor = await loadAuthorizedSliceAnchor(deps.db, args.sliceId, userEmails);
    if (!anchor) return deniedResult();
    window = buildSlackChannelHistoryWindow(anchor.startedAt, anchor.endedAt, args.expandMinutes);
    if (window) messageWindows = [{ start: window.start, end: window.end }];
  } else if (args.channelRef && args.startedAt && args.endedAt) {
    const conversationId = parseChannelRef(args.channelRef) ?? -1;
    window = buildSlackChannelHistoryWindow(args.startedAt, args.endedAt, args.expandMinutes, {
      maxWindowMinutes: MAX_SLACK_CHANNEL_HISTORY_WINDOW_MINUTES,
    });
    if (!window) return textResult(INVALID_INPUT_TEXT);
    const authorization = await loadChannelWindowAuthorization(deps.db, conversationId, userEmails, window);
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

  const result = await listRawMessagesInWindow(deps.db, anchor, window, messageWindows, limit, cursor);
  const payload = {
    channelRef: formatChannelRef(anchor.conversationId),
    anchor: {
      sliceId: anchor.sliceId,
      startedAt: anchor.startedAt,
      endedAt: anchor.endedAt,
      firstMessageId: anchor.firstMessageId,
      lastMessageId: anchor.lastMessageId,
      ...(anchor.providerThreadId ? { threadTs: anchor.providerThreadId } : {}),
    },
    window,
    messages: renderSlackChannelHistoryMessages(anchor.rosterSnapshot, result.messages),
    hasMore: result.hasMore,
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  };

  return textResult(JSON.stringify(payload, null, 2));
}

export function createSlackChannelHistoryTool(deps: SketchMcpDeps) {
  return tool(
    SLACK_CHANNEL_HISTORY_TOOL_NAME,
    "Read raw Slack channel messages around an indexed Slack slice, including adjacent messages that were dropped from indexing. Use this after Search finds a Slack slice and the user asks what exactly was said before, during, or after it. Requires sliceId, or channelRef with startedAt and endedAt from a prior SlackChannelHistory result. Thread slices return that thread's messages; channel slices return the top-level flow. Use pageToken as a continuation token for additional pages.",
    slackChannelHistorySchema,
    (args) => handleSlackChannelHistory(args, deps),
  );
}
