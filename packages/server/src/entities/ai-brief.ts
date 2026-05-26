/**
 * AI brief generation for the entity drawer's Signal / So-what rows.
 *
 * The brief is org-shared — stored on entities.ai_brief as JSON and computed
 * once per (entity, inputHash). Every user in the org sees the same brief;
 * there is no per-user personalization. First-user-lazy-loads,
 * everyone-else-instant.
 *
 * The "what" row is deterministic and computed at read time
 * (see profile-facts.ts buildWhatRow). This module covers signal + so-what
 * only.
 */
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { GeminiGenerator } from "../connectors/gemini-generate";
import type { DB } from "../db/schema";
import type { SingleFlight } from "../lib/single-flight";
import type { EntityProfileFacts } from "./profile-facts";

export interface CachedAiBrief {
  signal: string | null;
  soWhat: string | null;
  generatedAt: string | null;
  inputHash: string | null;
  stale: boolean;
}

export const EMPTY_BRIEF: CachedAiBrief = {
  signal: null,
  soWhat: null,
  generatedAt: null,
  inputHash: null,
  stale: false,
};

/** Hash inputs used to decide whether a cached brief is stale. */
export function computeInputHash(facts: EntityProfileFacts): string {
  const subset = {
    name: facts.name,
    sourceType: facts.sourceType,
    mentionCount: facts.mentionCount,
    sourceCounts: facts.sourceCounts,
    lastSeenAt: facts.lastSeenAt,
    domainsForCompany: facts.domainsForCompany.map((d) => ({ d: d.domain, p: d.isPrimary })),
    topRelationships: facts.topRelationships.slice(0, 10).map((r) => ({
      id: r.id,
      t: r.relationshipType,
      c: r.confidence,
      o: r.other.id,
    })),
  };
  return createHash("sha256").update(JSON.stringify(subset)).digest("hex").slice(0, 32);
}

const SYSTEM_PROMPT = `You are writing a profile card summary for an internal knowledge tool. The audience is the user's own team — colleagues who already know the entity exists and want a quick read on it.

Write in a warm, conversational tone — like a smart colleague summarizing what they noticed. Avoid corporate or consultant language ("subject demonstrates engagement", "leverages capability"). Prefer specifics over generalities (real project names, real time windows).

Output strict JSON with two fields:
- "signal": one sentence about the most interesting recent fact or pattern about this entity. May reference specific projects, companies, or time windows.
- "soWhat": one sentence with a suggested next step for the user. May suggest a 1:1, a check-in, a follow-up, a confirmation. Concrete and short.

Both fields must be ≤ 140 chars. If there isn't enough signal, return brief honest content like "Not enough signal yet — only 2 mentions in last 30 days."`;

function renderEntityFacts(facts: EntityProfileFacts): string {
  const lines: string[] = [];
  lines.push(`Entity: ${facts.name} (${facts.sourceType})`);
  const role = typeof facts.metadata?.role === "string" ? facts.metadata.role : null;
  const email = typeof facts.metadata?.email === "string" ? facts.metadata.email : null;
  const identityBits: string[] = [];
  if (role) identityBits.push(role);
  if (email) identityBits.push(email);
  if (facts.domainsForCompany.length > 0) {
    const primary = facts.domainsForCompany.find((d) => d.isPrimary) ?? facts.domainsForCompany[0];
    identityBits.push(primary.domain);
  }
  if (identityBits.length > 0) lines.push(`Identity: ${identityBits.join(", ")}`);

  if (facts.topRelationships.length > 0) {
    lines.push("Active relationships:");
    for (const r of facts.topRelationships.slice(0, 8)) {
      const direction = r.sourceEntityId === facts.entityId ? "" : "← ";
      const score = r.confidence === "AMBIGUOUS" ? "" : ` ${r.confidenceScore.toFixed(2)}`;
      lines.push(
        `  - ${direction}${r.relationshipType} ${r.other.name} (${r.confidence}${score}, ${r.evidenceCount} files)`,
      );
    }
  }

  lines.push("Recent activity:");
  lines.push(`  - ${facts.mentionCount} total mentions`);
  const sources = Object.entries(facts.sourceCounts);
  if (sources.length > 0) {
    lines.push(`  - sources: ${sources.map(([s, n]) => `${n} ${s}`).join(", ")}`);
  }
  if (facts.lastSeenAt) lines.push(`  - last seen: ${facts.lastSeenAt}`);
  return lines.join("\n");
}

interface RawBrief {
  signal: unknown;
  soWhat: unknown;
}

function sanitizeBriefField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 280 ? trimmed.slice(0, 280) : trimmed;
}

export interface GenerateAiBriefDeps {
  db: Kysely<DB>;
  gemini: GeminiGenerator;
  singleFlight: SingleFlight;
  logger: Logger;
}

export interface AiBriefResult extends CachedAiBrief {
  /** True when this call hit the cache (no Gemini call was made). */
  cached: boolean;
  /** Closed-set reason populated when generation failed. */
  error?: "generation_failed";
}

export async function loadCachedBrief(db: Kysely<DB>, entityId: string): Promise<CachedAiBrief | null> {
  const row = await db.selectFrom("entities").select("ai_brief").where("id", "=", entityId).executeTakeFirst();
  if (!row?.ai_brief) return null;
  try {
    const parsed = JSON.parse(row.ai_brief) as Partial<CachedAiBrief>;
    return {
      signal: typeof parsed.signal === "string" ? parsed.signal : null,
      soWhat: typeof parsed.soWhat === "string" ? parsed.soWhat : null,
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : null,
      inputHash: typeof parsed.inputHash === "string" ? parsed.inputHash : null,
      stale: parsed.stale === true,
    };
  } catch {
    return null;
  }
}

/**
 * Mark a cached brief stale without re-running Gemini. Used by data-writer
 * hooks (new relationship, fresh mentions). The next forced refresh re-checks
 * the input hash before deciding whether to regenerate.
 */
export async function markBriefStale(db: Kysely<DB>, entityId: string): Promise<void> {
  const cached = await loadCachedBrief(db, entityId);
  if (!cached) return;
  await db
    .updateTable("entities")
    .set({ ai_brief: JSON.stringify({ ...cached, stale: true }), updated_at: new Date().toISOString() })
    .where("id", "=", entityId)
    .execute();
}

/**
 * Generate (or read-cached) Signal + So-what for an entity.
 *
 * Flow:
 *   1. Compute inputHash from the supplied facts.
 *   2. If the cached brief's inputHash matches and `force` is false, return cached.
 *   3. Otherwise enter single-flight (`ai_brief:${entityId}`). Concurrent
 *      callers receive the same Promise — exactly one Gemini call per overlap.
 *   4. On Gemini failure, log a structured warn and return an empty brief.
 *      Caller decides whether to surface "couldn't generate — retry."
 */
export async function generateAiBrief(
  deps: GenerateAiBriefDeps,
  facts: EntityProfileFacts,
  opts: { force?: boolean } = {},
): Promise<AiBriefResult> {
  const inputHash = computeInputHash(facts);
  const cached = await loadCachedBrief(deps.db, facts.entityId);
  if (!opts.force && cached?.inputHash === inputHash && cached.signal !== null) {
    return { ...cached, cached: true };
  }

  return deps.singleFlight.do(`ai_brief:${facts.entityId}`, async () => {
    const recheck = await loadCachedBrief(deps.db, facts.entityId);
    if (!opts.force && recheck?.inputHash === inputHash && recheck.signal !== null) {
      return { ...recheck, cached: true };
    }

    const prompt = renderEntityFacts(facts);
    try {
      const raw = await deps.gemini.generateJSON<RawBrief>(prompt, {
        systemPrompt: SYSTEM_PROMPT,
        label: "entity-ai-brief",
        maxTokens: 512,
      });
      const signal = sanitizeBriefField(raw.signal);
      const soWhat = sanitizeBriefField(raw.soWhat);
      if (!signal || !soWhat) {
        deps.logger.warn({ entityId: facts.entityId }, "ai-brief: empty signal/soWhat from model");
        return { ...EMPTY_BRIEF, cached: false, error: "generation_failed" };
      }
      const generatedAt = new Date().toISOString();
      const next: CachedAiBrief = { signal, soWhat, generatedAt, inputHash, stale: false };
      await deps.db
        .updateTable("entities")
        .set({ ai_brief: JSON.stringify(next), updated_at: generatedAt })
        .where("id", "=", facts.entityId)
        .execute();
      return { ...next, cached: false };
    } catch (err) {
      deps.logger.warn({ err, entityId: facts.entityId }, "ai-brief: Gemini generation failed");
      return { ...EMPTY_BRIEF, cached: false, error: "generation_failed" };
    }
  });
}
