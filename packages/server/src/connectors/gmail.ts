import type { Logger } from "pino";
import { emailToSyncedItem } from "./email";
import { type EmailAddr, type NormalizedEmail, normalizeHeaderMap } from "./email";
import { shouldSuppressEmail } from "./email";
import { updateReciprocitySet } from "./email";
import { ensureValidToken } from "./google-drive";
import { runWithConcurrency } from "./sync-utils";
import type {
  AccessTokenProvider,
  Connector,
  ConnectorCredentials,
  OAuthCredentials,
  SuppressedEmailRecord,
} from "./types";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const DEFAULT_INITIAL_DAYS = 90;
const DEFAULT_MAX_MESSAGES = 500;
const DEFAULT_RECIPROCITY_DAYS = 365;
const DEFAULT_MAX_RECIPROCITY_SENT = 250;
const MESSAGE_FETCH_CONCURRENCY = 12;

type GmailTokenSource = string | AccessTokenProvider;

interface GmailMessageRef {
  id: string;
  threadId?: string;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePartBody {
  data?: string;
  attachmentId?: string;
}

export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

interface GmailHistoryRecord {
  messagesAdded?: Array<{ message?: GmailMessageRef }>;
  messagesDeleted?: Array<{ message?: GmailMessageRef }>;
}

type GmailCursor =
  | { mode?: "history"; historyId: string; reciprocityEmails?: string[] }
  | { mode: "list"; historyId: string; query: string; pageToken: string; reciprocityEmails?: string[] };

function assertOAuth(credentials: ConnectorCredentials): asserts credentials is OAuthCredentials {
  if (credentials.type !== "oauth") {
    throw new Error("Gmail connector requires OAuth credentials");
  }
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function parseCursor(cursor: string | null): GmailCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as Partial<GmailCursor>;
    if (!parsed.historyId) return null;
    if (parsed.mode === "list" && parsed.query && parsed.pageToken) {
      return {
        mode: "list",
        historyId: parsed.historyId,
        query: parsed.query,
        pageToken: parsed.pageToken,
        reciprocityEmails: parsed.reciprocityEmails,
      };
    }
    return {
      mode: "history",
      historyId: parsed.historyId,
      reciprocityEmails: parsed.reciprocityEmails,
    };
  } catch {
    return null;
  }
}

function serializeCursor(cursor: GmailCursor): string {
  return JSON.stringify(cursor);
}

function cursorReciprocity(cursor: GmailCursor | null): Set<string> {
  return new Set(cursor?.reciprocityEmails ?? []);
}

function withReciprocity<T extends GmailCursor>(cursor: T, reciprocity: ReadonlySet<string>): T {
  return { ...cursor, reciprocityEmails: [...reciprocity].slice(0, 5000) };
}

async function gmailRequest(
  path: string,
  accessToken: GmailTokenSource,
  opts?: { params?: Record<string, string | string[]> },
  attempt = 1,
  tokenRefreshed = false,
): Promise<unknown> {
  const url = new URL(`${GMAIL_API}${path}`);
  for (const [key, value] of Object.entries(opts?.params ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }

  let response: Response;
  try {
    const token =
      typeof accessToken === "string" ? accessToken : (await accessToken({ forceRefresh: tokenRefreshed })).accessToken;
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (attempt - 1)));
      return gmailRequest(path, accessToken, opts, attempt + 1, tokenRefreshed);
    }
    throw err;
  }

  if (response.status === 429 || response.status >= 500) {
    if (attempt < MAX_RETRIES) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : RETRY_BASE_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return gmailRequest(path, accessToken, opts, attempt + 1, tokenRefreshed);
    }
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401 && typeof accessToken !== "string" && !tokenRefreshed) {
      return gmailRequest(path, accessToken, opts, attempt, true);
    }
    throw new Error(`Gmail API ${path} failed (${response.status}): ${body}`);
  }

  return response.json();
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function headerMap(headers: GmailHeader[] | undefined): Map<string, string> {
  return normalizeHeaderMap((headers ?? []).map((header) => [header.name, header.value]));
}

function header(headers: ReadonlyMap<string, string>, key: string): string | null {
  return headers.get(key.toLowerCase()) ?? null;
}

function splitAddressList(value: string | null): EmailAddr[] {
  if (!value) return [];
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => parseAddress(part))
    .filter((addr): addr is EmailAddr => Boolean(addr));
}

function parseAddress(value: string): EmailAddr | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const bracket = trimmed.match(/^(.*?)<([^>]+)>$/);
  if (bracket) {
    const name = bracket[1]?.trim().replace(/^"|"$/g, "");
    return name ? { name, email: bracket[2].trim() } : { email: bracket[2].trim() };
  }
  const email = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (!email) return null;
  const name = trimmed.replace(email, "").trim().replace(/^"|"$/g, "");
  return name ? { name, email } : { email };
}

function collectBodyText(part: GmailMessagePart | undefined, mimeType: "text/plain" | "text/html"): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data && !part.body.attachmentId) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const text = collectBodyText(child, mimeType);
    if (text) return text;
  }
  return null;
}

function sentAtFromMessage(message: GmailMessage, headers: ReadonlyMap<string, string>): string | null {
  if (message.internalDate) return new Date(Number(message.internalDate)).toISOString();
  const date = header(headers, "date");
  if (!date) return null;
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function toNormalizedEmail(message: GmailMessage, ownerEmail: string | null): NormalizedEmail | null {
  if (!message.id || !message.payload) return null;
  const headers = headerMap(message.payload.headers);
  const from = splitAddressList(header(headers, "from"))[0];
  if (!from) return null;
  const providerMessageId = header(headers, "message-id") ?? `gmail:${message.id}`;
  const bodyText = collectBodyText(message.payload, "text/plain");
  const bodyHtml = collectBodyText(message.payload, "text/html");
  const labels = new Set(message.labelIds ?? []);
  if (labels.has("DRAFT") || labels.has("SPAM") || labels.has("TRASH")) return null;

  return {
    providerMessageId,
    providerFileId: message.id,
    threadId: message.threadId ?? null,
    subject: header(headers, "subject"),
    sentAt: sentAtFromMessage(message, headers),
    from,
    to: splitAddressList(header(headers, "to")),
    cc: splitAddressList(header(headers, "cc")),
    bcc: splitAddressList(header(headers, "bcc")),
    headers,
    bodyHtml,
    bodyText: bodyText ?? message.snippet ?? null,
    providerUrl: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
    ownerEmail,
    folder: labels.has("SENT") ? "sent" : "inbox",
  };
}

async function listMessageRefs(
  accessToken: GmailTokenSource,
  params: Record<string, string>,
  maxMessages: number,
): Promise<{ refs: GmailMessageRef[]; nextPageToken?: string }> {
  const refs: GmailMessageRef[] = [];
  let pageToken: string | undefined;
  do {
    const result = (await gmailRequest("/users/me/messages", accessToken, {
      params: {
        ...params,
        pageToken: pageToken ?? params.pageToken ?? "",
        maxResults: String(Math.min(100, maxMessages - refs.length)),
      },
    })) as { messages?: GmailMessageRef[]; nextPageToken?: string };
    refs.push(...(result.messages ?? []));
    pageToken = result.nextPageToken;
  } while (pageToken && refs.length < maxMessages);
  return { refs: refs.slice(0, maxMessages), nextPageToken: pageToken };
}

async function getMessage(
  accessToken: GmailTokenSource,
  id: string,
  opts: { format?: "full" | "metadata"; metadataHeaders?: string[] } = {},
): Promise<GmailMessage> {
  const format = opts.format ?? "full";
  return (await gmailRequest(`/users/me/messages/${id}`, accessToken, {
    params: {
      format,
      ...(opts.metadataHeaders ? { metadataHeaders: opts.metadataHeaders } : {}),
    },
  })) as GmailMessage;
}

async function getNormalizedMessages(
  accessToken: GmailTokenSource,
  refs: GmailMessageRef[],
  ownerEmail: string | null,
  logger: Logger,
  getMessageOpts?: { format?: "full" | "metadata"; metadataHeaders?: string[] },
): Promise<NormalizedEmail[]> {
  const uniqueRefs: GmailMessageRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    uniqueRefs.push(ref);
  }

  const messages: Array<NormalizedEmail | null> = new Array(uniqueRefs.length).fill(null);
  const fetchJobs = uniqueRefs.map((ref, index) => ({ ref, index }));
  await runWithConcurrency(fetchJobs, MESSAGE_FETCH_CONCURRENCY, async ({ ref, index }) => {
    try {
      messages[index] = toNormalizedEmail(await getMessage(accessToken, ref.id, getMessageOpts), ownerEmail);
    } catch (err) {
      logger.warn({ err, messageId: ref.id }, "Failed to fetch Gmail message");
    }
  });

  return messages.filter((message): message is NormalizedEmail => Boolean(message));
}

async function getProfileHistoryId(accessToken: GmailTokenSource): Promise<string | null> {
  const profile = (await gmailRequest("/users/me/profile", accessToken)) as { historyId?: string };
  return profile.historyId ?? null;
}

async function loadRecentSentMessages(
  accessToken: GmailTokenSource,
  ownerEmail: string | null,
  scopeConfig: Record<string, unknown>,
  logger: Logger,
): Promise<NormalizedEmail[]> {
  const days = parsePositiveInt(scopeConfig.reciprocityDays, DEFAULT_RECIPROCITY_DAYS, 3650);
  const maxMessages = parsePositiveInt(scopeConfig.maxReciprocitySent, DEFAULT_MAX_RECIPROCITY_SENT, 2000);
  const { refs, nextPageToken } = await listMessageRefs(accessToken, { q: `in:sent newer_than:${days}d` }, maxMessages);
  if (nextPageToken) {
    logger.warn(
      { maxMessages, days },
      "Gmail sent reciprocity bootstrap hit its per-run cap; continuing with partial reciprocity seed",
    );
  }
  return getNormalizedMessages(accessToken, refs, ownerEmail, logger, {
    format: "metadata",
    metadataHeaders: ["From", "To", "Cc", "Message-ID", "Subject", "Date"],
  });
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

async function* syncFullMailbox(
  connectorConfigId: string,
  accessToken: GmailTokenSource,
  scopeConfig: Record<string, unknown>,
  ownerEmail: string | null,
  logger: Logger,
  onEmailSuppressed: ((record: SuppressedEmailRecord) => Promise<void>) | undefined,
  historyId: string,
  baseReciprocity: ReadonlySet<string>,
  setNextCursor: (cursor: GmailCursor) => void,
  opts?: { query?: string; pageToken?: string; bootstrapReciprocity?: boolean },
) {
  const initialDays = parsePositiveInt(scopeConfig.initialDays, DEFAULT_INITIAL_DAYS, 3650);
  const maxMessages = parsePositiveInt(scopeConfig.maxMessages, DEFAULT_MAX_MESSAGES, 5000);
  const query =
    opts?.query ??
    (typeof scopeConfig.query === "string" && scopeConfig.query.trim()
      ? scopeConfig.query.trim()
      : `newer_than:${initialDays}d (in:inbox OR in:sent)`);
  const { refs, nextPageToken } = await listMessageRefs(
    accessToken,
    { q: query, pageToken: opts?.pageToken ?? "" },
    maxMessages,
  );
  const emails = await getNormalizedMessages(accessToken, refs, ownerEmail, logger);
  const recentSent = opts?.bootstrapReciprocity
    ? await loadRecentSentMessages(accessToken, ownerEmail, scopeConfig, logger)
    : [];
  const reciprocity = mergeReciprocity(baseReciprocity, emails, recentSent);

  if (nextPageToken) {
    logger.warn(
      { maxMessages, query },
      "Gmail initial sync hit its per-run cap; storing continuation cursor before advancing history",
    );
    setNextCursor(withReciprocity({ mode: "list", historyId, query, pageToken: nextPageToken }, reciprocity));
  } else {
    setNextCursor(withReciprocity({ mode: "history", historyId }, reciprocity));
  }

  yield* emitFilteredEmails(connectorConfigId, emails, reciprocity, onEmailSuppressed);
}

async function listHistoryMessageRefs(accessToken: GmailTokenSource, historyId: string): Promise<GmailMessageRef[]> {
  const refs: GmailMessageRef[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  do {
    const result = (await gmailRequest("/users/me/history", accessToken, {
      params: {
        startHistoryId: historyId,
        historyTypes: "messageAdded",
        pageToken: pageToken ?? "",
      },
    })) as { history?: GmailHistoryRecord[]; nextPageToken?: string };
    for (const history of result.history ?? []) {
      for (const added of history.messagesAdded ?? []) {
        if (!added.message?.id || seen.has(added.message.id)) continue;
        seen.add(added.message.id);
        refs.push(added.message);
      }
    }
    pageToken = result.nextPageToken;
  } while (pageToken);
  return refs;
}

async function* syncIncrementalMailbox(
  connectorConfigId: string,
  accessToken: GmailTokenSource,
  cursor: GmailCursor,
  scopeConfig: Record<string, unknown>,
  ownerEmail: string | null,
  logger: Logger,
  onEmailSuppressed: ((record: SuppressedEmailRecord) => Promise<void>) | undefined,
  fallbackHistoryId: string,
  setNextCursor: (cursor: GmailCursor) => void,
) {
  let refs: GmailMessageRef[];
  try {
    refs = await listHistoryMessageRefs(accessToken, cursor.historyId);
  } catch (err) {
    logger.warn({ err }, "Gmail history cursor expired; falling back to bounded full sync");
    yield* syncFullMailbox(
      connectorConfigId,
      accessToken,
      scopeConfig,
      ownerEmail,
      logger,
      onEmailSuppressed,
      fallbackHistoryId,
      cursorReciprocity(cursor),
      setNextCursor,
    );
    return null;
  }
  const emails = await getNormalizedMessages(accessToken, refs, ownerEmail, logger);
  const reciprocity = mergeReciprocity(cursorReciprocity(cursor), emails);
  yield* emitFilteredEmails(connectorConfigId, emails, reciprocity, onEmailSuppressed);
  return reciprocity;
}

export function createGmailConnector(): Connector {
  let nextCursor: GmailCursor | null = null;

  return {
    type: "gmail",
    perUserAuth: true,
    requiresOAuthClientSetup: true,
    emitsCorrespondentFacts: true,

    async validateCredentials(credentials) {
      assertOAuth(credentials);
      const valid = await ensureValidToken(credentials);
      await gmailRequest("/users/me/profile", valid.access_token);
    },

    async *sync({
      connectorConfigId = "gmail",
      credentials,
      scopeConfig,
      cursor,
      logger,
      ownerEmail,
      onEmailSuppressed,
      accessTokenProvider,
    }) {
      assertOAuth(credentials);
      const accessToken = accessTokenProvider ?? (await ensureValidToken(credentials)).access_token;
      const parsedCursor = parseCursor(cursor);
      nextCursor = null;

      if (parsedCursor?.mode === "list") {
        yield* syncFullMailbox(
          connectorConfigId,
          accessToken,
          scopeConfig,
          ownerEmail ?? null,
          logger,
          onEmailSuppressed,
          parsedCursor.historyId,
          cursorReciprocity(parsedCursor),
          (cursor) => {
            nextCursor = cursor;
          },
          { query: parsedCursor.query, pageToken: parsedCursor.pageToken },
        );
        return;
      }

      const startHistoryId = (await getProfileHistoryId(accessToken)) ?? parsedCursor?.historyId;
      if (!startHistoryId) {
        throw new Error("Gmail profile did not include historyId");
      }

      if (parsedCursor) {
        const reciprocity = yield* syncIncrementalMailbox(
          connectorConfigId,
          accessToken,
          parsedCursor,
          scopeConfig,
          ownerEmail ?? null,
          logger,
          onEmailSuppressed,
          startHistoryId,
          (cursor) => {
            nextCursor = cursor;
          },
        );
        if (reciprocity) {
          nextCursor = withReciprocity({ mode: "history", historyId: startHistoryId }, reciprocity);
        }
      } else {
        yield* syncFullMailbox(
          connectorConfigId,
          accessToken,
          scopeConfig,
          ownerEmail ?? null,
          logger,
          onEmailSuppressed,
          startHistoryId,
          new Set(),
          (cursor) => {
            nextCursor = cursor;
          },
          { bootstrapReciprocity: true },
        );
      }
    },

    async getCursor({ credentials, accessTokenProvider }) {
      assertOAuth(credentials);
      if (nextCursor) return serializeCursor(nextCursor);
      const accessToken = accessTokenProvider ?? (await ensureValidToken(credentials)).access_token;
      const historyId = await getProfileHistoryId(accessToken);
      return historyId ? serializeCursor({ mode: "history", historyId }) : null;
    },

    async refreshTokens(credentials) {
      const valid = await ensureValidToken(credentials);
      return valid.access_token !== credentials.access_token ? valid : null;
    },
  };
}
