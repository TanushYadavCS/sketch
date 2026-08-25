import type { AccessTokenProvider, OAuthCredentials } from "./types";

export const MICROSOFT_GRAPH_API = "https://graph.microsoft.com/v1.0";
export const MICROSOFT_AUTHORITY_BASE = "https://login.microsoftonline.com";

const DEFAULT_TENANT = "common";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1000;

export interface MicrosoftGraphRequestOptions {
  method?: string;
  params?: Record<string, string | string[] | undefined>;
  headers?: HeadersInit;
  body?: BodyInit | null;
  responseType?: "json" | "text" | "empty";
  scope?: string;
  tenant?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  accessTokenProvider?: AccessTokenProvider;
}

export interface MicrosoftGraphRequestResult<T> {
  data: T;
  credentials: OAuthCredentials;
}

export interface MicrosoftOAuthSettingsConfig {
  microsoft_oauth_client_id?: string | null;
  microsoft_oauth_client_secret?: string | null;
  microsoft_oauth_tenant?: string | null;
}

export interface MicrosoftOAuthFallbackConfig {
  clientId?: string | null;
  clientSecret?: string | null;
  tenant?: string | null;
}

export interface ResolvedMicrosoftOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  tenant: string;
  source: "settings" | "env";
}

export class MicrosoftGraphError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    super(`Microsoft Graph ${path} failed (${status}): ${body}`);
    this.name = "MicrosoftGraphError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export function microsoftTokenEndpoint(tenant = DEFAULT_TENANT): string {
  return `${MICROSOFT_AUTHORITY_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

export function microsoftAuthorizeEndpoint(tenant = DEFAULT_TENANT): string {
  return `${MICROSOFT_AUTHORITY_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
}

export function microsoftAdminConsentEndpoint(tenant: string): string {
  return `${MICROSOFT_AUTHORITY_BASE}/${encodeURIComponent(tenant)}/v2.0/adminconsent`;
}

export function resolveMicrosoftOAuthConfig(
  config: MicrosoftOAuthSettingsConfig | null,
  fallback: MicrosoftOAuthFallbackConfig,
): ResolvedMicrosoftOAuthConfig {
  const settingsClientId = trimOptional(config?.microsoft_oauth_client_id);
  const settingsClientSecret = trimOptional(config?.microsoft_oauth_client_secret);
  const settingsTenant = trimOptional(config?.microsoft_oauth_tenant);
  if (settingsClientId || settingsClientSecret) {
    return {
      clientId: settingsClientId,
      clientSecret: settingsClientSecret,
      tenant: settingsTenant ?? trimOptional(fallback.tenant) ?? DEFAULT_TENANT,
      source: "settings",
    };
  }

  return {
    clientId: trimOptional(fallback.clientId),
    clientSecret: trimOptional(fallback.clientSecret),
    tenant: settingsTenant ?? trimOptional(fallback.tenant) ?? DEFAULT_TENANT,
    source: "env",
  };
}

export function applyMicrosoftOAuthConfig(
  credentials: OAuthCredentials,
  config: Pick<ResolvedMicrosoftOAuthConfig, "clientId" | "clientSecret" | "tenant">,
): OAuthCredentials {
  if (!config.clientId || !config.clientSecret) return credentials;
  return {
    ...credentials,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    tenant: config.tenant,
  };
}

export function isMicrosoftTokenExpired(credentials: OAuthCredentials): boolean {
  if (!credentials.expires_at) return true;
  return new Date(credentials.expires_at).getTime() < Date.now() + 60_000;
}

async function requestMicrosoftTokens(
  credentials: OAuthCredentials,
  scope: string | undefined,
  opts: Pick<MicrosoftGraphRequestOptions, "fetchFn" | "tenant" | "timeoutMs">,
): Promise<OAuthCredentials> {
  const fetchImpl = opts.fetchFn ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh_token,
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
  });
  if (scope) body.set("scope", scope);

  const response = await fetchImpl(microsoftTokenEndpoint(opts.tenant ?? credentials.tenant ?? DEFAULT_TENANT), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Microsoft token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  return {
    ...credentials,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? credentials.refresh_token,
    token_type: data.token_type ?? credentials.token_type,
    scope: data.scope ?? scope,
    tenant: opts.tenant ?? credentials.tenant,
    expires_at: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
  };
}

/**
 * Entra refuses a refresh that asks for scopes beyond what the user consented
 * to. When a connector's requested scope list grows, every connector authorized
 * before that change would fail its next refresh and take the whole sync down
 * with it — not just the feature the new scope was for.
 *
 * So a widened request falls back to the grant already held. Everything covered
 * by the original consent keeps working, the new capability degrades on its own,
 * and reconnecting is what actually upgrades the grant.
 */
export async function refreshMicrosoftTokens(
  credentials: OAuthCredentials,
  opts: Pick<MicrosoftGraphRequestOptions, "fetchFn" | "scope" | "tenant" | "timeoutMs"> = {},
): Promise<OAuthCredentials> {
  const requestedScope = opts.scope ?? credentials.scope;
  try {
    return await requestMicrosoftTokens(credentials, requestedScope, opts);
  } catch (err) {
    const grantedScope = credentials.scope;
    if (!grantedScope || grantedScope === requestedScope) throw err;
    return requestMicrosoftTokens(credentials, grantedScope, opts);
  }
}

export async function ensureValidMicrosoftToken(
  credentials: OAuthCredentials,
  opts: Pick<MicrosoftGraphRequestOptions, "fetchFn" | "scope" | "tenant" | "timeoutMs"> = {},
): Promise<OAuthCredentials> {
  return isMicrosoftTokenExpired(credentials) ? refreshMicrosoftTokens(credentials, opts) : credentials;
}

export async function microsoftGraphRequest<T = unknown>(
  credentials: OAuthCredentials,
  pathOrUrl: string,
  opts: MicrosoftGraphRequestOptions = {},
): Promise<MicrosoftGraphRequestResult<T>> {
  if (opts.accessTokenProvider) {
    const token = await opts.accessTokenProvider();
    return microsoftGraphRequestAttempt<T>(
      {
        ...credentials,
        access_token: token.accessToken,
        expires_at: token.expiresAt,
      },
      pathOrUrl,
      opts,
      1,
    );
  }
  const credentialsForAttempt = await ensureValidMicrosoftToken(credentials, opts);
  return microsoftGraphRequestAttempt<T>(credentialsForAttempt, pathOrUrl, opts, 1);
}

export function createMicrosoftGraphClient(
  credentials: OAuthCredentials,
  opts: Omit<MicrosoftGraphRequestOptions, "method" | "params" | "headers" | "body" | "responseType"> = {},
) {
  let currentCredentials = credentials;
  return {
    async request<T = unknown>(
      pathOrUrl: string,
      requestOpts?: Omit<
        MicrosoftGraphRequestOptions,
        "fetchFn" | "sleep" | "timeoutMs" | "maxRetries" | "retryBaseMs"
      >,
    ): Promise<T> {
      const result = await microsoftGraphRequest<T>(currentCredentials, pathOrUrl, { ...opts, ...(requestOpts ?? {}) });
      currentCredentials = result.credentials;
      return result.data;
    },
    credentials(): OAuthCredentials {
      return currentCredentials;
    },
  };
}

export function parseVttToTranscript(vtt: string): string {
  return parseVttCues(vtt)
    .map((cue) => (cue.speaker ? `${cue.speaker}: ${cue.text}` : cue.text))
    .join("\n")
    .trim();
}

export function extractVttSpeakers(vtt: string): string[] {
  const speakers = new Map<string, string>();
  for (const cue of parseVttCues(vtt)) {
    if (!cue.speaker) continue;
    const key = normalizeSpeakerKey(cue.speaker);
    if (key && !speakers.has(key)) speakers.set(key, cue.speaker);
  }
  return [...speakers.values()];
}

export interface ParsedVtt {
  /** Speaker-labeled transcript text, one cue per line. */
  transcript: string;
  /** Distinct speaker display names, in first-seen order. */
  speakers: string[];
}

/**
 * Parse a VTT transcript a single time and derive both the speaker-labeled
 * transcript text and the distinct speaker list from the same cue stream.
 *
 * Teams transcripts are multi-MB and parsing is fully synchronous, so deriving
 * both outputs from one {@link parseVttCues} pass (rather than calling
 * `parseVttToTranscript` and `extractVttSpeakers` separately) halves the CPU
 * this blocks the shared event loop with per meeting.
 */
export function parseVtt(vtt: string): ParsedVtt {
  const cues = parseVttCues(vtt);
  const transcript = cues
    .map((cue) => (cue.speaker ? `${cue.speaker}: ${cue.text}` : cue.text))
    .join("\n")
    .trim();
  const speakers = new Map<string, string>();
  for (const cue of cues) {
    if (!cue.speaker) continue;
    const key = normalizeSpeakerKey(cue.speaker);
    if (key && !speakers.has(key)) speakers.set(key, cue.speaker);
  }
  return { transcript, speakers: [...speakers.values()] };
}

function parseVttCues(vtt: string): Array<{ speaker?: string; text: string }> {
  const blocks = vtt
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/);
  const cues: Array<{ speaker?: string; text: string }> = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0 || lines[0]?.toUpperCase().startsWith("WEBVTT")) continue;
    if (lines[0]?.startsWith("NOTE") || lines[0] === "STYLE" || lines[0] === "REGION") continue;

    const textLines = lines.filter((line) => !line.includes("-->") && !/^\d+$/.test(line));
    if (textLines.length === 0) continue;

    let speaker: string | undefined;
    const parts: string[] = [];
    for (const rawLine of textLines) {
      const voice = rawLine.match(/<v(?:\.[^ >]+)?\s+([^>]+)>(.*)/i);
      const line = voice ? voice[2] : rawLine;
      if (voice?.[1] && !speaker) speaker = cleanVttText(voice[1]);
      const text = cleanVttText(line);
      if (text) parts.push(text);
    }

    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) cues.push({ speaker, text });
  }

  return cues;
}

async function microsoftGraphRequestAttempt<T>(
  credentials: OAuthCredentials,
  pathOrUrl: string,
  opts: MicrosoftGraphRequestOptions,
  attempt: number,
  tokenRefreshed = false,
): Promise<MicrosoftGraphRequestResult<T>> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const fetchImpl = opts.fetchFn ?? fetch;
  const responseType = opts.responseType ?? "json";
  const url = graphUrl(pathOrUrl, opts.params);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: opts.method ?? "GET",
      headers: { ...headersToRecord(opts.headers), Authorization: `Bearer ${credentials.access_token}` },
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (attempt < maxRetries) {
      await sleepForAttempt(opts, attempt);
      return microsoftGraphRequestAttempt(credentials, pathOrUrl, opts, attempt + 1, tokenRefreshed);
    }
    throw err;
  }

  if (response.status === 401 && attempt < maxRetries) {
    if (opts.accessTokenProvider) {
      if (!tokenRefreshed) {
        const token = await opts.accessTokenProvider({ forceRefresh: true });
        return microsoftGraphRequestAttempt(
          {
            ...credentials,
            access_token: token.accessToken,
            expires_at: token.expiresAt,
          },
          pathOrUrl,
          opts,
          attempt + 1,
          true,
        );
      }
    } else {
      const refreshed = await refreshMicrosoftTokens(credentials, opts);
      return microsoftGraphRequestAttempt(refreshed, pathOrUrl, opts, attempt + 1, tokenRefreshed);
    }
  }

  if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
    await sleepForRetry(response, opts, attempt);
    return microsoftGraphRequestAttempt(credentials, pathOrUrl, opts, attempt + 1, tokenRefreshed);
  }

  if (!response.ok) {
    throw new MicrosoftGraphError(url.pathname, response.status, await response.text());
  }

  if (response.status === 204 || responseType === "empty") {
    return { data: undefined as T, credentials };
  }

  if (responseType === "text") {
    return { data: (await response.text()) as T, credentials };
  }

  return { data: (await response.json()) as T, credentials };
}

function graphUrl(pathOrUrl: string, params: MicrosoftGraphRequestOptions["params"]): URL {
  const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : new URL(`${MICROSOFT_GRAPH_API}${pathOrUrl}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

async function sleepForAttempt(opts: MicrosoftGraphRequestOptions, attempt: number): Promise<void> {
  await sleep(opts, (opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS) * 2 ** (attempt - 1));
}

async function sleepForRetry(response: Response, opts: MicrosoftGraphRequestOptions, attempt: number): Promise<void> {
  const retryAfter = retryAfterMs(response.headers.get("Retry-After"));
  await sleep(opts, retryAfter ?? (opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS) * 2 ** (attempt - 1));
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(value).getTime();
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

async function sleep(opts: MicrosoftGraphRequestOptions, ms: number): Promise<void> {
  if (ms <= 0) return;
  if (opts.sleep) {
    await opts.sleep(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanVttText(value: string): string {
  return decodeVttEntities(value)
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeVttEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeSpeakerKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
