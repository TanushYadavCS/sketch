import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { normalizeEmailValue } from "./email";
import { ensureValidToken } from "./google-drive";
import type { Connector, ConnectorCredentials, OAuthCredentials, SourceItemRemovalRecord, SyncedItem } from "./types";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const CALENDAR_PAGE_SIZE = 250;
const EVENTS_PAGE_SIZE = 2500;
const DEFAULT_INITIAL_DAYS = 365;
const FULL_WIPE_SOURCE_CREATED_BEFORE = "9999-12-31T23:59:59.999Z";

const CALENDAR_LIST_FIELDS = "nextPageToken,items(id,summary,primary,accessRole,hidden,deleted,timeZone)";
const EVENT_LIST_FIELDS =
  "nextPageToken,nextSyncToken,items(id,status,htmlLink,created,updated,summary,description,location,visibility,iCalUID,start(date,dateTime,timeZone),end(date,dateTime,timeZone),creator(id,email,displayName,self),organizer(id,email,displayName,self),attendees(email,displayName,self,organizer,responseStatus),hangoutLink,conferenceData(entryPoints(entryPointType,uri,label)))";

export interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: "none" | "freeBusyReader" | "reader" | "writer" | "owner";
  hidden?: boolean;
  deleted?: boolean;
  timeZone?: string;
}

interface GoogleCalendarEventDate {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleCalendarEventPerson {
  id?: string;
  email?: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
  responseStatus?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  visibility?: string;
  iCalUID?: string;
  start?: GoogleCalendarEventDate;
  end?: GoogleCalendarEventDate;
  creator?: GoogleCalendarEventPerson;
  organizer?: GoogleCalendarEventPerson;
  attendees?: GoogleCalendarEventPerson[];
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>;
  };
}

interface GoogleCalendarListResponse {
  nextPageToken?: string;
  items?: GoogleCalendarListEntry[];
}

interface GoogleCalendarEventsResponse {
  nextPageToken?: string;
  nextSyncToken?: string;
  items?: GoogleCalendarEvent[];
}

interface GoogleCalendarCursor {
  calendars: Record<string, string>;
  lastSyncedAt?: string;
}

interface CalendarEventCollection {
  items: SyncedItem[];
  removals: SourceItemRemovalRecord[];
  nextSyncToken: string | null;
  expired: boolean;
}

interface CalendarSetCollection {
  items: SyncedItem[];
  removals: SourceItemRemovalRecord[];
  cursor: GoogleCalendarCursor;
  expired: boolean;
}

class GoogleCalendarApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    super(`Google Calendar API ${path} failed (${status}): ${body}`);
    this.name = "GoogleCalendarApiError";
    this.status = status;
    this.body = body;
  }
}

function assertOAuth(credentials: ConnectorCredentials): asserts credentials is OAuthCredentials {
  if (credentials.type !== "oauth") {
    throw new Error("Google Calendar connector requires OAuth credentials");
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return RETRY_BASE_MS * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function calendarRequest(
  path: string,
  accessToken: string,
  opts?: { params?: Record<string, string | undefined> },
  attempt = 1,
): Promise<unknown> {
  const url = new URL(`${CALENDAR_API}${path}`);
  for (const [key, value] of Object.entries(opts?.params ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      return calendarRequest(path, accessToken, opts, attempt + 1);
    }
    throw err;
  }

  if (response.status === 429 || response.status >= 500) {
    if (attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(response, attempt));
      return calendarRequest(path, accessToken, opts, attempt + 1);
    }
  }

  if (!response.ok) {
    throw new GoogleCalendarApiError(path, response.status, await response.text());
  }

  return response.json();
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function parseCursor(cursor: string | null): GoogleCalendarCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as Partial<GoogleCalendarCursor>;
    if (!parsed.calendars || typeof parsed.calendars !== "object") return null;
    const calendars: Record<string, string> = {};
    for (const [calendarId, syncToken] of Object.entries(parsed.calendars)) {
      if (typeof syncToken === "string" && syncToken) calendars[calendarId] = syncToken;
    }
    return { calendars, lastSyncedAt: parsed.lastSyncedAt };
  } catch {
    return null;
  }
}

function serializeCursor(cursor: GoogleCalendarCursor): string {
  return JSON.stringify(cursor);
}

function initialTimeMin(scopeConfig: Record<string, unknown>): string {
  const days = parsePositiveInt(scopeConfig.initialDays, DEFAULT_INITIAL_DAYS, 3650);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function eventDateToIso(value: GoogleCalendarEventDate | undefined): string | null {
  if (!value) return null;
  if (value.dateTime) return normalizeTimestamp(value.dateTime);
  if (value.date) return normalizeTimestamp(`${value.date}T00:00:00.000Z`);
  return null;
}

function eventDateLabel(value: GoogleCalendarEventDate | undefined): string | null {
  return value?.dateTime ?? value?.date ?? null;
}

function personLabel(person: GoogleCalendarEventPerson | undefined): string | null {
  if (!person) return null;
  const email = normalizeEmailValue(person.email);
  const name = person.displayName?.trim();
  if (name && email) return `${name} <${email}>`;
  return name || email;
}

function personKey(person: GoogleCalendarEventPerson): string | null {
  return normalizeEmailValue(person.email) ?? person.displayName?.trim().toLowerCase() ?? null;
}

function eventPeople(event: GoogleCalendarEvent): Array<{ name?: string; email?: string }> {
  const people: Array<{ name?: string; email?: string }> = [];
  const seen = new Set<string>();
  for (const person of [event.organizer, event.creator, ...(event.attendees ?? [])]) {
    if (!person) continue;
    const key = personKey(person);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const email = normalizeEmailValue(person.email) ?? undefined;
    const name = person.displayName?.trim();
    if (name || email) people.push({ ...(name ? { name } : {}), ...(email ? { email } : {}) });
  }
  return people;
}

function eventAccessEmails(event: GoogleCalendarEvent, ownerEmail: string | null | undefined): string[] | null {
  const emails = new Set<string>();
  const owner = normalizeEmailValue(ownerEmail);
  if (owner) emails.add(owner);

  if (event.visibility !== "private") {
    for (const person of [event.organizer, event.creator, ...(event.attendees ?? [])]) {
      const email = normalizeEmailValue(person?.email);
      if (email) emails.add(email);
    }
  }

  return emails.size > 0 ? [...emails] : null;
}

function conferenceUrl(event: GoogleCalendarEvent): string | null {
  if (event.hangoutLink) return event.hangoutLink;
  const video = event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video" && entry.uri);
  return video?.uri ?? event.conferenceData?.entryPoints?.find((entry) => entry.uri)?.uri ?? null;
}

function normalizeDescription(value: string | undefined): string | null {
  if (!value) return null;
  const text = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return text || null;
}

function eventContent(event: GoogleCalendarEvent, calendar: GoogleCalendarListEntry): string {
  const title = event.summary?.trim() || "Untitled event";
  const calendarName = calendar.summary?.trim() || "Untitled calendar";
  const start = eventDateLabel(event.start);
  const end = eventDateLabel(event.end);
  const organizer = personLabel(event.organizer);
  const attendeeLabels = (event.attendees ?? []).map(personLabel).filter((label): label is string => Boolean(label));
  const lines = [`# ${title}`, "", `Calendar: ${calendarName}`];

  if (start || end) lines.push(`When: ${[start, end].filter(Boolean).join(" - ")}`);
  if (event.location?.trim()) lines.push(`Location: ${event.location.trim()}`);
  if (organizer) lines.push(`Organizer: ${organizer}`);
  if (attendeeLabels.length > 0 && event.visibility !== "private") {
    lines.push(`Attendees: ${attendeeLabels.join(", ")}`);
  }

  const meetingUrl = conferenceUrl(event);
  if (meetingUrl) lines.push(`Conference: ${meetingUrl}`);

  const description = normalizeDescription(event.description);
  if (description) lines.push("", description);

  return lines.join("\n").trim();
}

export function providerFileIdForEvent(calendarId: string, eventId: string): string {
  return `${calendarId}:${eventId}`;
}

export function eventToSyncedItem(
  event: GoogleCalendarEvent,
  calendar: GoogleCalendarListEntry,
  ownerEmail: string | null | undefined,
): SyncedItem | null {
  if (!event.id || event.status === "cancelled") return null;

  const content = eventContent(event, calendar);
  const people = eventPeople(event);
  const privateEvent = event.visibility === "private";
  const author = event.creator ?? event.organizer;
  const sourceCreatedAt = eventDateToIso(event.start) ?? normalizeTimestamp(event.created);
  const sourceUpdatedAt = normalizeTimestamp(event.updated) ?? sourceCreatedAt;

  return {
    providerFileId: providerFileIdForEvent(calendar.id, event.id),
    threadId: event.iCalUID ?? undefined,
    providerUrl: event.htmlLink ?? null,
    fileName: event.summary?.trim() || "Untitled event",
    fileType: "calendar_event",
    contentCategory: "structured",
    content,
    sourcePath: `Google Calendar / ${calendar.summary?.trim() || "Untitled calendar"}`,
    contentHash: contentHash(content),
    sourceCreatedAt,
    sourceUpdatedAt,
    mimeType: "text/calendar",
    accessEmails: eventAccessEmails(event, ownerEmail),
    attendees: !privateEvent && people.length > 0 ? people : undefined,
    authorEmail: normalizeEmailValue(author?.email) ?? undefined,
    authorName: author?.displayName?.trim() || undefined,
    authorSourceId: author?.id,
  };
}

async function listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const calendars: GoogleCalendarListEntry[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  do {
    const result = (await calendarRequest("/users/me/calendarList", accessToken, {
      params: {
        maxResults: String(CALENDAR_PAGE_SIZE),
        minAccessRole: "reader",
        showDeleted: "false",
        showHidden: "false",
        fields: CALENDAR_LIST_FIELDS,
        pageToken,
      },
    })) as GoogleCalendarListResponse;

    calendars.push(
      ...(result.items ?? []).filter(
        (calendar) => calendar.id && !calendar.deleted && calendar.accessRole !== "freeBusyReader",
      ),
    );

    pageToken = result.nextPageToken;
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        throw new Error(`Google Calendar calendarList repeated page token: ${pageToken}`);
      }
      seenPageTokens.add(pageToken);
    }
  } while (pageToken);

  return calendars;
}

async function collectEventsForCalendar(params: {
  accessToken: string;
  calendar: GoogleCalendarListEntry;
  syncToken: string | null;
  scopeConfig: Record<string, unknown>;
  ownerEmail: string | null | undefined;
  logger: Logger;
}): Promise<CalendarEventCollection> {
  const items: SyncedItem[] = [];
  const removals: SourceItemRemovalRecord[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;

  do {
    const requestParams: Record<string, string | undefined> = {
      maxResults: String(EVENTS_PAGE_SIZE),
      singleEvents: "true",
      fields: EVENT_LIST_FIELDS,
      pageToken,
    };

    if (params.syncToken) {
      requestParams.syncToken = params.syncToken;
      requestParams.showDeleted = "true";
    } else {
      requestParams.timeMin = initialTimeMin(params.scopeConfig);
      requestParams.showDeleted = "false";
    }

    let result: GoogleCalendarEventsResponse;
    try {
      result = (await calendarRequest(
        `/calendars/${encodeURIComponent(params.calendar.id)}/events`,
        params.accessToken,
        { params: requestParams },
      )) as GoogleCalendarEventsResponse;
    } catch (err) {
      if (params.syncToken && err instanceof GoogleCalendarApiError && (err.status === 410 || err.status === 400)) {
        params.logger.warn({ calendarId: params.calendar.id, err }, "Google Calendar sync token expired");
        return { items: [], removals: [], nextSyncToken: null, expired: true };
      }
      if (err instanceof GoogleCalendarApiError && (err.status === 403 || err.status === 404)) {
        params.logger.warn(
          { calendarId: params.calendar.id, status: err.status },
          "Skipping unreadable Google Calendar",
        );
        return { items: [], removals: [], nextSyncToken: params.syncToken, expired: false };
      }
      throw err;
    }

    for (const event of result.items ?? []) {
      if (!event.id) continue;
      if (event.status === "cancelled") {
        removals.push({
          providerFileId: providerFileIdForEvent(params.calendar.id, event.id),
          reason: "google_calendar_event_cancelled",
        });
        continue;
      }

      const item = eventToSyncedItem(event, params.calendar, params.ownerEmail);
      if (item) items.push(item);
    }

    pageToken = result.nextPageToken;
    if (result.nextSyncToken) nextSyncToken = result.nextSyncToken;
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        throw new Error(`Google Calendar events repeated page token for ${params.calendar.id}: ${pageToken}`);
      }
      seenPageTokens.add(pageToken);
    }
  } while (pageToken);

  if (!nextSyncToken) {
    params.logger.warn({ calendarId: params.calendar.id }, "Google Calendar response did not include nextSyncToken");
  }

  return { items, removals, nextSyncToken: nextSyncToken ?? params.syncToken, expired: false };
}

async function collectCalendarSet(params: {
  accessToken: string;
  calendars: GoogleCalendarListEntry[];
  previousCursor: GoogleCalendarCursor | null;
  useSyncTokens: boolean;
  scopeConfig: Record<string, unknown>;
  ownerEmail: string | null | undefined;
  logger: Logger;
}): Promise<CalendarSetCollection> {
  const selectedCalendarIds = new Set(parseStringArray(params.scopeConfig.calendarIds));
  const items: SyncedItem[] = [];
  const removals: SourceItemRemovalRecord[] = [];
  const cursor: GoogleCalendarCursor = { calendars: {}, lastSyncedAt: new Date().toISOString() };

  for (const calendar of params.calendars) {
    if (selectedCalendarIds.size > 0 && !selectedCalendarIds.has(calendar.id)) continue;
    const syncToken = params.useSyncTokens ? (params.previousCursor?.calendars[calendar.id] ?? null) : null;
    const result = await collectEventsForCalendar({
      accessToken: params.accessToken,
      calendar,
      syncToken,
      scopeConfig: params.scopeConfig,
      ownerEmail: params.ownerEmail,
      logger: params.logger,
    });
    if (result.expired) return { items: [], removals: [], cursor, expired: true };
    items.push(...result.items);
    removals.push(...result.removals);
    if (result.nextSyncToken) cursor.calendars[calendar.id] = result.nextSyncToken;
  }

  return { items, removals, cursor, expired: false };
}

export function createGoogleCalendarConnector(): Connector {
  let nextCursor: GoogleCalendarCursor | null = null;

  return {
    type: "google_calendar",
    perUserAuth: true,
    requiresOAuthClientSetup: true,

    async validateCredentials(credentials) {
      assertOAuth(credentials);
      const valid = await ensureValidToken(credentials);
      await calendarRequest("/users/me/calendarList", valid.access_token, {
        params: { maxResults: "1", fields: "items(id)" },
      });
    },

    async *sync({ credentials, scopeConfig, cursor, logger, ownerEmail, onSourceItemRemoved }) {
      assertOAuth(credentials);
      const valid = await ensureValidToken(credentials);
      const calendars = await listCalendars(valid.access_token);
      const parsedCursor = parseCursor(cursor);
      nextCursor = null;

      let collection = await collectCalendarSet({
        accessToken: valid.access_token,
        calendars,
        previousCursor: parsedCursor,
        useSyncTokens: Boolean(parsedCursor),
        scopeConfig,
        ownerEmail,
        logger,
      });

      if (collection.expired) {
        await onSourceItemRemoved?.({
          sourceCreatedBefore: FULL_WIPE_SOURCE_CREATED_BEFORE,
          reason: "google_calendar_sync_token_expired",
        });
        collection = await collectCalendarSet({
          accessToken: valid.access_token,
          calendars,
          previousCursor: null,
          useSyncTokens: false,
          scopeConfig,
          ownerEmail,
          logger,
        });
      }

      for (const removal of collection.removals) {
        await onSourceItemRemoved?.(removal);
      }

      nextCursor = collection.cursor;
      for (const item of collection.items) {
        yield item;
      }
    },

    async getCursor({ currentCursor }) {
      if (nextCursor) return serializeCursor(nextCursor);
      return currentCursor;
    },

    async refreshTokens(credentials) {
      const valid = await ensureValidToken(credentials);
      return valid.access_token !== credentials.access_token ? valid : null;
    },
  };
}
