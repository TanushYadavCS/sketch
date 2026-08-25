import { createHash } from "node:crypto";
import type { Logger } from "pino";
import {
  MicrosoftGraphError,
  createMicrosoftGraphClient,
  ensureValidMicrosoftToken,
  isMicrosoftTokenExpired,
  parseVtt,
  refreshMicrosoftTokens,
} from "./microsoft-graph";
import { streamWithConcurrency } from "./sync-utils";
import {
  type Connector,
  type ConnectorCredentials,
  type OAuthCredentials,
  type SourceItemRemovalRecord,
  type SyncedItem,
  toEmailPrincipals,
} from "./types";

export const TEAMS_MICROSOFT_SCOPE =
  "offline_access User.Read Calendars.Read Chat.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All OnlineMeetingRecording.Read.All";

const DEFAULT_INITIAL_LOOKBACK_DAYS = 365;
const DEFAULT_MAX_INFLIGHT = 4;
/**
 * Per-run cap on the number of meetings fetched/parsed, mirroring Outlook's
 * `maxMessages`. Each meeting yields a multi-MB VTT transcript, so an uncapped
 * initial backfill of a 365-day window could buffer an unbounded corpus through
 * the single shared event loop. 500 matches Outlook's default and comfortably
 * covers a typical tenant's incremental window; the initial full sync keeps the
 * 500 most-recent meetings and recovers older ones only on a cursor reset.
 */
const DEFAULT_MAX_MEETINGS = 500;
const DEFAULT_PROCESSING_LAG_MS = 2 * 60 * 60 * 1000;
const DEFAULT_PENDING_TRANSCRIPT_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

interface TeamsEmailAddress {
  name?: string | null;
  address?: string | null;
}

interface TeamsEventAttendee {
  emailAddress?: TeamsEmailAddress | null;
}

export interface TeamsCalendarEvent {
  id: string;
  subject?: string | null;
  webLink?: string | null;
  isOnlineMeeting?: boolean | null;
  onlineMeetingProvider?: string | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  organizer?: { emailAddress?: TeamsEmailAddress | null } | null;
  attendees?: TeamsEventAttendee[];
  start?: { dateTime?: string | null; timeZone?: string | null } | null;
  end?: { dateTime?: string | null; timeZone?: string | null } | null;
  lastModifiedDateTime?: string | null;
}

export interface TeamsMeetingChat {
  id?: string | null;
  topic?: string | null;
  createdDateTime?: string | null;
  lastUpdatedDateTime?: string | null;
  onlineMeetingInfo?: { joinWebUrl?: string | null; calendarEventId?: string | null } | null;
}

interface TeamsOnlineMeeting {
  id: string;
  subject?: string | null;
  joinWebUrl?: string | null;
  participants?: {
    organizer?: TeamsIdentitySet | null;
    attendees?: TeamsIdentitySet[] | null;
  } | null;
}

interface TeamsIdentitySet {
  user?: {
    id?: string | null;
    displayName?: string | null;
    userPrincipalName?: string | null;
    mail?: string | null;
  } | null;
}

interface TeamsTranscript {
  id: string;
  createdDateTime?: string | null;
  meetingOrganizer?: TeamsIdentitySet | null;
}

interface TeamsRecording {
  id?: string | null;
  playbackUrl?: string | null;
  recordingContentUrl?: string | null;
  contentUrl?: string | null;
  webUrl?: string | null;
}

interface GraphListResponse<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

interface TeamsObservedMeeting {
  transcriptIds: string[];
  sourceCreatedAt?: string | null;
  observedAt?: string;
  /** Set when the meeting was discovered from a chat rather than the calendar. */
  origin?: "chat";
}

interface TeamsCursor {
  lastSyncedAt: string;
  syncWindowStart?: string;
  observedMeetings?: Record<string, TeamsObservedMeeting>;
}

interface TeamsConnectorOptions {
  initialLookbackDays?: number;
  maxInflight?: number;
  maxMeetings?: number;
  processingLagMs?: number;
  pendingTranscriptRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  retryBaseMs?: number;
}

type GraphClient = ReturnType<typeof createMicrosoftGraphClient>;

function assertOAuth(credentials: ConnectorCredentials): asserts credentials is OAuthCredentials {
  if (credentials.type !== "oauth") {
    throw new Error("Teams connector requires OAuth credentials");
  }
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function envPositiveInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return parsePositiveInt(parsed, fallback, max);
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseObservedMeetings(value: unknown): Record<string, TeamsObservedMeeting> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const observed: Record<string, TeamsObservedMeeting> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Partial<TeamsObservedMeeting>;
    const transcriptIds = Array.isArray(record.transcriptIds)
      ? record.transcriptIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    observed[key] = {
      transcriptIds,
      sourceCreatedAt: isoOrNull(record.sourceCreatedAt),
      observedAt: isoOrNull(record.observedAt) ?? undefined,
      ...(record.origin === "chat" ? { origin: "chat" as const } : {}),
    };
  }
  return observed;
}

function parseCursor(cursor: string | null): TeamsCursor | null {
  if (!cursor) return null;
  const iso = isoOrNull(cursor);
  if (iso) return { lastSyncedAt: iso };
  try {
    const parsed = JSON.parse(cursor) as Partial<TeamsCursor>;
    const lastSyncedAt = isoOrNull(parsed.lastSyncedAt);
    if (!lastSyncedAt) return null;
    return {
      lastSyncedAt,
      syncWindowStart: isoOrNull(parsed.syncWindowStart) ?? undefined,
      observedMeetings: parseObservedMeetings(parsed.observedMeetings),
    };
  } catch {
    return null;
  }
}

function serializeCursor(cursor: TeamsCursor): string {
  return JSON.stringify(cursor);
}

function maxIso(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function minIso(a: string, b: string): string {
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

function meetingObservationKey(event: TeamsCalendarEvent): string | null {
  if (event.id) return event.id;
  const joinUrl = event.onlineMeeting?.joinUrl;
  return joinUrl ? createHash("sha256").update(joinUrl).digest("hex").slice(0, 32) : null;
}

function pruneObservedMeetings(
  observed: Record<string, TeamsObservedMeeting>,
  windowStart: string,
  pendingRetryCutoff: string,
): Record<string, TeamsObservedMeeting> {
  const pruned: Record<string, TeamsObservedMeeting> = {};
  for (const [key, observation] of Object.entries(observed)) {
    if (observation.sourceCreatedAt && observation.sourceCreatedAt < windowStart) continue;
    if (
      isPendingTranscriptObservation(observation) &&
      !isWithinPendingTranscriptRetry(observation, pendingRetryCutoff)
    ) {
      continue;
    }
    pruned[key] = observation;
  }
  return pruned;
}

function isPendingTranscriptObservation(observation: TeamsObservedMeeting): boolean {
  return observation.transcriptIds.length === 0;
}

function isWithinPendingTranscriptRetry(observation: TeamsObservedMeeting, pendingRetryCutoff: string): boolean {
  return Boolean(observation.sourceCreatedAt && observation.sourceCreatedAt >= pendingRetryCutoff);
}

function earliestPendingTranscriptSource(
  observed: Record<string, TeamsObservedMeeting>,
  pendingRetryCutoff: string,
): string | null {
  let earliest: string | null = null;
  for (const observation of Object.values(observed)) {
    if (!isPendingTranscriptObservation(observation)) continue;
    if (!isWithinPendingTranscriptRetry(observation, pendingRetryCutoff)) continue;
    if (!observation.sourceCreatedAt) continue;
    earliest = earliest ? minIso(earliest, observation.sourceCreatedAt) : observation.sourceCreatedAt;
  }
  return earliest;
}

function observationFallsInRange(observation: TeamsObservedMeeting, since: string, until: string): boolean {
  if (!observation.sourceCreatedAt) return false;
  return observation.sourceCreatedAt >= since && observation.sourceCreatedAt <= until;
}

async function emitWindowShrinkRemoval(
  cursor: TeamsCursor | null,
  windowStart: string,
  onSourceItemRemoved: ((record: SourceItemRemovalRecord) => Promise<void>) | undefined,
): Promise<void> {
  if (!cursor?.syncWindowStart) return;
  if (new Date(windowStart).getTime() <= new Date(cursor.syncWindowStart).getTime()) return;
  await onSourceItemRemoved?.({ sourceCreatedBefore: windowStart, reason: "teams_sync_window_shrunk" });
}

function lowerEmail(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value?.includes("@") ? value : null;
}

function normalizeName(name: string | null | undefined): string | null {
  const value = name?.trim().replace(/\s+/g, " ");
  return value ? value : null;
}

function normalizeNameKey(name: string | null | undefined): string | null {
  const value = normalizeName(name);
  return value ? value.toLowerCase() : null;
}

function graphDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const withZone = /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Epoch millis a meeting sorts by when the per-run cap keeps the most recent
 * meetings. Falls back to the end time, then 0 so undated events sort last.
 */
function eventStartMs(event: TeamsCalendarEvent): number {
  const iso = graphDateTime(event.start?.dateTime) ?? graphDateTime(event.end?.dateTime);
  return iso ? new Date(iso).getTime() : 0;
}

function isTeamsEvent(event: TeamsCalendarEvent): boolean {
  return (
    event.isOnlineMeeting === true &&
    event.onlineMeetingProvider === "teamsForBusiness" &&
    typeof event.onlineMeeting?.joinUrl === "string" &&
    event.onlineMeeting.joinUrl.length > 0
  );
}

async function listAll<T>(
  graph: GraphClient,
  path: string,
  params?: Record<string, string | string[] | undefined>,
): Promise<T[]> {
  const values: T[] = [];
  let nextUrl: string | undefined;
  do {
    const result = await graph.request<GraphListResponse<T>>(nextUrl ?? path, nextUrl ? undefined : { params });
    values.push(...(result.value ?? []));
    nextUrl = result["@odata.nextLink"];
  } while (nextUrl);
  return values;
}

async function listCalendarEvents(graph: GraphClient, since: string, until: string): Promise<TeamsCalendarEvent[]> {
  const select = [
    "id",
    "subject",
    "webLink",
    "isOnlineMeeting",
    "onlineMeetingProvider",
    "onlineMeeting",
    "organizer",
    "attendees",
    "start",
    "end",
    "lastModifiedDateTime",
  ].join(",");
  return listAll<TeamsCalendarEvent>(graph, "/me/calendarView", {
    startDateTime: since,
    endDateTime: until,
    $top: "50",
    $orderby: "start/dateTime",
    $select: select,
  });
}

async function listMeetingChats(graph: GraphClient, since: string): Promise<TeamsMeetingChat[]> {
  return listAll<TeamsMeetingChat>(graph, "/me/chats", {
    $filter: `chatType eq 'meeting' and lastUpdatedDateTime gt ${since}`,
    $select: "id,topic,createdDateTime,lastUpdatedDateTime,onlineMeetingInfo",
    $top: "50",
  });
}

/**
 * Adapts a meeting chat into the calendar-event shape the rest of the connector
 * speaks, so chat-started meetings reuse one code path for meeting resolution,
 * transcript fetch, observation keys and the removal sweep.
 *
 * Chats carrying a `calendarEventId` are dropped: `/me/calendarView` already
 * yields those, and the calendar row is the richer record (organizer, invited
 * attendees, scheduled start rather than chat-creation time).
 */
export function meetingChatToEvent(chat: TeamsMeetingChat): TeamsCalendarEvent | null {
  const joinUrl = chat.onlineMeetingInfo?.joinWebUrl;
  if (!chat.id || typeof joinUrl !== "string" || joinUrl.length === 0) return null;
  if (chat.onlineMeetingInfo?.calendarEventId) return null;

  const startedAt = chat.createdDateTime ?? null;
  return {
    id: chat.id,
    subject: chat.topic ?? null,
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
    onlineMeeting: { joinUrl },
    start: startedAt ? { dateTime: startedAt, timeZone: "UTC" } : null,
    end: null,
    lastModifiedDateTime: chat.lastUpdatedDateTime ?? startedAt,
  };
}

/**
 * A meeting started from a Teams chat never creates a calendar event, so
 * `/me/calendarView` cannot see it and its transcript is never ingested. List
 * meeting chats separately to recover those.
 *
 * Connectors authorized before `Chat.Read` was requested hold a token without
 * it, so this listing fails until the user reconsents. Calendar discovery must
 * keep working meanwhile, so the failure is logged and swallowed — and reported
 * via `listed` so the removal sweep does not read an unlistable chat as a
 * deleted meeting and tombstone transcripts that are still there.
 */
async function discoverChatMeetings(
  graph: GraphClient,
  since: string,
  calendarEvents: TeamsCalendarEvent[],
  logger: Logger,
): Promise<{ events: TeamsCalendarEvent[]; listed: boolean }> {
  let chats: TeamsMeetingChat[];
  try {
    chats = await listMeetingChats(graph, since);
  } catch (err) {
    logger.warn({ err }, "Skipping Teams meeting chat discovery");
    return { events: [], listed: false };
  }

  const seenJoinUrls = new Set(
    calendarEvents.map((event) => event.onlineMeeting?.joinUrl).filter((url): url is string => Boolean(url)),
  );
  const events: TeamsCalendarEvent[] = [];
  for (const chat of chats) {
    const event = meetingChatToEvent(chat);
    const joinUrl = event?.onlineMeeting?.joinUrl;
    if (!event || !joinUrl || seenJoinUrls.has(joinUrl)) continue;
    seenJoinUrls.add(joinUrl);
    events.push(event);
  }
  return { events, listed: true };
}

async function resolveOnlineMeeting(graph: GraphClient, joinUrl: string): Promise<TeamsOnlineMeeting | null> {
  const filterJoinUrl = joinUrl.replace(/'/g, "''");
  const result = await graph.request<GraphListResponse<TeamsOnlineMeeting>>("/me/onlineMeetings", {
    params: { $filter: `JoinWebUrl eq '${filterJoinUrl}'` },
  });
  return result.value?.[0] ?? null;
}

async function listTranscripts(graph: GraphClient, onlineMeetingId: string): Promise<TeamsTranscript[]> {
  return listAll<TeamsTranscript>(graph, `/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts`);
}

async function fetchTranscriptVtt(
  graph: GraphClient,
  onlineMeetingId: string,
  transcriptId: string,
): Promise<string | null> {
  return graph.request<string>(
    `/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`,
    { params: { $format: "text/vtt" }, responseType: "text" },
  );
}

async function listRecordings(graph: GraphClient, onlineMeetingId: string): Promise<TeamsRecording[]> {
  return listAll<TeamsRecording>(graph, `/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/recordings`);
}

function recordingUrl(recordings: TeamsRecording[]): string | null {
  for (const recording of recordings) {
    const url = recording.playbackUrl ?? recording.recordingContentUrl ?? recording.contentUrl ?? recording.webUrl;
    if (url) return url;
  }
  return null;
}

function collectEmailPerson(
  people: Map<string, { name?: string; email?: string }>,
  emails: Set<string>,
  name: string | null | undefined,
  email: string | null | undefined,
) {
  const normalizedName = normalizeName(name);
  const normalizedEmail = lowerEmail(email);
  if (normalizedEmail) emails.add(normalizedEmail);
  if (!normalizedName && !normalizedEmail) return;
  const key = normalizedEmail ?? `name:${normalizeNameKey(normalizedName)}`;
  if (!key || people.has(key)) return;
  people.set(key, { name: normalizedName ?? undefined, email: normalizedEmail ?? undefined });
}

function collectIdentitySet(
  people: Map<string, { name?: string; email?: string }>,
  emails: Set<string>,
  identity: TeamsIdentitySet | null | undefined,
) {
  collectEmailPerson(
    people,
    emails,
    identity?.user?.displayName,
    identity?.user?.mail ?? identity?.user?.userPrincipalName,
  );
}

function buildPeople(params: {
  event: TeamsCalendarEvent;
  onlineMeeting: TeamsOnlineMeeting | null;
  transcript: TeamsTranscript;
  speakerNames: string[];
  ownerEmail: string | null;
}): { attendees: Array<{ name?: string; email?: string }>; accessValues: string[] } {
  const emailPeople = new Map<string, { name?: string; email?: string }>();
  const allEmails = new Set<string>();
  const emailByName = new Map<string, string>();

  const collect = (name: string | null | undefined, email: string | null | undefined) => {
    collectEmailPerson(emailPeople, allEmails, name, email);
    const key = normalizeNameKey(name);
    const normalizedEmail = lowerEmail(email);
    if (key && normalizedEmail && !emailByName.has(key)) emailByName.set(key, normalizedEmail);
  };

  collect(params.event.organizer?.emailAddress?.name, params.event.organizer?.emailAddress?.address);
  for (const attendee of params.event.attendees ?? []) {
    collect(attendee.emailAddress?.name, attendee.emailAddress?.address);
  }

  collectIdentitySet(emailPeople, allEmails, params.transcript.meetingOrganizer);
  collectIdentitySet(emailPeople, allEmails, params.onlineMeeting?.participants?.organizer);
  for (const attendee of params.onlineMeeting?.participants?.attendees ?? []) {
    collectIdentitySet(emailPeople, allEmails, attendee);
  }

  for (const person of emailPeople.values()) {
    const key = normalizeNameKey(person.name);
    if (key && person.email && !emailByName.has(key)) emailByName.set(key, person.email);
  }

  const attendees: Array<{ name?: string; email?: string }> = [];
  const claimedEmails = new Set<string>();
  const claimedNames = new Set<string>();

  for (const speakerName of params.speakerNames) {
    const name = normalizeName(speakerName);
    if (!name) continue;
    const key = normalizeNameKey(name);
    if (!key || claimedNames.has(key)) continue;
    const email = emailByName.get(key);
    if (email) claimedEmails.add(email);
    claimedNames.add(key);
    attendees.push(email ? { name, email } : { name });
  }

  for (const person of emailPeople.values()) {
    if (person.email && claimedEmails.has(person.email)) continue;
    const key = normalizeNameKey(person.name);
    if (key && claimedNames.has(key)) continue;
    if (person.email) claimedEmails.add(person.email);
    if (key) claimedNames.add(key);
    attendees.push(person);
  }

  const owner = lowerEmail(params.ownerEmail);
  if (owner) allEmails.add(owner);
  for (const attendee of attendees) {
    if (attendee.email) allEmails.add(attendee.email);
  }

  return { attendees, accessValues: [...allEmails] };
}

export function teamsMeetingToSyncedItems(params: {
  event: TeamsCalendarEvent;
  onlineMeeting: TeamsOnlineMeeting | null;
  transcripts: Array<{ transcript: TeamsTranscript; vtt: string }>;
  recordings: TeamsRecording[];
  ownerEmail: string | null;
}): SyncedItem[] {
  const joinUrl =
    params.event.onlineMeeting?.joinUrl ?? params.onlineMeeting?.joinWebUrl ?? params.event.webLink ?? null;
  const providerUrl = recordingUrl(params.recordings) ?? joinUrl;
  const meetingTitle = normalizeName(params.event.subject ?? params.onlineMeeting?.subject) ?? "Teams meeting";
  const sourceCreatedAt = graphDateTime(params.event.start?.dateTime) ?? graphDateTime(params.event.end?.dateTime);
  const sourceUpdatedAt = graphDateTime(params.event.lastModifiedDateTime) ?? sourceCreatedAt;

  return params.transcripts.flatMap(({ transcript, vtt }) => {
    const { transcript: transcriptText, speakers } = parseVtt(vtt);
    if (!transcriptText) return [];

    const content = `# ${meetingTitle}\n\n${transcriptText}`;
    const people = buildPeople({
      event: params.event,
      onlineMeeting: params.onlineMeeting,
      transcript,
      speakerNames: speakers,
      ownerEmail: params.ownerEmail,
    });

    return [
      {
        providerFileId: transcript.id,
        providerUrl,
        fileName: meetingTitle,
        fileType: "meeting_transcript",
        contentCategory: "document",
        content,
        sourcePath: null,
        contentHash: contentHash(content),
        sourceCreatedAt,
        sourceUpdatedAt: graphDateTime(transcript.createdDateTime) ?? sourceUpdatedAt,
        accessPrincipals: people.accessValues.length > 0 ? toEmailPrincipals(people.accessValues) : null,
        attendees: people.attendees.length > 0 ? people.attendees : undefined,
      },
    ];
  });
}

interface TeamsMeetingSyncResult {
  items: SyncedItem[];
  transcriptIds: string[];
  inspected: boolean;
}

async function syncMeeting(
  graph: GraphClient,
  event: TeamsCalendarEvent,
  ownerEmail: string | null,
  logger: Logger,
): Promise<TeamsMeetingSyncResult> {
  const joinUrl = event.onlineMeeting?.joinUrl;
  if (!joinUrl) return { items: [], transcriptIds: [], inspected: false };

  let onlineMeeting: TeamsOnlineMeeting | null;
  try {
    onlineMeeting = await resolveOnlineMeeting(graph, joinUrl);
  } catch (err) {
    if (isSkippableGraphError(err)) {
      logger.warn({ err, eventId: event.id }, "Skipping Teams meeting with unresolvable join URL");
      return { items: [], transcriptIds: [], inspected: false };
    }
    throw err;
  }

  if (!onlineMeeting?.id) {
    logger.warn({ eventId: event.id }, "Skipping Teams meeting with unresolvable join URL");
    return { items: [], transcriptIds: [], inspected: false };
  }

  let transcripts: TeamsTranscript[];
  try {
    transcripts = await listTranscripts(graph, onlineMeeting.id);
  } catch (err) {
    if (isSkippableGraphError(err)) {
      logger.warn({ err, eventId: event.id, onlineMeetingId: onlineMeeting.id }, "Skipping Teams meeting transcripts");
      return { items: [], transcriptIds: [], inspected: false };
    }
    throw err;
  }

  const transcriptIds = transcripts.map((transcript) => transcript.id);
  if (transcripts.length === 0) {
    logger.debug(
      { eventId: event.id, onlineMeetingId: onlineMeeting.id },
      "Skipping Teams meeting without transcripts",
    );
    return { items: [], transcriptIds, inspected: true };
  }

  let recordings: TeamsRecording[] = [];
  try {
    recordings = await listRecordings(graph, onlineMeeting.id);
  } catch (err) {
    if (isSkippableGraphError(err)) {
      logger.warn({ err, eventId: event.id, onlineMeetingId: onlineMeeting.id }, "Skipping Teams recording lookup");
    } else {
      throw err;
    }
  }

  const transcriptBodies: Array<{ transcript: TeamsTranscript; vtt: string }> = [];
  for (const transcript of transcripts) {
    try {
      const vtt = await fetchTranscriptVtt(graph, onlineMeeting.id, transcript.id);
      if (vtt) transcriptBodies.push({ transcript, vtt });
    } catch (err) {
      if (isSkippableGraphError(err)) {
        logger.warn({ err, eventId: event.id, transcriptId: transcript.id }, "Skipping Teams transcript content");
        continue;
      }
      throw err;
    }
  }

  return {
    items: teamsMeetingToSyncedItems({ event, onlineMeeting, transcripts: transcriptBodies, recordings, ownerEmail }),
    transcriptIds,
    inspected: true,
  };
}

function isSkippableGraphError(err: unknown): boolean {
  return err instanceof MicrosoftGraphError && (err.status === 403 || err.status === 404);
}

export async function validateTeamsCredentials(credentials: ConnectorCredentials): Promise<void> {
  assertOAuth(credentials);
  const valid = await ensureValidMicrosoftToken(credentials, { scope: TEAMS_MICROSOFT_SCOPE });
  const graph = createMicrosoftGraphClient(valid, { scope: TEAMS_MICROSOFT_SCOPE });
  await graph.request("/me", { params: { $select: "id,mail,userPrincipalName" } });
}

export function createTeamsConnector(options: TeamsConnectorOptions = {}): Connector {
  const maxInflight = options.maxInflight ?? envPositiveInt("TEAMS_MAX_INFLIGHT", DEFAULT_MAX_INFLIGHT, 16);
  const maxMeetings = options.maxMeetings ?? envPositiveInt("TEAMS_MAX_MEETINGS", DEFAULT_MAX_MEETINGS, 5000);
  const initialLookbackDays =
    options.initialLookbackDays ?? envPositiveInt("TEAMS_INITIAL_LOOKBACK_DAYS", DEFAULT_INITIAL_LOOKBACK_DAYS, 3650);
  const processingLagMs =
    options.processingLagMs ??
    envPositiveInt("TEAMS_PROCESSING_LAG_MS", DEFAULT_PROCESSING_LAG_MS, 7 * 24 * 60 * 60 * 1000);
  const pendingTranscriptRetryMs =
    options.pendingTranscriptRetryMs ??
    envPositiveInt("TEAMS_PENDING_TRANSCRIPT_RETRY_MS", DEFAULT_PENDING_TRANSCRIPT_RETRY_MS, 90 * 24 * 60 * 60 * 1000);
  let nextCursor: TeamsCursor | null = null;

  return {
    type: "teams",
    perUserAuth: true,
    requiresOAuthClientSetup: false,
    promotableFileTypes: [],

    validateCredentials: validateTeamsCredentials,

    async *sync({ credentials, accessTokenProvider, scopeConfig, cursor, logger, ownerEmail, onSourceItemRemoved }) {
      assertOAuth(credentials);
      const valid = accessTokenProvider
        ? credentials
        : await ensureValidMicrosoftToken(credentials, { scope: TEAMS_MICROSOFT_SCOPE });
      const graph = createMicrosoftGraphClient(valid, {
        scope: TEAMS_MICROSOFT_SCOPE,
        accessTokenProvider,
        sleep: options.sleep,
        retryBaseMs: options.retryBaseMs,
      });
      const now = new Date().toISOString();
      const initialDays = parsePositiveInt(scopeConfig.initialDays, initialLookbackDays, 3650);
      const runMaxInflight = parsePositiveInt(scopeConfig.maxInflight, maxInflight, 16);
      const runMaxMeetings = parsePositiveInt(scopeConfig.maxMeetings, maxMeetings, 5000);
      const parsedCursor = parseCursor(cursor);
      const windowStart = new Date(Date.now() - initialDays * 24 * 60 * 60 * 1000).toISOString();
      const pendingRetryCutoff = new Date(Date.now() - pendingTranscriptRetryMs).toISOString();
      const observations = pruneObservedMeetings(parsedCursor?.observedMeetings ?? {}, windowStart, pendingRetryCutoff);
      const pendingSince = earliestPendingTranscriptSource(observations, pendingRetryCutoff);
      const cursorSince = parsedCursor?.lastSyncedAt
        ? pendingSince
          ? minIso(parsedCursor.lastSyncedAt, pendingSince)
          : parsedCursor.lastSyncedAt
        : windowStart;
      const since = maxIso(cursorSince, windowStart);
      await emitWindowShrinkRemoval(parsedCursor, windowStart, onSourceItemRemoved);
      nextCursor = null;

      const calendarEvents = (await listCalendarEvents(graph, since, now)).filter(isTeamsEvent);
      const chatDiscovery = await discoverChatMeetings(graph, since, calendarEvents, logger);
      const events = [...calendarEvents, ...chatDiscovery.events];
      const chatEventKeys = new Set(
        chatDiscovery.events.map(meetingObservationKey).filter((key): key is string => key !== null),
      );
      const currentEventKeys = new Set<string>();
      for (const event of events) {
        const eventKey = meetingObservationKey(event);
        if (eventKey) currentEventKeys.add(eventKey);
      }

      /**
       * Fetch/parse only the most-recent {@link runMaxMeetings} meetings, but
       * record every in-window meeting key above first: a meeting dropped by the
       * cap must not be treated as a calendar deletion by the removal sweep
       * below, and its prior observation stays untouched until it re-enters the
       * cap on a later run (or a cursor reset).
       */
      const processableEvents = [...events].sort((a, b) => eventStartMs(b) - eventStartMs(a)).slice(0, runMaxMeetings);

      const inspectedEventKeys = new Set<string>();
      const removalRecords: SourceItemRemovalRecord[] = [];

      const syncMeetingStreaming = async (event: TeamsCalendarEvent): Promise<SyncedItem[]> => {
        const eventKey = meetingObservationKey(event);
        const result = await syncMeeting(graph, event, ownerEmail ?? null, logger);
        if (eventKey && result.inspected) {
          inspectedEventKeys.add(eventKey);
          const previousTranscriptIds = new Set(observations[eventKey]?.transcriptIds ?? []);
          const currentTranscriptIds = new Set(result.transcriptIds);
          for (const providerFileId of previousTranscriptIds) {
            if (!currentTranscriptIds.has(providerFileId)) {
              removalRecords.push({ providerFileId, reason: "teams_transcript_removed" });
            }
          }
          const observation: TeamsObservedMeeting = {
            transcriptIds: result.transcriptIds,
            sourceCreatedAt: graphDateTime(event.start?.dateTime) ?? graphDateTime(event.end?.dateTime),
            observedAt: now,
            ...(chatEventKeys.has(eventKey) ? { origin: "chat" as const } : {}),
          };
          if (result.transcriptIds.length > 0 || isWithinPendingTranscriptRetry(observation, pendingRetryCutoff)) {
            observations[eventKey] = observation;
          } else {
            delete observations[eventKey];
          }
        }
        return result.items;
      };

      /**
       * Stream each meeting's items out as its worker settles instead of
       * buffering the whole transcript corpus (all VTT content across the
       * window) before the first yield. Removal bookkeeping and cursor advance
       * still run after the concurrent phase drains, exactly as before.
       */
      for await (const items of streamWithConcurrency(processableEvents, runMaxInflight, syncMeetingStreaming)) {
        for (const item of items) yield item;
      }

      for (const [eventKey, observation] of Object.entries(observations)) {
        if (currentEventKeys.has(eventKey) || inspectedEventKeys.has(eventKey)) continue;
        if (!chatDiscovery.listed && observation.origin === "chat") continue;
        if (!observationFallsInRange(observation, since, now)) continue;
        for (const providerFileId of observation.transcriptIds) {
          removalRecords.push({ providerFileId, reason: "teams_meeting_removed" });
        }
        delete observations[eventKey];
      }

      for (const record of removalRecords) {
        await onSourceItemRemoved?.(record);
      }

      const advanceableLastSyncedAt = new Date(Date.now() - processingLagMs).toISOString();
      const nextPendingSince = earliestPendingTranscriptSource(observations, pendingRetryCutoff);
      nextCursor = {
        lastSyncedAt: nextPendingSince ? minIso(advanceableLastSyncedAt, nextPendingSince) : advanceableLastSyncedAt,
        syncWindowStart: windowStart,
        observedMeetings: observations,
      };
    },

    async getCursor() {
      if (nextCursor) return serializeCursor(nextCursor);
      return serializeCursor({
        lastSyncedAt: new Date(Date.now() - processingLagMs).toISOString(),
      });
    },

    async refreshTokens(credentials) {
      return isMicrosoftTokenExpired(credentials)
        ? refreshMicrosoftTokens(credentials, { scope: TEAMS_MICROSOFT_SCOPE })
        : null;
    },
  };
}
