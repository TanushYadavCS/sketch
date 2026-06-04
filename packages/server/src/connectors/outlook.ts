import type { Logger } from "pino";
import { emailToSyncedItem } from "./email";
import {
  type EmailAddr,
  type NormalizedEmail,
  normalizeEmailValue,
  normalizeHeaderMap,
  shouldSuppressEmail,
  updateReciprocitySet,
} from "./email";
import { runWithConcurrency } from "./sync-utils";
import type { Connector, ConnectorCredentials, OAuthCredentials, SuppressedEmailRecord } from "./types";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const DEFAULT_INITIAL_DAYS = 90;
const DEFAULT_MAX_MESSAGES = 500;
const DEFAULT_RECIPROCITY_DAYS = 365;
const DEFAULT_MAX_RECIPROCITY_SENT = 250;
const MESSAGE_FETCH_CONCURRENCY = 12;

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
}

interface OutlookListResponse<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

type OutlookCursor = { mode: "time"; since: string; reciprocityEmails?: string[] };

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
    const parsed = JSON.parse(cursor) as Partial<OutlookCursor>;
    if (parsed.mode !== "time" || !parsed.since) return null;
    return { mode: "time", since: parsed.since, reciprocityEmails: parsed.reciprocityEmails };
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
  return { ...cursor, reciprocityEmails: [...reciprocity].slice(0, 5000) };
}

function isTokenExpired(credentials: OAuthCredentials): boolean {
  if (!credentials.expires_at) return true;
  return new Date(credentials.expires_at).getTime() < Date.now() + 60_000;
}

async function refreshOAuthToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      scope: "offline_access User.Read Mail.Read",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Microsoft token refresh failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type?: string;
  };

  return {
    ...credentials,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? credentials.refresh_token,
    token_type: data.token_type ?? credentials.token_type,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

async function ensureValidMicrosoftToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return isTokenExpired(credentials) ? refreshOAuthToken(credentials) : credentials;
}

async function graphRequest(
  pathOrUrl: string,
  accessToken: string,
  opts?: { params?: Record<string, string> },
  attempt = 1,
): Promise<unknown> {
  const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : new URL(`${GRAPH_API}${pathOrUrl}`);
  for (const [key, value] of Object.entries(opts?.params ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (attempt - 1)));
      return graphRequest(pathOrUrl, accessToken, opts, attempt + 1);
    }
    throw err;
  }

  if (response.status === 429 || response.status >= 500) {
    if (attempt < MAX_RETRIES) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : RETRY_BASE_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return graphRequest(pathOrUrl, accessToken, opts, attempt + 1);
    }
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Microsoft Graph ${url.pathname} failed (${response.status}): ${body}`);
  }

  return response.json();
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

function fallbackMessageId(message: OutlookMessage): string {
  return `outlook:${message.id}`;
}

export function toNormalizedOutlookEmail(message: OutlookMessage, ownerEmail: string | null): NormalizedEmail | null {
  if (!message.id) return null;
  const from = toEmailAddr(message.from) ?? toEmailAddr(message.sender);
  if (!from) return null;

  const bodyType = message.body?.contentType?.toLowerCase();
  const bodyContent = message.body?.content ?? null;
  const headers = normalizeHeaderMap(
    (message.internetMessageHeaders ?? []).map((header) => [header.name ?? "", header.value ?? ""]),
  );
  const owner = normalizeEmailValue(ownerEmail);
  const fromOwner = Boolean(owner && normalizeEmailValue(from.email) === owner);

  return {
    providerMessageId: message.internetMessageId?.trim() || fallbackMessageId(message),
    providerFileId: message.id,
    threadId: message.conversationId ?? null,
    subject: message.subject ?? null,
    sentAt: normalizeDate(message.sentDateTime ?? message.receivedDateTime),
    from,
    to: toEmailAddrs(message.toRecipients),
    cc: toEmailAddrs(message.ccRecipients),
    bcc: toEmailAddrs(message.bccRecipients),
    headers,
    bodyHtml: bodyType === "html" ? bodyContent : null,
    bodyText: bodyType !== "html" ? (bodyContent ?? message.bodyPreview ?? null) : (message.bodyPreview ?? null),
    providerUrl: message.webLink ?? null,
    ownerEmail: owner,
    folder: fromOwner ? "sent" : "inbox",
  };
}

async function listMessages(
  accessToken: string,
  path: string,
  params: Record<string, string>,
  maxMessages: number,
): Promise<OutlookMessage[]> {
  const messages: OutlookMessage[] = [];
  let nextUrl: string | undefined;
  do {
    const result = (await graphRequest(
      nextUrl ?? path,
      accessToken,
      nextUrl ? undefined : { params },
    )) as OutlookListResponse<OutlookMessage>;
    messages.push(...(result.value ?? []));
    nextUrl = result["@odata.nextLink"];
  } while (nextUrl && messages.length < maxMessages);
  return messages.slice(0, maxMessages);
}

async function getMessage(accessToken: string, id: string): Promise<OutlookMessage> {
  const select = [
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
  return (await graphRequest(`/me/messages/${encodeURIComponent(id)}`, accessToken, {
    params: { $select: select },
  })) as OutlookMessage;
}

async function getNormalizedMessages(
  accessToken: string,
  messages: OutlookMessage[],
  ownerEmail: string | null,
  logger: Logger,
): Promise<NormalizedEmail[]> {
  const normalized: Array<NormalizedEmail | null> = new Array(messages.length).fill(null);
  await runWithConcurrency(
    messages.map((message, index) => ({ message, index })),
    MESSAGE_FETCH_CONCURRENCY,
    async ({ message, index }) => {
      try {
        const full =
          message.body && message.internetMessageHeaders ? message : await getMessage(accessToken, message.id);
        normalized[index] = toNormalizedOutlookEmail(full, ownerEmail);
      } catch (err) {
        logger.warn({ err, messageId: message.id }, "Failed to fetch Outlook message");
      }
    },
  );
  return normalized.filter((message): message is NormalizedEmail => Boolean(message));
}

async function loadRecentSentMessages(
  accessToken: string,
  ownerEmail: string | null,
  scopeConfig: Record<string, unknown>,
  logger: Logger,
): Promise<NormalizedEmail[]> {
  const days = parsePositiveInt(scopeConfig.reciprocityDays, DEFAULT_RECIPROCITY_DAYS, 3650);
  const maxMessages = parsePositiveInt(scopeConfig.maxReciprocitySent, DEFAULT_MAX_RECIPROCITY_SENT, 2000);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const messages = await listMessages(
    accessToken,
    "/me/mailFolders/sentitems/messages",
    {
      $top: String(Math.min(maxMessages, 100)),
      $orderby: "sentDateTime desc",
      $filter: `sentDateTime ge ${since}`,
      $select: "id,internetMessageId,conversationId,subject,sentDateTime,webLink,from,toRecipients,ccRecipients",
    },
    maxMessages,
  );
  return getNormalizedMessages(accessToken, messages, ownerEmail, logger);
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
  accessToken: string,
): Promise<{ id?: string; mail?: string | null; userPrincipalName?: string | null }> {
  return (await graphRequest("/me", accessToken, {
    params: { $select: "id,mail,userPrincipalName" },
  })) as { id?: string; mail?: string | null; userPrincipalName?: string | null };
}

export async function validateOutlookCredentials(credentials: ConnectorCredentials): Promise<void> {
  assertOAuth(credentials);
  const valid = await ensureValidMicrosoftToken(credentials);
  await getMe(valid.access_token);
}

export function createOutlookConnector(): Connector {
  let nextCursor: OutlookCursor | null = null;

  return {
    type: "outlook",
    perUserAuth: true,
    requiresOAuthClientSetup: false,
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
    }) {
      assertOAuth(credentials);
      const valid = await ensureValidMicrosoftToken(credentials);
      const parsedCursor = parseCursor(cursor);
      const initialDays = parsePositiveInt(scopeConfig.initialDays, DEFAULT_INITIAL_DAYS, 3650);
      const maxMessages = parsePositiveInt(scopeConfig.maxMessages, DEFAULT_MAX_MESSAGES, 5000);
      const since = parsedCursor?.since ?? new Date(Date.now() - initialDays * 24 * 60 * 60 * 1000).toISOString();
      const select = [
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
        "bodyPreview",
      ].join(",");
      const messages = await listMessages(
        valid.access_token,
        "/me/messages",
        {
          $top: String(Math.min(maxMessages, 100)),
          $orderby: "receivedDateTime desc",
          $filter: `receivedDateTime ge ${since}`,
          $select: select,
        },
        maxMessages,
      );
      const emails = await getNormalizedMessages(valid.access_token, messages, ownerEmail ?? null, logger);
      const recentSent = parsedCursor
        ? []
        : await loadRecentSentMessages(valid.access_token, ownerEmail ?? null, scopeConfig, logger);
      const reciprocity = mergeReciprocity(cursorReciprocity(parsedCursor), emails, recentSent);
      const maxSeen = emails
        .map((email) => email.sentAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      nextCursor = withReciprocity({ mode: "time", since: maxSeen ?? new Date().toISOString() }, reciprocity);

      yield* emitFilteredEmails(connectorConfigId, emails, reciprocity, onEmailSuppressed);
    },

    async getCursor() {
      return nextCursor ? serializeCursor(nextCursor) : null;
    },

    async refreshTokens(credentials) {
      return isTokenExpired(credentials) ? refreshOAuthToken(credentials) : null;
    },
  };
}
