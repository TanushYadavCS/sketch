/**
 * Fireflies.ai connector.
 *
 * Uses Fireflies' GraphQL API to sync meeting transcripts.
 * Auth: API key only (Fireflies uses API keys, not OAuth).
 *
 * Sync strategy:
 * - Incremental: filter transcripts by date >= lastSyncTimestamp
 * - Full: paginate all transcripts
 * - Transcripts stored as documents with summary, action items, and attendee metadata
 * - Attendee emails → file_access records (only attendees can see by default)
 *
 * Fireflies API: https://docs.fireflies.ai/graphql-api
 * Rate limit: 50 req/min on paid plans. We stay conservative.
 */
import { createHash } from "node:crypto";
import pino, { type Logger } from "pino";
import { type AmbiguityAwareMap, createAmbiguityAwareMap, normalizeName } from "./name-normalize";
import {
  type Connector,
  type ConnectorCredentials,
  type NameResolver,
  type SyncedItem,
  toEmailPrincipals,
} from "./types";

const FIREFLIES_API = "https://api.fireflies.ai/graphql";

const PAGE_SIZE = 50;

/** Conservative rate limit: ~40 req/min → ~1 req per 1.5s */
const MIN_REQUEST_INTERVAL_MS = 1500;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Fireflies' GraphQL `fromDate` filters transcripts by meeting start time
 * (`date`), NOT by when a transcript becomes listable. Two gaps follow:
 *
 *  1. Post-processing lag — a recording is queryable only ~15–45 min after
 *     the meeting ends.
 *  2. Late finalization — a transcript can be finalized or uploaded days
 *     after the meeting (delayed processing, or a manual upload of an old
 *     recording). It then carries an OLD meeting `date`, so once the stored
 *     cursor's high-watermark has advanced past that date, the next
 *     incremental sync's `fromDate` filters it out forever — it only
 *     reappears on a full re-pull (cursor reset).
 *
 * Fix: on every incremental sync, look back {@link DEFAULT_INCREMENTAL_OVERLAP_MS}
 * before the stored cursor instead of starting exactly at it. Content-hash
 * dedup (`processSyncedItem` returns `kind: "unchanged"`) makes re-seeing an
 * untouched transcript a cheap no-op, so a generous overlap is safe.
 *
 * The window is tunable per connector via `scopeConfig.incrementalOverlapDays`.
 * Transcripts finalized later than the overlap window still need a cursor
 * reset to recover.
 */
const DEFAULT_INCREMENTAL_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Compute the `fromDate` to send for an incremental sync: the stored cursor
 * shifted back by `overlapMs`. Returns `undefined` for a full sync (no cursor)
 * so the API returns everything. A malformed cursor falls back to itself
 * rather than silently widening to all-time.
 */
function incrementalFromDate(cursor: string | null, overlapMs: number): string | undefined {
  if (!cursor) return undefined;
  const ts = Date.parse(cursor);
  if (Number.isNaN(ts)) return cursor;
  return new Date(ts - overlapMs).toISOString();
}

/** Resolve the incremental overlap window, honoring a per-connector override. */
function resolveOverlapMs(scopeConfig: Record<string, unknown> | undefined): number {
  const days = scopeConfig?.incrementalOverlapDays;
  if (typeof days === "number" && Number.isFinite(days) && days >= 0) {
    return days * 24 * 60 * 60 * 1000;
  }
  return DEFAULT_INCREMENTAL_OVERLAP_MS;
}

interface FirefliesSpeaker {
  id: number;
  name: string;
}

interface FirefliesMeetingAttendee {
  name: string | null;
  email: string | null;
  displayName: string | null;
}

interface FirefliesTranscript {
  id: string;
  title: string;
  date: number; // Unix timestamp (ms)
  duration: number; // seconds
  organizer_email: string | null;
  host_email: string | null;
  participants: string[];
  meeting_attendees: FirefliesMeetingAttendee[] | null;
  transcript_url: string | null;
  /** Fireflies' AI-generated summary. Fields may be strings or arrays depending on the plan/API version. */
  summary: {
    overview: string | null;
    shorthand_bullet: string | string[] | null;
    action_items: string | string[] | null;
    keywords: string | string[] | null;
  } | null;
  /** Speaker diarization result — populated by the per-transcript detail query. */
  speakers?: FirefliesSpeaker[];
}

interface FirefliesContact {
  email: string;
  name: string;
}

function getApiKey(credentials: ConnectorCredentials): string {
  if (credentials.type === "api_key") return credentials.api_key;
  throw new Error("Fireflies connector requires api_key credentials");
}

function summarizeErrorBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("<") || /<html[\s>]/i.test(trimmed)) {
    const titleMatch = trimmed.match(/<title>([^<]+)<\/title>/i);
    return titleMatch ? `upstream returned HTML — ${titleMatch[1].trim()}` : "upstream returned HTML error page";
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

function makeFirefliesRequest(
  getLastRequestTime: () => number,
  setLastRequestTime: (t: number) => void,
  minRequestIntervalMs: number = MIN_REQUEST_INTERVAL_MS,
) {
  return async function firefliesRequest<T>(
    query: string,
    variables: Record<string, unknown>,
    apiKey: string,
    logger: Logger,
    attempt = 1,
  ): Promise<T> {
    const now = Date.now();
    const elapsed = now - getLastRequestTime();
    if (elapsed < minRequestIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, minRequestIntervalMs - elapsed));
    }
    setLastRequestTime(Date.now());

    let response: Response;
    try {
      response = await fetch(FIREFLIES_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const cause = err instanceof Error && "cause" in err ? ((err.cause as Error)?.message ?? "") : "";
      const detail = cause ? `${(err as Error).message} (${cause})` : (err as Error).message;

      if (attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        logger.warn({ attempt, detail, waitMs }, "Fireflies network error, retrying");
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return firefliesRequest(query, variables, apiKey, logger, attempt + 1);
      }

      throw new Error(`Fireflies API network error after ${MAX_RETRIES} attempts: ${detail}`);
    }

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Fireflies API rate limited after ${MAX_RETRIES} attempts`);
      }
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 10_000;
      logger.debug({ waitMs }, "Rate limited, waiting");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return firefliesRequest(query, variables, apiKey, logger, attempt + 1);
    }

    if (!response.ok) {
      const body = await response.text();

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        logger.warn({ attempt, status: response.status, waitMs }, "Fireflies server error, retrying");
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return firefliesRequest(query, variables, apiKey, logger, attempt + 1);
      }

      logger.debug({ status: response.status, body }, "Fireflies API non-OK response");
      throw new Error(`Fireflies API failed (${response.status}): ${summarizeErrorBody(body)}`);
    }

    const result = (await response.json()) as { data: T; errors?: Array<{ message: string }> };

    if (result.errors && result.errors.length > 0) {
      const msg = result.errors[0].message;
      // Rate limit can arrive as a GraphQL error with a retry-after date in the message
      if (msg.toLowerCase().includes("too many requests") && attempt < MAX_RETRIES) {
        const match = msg.match(/retry after (.+?)(?:\s*\(|$)/i);
        let waitMs: number;
        if (match) {
          const retryDate = new Date(match[1]).getTime();
          waitMs = Math.max(retryDate - Date.now(), RETRY_BASE_MS) + 1000;
        } else {
          waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        }
        logger.warn({ attempt, waitMs }, "Fireflies rate limited (GraphQL), retrying");
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return firefliesRequest(query, variables, apiKey, logger, attempt + 1);
      }
      throw new Error(`Fireflies GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`);
    }

    return result.data;
  };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function formatTranscriptContent(transcript: FirefliesTranscript): string {
  const parts: string[] = [];

  // Title and metadata header
  const date = new Date(transcript.date);
  const durationMin = Math.round(transcript.duration / 60);
  parts.push(`# ${transcript.title}`);
  parts.push(`Date: ${date.toISOString().split("T")[0]} | Duration: ${durationMin}min`);

  // Participant emails live in accessPrincipals for ACL — keeping them out of the body avoids polluting embeddings and the entity extractor.

  // AI summary
  if (transcript.summary?.overview) {
    parts.push(`\n## Summary\n${transcript.summary.overview}`);
  }

  if (transcript.summary?.shorthand_bullet) {
    const bullets = Array.isArray(transcript.summary.shorthand_bullet)
      ? transcript.summary.shorthand_bullet
      : [transcript.summary.shorthand_bullet];
    parts.push(`\n## Key Points\n${bullets.map((b) => `- ${b}`).join("\n")}`);
  }

  // Action items
  if (transcript.summary?.action_items) {
    const items = Array.isArray(transcript.summary.action_items)
      ? transcript.summary.action_items
      : [transcript.summary.action_items];
    parts.push(`\n## Action Items\n${items.map((a) => `- ${a}`).join("\n")}`);
  }

  return parts.join("\n");
}

/**
 * Try to match a speaker name to an email by checking if any name token
 * (length ≥ 3) appears as a substring of the email's local-part. Requires
 * an unambiguous single match — emits null on zero or multiple hits.
 */
function matchSpeakerToEmail(speakerName: string, emails: string[]): string | null {
  const tokens = speakerName
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return null;

  const matches = new Set<string>();
  for (const email of emails) {
    const local = email.split("@")[0]?.toLowerCase().replace(/[\d.]/g, "") ?? "";
    if (tokens.some((t) => local.includes(t))) {
      matches.add(email);
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function lowerEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const v = email.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/**
 * Build attendees + accessPrincipals coherently. Emails are lowercased on
 * every insert/lookup — Fireflies returns mixed-case across fields, so
 * canonicalization is required for dedup to work.
 *
 * Speaker → email resolution precedence:
 *   (a) `meeting_attendees` name pair — strongest signal, direct from Fireflies
 *   (b) local-part substring against the collected email pool — existing fallback
 *   (c) Fireflies contacts directory forward lookup — covers speakers Fireflies didn't roster
 *   (d) Sketch-side resolver (users table → person entities incl. aliases) — recovers
 *       people Sketch already knows from other sources / past confirmations
 */
function buildPeople(
  transcript: FirefliesTranscript,
  contacts: Map<string, string>,
  contactsByName: AmbiguityAwareMap<string, string>,
  ownerEmail: string | null,
  resolveNameToEmail: NameResolver | undefined,
): { attendees: Array<{ name?: string; email?: string }>; accessValues: string[] } {
  const emailByName = createAmbiguityAwareMap<string, string>();
  const allEmails = new Set<string>();

  for (const a of transcript.meeting_attendees ?? []) {
    const email = lowerEmail(a.email);
    if (email) allEmails.add(email);
    const name = a.name?.trim() || a.displayName?.trim() || null;
    if (name && email) emailByName.add(normalizeName(name), email);
  }

  const organizer = lowerEmail(transcript.organizer_email);
  const host = lowerEmail(transcript.host_email);
  if (organizer) allEmails.add(organizer);
  if (host) allEmails.add(host);
  for (const p of transcript.participants ?? []) {
    const e = lowerEmail(p);
    if (e?.includes("@")) allEmails.add(e);
  }

  const attendees: Array<{ name?: string; email?: string }> = [];
  const claimed = new Set<string>();

  for (const speaker of transcript.speakers ?? []) {
    const key = normalizeName(speaker.name);
    const email =
      emailByName.get(key) ??
      matchSpeakerToEmail(speaker.name, [...allEmails]) ??
      contactsByName.get(key) ??
      resolveNameToEmail?.(speaker.name)?.email ??
      null;

    if (email && !claimed.has(email)) {
      claimed.add(email);
      attendees.push({ name: speaker.name, email });
    } else {
      attendees.push({ name: speaker.name });
    }
  }

  for (const email of allEmails) {
    if (claimed.has(email)) continue;
    const name = contacts.get(email);
    if (name && name.toLowerCase() !== email) {
      attendees.push({ name, email });
    }
  }

  // Resolver-recovered speakers contribute their emails to accessPrincipals too,
  // not just attendees — the whole point is the right humans get RBAC.
  const accessValues = new Set<string>(allEmails);
  for (const a of attendees) {
    if (a.email) accessValues.add(a.email);
  }
  const owner = lowerEmail(ownerEmail);
  if (owner) accessValues.add(owner);

  return { attendees, accessValues: [...accessValues] };
}

function transcriptToSyncedItem(
  transcript: FirefliesTranscript,
  contacts: Map<string, string>,
  contactsByName: AmbiguityAwareMap<string, string>,
  ownerEmail: string | null,
  resolveNameToEmail: NameResolver | undefined,
): SyncedItem {
  const content = formatTranscriptContent(transcript);
  const date = new Date(transcript.date);

  const { attendees, accessValues } = buildPeople(transcript, contacts, contactsByName, ownerEmail, resolveNameToEmail);

  return {
    providerFileId: transcript.id,
    providerUrl: transcript.transcript_url,
    fileName: transcript.title,
    fileType: "meeting_transcript",
    contentCategory: "document",
    content,
    sourcePath: null,
    contentHash: contentHash(content),
    sourceCreatedAt: date.toISOString(),
    sourceUpdatedAt: date.toISOString(),
    accessPrincipals: accessValues.length > 0 ? toEmailPrincipals(accessValues) : null,
    attendees: attendees.length > 0 ? attendees : undefined,
  };
}

/**
 * Query to list transcripts with pagination (metadata only — summary not available in bulk).
 * Fireflies uses limit/skip pagination (not cursor-based).
 */
const TRANSCRIPTS_LIST_QUERY = `
query Transcripts($limit: Int, $skip: Int, $fromDate: DateTime) {
  transcripts(limit: $limit, skip: $skip, fromDate: $fromDate) {
    id
    title
    date
    duration
    organizer_email
    host_email
    participants
    meeting_attendees {
      name
      email
      displayName
    }
    transcript_url
  }
}`;

/** Fetch a single transcript's summary + speakers by ID. */
const TRANSCRIPT_DETAIL_QUERY = `
query Transcript($id: String!) {
  transcript(id: $id) {
    summary {
      overview
      shorthand_bullet
      action_items
      keywords
    }
    speakers {
      id
      name
    }
  }
}`;

/**
 * Contacts directory for the API key owner. Used as a name fallback for
 * silent participants — Fireflies enriches names here when it can.
 */
const USER_CONTACTS_QUERY = `
query Contacts {
  contacts {
    email
    name
  }
}`;

/** Validate API key by fetching the current user. */
const USER_QUERY = `
query User {
  user {
    user_id
    name
    email
  }
}`;

type FirefliesRequestFn = ReturnType<typeof makeFirefliesRequest>;

/**
 * Fetch the contacts directory once per sync.
 *
 * Returns two maps:
 *   - `byEmail`:  lowercased email → display name (existing reverse lookup)
 *   - `byName`:   normalized name → lowercased email (forward lookup used to
 *                 recover emails for speakers Fireflies didn't roster)
 *
 * Names that resolve ambiguously (two contacts share a normalized name) are
 * dropped from `byName` so a forward lookup never returns the wrong person.
 */
async function fetchContactsMap(
  apiKey: string,
  logger: Logger,
  firefliesRequest: FirefliesRequestFn,
): Promise<{ byEmail: Map<string, string>; byName: AmbiguityAwareMap<string, string> }> {
  const byEmail = new Map<string, string>();
  const byName = createAmbiguityAwareMap<string, string>();

  try {
    const data = await firefliesRequest<{ contacts: FirefliesContact[] | null }>(
      USER_CONTACTS_QUERY,
      {},
      apiKey,
      logger,
    );
    for (const c of data.contacts ?? []) {
      if (!c.email || !c.name) continue;
      const email = c.email.toLowerCase();
      // Skip stubs where Fireflies hasn't enriched a real name.
      if (c.name.toLowerCase() === email) continue;
      byEmail.set(email, c.name);
      byName.add(normalizeName(c.name), email);
    }
  } catch (err) {
    logger.warn({ err }, "Fireflies contacts directory fetch failed; proceeding without name fallback");
  }
  return { byEmail, byName };
}

async function* syncTranscripts(
  apiKey: string,
  fromDate: string | undefined,
  ownerEmail: string | null,
  resolveNameToEmail: NameResolver | undefined,
  logger: Logger,
  firefliesRequest: FirefliesRequestFn,
): AsyncGenerator<SyncedItem> {
  let skip = 0;
  let totalTranscripts = 0;

  const { byEmail: contacts, byName: contactsByName } = await fetchContactsMap(apiKey, logger, firefliesRequest);
  logger.debug(
    { contactsCount: contacts.size, contactsByNameCount: contactsByName.size, ownerEmail, fromDate },
    "Fireflies contacts directory loaded",
  );

  let hasMore = true;
  while (hasMore) {
    const data = await firefliesRequest<{
      transcripts: FirefliesTranscript[];
    }>(TRANSCRIPTS_LIST_QUERY, { limit: PAGE_SIZE, skip, fromDate }, apiKey, logger);

    if (!data.transcripts || data.transcripts.length === 0) {
      break;
    }

    for (const transcript of data.transcripts) {
      // Fetch summary + speakers separately — neither available in bulk list query
      const detailData = await firefliesRequest<{
        transcript: { summary: FirefliesTranscript["summary"]; speakers: FirefliesSpeaker[] | null } | null;
      }>(TRANSCRIPT_DETAIL_QUERY, { id: transcript.id }, apiKey, logger);

      transcript.summary = detailData.transcript?.summary ?? null;
      transcript.speakers = detailData.transcript?.speakers ?? [];

      yield transcriptToSyncedItem(transcript, contacts, contactsByName, ownerEmail, resolveNameToEmail);
      totalTranscripts++;
    }

    // If we got fewer than PAGE_SIZE, we've reached the end
    hasMore = data.transcripts.length >= PAGE_SIZE;

    skip += PAGE_SIZE;
    logger.debug({ transcriptsProcessed: totalTranscripts, skip }, "Transcripts page complete");
  }

  logger.info({ totalTranscripts }, "Transcripts sync complete");
}

/**
 * Last 6 chars of an API key, for display in list views.
 * Returns null if the key is too short to slice meaningfully.
 */
export function buildCredentialHint(apiKey: string): string | null {
  if (typeof apiKey !== "string" || apiKey.length < 6) return null;
  return apiKey.slice(-6);
}

export interface FirefliesConnectorOptions {
  /**
   * Minimum spacing between API requests in milliseconds. Defaults to the
   * production rate limit ({@link MIN_REQUEST_INTERVAL_MS}); tests pass 0 to
   * avoid real wall-clock waits while still exercising the request path.
   */
  minRequestIntervalMs?: number;
}

export function createFirefliesConnector(options: FirefliesConnectorOptions = {}): Connector {
  let lastRequestTime = 0;
  const firefliesRequest = makeFirefliesRequest(
    () => lastRequestTime,
    (t) => {
      lastRequestTime = t;
    },
    options.minRequestIntervalMs ?? MIN_REQUEST_INTERVAL_MS,
  );

  return {
    type: "fireflies",
    perUserAuth: true,
    requiresOAuthClientSetup: false,

    async validateCredentials(credentials) {
      const apiKey = getApiKey(credentials);
      await firefliesRequest(USER_QUERY, {}, apiKey, pino({ level: "silent" }));
    },

    async *sync({ credentials, cursor, scopeConfig, ownerEmail, resolveNameToEmail, logger }) {
      const apiKey = getApiKey(credentials);
      const fromDate = incrementalFromDate(cursor, resolveOverlapMs(scopeConfig));
      yield* syncTranscripts(apiKey, fromDate, ownerEmail ?? null, resolveNameToEmail, logger, firefliesRequest);
    },

    async getCursor() {
      // Store the true high-watermark; the read-time overlap in `sync` re-scans
      // the recent window to recover late-finalized transcripts (see
      // DEFAULT_INCREMENTAL_OVERLAP_MS).
      return new Date(Date.now()).toISOString();
    },
  };
}
