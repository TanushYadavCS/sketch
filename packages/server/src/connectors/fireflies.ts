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
import type { Connector, ConnectorCredentials, SyncedItem } from "./types";

const FIREFLIES_API = "https://api.fireflies.ai/graphql";

const PAGE_SIZE = 50;

/** Conservative rate limit: ~40 req/min → ~1 req per 1.5s */
const MIN_REQUEST_INTERVAL_MS = 1500;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Fireflies post-processes recordings into queryable transcripts for
 * ~15–45 min after a meeting ends. During that window the transcript
 * is invisible to the API. If we advance the cursor to `now`, a
 * transcript whose meeting `date` predates the cursor when it finally
 * becomes listable is filtered out by Fireflies' `fromDate` forever.
 *
 * Lag the cursor by 2h so the next sync always re-queries the recent
 * window. Content-hash dedup makes re-fetches cheap.
 */
const FIREFLIES_PROCESSING_LAG_MS = 2 * 60 * 60 * 1000;

interface FirefliesSpeaker {
  id: number;
  name: string;
}

interface FirefliesTranscript {
  id: string;
  title: string;
  date: number; // Unix timestamp (ms)
  duration: number; // seconds
  organizer_email: string | null;
  participants: string[];
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

function makeFirefliesRequest(getLastRequestTime: () => number, setLastRequestTime: (t: number) => void) {
  return async function firefliesRequest<T>(
    query: string,
    variables: Record<string, unknown>,
    apiKey: string,
    logger: Logger,
    attempt = 1,
  ): Promise<T> {
    const now = Date.now();
    const elapsed = now - getLastRequestTime();
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
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

      throw new Error(`Fireflies API failed (${response.status}): ${body}`);
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

  // Participant emails live in accessEmails for ACL — keeping them out of the body avoids polluting embeddings and the entity extractor.

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

/**
 * Build the attendees list. Speakers (real names from diarization) seed
 * person entities; silent attendees stay in accessEmails only.
 *
 * Speakers are matched against the participant email list via local-part
 * substring; on a clean match we emit `{name, email}`, otherwise `{name}`
 * only and let the contacts directory provide a name-only fallback for
 * un-matched participants we have a real contact name for.
 */
function buildAttendees(
  transcript: FirefliesTranscript,
  contacts: Map<string, string>,
): Array<{ name?: string; email?: string }> {
  const allEmails: string[] = [];
  if (transcript.organizer_email) allEmails.push(transcript.organizer_email);
  for (const p of transcript.participants) {
    if (p.includes("@")) allEmails.push(p);
  }

  const attendees: Array<{ name?: string; email?: string }> = [];
  const claimedEmails = new Set<string>();

  for (const speaker of transcript.speakers ?? []) {
    const matched = matchSpeakerToEmail(speaker.name, allEmails);
    if (matched && !claimedEmails.has(matched)) {
      claimedEmails.add(matched);
      attendees.push({ name: speaker.name, email: matched });
    } else {
      attendees.push({ name: speaker.name });
    }
  }

  // Fallback: participants we didn't tie to a speaker — if the contacts
  // directory has a real name for the email, surface that.
  for (const email of allEmails) {
    if (claimedEmails.has(email)) continue;
    const name = contacts.get(email.toLowerCase());
    if (name && name.toLowerCase() !== email.toLowerCase()) {
      attendees.push({ name, email });
    }
  }

  return attendees;
}

function transcriptToSyncedItem(transcript: FirefliesTranscript, contacts: Map<string, string>): SyncedItem {
  const content = formatTranscriptContent(transcript);
  const date = new Date(transcript.date);

  // Collect attendee emails for access control
  const accessEmails: string[] = [];
  if (transcript.organizer_email) {
    accessEmails.push(transcript.organizer_email);
  }
  for (const p of transcript.participants) {
    if (p.includes("@")) {
      accessEmails.push(p);
    }
  }

  const attendees = buildAttendees(transcript, contacts);

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
    accessEmails: accessEmails.length > 0 ? accessEmails : null,
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
    participants
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

/** Fetch the contacts directory once per sync; map keyed by lowercased email. */
async function fetchContactsMap(
  apiKey: string,
  logger: Logger,
  firefliesRequest: FirefliesRequestFn,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const data = await firefliesRequest<{ contacts: FirefliesContact[] | null }>(
      USER_CONTACTS_QUERY,
      {},
      apiKey,
      logger,
    );
    for (const c of data.contacts ?? []) {
      if (!c.email || !c.name) continue;
      // Skip stubs where Fireflies hasn't enriched a real name.
      if (c.name.toLowerCase() === c.email.toLowerCase()) continue;
      map.set(c.email.toLowerCase(), c.name);
    }
  } catch (err) {
    logger.warn({ err }, "Fireflies contacts directory fetch failed; proceeding without name fallback");
  }
  return map;
}

async function* syncTranscripts(
  apiKey: string,
  sinceTimestamp: string | null,
  logger: Logger,
  firefliesRequest: FirefliesRequestFn,
): AsyncGenerator<SyncedItem> {
  let skip = 0;
  let totalTranscripts = 0;

  const contacts = await fetchContactsMap(apiKey, logger, firefliesRequest);
  logger.debug({ contactsCount: contacts.size }, "Fireflies contacts directory loaded");

  // Pass fromDate to the API so it only returns transcripts newer than our cursor.
  // Without this, a failed sync retries from the old cursor and re-fetches everything.
  const fromDate = sinceTimestamp ?? undefined;

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

      yield transcriptToSyncedItem(transcript, contacts);
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

export function createFirefliesConnector(): Connector {
  let lastRequestTime = 0;
  const firefliesRequest = makeFirefliesRequest(
    () => lastRequestTime,
    (t) => {
      lastRequestTime = t;
    },
  );

  return {
    type: "fireflies",
    perUserAuth: true,
    requiresOAuthClientSetup: false,

    async validateCredentials(credentials) {
      const apiKey = getApiKey(credentials);
      await firefliesRequest(USER_QUERY, {}, apiKey, pino({ level: "silent" }));
    },

    async *sync({ credentials, cursor, logger }) {
      const apiKey = getApiKey(credentials);
      yield* syncTranscripts(apiKey, cursor, logger, firefliesRequest);
    },

    async getCursor() {
      return new Date(Date.now() - FIREFLIES_PROCESSING_LAG_MS).toISOString();
    },
  };
}
