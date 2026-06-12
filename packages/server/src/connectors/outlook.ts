import type { Logger } from "pino";
import { emailToSyncedItem } from "./email";
import {
  type EmailAddr,
  type EmailFolder,
  type NormalizedEmail,
  normalizeEmailValue,
  normalizeHeaderMap,
  shouldSuppressEmail,
  updateReciprocitySet,
} from "./email";
import {
  MicrosoftGraphError,
  createMicrosoftGraphClient,
  ensureValidMicrosoftToken,
  isMicrosoftTokenExpired,
  refreshMicrosoftTokens,
} from "./microsoft-graph";
import { runWithConcurrency } from "./sync-utils";
import type {
  Connector,
  ConnectorCredentials,
  OAuthCredentials,
  SourceItemRemovalRecord,
  SuppressedEmailRecord,
} from "./types";

export const OUTLOOK_MICROSOFT_SCOPE = "offline_access User.Read Mail.Read";

const DEFAULT_INITIAL_DAYS = 365;
const DEFAULT_MAX_MESSAGES = 500;
const DEFAULT_MAX_INFLIGHT = 4;
const PAGE_SIZE = 50;
const RECIPROCITY_CURSOR_LIMIT = 5000;

type GraphClient = ReturnType<typeof createMicrosoftGraphClient>;

interface OutlookEmailAddress {
  name?: string | null;
  address?: string | null;
}

interface OutlookRecipient {
  emailAddress?: OutlookEmailAddress | null;
}

interface OutlookHeader {
  name?: string | null;
  value?: string | null;
}

export interface OutlookMessage {
  id: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  subject?: string | null;
  sentDateTime?: string | null;
  receivedDateTime?: string | null;
  webLink?: string | null;
  from?: OutlookRecipient | null;
  sender?: OutlookRecipient | null;
  toRecipients?: OutlookRecipient[];
  ccRecipients?: OutlookRecipient[];
  bccRecipients?: OutlookRecipient[];
  body?: { contentType?: string | null; content?: string | null } | null;
  bodyPreview?: string | null;
  internetMessageHeaders?: OutlookHeader[];
  "@removed"?: { reason?: string };
}

interface OutlookListResponse<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface OutlookCursor {
  inboxDeltaLink?: string;
  sentDeltaLink?: string;
  lastSyncedAt: string;
  syncWindowStart?: string;
  reciprocityEmails?: string[];
}

interface FolderConfig {
  key: EmailFolder;
  graphId: "inbox" | "sentitems";
  cursorKey: "inboxDeltaLink" | "sentDeltaLink";
  dateField: "receivedDateTime" | "sentDateTime";
}

const FOLDERS: FolderConfig[] = [
  { key: "inbox", graphId: "inbox", cursorKey: "inboxDeltaLink", dateField: "receivedDateTime" },
  { key: "sent", graphId: "sentitems", cursorKey: "sentDeltaLink", dateField: "sentDateTime" },
];

const MESSAGE_SELECT = [
  "id",
  "internetMessageId",
  "conversationId",
  "subject",
  "sentDateTime",
  "receivedDateTime",
  "webLink",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "body",
  "bodyPreview",
  "internetMessageHeaders",
].join(",");

function assertOAuth(credentials: ConnectorCredentials): asserts credentials is OAuthCredentials {
  if (credentials.type !== "oauth") {
    throw new Error("Outlook connector requires OAuth credentials");
  }
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function parseCursor(cursor: string | null): OutlookCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as Partial<OutlookCursor> & {
      mode?: string;
      since?: string;
    };
    if (parsed.mode === "time" && parsed.since) {
      return { lastSyncedAt: parsed.since, reciprocityEmails: parsed.reciprocityEmails };
    }
    if (!parsed.lastSyncedAt) return null;
    return {
      inboxDeltaLink: parsed.inboxDeltaLink,
      sentDeltaLink: parsed.sentDeltaLink,
      lastSyncedAt: parsed.lastSyncedAt,
      syncWindowStart: parsed.syncWindowStart,
      reciprocityEmails: parsed.reciprocityEmails,
    };
  } catch {
    return null;
  }
}

function serializeCursor(cursor: OutlookCursor): string {
  return JSON.stringify(cursor);
}

function cursorReciprocity(cursor: OutlookCursor | null): Set<string> {
  return new Set(cursor?.reciprocityEmails ?? []);
}

function withReciprocity(cursor: Omit<OutlookCursor, "reciprocityEmails">, reciprocity: ReadonlySet<string>) {
  return { ...cursor, reciprocityEmails: [...reciprocity].slice(0, RECIPROCITY_CURSOR_LIMIT) };
}

function toEmailAddr(recipient: OutlookRecipient | null | undefined): EmailAddr | null {
  const raw = recipient?.emailAddress;
  const email = normalizeEmailValue(raw?.address);
  if (!email) return null;
  const name = raw?.name?.trim();
  return name && name !== email ? { name, email } : { email };
}

function toEmailAddrs(recipients: OutlookRecipient[] | undefined): EmailAddr[] {
  return (recipients ?? [])
    .map((recipient) => toEmailAddr(recipient))
    .filter((addr): addr is EmailAddr => Boolean(addr));
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function folderMessageDate(message: OutlookMessage, folder: FolderConfig): string | null {
  return normalizeDate(message[folder.dateField]);
}

function compareFolderMessagesDesc(folder: FolderConfig, a: OutlookMessage, b: OutlookMessage): number {
  return (
    (new Date(folderMessageDate(b, folder) ?? 0).getTime() || 0) -
    (new Date(folderMessageDate(a, folder) ?? 0).getTime() || 0)
  );
}

function trimFolderMessages(folder: FolderConfig, messages: OutlookMessage[], maxMessages: number): OutlookMessage[] {
  return messages.sort((a, b) => compareFolderMessagesDesc(folder, a, b)).slice(0, maxMessages);
}

function mergeFolderMessages(
  folder: FolderConfig,
  listedMessages: OutlookMessage[],
  deltaMessages: OutlookMessage[],
  maxMessages: number,
): OutlookMessage[] {
  const byId = new Map<string, OutlookMessage>();
  for (const message of deltaMessages) {
    if (message.id) byId.set(message.id, message);
  }
  for (const message of listedMessages) {
    if (message.id) byId.set(message.id, message);
  }
  return trimFolderMessages(folder, [...byId.values()], maxMessages);
}

export function toNormalizedOutlookEmail(
  message: OutlookMessage,
  ownerEmail: string | null,
  folder: EmailFolder,
): NormalizedEmail | null {
  if (!message.id) return null;
  const providerMessageId = message.internetMessageId?.trim();
  if (!providerMessageId) return null;

  const from = toEmailAddr(message.from) ?? toEmailAddr(message.sender);
  if (!from) return null;

  const bodyType = message.body?.contentType?.toLowerCase();
  const bodyContent = message.body?.content ?? null;
  const headers = normalizeHeaderMap(
    (message.internetMessageHeaders ?? []).map((header) => [header.name ?? "", header.value ?? ""]),
  );

  return {
    providerMessageId,
    providerFileId: message.id,
    threadId: message.conversationId ?? null,
    subject: message.subject ?? null,
    sentAt: normalizeDate(
      folder === "sent"
        ? (message.sentDateTime ?? message.receivedDateTime)
        : (message.receivedDateTime ?? message.sentDateTime),
    ),
    from,
    to: toEmailAddrs(message.toRecipients),
    cc: toEmailAddrs(message.ccRecipients),
    bcc: toEmailAddrs(message.bccRecipients),
    headers,
    bodyHtml: bodyType === "html" ? bodyContent : null,
    bodyText: bodyType === "html" ? (message.bodyPreview ?? null) : (bodyContent ?? message.bodyPreview ?? null),
    providerUrl: message.webLink ?? null,
    ownerEmail: normalizeEmailValue(ownerEmail),
    folder,
  };
}

function hasFullMessageFields(message: OutlookMessage): boolean {
  return Boolean(message.body && message.internetMessageHeaders !== undefined);
}

async function getMessage(graph: GraphClient, id: string): Promise<OutlookMessage> {
  return graph.request<OutlookMessage>(`/me/messages/${encodeURIComponent(id)}`, {
    params: { $select: MESSAGE_SELECT },
  });
}

async function getNormalizedMessages(
  graph: GraphClient,
  messages: OutlookMessage[],
  ownerEmail: string | null,
  folder: EmailFolder,
  maxInflight: number,
  logger: Logger,
  onEmailSuppressed: ((record: SuppressedEmailRecord) => Promise<void>) | undefined,
): Promise<NormalizedEmail[]> {
  const normalized: Array<NormalizedEmail | null> = new Array(messages.length).fill(null);
  await runWithConcurrency(
    messages.map((message, index) => ({ message, index })),
    maxInflight,
    async ({ message, index }) => {
      try {
        const full = hasFullMessageFields(message) ? message : await getMessage(graph, message.id);
        if (!full.internetMessageId?.trim()) {
          logger.warn({ providerFileId: full.id, folder }, "Skipping Outlook message without internetMessageId");
          await onEmailSuppressed?.({
            providerFileId: full.id,
            providerMessageId: null,
            threadId: full.conversationId ?? null,
            reason: "missing_internet_message_id",
          });
          return;
        }
        normalized[index] = toNormalizedOutlookEmail(full, ownerEmail, folder);
      } catch (err) {
        logger.warn({ err, providerFileId: message.id, folder }, "Failed to fetch Outlook message");
      }
    },
  );
  return normalized.filter((message): message is NormalizedEmail => Boolean(message));
}

async function listFolderMessages(
  graph: GraphClient,
  folder: FolderConfig,
  since: string,
  maxMessages: number,
): Promise<OutlookMessage[]> {
  const messages: OutlookMessage[] = [];
  let nextUrl: string | undefined;
  do {
    const result = await graph.request<OutlookListResponse<OutlookMessage>>(
      nextUrl ?? `/me/mailFolders/${folder.graphId}/messages`,
      nextUrl
        ? undefined
        : {
            params: {
              $top: String(PAGE_SIZE),
              $filter: `${folder.dateField} ge ${since}`,
              $orderby: `${folder.dateField} desc`,
              $select: MESSAGE_SELECT,
            },
          },
    );
    messages.push(...(result.value ?? []));
    nextUrl = result["@odata.nextLink"];
  } while (nextUrl && messages.length < maxMessages);
  return messages.slice(0, maxMessages);
}

async function readFolderDelta(
  graph: GraphClient,
  folder: FolderConfig,
  deltaLink: string,
  maxMessages: number,
): Promise<{ messages: OutlookMessage[]; removedProviderFileIds: string[]; cursorLink: string | null }> {
  const messages: OutlookMessage[] = [];
  const removedProviderFileIds: string[] = [];
  let nextUrl: string | undefined = deltaLink;
  let cursorLink: string | null = null;

  while (nextUrl && messages.length < maxMessages) {
    const result: OutlookListResponse<OutlookMessage> =
      await graph.request<OutlookListResponse<OutlookMessage>>(nextUrl);
    for (const message of result.value ?? []) {
      if (message["@removed"]) {
        if (message.id) removedProviderFileIds.push(message.id);
      } else {
        messages.push(message);
      }
    }
    cursorLink = result["@odata.deltaLink"] ?? null;
    nextUrl = result["@odata.nextLink"];
  }

  return {
    messages: messages.slice(0, maxMessages),
    removedProviderFileIds,
    cursorLink: cursorLink ?? nextUrl ?? null,
  };
}

async function establishFolderDeltaState(
  graph: GraphClient,
  folder: FolderConfig,
  since: string,
  maxMessages: number,
): Promise<{ messages: OutlookMessage[]; cursorLink: string | null }> {
  const messages: OutlookMessage[] = [];
  let nextUrl: string | undefined;
  do {
    const result = await graph.request<OutlookListResponse<OutlookMessage>>(
      nextUrl ?? `/me/mailFolders/${folder.graphId}/messages/delta`,
      nextUrl
        ? undefined
        : {
            params: {
              $top: String(PAGE_SIZE),
              $select: `id,${folder.dateField}`,
            },
          },
    );
    for (const message of result.value ?? []) {
      if (message["@removed"]) continue;
      const messageDate = folderMessageDate(message, folder);
      if (!messageDate || messageDate < since) continue;
      messages.push(message);
      if (messages.length > maxMessages * 2) {
        messages.splice(0, messages.length, ...trimFolderMessages(folder, messages, maxMessages));
      }
    }
    if (result["@odata.deltaLink"]) {
      return { messages: trimFolderMessages(folder, messages, maxMessages), cursorLink: result["@odata.deltaLink"] };
    }
    nextUrl = result["@odata.nextLink"];
  } while (nextUrl);
  return { messages: trimFolderMessages(folder, messages, maxMessages), cursorLink: null };
}

async function establishFolderDeltaLink(graph: GraphClient, folder: FolderConfig): Promise<string | null> {
  const result = await establishFolderDeltaState(graph, folder, "0000-01-01T00:00:00.000Z", 0);
  return result.cursorLink;
}

async function syncFolder(
  graph: GraphClient,
  folder: FolderConfig,
  cursor: OutlookCursor | null,
  since: string,
  maxMessages: number,
  logger: Logger,
): Promise<{
  folder: EmailFolder;
  messages: OutlookMessage[];
  cursorLink: string | null;
  removedProviderFileIds: string[];
}> {
  const deltaLink = cursor?.[folder.cursorKey];
  if (deltaLink) {
    try {
      const result = await readFolderDelta(graph, folder, deltaLink, maxMessages);
      logRemovedMessages(folder.key, result.removedProviderFileIds, logger);
      return {
        folder: folder.key,
        messages: result.messages,
        cursorLink: result.cursorLink ?? deltaLink,
        removedProviderFileIds: result.removedProviderFileIds,
      };
    } catch (err) {
      if (!(err instanceof MicrosoftGraphError && err.status === 410)) throw err;
      logger.warn({ err, folder: folder.key }, "Outlook delta cursor expired; falling back to bounded folder sync");
    }
  }

  const listedMessages = await listFolderMessages(graph, folder, since, maxMessages);
  const deltaState = await establishFolderDeltaState(graph, folder, since, maxMessages);
  return {
    folder: folder.key,
    messages: mergeFolderMessages(folder, listedMessages, deltaState.messages, maxMessages),
    cursorLink: deltaState.cursorLink,
    removedProviderFileIds: [],
  };
}

function logRemovedMessages(folder: EmailFolder, providerFileIds: string[], logger: Logger): void {
  if (providerFileIds.length === 0) return;
  logger.info({ folder, providerFileIds, count: providerFileIds.length }, "Outlook removal events observed");
}

async function emitWindowShrinkRemoval(
  cursor: OutlookCursor | null,
  windowStart: string,
  onSourceItemRemoved: ((record: SourceItemRemovalRecord) => Promise<void>) | undefined,
): Promise<void> {
  if (!cursor?.syncWindowStart || new Date(windowStart).getTime() <= new Date(cursor.syncWindowStart).getTime()) {
    return;
  }
  await onSourceItemRemoved?.({ sourceCreatedBefore: windowStart, reason: "outlook_sync_window_shrunk" });
}

function mergeReciprocity(
  base: ReadonlySet<string>,
  emails: NormalizedEmail[],
  recentSent: NormalizedEmail[] = [],
): Set<string> {
  const reciprocity = new Set(base);
  const ownerEmail = emails[0]?.ownerEmail ?? recentSent[0]?.ownerEmail ?? null;
  for (const email of updateReciprocitySet([...recentSent, ...emails], ownerEmail)) {
    reciprocity.add(email);
  }
  return reciprocity;
}

async function* emitFilteredEmails(
  connectorConfigId: string,
  emails: NormalizedEmail[],
  reciprocity: ReadonlySet<string>,
  onEmailSuppressed: ((record: SuppressedEmailRecord) => Promise<void>) | undefined,
): AsyncGenerator<ReturnType<typeof emailToSyncedItem>> {
  for (const email of emails) {
    const decision = shouldSuppressEmail(email, reciprocity);
    if (decision.suppressed) {
      await onEmailSuppressed?.({
        providerFileId: email.providerFileId,
        providerMessageId: email.providerMessageId,
        threadId: email.threadId,
        reason: decision.reason,
      });
      continue;
    }
    yield emailToSyncedItem(connectorConfigId, email, decision.gate);
  }
}

async function getMe(
  graph: GraphClient,
): Promise<{ id?: string; mail?: string | null; userPrincipalName?: string | null }> {
  return graph.request<{ id?: string; mail?: string | null; userPrincipalName?: string | null }>("/me", {
    params: { $select: "id,mail,userPrincipalName" },
  });
}

export async function validateOutlookCredentials(credentials: ConnectorCredentials): Promise<void> {
  assertOAuth(credentials);
  const valid = await ensureValidMicrosoftToken(credentials, { scope: OUTLOOK_MICROSOFT_SCOPE });
  await getMe(createMicrosoftGraphClient(valid, { scope: OUTLOOK_MICROSOFT_SCOPE }));
}

export function createOutlookConnector(): Connector {
  let nextCursor: OutlookCursor | null = null;

  return {
    type: "outlook",
    perUserAuth: true,
    requiresOAuthClientSetup: false,
    promotableFileTypes: [],
    emitsCorrespondentFacts: true,

    validateCredentials: validateOutlookCredentials,

    async *sync({
      connectorConfigId = "outlook",
      credentials,
      scopeConfig,
      cursor,
      logger,
      ownerEmail,
      onEmailSuppressed,
      onSourceItemRemoved,
    }) {
      assertOAuth(credentials);
      const valid = await ensureValidMicrosoftToken(credentials, { scope: OUTLOOK_MICROSOFT_SCOPE });
      const graph = createMicrosoftGraphClient(valid, { scope: OUTLOOK_MICROSOFT_SCOPE });
      const parsedCursor = parseCursor(cursor);
      const initialDays = parsePositiveInt(scopeConfig.initialDays, DEFAULT_INITIAL_DAYS, 3650);
      const maxMessages = parsePositiveInt(scopeConfig.maxMessages, DEFAULT_MAX_MESSAGES, 5000);
      const maxInflight = parsePositiveInt(scopeConfig.maxInflight, DEFAULT_MAX_INFLIGHT, 16);
      const windowStart = new Date(Date.now() - initialDays * 24 * 60 * 60 * 1000).toISOString();
      const since = parsedCursor?.lastSyncedAt ?? windowStart;
      await emitWindowShrinkRemoval(parsedCursor, windowStart, onSourceItemRemoved);
      nextCursor = null;

      const folderResults: Array<{
        folder: EmailFolder;
        messages: OutlookMessage[];
        cursorLink: string | null;
        removedProviderFileIds: string[];
      }> = [];
      await runWithConcurrency(FOLDERS, Math.min(maxInflight, FOLDERS.length), async (folder) => {
        folderResults.push(await syncFolder(graph, folder, parsedCursor, since, maxMessages, logger));
      });
      folderResults.sort((a, b) => (a.folder === b.folder ? 0 : a.folder === "inbox" ? -1 : 1));

      for (const result of folderResults) {
        for (const providerFileId of result.removedProviderFileIds) {
          await onSourceItemRemoved?.({ providerFileId, reason: `outlook_${result.folder}_removed` });
        }
      }

      const emails: NormalizedEmail[] = [];
      for (const result of folderResults) {
        emails.push(
          ...(await getNormalizedMessages(
            graph,
            result.messages,
            ownerEmail ?? null,
            result.folder,
            maxInflight,
            logger,
            onEmailSuppressed,
          )),
        );
      }

      const reciprocity = mergeReciprocity(cursorReciprocity(parsedCursor), emails);
      const cursorParts: Omit<OutlookCursor, "reciprocityEmails"> = {
        lastSyncedAt: new Date().toISOString(),
        syncWindowStart: windowStart,
        inboxDeltaLink:
          folderResults.find((result) => result.folder === "inbox")?.cursorLink ?? parsedCursor?.inboxDeltaLink,
        sentDeltaLink:
          folderResults.find((result) => result.folder === "sent")?.cursorLink ?? parsedCursor?.sentDeltaLink,
      };
      nextCursor = withReciprocity(cursorParts, reciprocity);

      yield* emitFilteredEmails(connectorConfigId, emails, reciprocity, onEmailSuppressed);
    },

    async getCursor({ credentials, currentCursor, logger }) {
      assertOAuth(credentials);
      if (nextCursor) return serializeCursor(nextCursor);

      const valid = await ensureValidMicrosoftToken(credentials, { scope: OUTLOOK_MICROSOFT_SCOPE });
      const graph = createMicrosoftGraphClient(valid, { scope: OUTLOOK_MICROSOFT_SCOPE });
      const parsedCursor = parseCursor(currentCursor);
      const cursorParts: Omit<OutlookCursor, "reciprocityEmails"> = {
        lastSyncedAt: parsedCursor?.lastSyncedAt ?? new Date().toISOString(),
        syncWindowStart: parsedCursor?.syncWindowStart,
        inboxDeltaLink: parsedCursor?.inboxDeltaLink,
        sentDeltaLink: parsedCursor?.sentDeltaLink,
      };

      await runWithConcurrency(FOLDERS, FOLDERS.length, async (folder) => {
        if (cursorParts[folder.cursorKey]) return;
        try {
          cursorParts[folder.cursorKey] = (await establishFolderDeltaLink(graph, folder)) ?? undefined;
        } catch (err) {
          logger.warn({ err, folder: folder.key }, "Failed to establish Outlook delta cursor");
        }
      });

      return serializeCursor(withReciprocity(cursorParts, cursorReciprocity(parsedCursor)));
    },

    async refreshTokens(credentials) {
      return isMicrosoftTokenExpired(credentials)
        ? refreshMicrosoftTokens(credentials, { scope: OUTLOOK_MICROSOFT_SCOPE })
        : null;
    },
  };
}
