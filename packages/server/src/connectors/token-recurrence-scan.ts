import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import { yieldToEventLoop } from "../lib/event-loop";

/**
 * Content recurrence scan: how often a candidate's name tokens actually
 * recur across a set of files, read from the file text itself. Stored
 * entity_mentions undercount content reality 5-6x (measured on Redseer), so
 * candidacy ranking reads the content, never the mention table. TS regex on
 * purpose — SQLite has no regex operator, and the scan must work on both
 * dialects.
 */
export interface ScanCandidate {
  key: string;
  /** Distinctive name tokens; ALL must appear in the same file for it to count. */
  tokens: string[];
}

export interface TokenRecurrence {
  files: string[];
  distinctDays: number;
  firstDay: string | null;
  lastDay: string | null;
  monthly: Record<string, number>;
}

const CONTENT_CHUNK = 25;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A token matches its bare plural/singular sibling too: "benchmark" and
 * "benchmarks" are the same workstream, and meeting titles flip between the
 * forms freely (measured: exact-token matching cost Benchmarks 21 of its 36
 * scan days on Redseer).
 */
function tokenPattern(token: string): string {
  const stem = token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
  return `\\b${escapeRegex(stem)}s?\\b`;
}

/**
 * One matcher per candidate: every token must appear with word boundaries,
 * and as a fallback the tokens joined adjacently (spaces/hyphens/nothing
 * between them) count as one phrase — "multi metric" still matches
 * "multi-metric" and "multimetric", where the per-token boundaries would
 * miss the fused form.
 */
function candidateMatcher(tokens: string[]): ((text: string) => boolean) | null {
  const cleaned = [...new Set(tokens.map((token) => token.trim().toLowerCase()).filter(Boolean))];
  if (cleaned.length === 0) return null;
  const tokenPatterns = cleaned.map((token) => new RegExp(tokenPattern(token), "i"));
  const phrase =
    cleaned.length > 1 ? new RegExp(`\\b${cleaned.map((token) => escapeRegex(token)).join("[\\s-]*")}\\b`, "i") : null;
  return (text: string) => tokenPatterns.every((pattern) => pattern.test(text)) || (phrase?.test(text) ?? false);
}

export async function scanTokenRecurrence(
  db: Kysely<DB>,
  input: { candidates: ScanCandidate[]; fileIds: string[] },
): Promise<Map<string, TokenRecurrence>> {
  const results = new Map<string, TokenRecurrence>();
  const matchers: { key: string; matches: (text: string) => boolean }[] = [];
  for (const candidate of input.candidates) {
    results.set(candidate.key, { files: [], distinctDays: 0, firstDay: null, lastDay: null, monthly: {} });
    const matches = candidateMatcher(candidate.tokens);
    if (matches) matchers.push({ key: candidate.key, matches });
  }
  if (matchers.length === 0 || input.fileIds.length === 0) return results;

  const daysByKey = new Map<string, Set<string>>(matchers.map((matcher) => [matcher.key, new Set<string>()]));
  for (let i = 0; i < input.fileIds.length; i += CONTENT_CHUNK) {
    const rows = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name", "content", "source_created_at", "synced_at"])
      .where("id", "in", input.fileIds.slice(i, i + CONTENT_CHUNK))
      .execute();
    for (const row of rows) {
      const text = `${row.file_name ?? ""}\n${row.content ?? ""}`;
      const day = (row.source_created_at ?? row.synced_at ?? "").slice(0, 10) || null;
      for (const matcher of matchers) {
        if (!matcher.matches(text)) continue;
        const recurrence = results.get(matcher.key);
        if (!recurrence) continue;
        recurrence.files.push(row.id);
        if (day) {
          daysByKey.get(matcher.key)?.add(day);
          const month = day.slice(0, 7);
          recurrence.monthly[month] = (recurrence.monthly[month] ?? 0) + 1;
          if (!recurrence.firstDay || day < recurrence.firstDay) recurrence.firstDay = day;
          if (!recurrence.lastDay || day > recurrence.lastDay) recurrence.lastDay = day;
        }
      }
    }
    await yieldToEventLoop();
  }
  for (const [key, days] of daysByKey) {
    const recurrence = results.get(key);
    if (recurrence) recurrence.distinctDays = days.size;
  }
  return results;
}
