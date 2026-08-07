import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { normalizeEmailValue } from "./email";
import { MicrosoftGraphError, createMicrosoftGraphClient, ensureValidMicrosoftToken } from "./microsoft-graph";
import type {
  AccessTokenProvider,
  BrowseFlatItem,
  BrowseResult,
  Connector,
  ConnectorCredentials,
  OAuthCredentials,
  SourceItemRemovalRecord,
  SyncedItem,
} from "./types";

export const OUTLOOK_CALENDAR_MICROSOFT_SCOPE = "offline_access User.Read Calendars.Read";

const CALENDAR_PAGE_SIZE = 100;
const DEFAULT_INITIAL_DAYS = 365;
const DEFAULT_INITIAL_FUTURE_DAYS = 365;
const MAX_INITIAL_DAYS = 3650;
const FULL_WIPE_SOURCE_CREATED_BEFORE = "9999-12-31T23:59:59.999Z";
const CURSOR_VERSION = 1;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DELTA_WINDOW_REFRESH_FRACTION = 0.5;
const GRAPH_HEADERS = {
  Prefer: `odata.maxpagesize=${CALENDAR_PAGE_SIZE}, outlook.timezone=\"UTC\", outlook.body-content-type=\"text\", IdType=\"ImmutableId\"`,
};

export interface OutlookCalendarPerson {
  emailAddress?: {
    address?: string;
    name?: string;
  };
  status?: {
    response?: string;
    time?: string;
  };
  type?: string;
}

export interface OutlookCalendarListEntry {
  id: string;
  name?: string;
  isDefaultCalendar?: boolean;
  owner?: OutlookCalendarPerson;
  canViewPrivateItems?: boolean;
  canEdit?: boolean;
  isShared?: boolean;
  isSharedWithMe?: boolean;
}

interface OutlookCalendarDateTime {
  dateTime?: string;
  timeZone?: string;
}

export interface OutlookCalendarEvent {
  id: string;
  iCalUId?: string;
  subject?: string;
  body?: {
    content?: string;
    contentType?: string;
  };
  bodyPreview?: string;
  start?: OutlookCalendarDateTime;
  end?: OutlookCalendarDateTime;
  location?: {
    displayName?: string;
    locationUri?: string;
  };
  organizer?: OutlookCalendarPerson;
  attendees?: OutlookCalendarPerson[];
  webLink?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  seriesMasterId?: string;
  type?: string;
  responseStatus?: {
    response?: string;
    time?: string;
  };
  onlineMeeting?: {
    joinUrl?: string;
  };
  "@removed"?: {
    reason?: string;
  };
}

interface GraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface OutlookCalendarCursor {
  version: typeof CURSOR_VERSION;
  calendars: Record<string, string>;
  lastSyncedAt?: string;
}

interface ParsedCursorState {
  cursor: OutlookCalendarCursor | null;
  needsFullReset: boolean;
}

interface CalendarStreamOutcome {
  deltaLink: string | null;
  expired: boolean;
}

type EventPerson = { name?: string; email?: string };

function assertOAuth(credentials: ConnectorCredentials): asserts credentials is OAuthCredentials {
  if (credentials.type !== "oauth") {
    throw new Error("Outlook Calendar connector requires OAuth credentials");
  }
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), MAX_INITIAL_DAYS));
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
    : [];
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseCursor(cursor: string | null): ParsedCursorState {
  if (!cursor) return { cursor: null, needsFullReset: false };
  try {
    const parsed = JSON.parse(cursor) as Partial<OutlookCalendarCursor>;
    if (parsed.version !== CURSOR_VERSION || !parsed.calendars || typeof parsed.calendars !== "object") {
      return { cursor: null, needsFullReset: true };
    }
    const calendars: Record<string, string> = {};
    for (const [calendarId, deltaLink] of Object.entries(parsed.calendars)) {
      if (typeof deltaLink === "string" && deltaLink) calendars[calendarId] = deltaLink;
    }
    return {
      cursor: { version: CURSOR_VERSION, calendars, lastSyncedAt: parsed.lastSyncedAt },
      needsFullReset: false,
    };
  } catch {
    return { cursor: null, needsFullReset: true };
  }
}

function shouldRefreshDeltaWindow(cursor: OutlookCalendarCursor | null, scopeConfig: Record<string, unknown>): boolean {
  if (!cursor) return false;
  const lastSyncedAt = cursor.lastSyncedAt ? Date.parse(cursor.lastSyncedAt) : Number.NaN;
  if (!Number.isFinite(lastSyncedAt)) return true;

  const futureDays = parsePositiveInt(scopeConfig.initialFutureDays, DEFAULT_INITIAL_FUTURE_DAYS);
  const refreshAfterMs = Math.max(1, Math.floor(futureDays * DELTA_WINDOW_REFRESH_FRACTION)) * MILLISECONDS_PER_DAY;
  return Date.now() - lastSyncedAt >= refreshAfterMs;
}

function serializeCursor(cursor: OutlookCalendarCursor): string {
  return JSON.stringify(cursor);
}

function initialTime(scopeConfig: Record<string, unknown>, key: string, fallback: number, direction: -1 | 1): string {
  const days = parsePositiveInt(scopeConfig[key], fallback);
  return new Date(Date.now() + direction * days * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const withoutExcessFraction = value.replace(/\.(\d{3})\d+/, ".$1");
  const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(withoutExcessFraction)
    ? withoutExcessFraction
    : `${withoutExcessFraction}Z`;
  const parsed = new Date(withTimezone);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function eventDateToIso(value: OutlookCalendarDateTime | undefined): string | null {
  return normalizeTimestamp(value?.dateTime);
}

function eventDateLabel(value: OutlookCalendarDateTime | undefined): string | null {
  if (!value?.dateTime) return null;
  return value.timeZone ? `${value.dateTime} (${value.timeZone})` : value.dateTime;
}

function cleanPersonName(value: string | null | undefined): string | null {
  if (!value) return null;
  const name = value
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[<>()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
    .trim();
  if (!name || name.includes("@") || /^(?:none|n\/a|na)$/i.test(name) || name.length > 120) return null;
  return name;
}

function displayNameFromEmail(email: string | undefined): string | null {
  const localPart = email?.split("@")[0]?.trim();
  if (!localPart) return null;
  const words = localPart
    .replace(/[._+-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function personEmail(person: OutlookCalendarPerson | undefined): string | undefined {
  return normalizeEmailValue(person?.emailAddress?.address) ?? undefined;
}

function personName(person: OutlookCalendarPerson | undefined, email: string | undefined): string | undefined {
  return cleanPersonName(person?.emailAddress?.name) ?? displayNameFromEmail(email) ?? undefined;
}

function personLabel(person: OutlookCalendarPerson | undefined): string | null {
  const email = personEmail(person);
  const name = personName(person, email);
  if (name && email) return `${name} <${email}>`;
  return name ?? email ?? null;
}

function personKey(person: OutlookCalendarPerson): string | null {
  return personEmail(person) ?? cleanPersonName(person.emailAddress?.name)?.toLowerCase() ?? null;
}

function eventPeople(event: OutlookCalendarEvent): EventPerson[] {
  const people: EventPerson[] = [];
  const seen = new Set<string>();
  for (const person of [event.organizer, ...(event.attendees ?? [])]) {
    if (!person) continue;
    const key = personKey(person);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const email = personEmail(person);
    const name = personName(person, email);
    if (name || email) people.push({ ...(name ? { name } : {}), ...(email ? { email } : {}) });
  }
  return people;
}

function eventAccessEmails(
  event: OutlookCalendarEvent,
  calendar: OutlookCalendarListEntry,
  ownerEmail: string | null | undefined,
): string[] | null {
  const emails = new Set<string>();
  const owner = normalizeEmailValue(ownerEmail);
  if (owner) emails.add(owner);
  const calendarOwner = personEmail(calendar.owner);
  if (calendarOwner) emails.add(calendarOwner);
  for (const person of [event.organizer, ...(event.attendees ?? [])]) {
    const email = personEmail(person);
    if (email) emails.add(email);
  }
  return emails.size > 0 ? [...emails] : null;
}

function normalizeBody(event: OutlookCalendarEvent): string | null {
  const value = event.body?.content?.trim() || event.bodyPreview?.trim();
  if (!value) return null;
  const text = value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

function eventContent(event: OutlookCalendarEvent, calendar: OutlookCalendarListEntry): string {
  const title = event.subject?.trim() || "Untitled event";
  const calendarName = calendar.name?.trim() || "Untitled calendar";
  const start = eventDateLabel(event.start);
  const end = eventDateLabel(event.end);
  const organizer = personLabel(event.organizer);
  const attendees = (event.attendees ?? []).map(personLabel).filter((label): label is string => Boolean(label));
  const lines = [`# ${title}`, "", `Calendar: ${calendarName}`];

  if (start || end) lines.push(`When: ${[start, end].filter(Boolean).join(" - ")}`);
  if (event.location?.displayName?.trim()) lines.push(`Location: ${event.location.displayName.trim()}`);
  if (organizer) lines.push(`Organizer: ${organizer}`);
  if (attendees.length > 0) lines.push(`Attendees: ${attendees.join(", ")}`);
  if (event.onlineMeeting?.joinUrl) lines.push(`Conference: ${event.onlineMeeting.joinUrl}`);

  const body = normalizeBody(event);
  if (body) lines.push("", body);
  return lines.join("\n").trim();
}

export function providerFileIdForEvent(calendarId: string, eventId: string): string {
  return `${calendarId}:${eventId}`;
}

export function ownerDeclinedEvent(event: OutlookCalendarEvent): boolean {
  return event.responseStatus?.response?.toLowerCase() === "declined";
}

export function eventToSyncedItem(
  event: OutlookCalendarEvent,
  calendar: OutlookCalendarListEntry,
  ownerEmail: string | null | undefined,
): SyncedItem | null {
  if (!event.id || event.isCancelled || ownerDeclinedEvent(event)) return null;

  const content = eventContent(event, calendar);
  const people = eventPeople(event);
  const authorEmail = personEmail(event.organizer);
  const authorName = personName(event.organizer, authorEmail);
  const sourceCreatedAt = eventDateToIso(event.start) ?? normalizeTimestamp(event.createdDateTime);
  const sourceUpdatedAt = normalizeTimestamp(event.lastModifiedDateTime) ?? sourceCreatedAt;

  return {
    providerFileId: providerFileIdForEvent(calendar.id, event.id),
    threadId: event.iCalUId ?? event.id,
    providerUrl: event.webLink ?? null,
    fileName: event.subject?.trim() || "Untitled event",
    fileType: "calendar_event",
    contentCategory: "document",
    content,
    sourcePath: `Outlook Calendar / ${calendar.name?.trim() || "Untitled calendar"}`,
    contentHash: contentHash(content),
    sourceCreatedAt,
    sourceUpdatedAt,
    isAllDay: event.isAllDay === true,
    mimeType: "text/calendar",
    accessEmails: eventAccessEmails(event, calendar, ownerEmail),
    attendees: people.length > 0 ? people : undefined,
    authorEmail,
    authorName,
  };
}

function calendarBrowseResult(calendars: OutlookCalendarListEntry[]): BrowseResult {
  const items: BrowseFlatItem[] = calendars
    .map((calendar) => ({
      id: calendar.id,
      name: `${calendar.name?.trim() || calendar.id}${calendar.isDefaultCalendar ? " (default)" : ""}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { type: "flat", items };
}

function graphClient(credentials: OAuthCredentials, accessTokenProvider?: AccessTokenProvider) {
  return createMicrosoftGraphClient(credentials, {
    scope: OUTLOOK_CALENDAR_MICROSOFT_SCOPE,
    tenant: credentials.tenant,
    accessTokenProvider,
  });
}

async function listCalendars(client: ReturnType<typeof graphClient>): Promise<OutlookCalendarListEntry[]> {
  const calendars: OutlookCalendarListEntry[] = [];
  const seenLinks = new Set<string>();
  const params = {
    $select: "id,name,isDefaultCalendar,owner,canViewPrivateItems,canEdit,isShared,isSharedWithMe",
    $top: String(CALENDAR_PAGE_SIZE),
  };
  let nextLink: string | null = "/me/calendars";

  while (nextLink) {
    const requestUrl = nextLink;
    const response: GraphCollection<OutlookCalendarListEntry> = await client.request<
      GraphCollection<OutlookCalendarListEntry>
    >(requestUrl, {
      ...(requestUrl === "/me/calendars" ? { params } : {}),
      headers: GRAPH_HEADERS,
    });
    calendars.push(...(response.value ?? []).filter((calendar) => Boolean(calendar.id)));
    nextLink = response["@odata.nextLink"] ?? null;
    if (nextLink) {
      if (seenLinks.has(nextLink)) throw new Error(`Microsoft Calendar calendar page repeated link: ${nextLink}`);
      seenLinks.add(nextLink);
    }
  }

  return calendars;
}

async function* streamEventsForCalendar(params: {
  client: ReturnType<typeof graphClient>;
  calendar: OutlookCalendarListEntry;
  deltaLink: string | null;
  scopeConfig: Record<string, unknown>;
  ownerEmail: string | null | undefined;
  logger: Logger;
  onSourceItemRemoved?: (record: SourceItemRemovalRecord) => Promise<void>;
}): AsyncGenerator<SyncedItem, CalendarStreamOutcome> {
  const initialPath = `/me/calendars/${encodeURIComponent(params.calendar.id)}/calendarView/delta`;
  const initialParams = {
    startDateTime: initialTime(params.scopeConfig, "initialDays", DEFAULT_INITIAL_DAYS, -1),
    endDateTime: initialTime(params.scopeConfig, "initialFutureDays", DEFAULT_INITIAL_FUTURE_DAYS, 1),
  };
  const seenLinks = new Set<string>();
  let nextLink: string | null = params.deltaLink ?? initialPath;
  let deltaLink: string | null = null;
  let firstRequest = params.deltaLink === null;
  let sawEvents = false;

  while (nextLink) {
    let response: GraphCollection<OutlookCalendarEvent>;
    try {
      response = await params.client.request<GraphCollection<OutlookCalendarEvent>>(nextLink, {
        ...(firstRequest ? { params: initialParams } : {}),
        headers: GRAPH_HEADERS,
      });
    } catch (error) {
      if (params.deltaLink && error instanceof MicrosoftGraphError && (error.status === 400 || error.status === 410)) {
        params.logger.warn(
          { calendarId: params.calendar.id, status: error.status },
          "Microsoft Calendar delta link expired",
        );
        return { deltaLink: null, expired: true };
      }
      if (error instanceof MicrosoftGraphError && (error.status === 403 || error.status === 404)) {
        await params.onSourceItemRemoved?.({
          providerFileIdPrefix: `${params.calendar.id}:`,
          reason: "outlook_calendar_calendar_unreadable",
        });
        return { deltaLink: null, expired: false };
      }
      throw error;
    }

    for (const event of response.value ?? []) {
      if (!event.id) continue;
      sawEvents = true;
      const providerFileId = providerFileIdForEvent(params.calendar.id, event.id);
      if (event["@removed"] || event.isCancelled) {
        await params.onSourceItemRemoved?.({
          providerFileId,
          reason: event["@removed"] ? "outlook_calendar_event_deleted" : "outlook_calendar_event_cancelled",
        });
        continue;
      }
      if (ownerDeclinedEvent(event)) {
        await params.onSourceItemRemoved?.({ providerFileId, reason: "outlook_calendar_event_declined" });
        continue;
      }
      const item = eventToSyncedItem(event, params.calendar, params.ownerEmail);
      if (item) yield item;
    }

    if (response["@odata.deltaLink"]) deltaLink = response["@odata.deltaLink"];
    nextLink = response["@odata.nextLink"] ?? null;
    firstRequest = false;
    if (nextLink) {
      if (seenLinks.has(nextLink)) {
        throw new Error(`Microsoft Calendar event page repeated link for ${params.calendar.id}: ${nextLink}`);
      }
      seenLinks.add(nextLink);
    }
  }

  if (!deltaLink) {
    params.logger.warn({ calendarId: params.calendar.id }, "Microsoft Calendar response did not include a delta link");
  }
  if (params.deltaLink === null && !sawEvents) {
    await params.onSourceItemRemoved?.({
      providerFileIdPrefix: `${params.calendar.id}:`,
      reason: "outlook_calendar_empty_full_sync",
    });
  }
  return { deltaLink, expired: false };
}

export function createOutlookCalendarConnector(): Connector {
  let nextCursor: OutlookCalendarCursor | null = null;

  return {
    type: "outlook_calendar",
    perUserAuth: true,
    requiresOAuthClientSetup: false,

    async validateCredentials(credentials) {
      assertOAuth(credentials);
      await listCalendars(graphClient(credentials));
    },

    async *sync({ credentials, accessTokenProvider, scopeConfig, cursor, logger, ownerEmail, onSourceItemRemoved }) {
      assertOAuth(credentials);
      const client = graphClient(credentials, accessTokenProvider);
      const parsedCursor = parseCursor(cursor);
      const refreshDeltaWindow = shouldRefreshDeltaWindow(parsedCursor.cursor, scopeConfig);
      const cursorForSync = refreshDeltaWindow ? null : parsedCursor.cursor;
      const cursorTimestamp = parsedCursor.cursor?.lastSyncedAt;
      const deltaWindowTimestamp = !refreshDeltaWindow && cursorTimestamp ? cursorTimestamp : new Date().toISOString();
      const calendars = await listCalendars(client);
      const hasCalendarSelection = hasOwn(scopeConfig, "calendarIds");
      const selectedCalendarIds = new Set(parseStringArray(scopeConfig.calendarIds));
      const selectedCalendars = calendars.filter(
        (calendar) => !hasCalendarSelection || selectedCalendarIds.has(calendar.id),
      );
      const runCursor: OutlookCalendarCursor = {
        version: CURSOR_VERSION,
        calendars: {},
        lastSyncedAt: deltaWindowTimestamp,
      };
      nextCursor = null;

      if (parsedCursor.needsFullReset || refreshDeltaWindow) {
        await onSourceItemRemoved?.({
          sourceCreatedBefore: FULL_WIPE_SOURCE_CREATED_BEFORE,
          reason: parsedCursor.needsFullReset
            ? "outlook_calendar_cursor_reset"
            : "outlook_calendar_delta_window_refresh",
        });
      }

      const selectedIds = new Set(selectedCalendars.map((calendar) => calendar.id));
      for (const calendarId of Object.keys(cursorForSync?.calendars ?? {})) {
        if (!selectedIds.has(calendarId)) {
          await onSourceItemRemoved?.({
            providerFileIdPrefix: `${calendarId}:`,
            reason: "outlook_calendar_scope_removed",
          });
        }
      }

      let expired = false;
      for (const calendar of selectedCalendars) {
        const previousDeltaLink = cursorForSync?.calendars[calendar.id] ?? null;
        const outcome = yield* streamEventsForCalendar({
          client,
          calendar,
          deltaLink: previousDeltaLink,
          scopeConfig,
          ownerEmail,
          logger,
          onSourceItemRemoved,
        });
        if (outcome.expired) {
          expired = true;
          break;
        }
        if (outcome.deltaLink) runCursor.calendars[calendar.id] = outcome.deltaLink;
      }

      if (expired) {
        await onSourceItemRemoved?.({
          sourceCreatedBefore: FULL_WIPE_SOURCE_CREATED_BEFORE,
          reason: "outlook_calendar_delta_expired",
        });
        runCursor.calendars = {};
        for (const calendar of selectedCalendars) {
          const outcome = yield* streamEventsForCalendar({
            client,
            calendar,
            deltaLink: null,
            scopeConfig,
            ownerEmail,
            logger,
            onSourceItemRemoved,
          });
          if (outcome.deltaLink) runCursor.calendars[calendar.id] = outcome.deltaLink;
        }
        runCursor.lastSyncedAt = new Date().toISOString();
      }

      nextCursor = runCursor;
    },

    async getCursor({ currentCursor }) {
      return nextCursor ? serializeCursor(nextCursor) : currentCursor;
    },

    async refreshTokens(credentials) {
      const valid = await ensureValidMicrosoftToken(credentials, {
        scope: OUTLOOK_CALENDAR_MICROSOFT_SCOPE,
        tenant: credentials.tenant,
      });
      return valid.access_token !== credentials.access_token ? valid : null;
    },

    async browseExisting({ credentials, accessTokenProvider }) {
      assertOAuth(credentials);
      return calendarBrowseResult(await listCalendars(graphClient(credentials, accessTokenProvider)));
    },
  };
}
