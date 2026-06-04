import type { Kysely } from "kysely";
import { PERSON_PARTICIPANT_FACT_TYPES } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";

export const MAX_FACTS_PER_ENTITY = 10;
export const MAX_FACT_CHARS = 180;
export const MAX_FACTS_CHARS_PER_ENTITY = 1500;
const DEFAULT_HALF_LIFE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const ANCHOR_TYPES = new Set(["company", "product", "project"]);

export interface LearnedFactStored {
  fact: string;
  source_file_id?: string;
  learned_at?: string;
}

export interface FactSelectionContext {
  currentFileId: string;
  attendeeEmails: string[];
  matchedEntityIds: string[];
}

export interface SourceFileFactContext {
  attendeeEmails: string[];
  mentionedEntityIds: string[];
  anchorEntityIds: string[];
}

export interface FactSelectionCache {
  bySourceFileId: Map<string, SourceFileFactContext>;
}

export function createFactSelectionCache(): FactSelectionCache {
  return { bySourceFileId: new Map() };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function clampFact(fact: string, maxChars: number): string {
  const trimmed = fact.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

async function loadMissingSourceFileContexts(
  db: Kysely<DB>,
  cache: FactSelectionCache,
  sourceFileIds: string[],
): Promise<void> {
  const missing = Array.from(new Set(sourceFileIds)).filter((id) => id.length > 0 && !cache.bySourceFileId.has(id));
  if (missing.length === 0) return;

  for (const id of missing) {
    cache.bySourceFileId.set(id, { attendeeEmails: [], mentionedEntityIds: [], anchorEntityIds: [] });
  }

  const attendeeRows = await db
    .selectFrom("indexed_file_facts")
    .select(["indexed_file_id", "subject_email"])
    .where("indexed_file_id", "in", missing)
    .where("fact_type", "in", PERSON_PARTICIPANT_FACT_TYPES)
    .where("subject_email", "is not", null)
    .where("deleted_at", "is", null)
    .execute();
  for (const row of attendeeRows) {
    if (!row.indexed_file_id) continue;
    const ctx = cache.bySourceFileId.get(row.indexed_file_id);
    if (!ctx || !row.subject_email) continue;
    ctx.attendeeEmails.push(normalizeEmail(row.subject_email));
  }

  const mentionRows = await db
    .selectFrom("entity_mentions")
    .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
    .select(["entity_mentions.indexed_file_id", "entity_mentions.entity_id", "entities.source_type"])
    .where("entity_mentions.indexed_file_id", "in", missing)
    .execute();
  for (const row of mentionRows) {
    const ctx = cache.bySourceFileId.get(row.indexed_file_id);
    if (!ctx) continue;
    ctx.mentionedEntityIds.push(row.entity_id);
    if (ANCHOR_TYPES.has(row.source_type)) ctx.anchorEntityIds.push(row.entity_id);
  }

  for (const ctx of cache.bySourceFileId.values()) {
    ctx.attendeeEmails = Array.from(new Set(ctx.attendeeEmails));
    ctx.mentionedEntityIds = Array.from(new Set(ctx.mentionedEntityIds));
    ctx.anchorEntityIds = Array.from(new Set(ctx.anchorEntityIds));
  }
}

function overlapScore(context: FactSelectionContext, sourceContext: SourceFileFactContext | undefined): number {
  if (!sourceContext) return 0;
  const currentAttendees = new Set(context.attendeeEmails.map(normalizeEmail));
  const currentEntities = new Set(context.matchedEntityIds);
  const attendeeOverlap = sourceContext.attendeeEmails.some((email) => currentAttendees.has(normalizeEmail(email)));
  const entityOverlap = sourceContext.mentionedEntityIds.some((id) => currentEntities.has(id));
  const anchorOverlap = sourceContext.anchorEntityIds.some((id) => currentEntities.has(id));
  return attendeeOverlap || entityOverlap || anchorOverlap ? 1 : 0;
}

export async function buildFactSelectionContext(
  db: Kysely<DB>,
  fileId: string,
  matchedEntityIds: string[],
): Promise<FactSelectionContext> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select("subject_email")
    .where("indexed_file_id", "=", fileId)
    .where("fact_type", "in", PERSON_PARTICIPANT_FACT_TYPES)
    .where("subject_email", "is not", null)
    .where("deleted_at", "is", null)
    .execute();
  return {
    currentFileId: fileId,
    attendeeEmails: rows.flatMap((row) => (row.subject_email ? [normalizeEmail(row.subject_email)] : [])),
    matchedEntityIds: Array.from(new Set(matchedEntityIds)),
  };
}

export async function selectRelevantFacts(
  deps: { db: Kysely<DB>; now?: () => number },
  entity: { entityId: string; learnedFacts: LearnedFactStored[] },
  context: FactSelectionContext,
  cache: FactSelectionCache,
  opts?: { maxFacts?: number; halfLifeDays?: number },
): Promise<LearnedFactStored[]> {
  const maxFacts = opts?.maxFacts ?? MAX_FACTS_PER_ENTITY;
  const halfLifeDays = opts?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const now = deps.now ? deps.now() : Date.now();
  const sourceFileIds = entity.learnedFacts.flatMap((fact) => (fact.source_file_id ? [fact.source_file_id] : []));
  await loadMissingSourceFileContexts(deps.db, cache, sourceFileIds);

  const scored = entity.learnedFacts.map((fact, index) => {
    const sourceContext = fact.source_file_id ? cache.bySourceFileId.get(fact.source_file_id) : undefined;
    const learnedAt = parseTime(fact.learned_at);
    const recency = learnedAt === null ? null : Math.exp(-Math.max(0, (now - learnedAt) / DAY_MS) / halfLifeDays);
    const overlap = overlapScore(context, sourceContext);
    return {
      fact,
      index,
      score: recency === null ? null : 0.5 * recency + 0.5 * overlap,
    };
  });

  const withScore = scored
    .filter((item): item is typeof item & { score: number } => item.score !== null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.index - a.index;
    });
  const legacy = scored.filter((item) => item.score === null).sort((a, b) => b.index - a.index);

  return [...withScore, ...legacy].slice(0, maxFacts).map((item) => item.fact);
}

export function renderFactsForPrompt(
  facts: LearnedFactStored[],
  opts?: { maxFactChars?: number; maxTotalChars?: number },
): string {
  const maxFactChars = opts?.maxFactChars ?? MAX_FACT_CHARS;
  const maxTotalChars = opts?.maxTotalChars ?? MAX_FACTS_CHARS_PER_ENTITY;
  const rendered: string[] = [];
  let used = 0;
  for (const fact of facts) {
    const line = clampFact(fact.fact, maxFactChars);
    if (!line) continue;
    const nextLength = used + (rendered.length > 0 ? 2 : 0) + line.length;
    if (nextLength > maxTotalChars) break;
    rendered.push(line);
    used = nextLength;
  }
  return rendered.join("; ");
}
