/**
 * Entity linking helpers for the enrichment pipeline.
 *
 * - Hot entity injection: builds the entity list for the LLM prompt
 * - Person resolution: matches LLM-discovered people to existing entities
 * - Fuzzy matching via Talisman Jaro-Winkler
 */
import type { Kysely, Selectable } from "kysely";
// @ts-expect-error talisman has no type declarations
import jaroWinklerModule from "talisman/metrics/jaro-winkler";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB, EntitiesTable } from "../db/schema";
import { HIDDEN_ENTITY_SOURCE_TYPES } from "../entities/profile-facts";

/** talisman is CJS — handle both default and named export shapes */
const jaroWinkler: (a: string, b: string) => number =
  typeof jaroWinklerModule === "function"
    ? jaroWinklerModule
    : (jaroWinklerModule as { similarity: (a: string, b: string) => number }).similarity;

const JARO_WINKLER_THRESHOLD = 0.85;

type Entity = Selectable<EntitiesTable>;

/**
 * Get entities relevant to a document's content for LLM prompt injection.
 * 1. Substring-match entity names/aliases against content
 * 2. Pad with hottest entities up to cap
 */
export async function getHotEntitiesForPrompt(db: Kysely<DB>, content: string): Promise<Entity[]> {
  const entityRepo = createEntityRepository(db);
  const allEntities = await entityRepo.getEntitiesByStatus("confirmed", {
    excludeSourceTypes: Array.from(HIDDEN_ENTITY_SOURCE_TYPES),
  });
  const contentLower = content.toLowerCase();

  const matched = allEntities.filter((e) => {
    const names = [e.name, ...(JSON.parse(e.aliases || "[]") as string[])];
    return names.some((name) => contentLower.includes(name.toLowerCase()));
  });

  const matchedIds = new Set(matched.map((e) => e.id));
  const hot = await entityRepo.getHotEntities(50);
  const combined = [...matched, ...hot.filter((e) => !matchedIds.has(e.id))];

  return combined.slice(0, 100);
}

/**
 * Format entities for injection into the LLM tagging prompt.
 */
export function formatEntitiesForPrompt(entities: Entity[]): string {
  if (entities.length === 0) return "";

  const lines = entities.map((e) => {
    const aliases = JSON.parse(e.aliases || "[]") as string[];
    const aliasStr = aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";
    const subtypeStr = e.subtype ? `, ${e.subtype}` : "";
    return `- ${e.id}: ${e.name}${aliasStr} [${e.source_type}${subtypeStr}]`;
  });

  return `\nKnown entities (match content to these when relevant):\n${lines.join("\n")}\n`;
}

/**
 * Resolve a person name found by the LLM that wasn't in the injected entity list.
 * 1. Exact name match in entities
 * 2. Fuzzy match (Jaro-Winkler >= 0.85) — auto-merge with alias
 * 3. No match — create tentative person entity
 *
 * Dormant legacy path retained for compatibility; new extraction flows should
 * use propose/materialize helpers and pass provenance explicitly.
 */
export async function resolveNewPerson(db: Kysely<DB>, name: string): Promise<Entity> {
  const entityRepo = createEntityRepository(db);

  const exact = await entityRepo.searchEntities(name, { sourceTypes: ["person"], limit: 1 });
  if (exact.length > 0 && exact[0].name.toLowerCase() === name.toLowerCase()) {
    return exact[0];
  }

  const candidates = await entityRepo.getEntitiesBySourceType("person");
  for (const candidate of candidates) {
    const names = [candidate.name, ...(JSON.parse(candidate.aliases || "[]") as string[])];
    for (const n of names) {
      if (jaroWinkler(name.toLowerCase(), n.toLowerCase()) >= JARO_WINKLER_THRESHOLD) {
        const aliases: string[] = JSON.parse(candidate.aliases || "[]");
        if (!aliases.some((a) => a.toLowerCase() === name.toLowerCase())) {
          aliases.push(name);
          await entityRepo.updateEntity(candidate.id, { aliases: JSON.stringify(aliases) });
        }
        return candidate;
      }
    }
  }

  return await entityRepo.upsertEntity({
    name,
    sourceType: "person",
    subtype: "external",
    status: "tentative",
    provenanceTier: "inferred",
  });
}
