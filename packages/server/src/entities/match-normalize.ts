import { normalizeName } from "../connectors/name-normalize";

export function normalizeEntityMatchName(entityType: string, name: string): string {
  if (entityType !== "product") return normalizeName(name);
  return normalizeName(
    name
      .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " "),
  );
}

export function normalizeMatchName(entityType: string, name: string): string {
  return normalizeEntityMatchName(entityType, name);
}

/**
 * Exact whole-string equality of `query` against an entity's own name or one of
 * its committed aliases — case-insensitive, trimmed, inner whitespace collapsed.
 *
 * This is deliberately not substring matching, which is why it is safe for
 * values too short for the substring matcher's minimum length: the alias "OW"
 * matches the query "OW" and never matches inside "NOW" or "power". A short
 * string that is nobody's committed alias, like "of", still matches nothing.
 */
export function matchesNameOrAliasExactly(query: string, candidate: { name: string; aliases: string[] }): boolean {
  const needle = normalizeName(query);
  if (!needle) return false;
  if (normalizeName(candidate.name) === needle) return true;
  return candidate.aliases.some((alias) => normalizeName(alias) === needle);
}

/**
 * Whitespace-free match key: the normalized name with separators folded away.
 * `One Stop`, `Onestop` and `one-stop` all collapse to `onestop`. Used by the
 * domain↔name comparison in the entity-domains repository and by company
 * duplicate grouping, so both agree on what "the same compact name" means.
 */
export function compactEntityNameKey(entityType: string, value: string): string {
  return normalizeEntityMatchName(entityType, value.replace(/[._-]+/g, " ")).replace(/\s+/g, "");
}
