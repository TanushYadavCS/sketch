import { createHash } from "node:crypto";
import {
  type Connector,
  type ConnectorCredentials,
  type NameResolver,
  type SyncedItem,
  toEmailPrincipals,
} from "./types";

const DEFAULT_API_BASE_URL = "https://otter.ai/forward/api/v1/";
const DEFAULT_WEB_BASE_URL = "https://otter.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 16_000;
const DEFAULT_SYNC_PAGE_SIZE = 50;
const MAX_SYNC_PAGE_SIZE = 200;

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type OtterSpeechSource = "owned" | "shared" | "all";

export interface OtterLoginCredentials {
  email: string;
  password: string;
}

export interface OtterClientOptions {
  credentials: OtterLoginCredentials;
  fetchFn?: FetchFn;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface OtterConnectorOptions {
  fetchFn?: FetchFn;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  pageSize?: number;
  source?: OtterSpeechSource;
}

export interface OtterLoginResponse extends Record<string, unknown> {
  userid?: string | number;
}

export interface OtterUserResponse extends Record<string, unknown> {}

export interface OtterSpeaker extends Record<string, unknown> {
  id?: string | number;
  speaker_id?: string | number;
  speaker_name?: string;
  name?: string;
}

export interface OtterTranscriptSegment extends Record<string, unknown> {
  speaker_id?: string | number;
  speaker_name?: string;
  speaker_model_label?: string;
  transcript?: string;
}

export interface OtterSpeechSummary extends Record<string, unknown> {
  otid?: string;
  speech_otid?: string;
  speech_id?: string;
  title?: string;
  summary?: unknown;
  created_at?: number;
  start_time?: number;
  end_time?: number;
  transcript_updated_at?: number;
  duration?: number;
  speakers?: OtterSpeaker[];
}

export interface OtterSpeechResponse extends Record<string, unknown> {
  speech?: OtterSpeechSummary;
  transcripts?: OtterTranscriptSegment[];
}

export interface OtterListSpeechesOptions {
  folder?: number | string;
  pageSize?: number;
  source?: OtterSpeechSource;
}

export interface OtterSearchOptions {
  query: string;
  size?: number;
  otid?: string;
}

export interface OtterSearchResponse extends Record<string, unknown> {
  hits?: unknown[];
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  basicAuth?: boolean;
}

export class OtterApiError extends Error {
  readonly bodySummary: string | null;

  constructor(
    message: string,
    readonly status: number | null,
    readonly path: string,
    body: unknown,
  ) {
    super(message);
    this.name = "OtterApiError";
    this.bodySummary = body === null ? null : summarizeBody(body);
  }
}

export class OtterClient {
  private readonly credentials: OtterLoginCredentials;
  private readonly fetchFn: FetchFn;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly cookies = new Map<string, string>();
  private userId: string | null = null;

  constructor(options: OtterClientOptions) {
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiBaseUrl = withTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  }

  getUserId() {
    return this.userId;
  }

  async login(): Promise<OtterLoginResponse> {
    const response = await this.request<OtterLoginResponse>("login", {
      query: { username: this.credentials.email },
      basicAuth: true,
    });
    const userId = extractUserId(response);
    if (userId) this.userId = userId;
    return response;
  }

  async getUser(): Promise<OtterUserResponse> {
    const response = await this.request<OtterUserResponse>("user");
    const userId = extractUserId(response);
    if (userId) this.userId = userId;
    return response;
  }

  async listSpeeches(options: OtterListSpeechesOptions = {}): Promise<OtterSpeechSummary[]> {
    const userId = await this.requireUserId();
    const response = await this.request<Record<string, unknown>>("speeches", {
      query: {
        userid: userId,
        folder: options.folder ?? 0,
        page_size: options.pageSize ?? 45,
        source: options.source ?? "owned",
      },
    });
    return extractSpeeches(response);
  }

  async getSpeech(otid: string): Promise<OtterSpeechResponse> {
    const userId = await this.requireUserId();
    return this.request<OtterSpeechResponse>("speech", {
      query: { userid: userId, otid },
    });
  }

  async search(options: OtterSearchOptions): Promise<OtterSearchResponse> {
    const query: Record<string, string | number> = { query: options.query, size: options.size ?? 50 };
    if (options.otid) query.otid = options.otid;
    return this.request<OtterSearchResponse>("advanced_search", { query });
  }

  private async requireUserId() {
    if (!this.userId) {
      const user = await this.getUser();
      const userId = extractUserId(user);
      if (!userId) {
        throw new OtterApiError("Otter login succeeded but did not return a usable user id.", null, "user", user);
      }
      this.userId = userId;
    }
    return this.userId;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const url = buildUrl(this.apiBaseUrl, path, options.query);
        const headers: Record<string, string> = { Accept: "application/json" };
        if (options.basicAuth) headers.Authorization = basicAuthHeader(this.credentials);

        const cookieHeader = this.cookieHeader();
        if (cookieHeader) headers.Cookie = cookieHeader;

        const response = await this.fetchFn(url, {
          method: "GET",
          headers,
          signal: this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined,
        });

        this.storeCookies(response);

        if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
          await sleep(this.retryDelayMs(response, attempt));
          continue;
        }

        const body = await readResponseBody(response);
        if (!response.ok) {
          throw new OtterApiError(formatHttpErrorMessage(response.status, path, body), response.status, path, body);
        }

        return body as T;
      } catch (err) {
        if (err instanceof OtterApiError) throw err;
        lastError = err;
        if (attempt < this.maxRetries) {
          await sleep(this.retryDelayMs(null, attempt));
        }
      }
    }

    throw new OtterApiError(`Otter network error at ${path}: ${errorMessage(lastError)}`, null, path, null);
  }

  private retryDelayMs(response: Response | null, attempt: number) {
    const retryAfter = response?.headers.get("Retry-After");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), this.retryMaxMs);

      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) return Math.min(Math.max(retryAt - Date.now(), 0), this.retryMaxMs);
    }

    return Math.min(this.retryBaseMs * 2 ** attempt, this.retryMaxMs);
  }

  private storeCookies(response: Response) {
    for (const cookie of getSetCookieHeaders(response.headers)) {
      const pair = cookie.split(";")[0]?.trim();
      if (!pair) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  private cookieHeader() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

export function createOtterClient(options: OtterClientOptions) {
  return new OtterClient(options);
}

export function createOtterConnector(options: OtterConnectorOptions = {}): Connector {
  return {
    type: "otter",
    perUserAuth: true,
    requiresOAuthClientSetup: false,

    async validateCredentials(credentials) {
      const client = createOtterClient({
        credentials: getOtterCredentials(credentials),
        fetchFn: options.fetchFn,
        apiBaseUrl: options.apiBaseUrl,
      });
      await client.login();
      await client.getUser();
    },

    async *sync({ credentials, scopeConfig, ownerEmail, logger, resolveNameToEmail }) {
      const loginCredentials = getOtterCredentials(credentials);
      const client = createOtterClient({
        credentials: loginCredentials,
        fetchFn: options.fetchFn,
        apiBaseUrl: options.apiBaseUrl,
      });
      await client.login();

      const source = parseSpeechSource(scopeConfig.source) ?? options.source ?? "all";
      const pageSize = parsePageSize(scopeConfig.pageSize) ?? options.pageSize ?? DEFAULT_SYNC_PAGE_SIZE;
      const speeches = await client.listSpeeches({ source, pageSize });
      const accessEmail = ownerEmail?.trim() || loginCredentials.email;

      for (const speech of speeches) {
        const otid = getOtterSpeechId(speech);
        if (!otid) continue;

        try {
          const speechResponse = await client.getSpeech(otid);
          yield otterSpeechToSyncedItem(speechResponse, {
            ownerEmail: accessEmail,
            webBaseUrl: options.webBaseUrl,
            resolveNameToEmail,
          });
        } catch (err) {
          logger.warn({ error: summarizeOtterError(err), otid }, "Otter transcript fetch failed");
        }
      }
    },

    async getCursor() {
      return new Date().toISOString();
    },
  };
}

export function buildOtterCredentialHint(credentials: ConnectorCredentials): string | null {
  try {
    return getOtterCredentials(credentials).email;
  } catch {
    return null;
  }
}

export function extractOtterSpeech(response: OtterSpeechResponse): OtterSpeechSummary {
  const responseRecord = asRecord(response);
  const data = asRecord(responseRecord?.data);
  const speech = asRecord(responseRecord?.speech) ?? asRecord(data?.speech) ?? responseRecord ?? {};
  return speech as OtterSpeechSummary;
}

export function extractOtterTranscriptSegments(response: OtterSpeechResponse): OtterTranscriptSegment[] {
  const responseRecord = asRecord(response);
  const data = asRecord(responseRecord?.data);
  const speech = extractOtterSpeech(response);
  const candidates = [speech.transcripts, responseRecord?.transcripts, data?.transcripts];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord) as OtterTranscriptSegment[];
  }
  return [];
}

export function getOtterSpeechId(speech: OtterSpeechSummary): string | null {
  return asStringId(speech.otid) ?? asStringId(speech.speech_otid) ?? asStringId(speech.speech_id);
}

export function getOtterSpeechTitle(speech: OtterSpeechSummary): string {
  return asNonEmptyString(speech.title) ?? "Untitled Otter transcript";
}

export function formatOtterSpeechContent(response: OtterSpeechResponse): string {
  const speech = extractOtterSpeech(response);
  const segments = extractOtterTranscriptSegments(response);
  const title = getOtterSpeechTitle(speech);
  const lines = [`# ${title}`, ""];
  const startedAt = unixTimestampToIso(speech.start_time ?? speech.created_at);
  const duration = formatDurationSeconds(speech.duration);

  if (startedAt) lines.push(`Date: ${startedAt}`);
  if (duration) lines.push(`Duration: ${duration}`);
  if (startedAt || duration) lines.push("");

  const summary = formatSummary(speech.summary);
  if (summary) lines.push("## Summary", summary, "");

  if (segments.length > 0) {
    const speakerNames = speakerNamesById(speech);
    lines.push("## Transcript", "");
    for (const segment of segments) {
      const text = asNonEmptyString(segment.transcript);
      if (!text) continue;
      lines.push(`${resolveSegmentSpeaker(segment, speakerNames)}: ${text}`, "");
    }
  }

  return lines.join("\n").trimEnd();
}

export function otterSpeechToSyncedItem(
  response: OtterSpeechResponse,
  options: { ownerEmail?: string | null; webBaseUrl?: string; resolveNameToEmail?: NameResolver } = {},
): SyncedItem {
  const speech = extractOtterSpeech(response);
  const otid = getOtterSpeechId(speech);
  if (!otid) {
    throw new Error("Otter speech response did not include an otid");
  }

  const content = formatOtterSpeechContent(response);
  const title = getOtterSpeechTitle(speech);
  const createdAt = unixTimestampToIso(speech.created_at ?? speech.start_time);
  const updatedAt = unixTimestampToIso(speech.transcript_updated_at) ?? createdAt;
  const ownerEmail = normalizeEmail(options.ownerEmail);
  const attendeeNames = extractSpeakerNames(speech, extractOtterTranscriptSegments(response));
  const people = buildPeople(attendeeNames, ownerEmail, options.resolveNameToEmail);

  return {
    providerFileId: otid,
    providerUrl: `${(options.webBaseUrl ?? DEFAULT_WEB_BASE_URL).replace(/\/+$/, "")}/u/${otid}`,
    fileName: title,
    fileType: "meeting_transcript",
    contentCategory: "document",
    content,
    sourcePath: "Otter.ai",
    contentHash: createHash("sha256").update(content).digest("hex"),
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: updatedAt,
    accessPrincipals: people.accessValues.length > 0 ? toEmailPrincipals(people.accessValues) : null,
    attendees: people.attendees.length > 0 ? people.attendees : undefined,
  };
}

function extractSpeeches(response: Record<string, unknown>): OtterSpeechSummary[] {
  const data = asRecord(response.data);
  const candidates = [response.speeches, data?.speeches];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord) as OtterSpeechSummary[];
  }
  return [];
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions["query"]) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function basicAuthHeader(credentials: OtterLoginCredentials) {
  return `Basic ${Buffer.from(`${credentials.email}:${credentials.password}`).toString("base64")}`;
}

function withTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summarizeBody(body: unknown) {
  const record = asRecord(body);
  if (record) {
    const summary: Record<string, unknown> = {};
    for (const key of ["status", "code", "message", "error"]) {
      if (record[key] !== undefined) summary[key] = record[key];
    }
    if (Object.keys(summary).length > 0) return JSON.stringify(summary);
    return `object with ${Object.keys(record).length} keys`;
  }

  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (!text) return "empty response body";
  if (text.trim().startsWith("<")) return "upstream returned HTML error page";
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function formatHttpErrorMessage(status: number, path: string, body: unknown) {
  if (status === 401 && path === "login") {
    return "Otter rejected this email/password. If the account uses Google or SSO sign-in, create or reset an Otter password in Otter and try again.";
  }
  if (status === 401) {
    return "Otter rejected the saved session. Update the Otter credentials and try again.";
  }
  if (status === 429) {
    return "Otter rate limited the connector. Try again in a few minutes.";
  }

  const upstreamMessage = extractProviderMessage(body);
  return upstreamMessage
    ? `Otter request failed (${status}) at ${path}: ${upstreamMessage}`
    : `Otter request failed (${status}) at ${path}`;
}

function extractProviderMessage(body: unknown) {
  const record = asRecord(body);
  return asNonEmptyString(record?.message) ?? asNonEmptyString(record?.error);
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function summarizeOtterError(err: unknown) {
  if (err instanceof OtterApiError) {
    return {
      name: err.name,
      message: err.message,
      status: err.status,
      path: err.path,
      bodySummary: err.bodySummary,
    };
  }
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSetCookieHeaders(headers: Headers) {
  const maybeUndiciHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof maybeUndiciHeaders.getSetCookie === "function") return maybeUndiciHeaders.getSetCookie();

  const header = headers.get("set-cookie");
  if (!header) return [];
  return header.split(/,(?=\s*[^;,]+=)/g).map((value) => value.trim());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(asRecord(value));
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringId(value: unknown): string | null {
  const stringValue = asNonEmptyString(value);
  if (stringValue) return stringValue;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function extractUserId(response: OtterLoginResponse): string | null {
  const record = asRecord(response);
  const data = asRecord(record?.data);
  const user = asRecord(record?.user) ?? asRecord(data?.user);
  return (
    asStringId(record?.userid) ??
    asStringId(record?.user_id) ??
    asStringId(record?.id) ??
    asStringId(data?.userid) ??
    asStringId(data?.user_id) ??
    asStringId(data?.id) ??
    asStringId(user?.userid) ??
    asStringId(user?.user_id) ??
    asStringId(user?.id)
  );
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unixTimestampToIso(value: unknown): string | null {
  const timestamp = numberValue(value);
  if (!timestamp || timestamp <= 0) return null;
  const milliseconds = timestamp > 100_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(milliseconds).toISOString();
}

function formatDurationSeconds(value: unknown): string | null {
  const seconds = numberValue(value);
  if (!seconds || seconds <= 0) return null;
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function formatSummary(summary: unknown): string | null {
  if (typeof summary === "string") return asNonEmptyString(summary);
  if (Array.isArray(summary)) {
    const lines = summary.map(asNonEmptyString).filter((value): value is string => Boolean(value));
    return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : null;
  }

  const record = asRecord(summary);
  if (!record) return null;

  const parts: string[] = [];
  for (const key of ["overview", "summary", "abstract_summary", "short_summary"]) {
    const value = formatSummary(record[key]);
    if (value) parts.push(value);
  }
  for (const key of ["action_items", "actionItems"]) {
    const value = formatSummary(record[key]);
    if (value) parts.push(`Action items:\n${value}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function speakerNamesById(speech: OtterSpeechSummary) {
  const result = new Map<string, string>();
  for (const speaker of Array.isArray(speech.speakers) ? speech.speakers : []) {
    const id = speaker.id ?? speaker.speaker_id;
    const name = asNonEmptyString(speaker.speaker_name) ?? asNonEmptyString(speaker.name);
    if (id !== undefined && id !== null && name) result.set(String(id), name);
  }
  return result;
}

function resolveSegmentSpeaker(segment: OtterTranscriptSegment, speakerNames: Map<string, string>) {
  const named = asNonEmptyString(segment.speaker_name);
  if (named) return named;

  if (segment.speaker_id !== undefined && segment.speaker_id !== null) {
    const speaker = speakerNames.get(String(segment.speaker_id));
    if (speaker) return speaker;
  }

  return asNonEmptyString(segment.speaker_model_label) ?? "Unknown";
}

function extractSpeakerNames(speech: OtterSpeechSummary, segments: OtterTranscriptSegment[]) {
  const names = new Set<string>();
  for (const speaker of Array.isArray(speech.speakers) ? speech.speakers : []) {
    const name = asNonEmptyString(speaker.speaker_name) ?? asNonEmptyString(speaker.name);
    if (name) names.add(name);
  }

  const speakerNames = speakerNamesById(speech);
  for (const segment of segments) {
    const name = resolveSegmentSpeaker(segment, speakerNames);
    if (name !== "Unknown") names.add(name);
  }

  return [...names];
}

function buildPeople(names: string[], ownerEmail: string | null, resolveNameToEmail: NameResolver | undefined) {
  const attendees: Array<{ name?: string; email?: string }> = [];
  const accessValues = new Set<string>();

  if (ownerEmail) accessValues.add(ownerEmail);

  for (const name of names) {
    const resolvedEmail =
      normalizeEmail(resolveNameToEmail?.(name)?.email) ?? normalizeEmail(name.includes("@") ? name : null);
    if (resolvedEmail) {
      attendees.push({ name, email: resolvedEmail });
      accessValues.add(resolvedEmail);
    } else {
      attendees.push({ name });
    }
  }

  return { attendees, accessValues: [...accessValues] };
}

function normalizeEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function getOtterCredentials(credentials: ConnectorCredentials): OtterLoginCredentials {
  if (credentials.type !== "api_key") {
    throw new Error("Otter requires email/password credentials");
  }

  const record = credentials as ConnectorCredentials & { email?: unknown; password?: unknown };
  const email = asNonEmptyString(record.email);
  const password = asNonEmptyString(record.password);
  if (!email || !password) {
    throw new Error(
      "Otter requires an Otter email and password. If this account uses Google or SSO sign-in, create or reset an Otter password in Otter and try again.",
    );
  }

  return { email, password };
}

function parseSpeechSource(value: unknown): OtterSpeechSource | null {
  if (value === "owned" || value === "shared" || value === "all") return value;
  return null;
}

function parsePageSize(value: unknown): number | null {
  const parsed = numberValue(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, MAX_SYNC_PAGE_SIZE);
}
