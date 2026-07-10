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
import { chunk, runWithConcurrency } from "./sync-utils";
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
const BODY_PAGE_SIZE = 50;
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

interface FolderSyncResult {
  folder: EmailFolder;
  messages: OutlookMessage[];
  cursorLink: string | null;
  removedProviderFileIds: string[];
}

interface FolderStreamPlan {
  folder: EmailFolder;
  refs: string[];
}

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

/**
 * Address/metadata-only projection for the reciprocity pass. Excludes `body` and
 * `internetMessageHeaders` (the two large per-message payloads) so pass 1 can page
 * the whole corpus while holding only addresses, never bodies. Reciprocity itself
 * reads only SENT `to`/`cc`, but the fuller address set keeps normalization and the
 * missing-`internetMessageId` diagnostic identical to the body pass.
 */
const RECIPROCITY_SELECT = [
  "id",
  "internetMessageId",
  "conversationId",
  "sentDateTime",
  "receivedDateTime",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
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

async function getMessage(graph: GraphClient, id: string, select: string): Promise<OutlookMessage> {
  return graph.request<OutlookMessage>(`/me/messages/${encodeURIComponent(id)}`, {
    params: { $select: select },
  });
}

/**
 * True when a page ref already carries the address/metadata projection inline, so
 * reciprocity needs no extra fetch. LIST pages and delta cursors established with
 * {@link RECIPROCITY_SELECT} include `internetMessageId`; legacy delta cursors were
 * established with only `id`+date, so the property is absent and the ref must be
 * enriched with a per-message metadata GET before it can seed reciprocity.
 */
function hasReciprocityFields(message: OutlookMessage): boolean {
  return "internetMessageId" in message;
}

async function fetchMetadataRef(graph: GraphClient, id: string, logger: Logger): Promise<OutlookMessage | null> {
  try {
    return await getMessage(graph, id, RECIPROCITY_SELECT);
  } catch (err) {
    logger.warn({ err, providerFileId: id }, "Failed to fetch Outlook message metadata");
    return null;
  }
}

function accumulateReciprocity(reciprocity: Set<string>, messages: NormalizedEmail[], ownerEmail: string | null): void {
  for (const email of updateReciprocitySet(messages, ownerEmail)) {
    reciprocity.add(email);
  }
}

/**
 * Pass 1: fold the capped corpus into the reciprocity set from addresses only.
 *
 * Suppression of inbound-only mail needs the complete reciprocity set before the
 * first item is emitted, so this runs to completion before the body pass. Peak
 * residency is the ref list plus one address-only page; bodies are never resident.
 * Each folder's normalized address stubs are folded into reciprocity (only SENT
 * `to`/`cc` actually contribute), and the ids that survive to a real message are
 * captured per folder so the body pass fetches exactly the same set the pre-refactor
 * path would have normalized. Messages missing `internetMessageId` are diagnosed and
 * excluded here — identical to the old single-fetch pass — so the body pass never
 * fetches them.
 */
async function collectReciprocity(
  graph: GraphClient,
  folderResults: FolderSyncResult[],
  ownerEmail: string | null,
  base: ReadonlySet<string>,
  logger: Logger,
  onEmailSuppressed: ((record: SuppressedEmailRecord) => Promise<void>) | undefined,
): Promise<{ reciprocity: Set<string>; plans: FolderStreamPlan[] }> {
  const reciprocity = new Set(base);
  const plans: FolderStreamPlan[] = [];
  for (const result of folderResults) {
    const metadata: NormalizedEmail[] = [];
    const refs: string[] = [];
    for (const ref of result.messages) {
      const stub = hasReciprocityFields(ref) ? ref : await fetchMetadataRef(graph, ref.id, logger);
      if (!stub) continue;
      if (!stub.internetMessageId?.trim()) {
        logger.warn(
          { providerFileId: stub.id, folder: result.folder },
          "Skipping Outlook message without internetMessageId",
        );
        await onEmailSuppressed?.({
          providerFileId: stub.id,
          providerMessageId: null,
          threadId: stub.conversationId ?? null,
          reason: "missing_internet_message_id",
        });
        continue;
      }
      const normalized = toNormalizedOutlookEmail(stub, ownerEmail, result.folder);
      if (!normalized) continue;
      metadata.push(normalized);
      refs.push(stub.id);
    }
    accumulateReciprocity(reciprocity, metadata, ownerEmail);
    plans.push({ folder: result.folder, refs });
  }
  return { reciprocity, plans };
}

async function fetchFullNormalized(
  graph: GraphClient,
  ids: string[],
  ownerEmail: string | null,
  folder: EmailFolder,
  maxInflight: number,
  logger: Logger,
): Promise<NormalizedEmail[]> {
  const normalized: Array<NormalizedEmail | null> = new Array(ids.length).fill(null);
  await runWithConcurrency(
    ids.map((id, index) => ({ id, index })),
    maxInflight,
    async ({ id, index }) => {
      try {
        const full = await getMessage(graph, id, MESSAGE_SELECT);
        normalized[index] = toNormalizedOutlookEmail(full, ownerEmail, folder);
      } catch (err) {
        logger.warn({ err, providerFileId: id, folder }, "Failed to fetch Outlook message");
      }
    },
  );
  return normalized.filter((message): message is NormalizedEmail => Boolean(message));
}

/**
 * Pass 2: fetch full bodies one page at a time and emit each normalized item.
 * Peak residency is a single page of full messages, never the whole corpus, which
 * is the memory fix — the pre-refactor path materialized every raw message plus
 * every normalized email before the first yield.
 */
async function* streamFolderItems(
  connectorConfigId: string,
  graph: GraphClient,
  plan: FolderStreamPlan,
  reciprocity: ReadonlySet<string>,
  ownerEmail: string | null,
  maxInflight: number,
  logger: Logger,
  onEmailSuppressed: ((record: SuppressedEmailRecord) => Promise<void>) | undefined,
): AsyncGenerator<ReturnType<typeof emailToSyncedItem>> {
  for (const page of chunk(plan.refs, BODY_PAGE_SIZE)) {
    const emails = await fetchFullNormalized(graph, page, ownerEmail, plan.folder, maxInflight, logger);
    yield* emitFilteredEmails(connectorConfigId, emails, reciprocity, onEmailSuppressed);
  }
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
              $select: RECIPROCITY_SELECT,
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
              $select: RECIPROCITY_SELECT,
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
): Promise<FolderSyncResult> {
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
      accessTokenProvider,
    }) {
      assertOAuth(credentials);
      const valid = accessTokenProvider
        ? credentials
        : await ensureValidMicrosoftToken(credentials, { scope: OUTLOOK_MICROSOFT_SCOPE });
      const graph = createMicrosoftGraphClient(valid, { scope: OUTLOOK_MICROSOFT_SCOPE, accessTokenProvider });
      const parsedCursor = parseCursor(cursor);
      const initialDays = parsePositiveInt(scopeConfig.initialDays, DEFAULT_INITIAL_DAYS, 3650);
      const maxMessages = parsePositiveInt(scopeConfig.maxMessages, DEFAULT_MAX_MESSAGES, 5000);
      const maxInflight = parsePositiveInt(scopeConfig.maxInflight, DEFAULT_MAX_INFLIGHT, 16);
      const windowStart = new Date(Date.now() - initialDays * 24 * 60 * 60 * 1000).toISOString();
      const since = parsedCursor?.lastSyncedAt ?? windowStart;
      await emitWindowShrinkRemoval(parsedCursor, windowStart, onSourceItemRemoved);
      nextCursor = null;

      const folderResults: FolderSyncResult[] = [];
      await runWithConcurrency(FOLDERS, Math.min(maxInflight, FOLDERS.length), async (folder) => {
        folderResults.push(await syncFolder(graph, folder, parsedCursor, since, maxMessages, logger));
      });
      folderResults.sort((a, b) => (a.folder === b.folder ? 0 : a.folder === "inbox" ? -1 : 1));

      for (const result of folderResults) {
        for (const providerFileId of result.removedProviderFileIds) {
          await onSourceItemRemoved?.({ providerFileId, reason: `outlook_${result.folder}_removed` });
        }
      }

      const { reciprocity, plans } = await collectReciprocity(
        graph,
        folderResults,
        ownerEmail ?? null,
        cursorReciprocity(parsedCursor),
        logger,
        onEmailSuppressed,
      );

      const cursorParts: Omit<OutlookCursor, "reciprocityEmails"> = {
        lastSyncedAt: new Date().toISOString(),
        syncWindowStart: windowStart,
        inboxDeltaLink:
          folderResults.find((result) => result.folder === "inbox")?.cursorLink ?? parsedCursor?.inboxDeltaLink,
        sentDeltaLink:
          folderResults.find((result) => result.folder === "sent")?.cursorLink ?? parsedCursor?.sentDeltaLink,
      };
      nextCursor = withReciprocity(cursorParts, reciprocity);

      for (const plan of plans) {
        yield* streamFolderItems(
          connectorConfigId,
          graph,
          plan,
          reciprocity,
          ownerEmail ?? null,
          maxInflight,
          logger,
          onEmailSuppressed,
        );
      }
    },

    async getCursor({ credentials, accessTokenProvider, currentCursor, logger }) {
      assertOAuth(credentials);
      if (nextCursor) return serializeCursor(nextCursor);

      const valid = accessTokenProvider
        ? credentials
        : await ensureValidMicrosoftToken(credentials, { scope: OUTLOOK_MICROSOFT_SCOPE });
      const graph = createMicrosoftGraphClient(valid, { scope: OUTLOOK_MICROSOFT_SCOPE, accessTokenProvider });
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
