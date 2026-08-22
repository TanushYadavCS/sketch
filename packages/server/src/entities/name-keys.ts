/**
 * Canonicalize a person name for cross-map lookups. Lowercase, collapse
 * internal whitespace, strip trailing `.`/`,`. Conservative on purpose —
 * a stricter normalizer would risk spurious cross-name collisions.
 *
 * Used by every map that resolves speaker / attendee names to emails:
 * Fireflies' in-meeting `emailByName` and `contactsByName`, plus the
 * sync-dispatcher's `personEmailByName` and `userEmailByName`.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeEntityMatchName(entityType: string, name: string): string {
  if (entityType !== "product") return normalizeName(name);
  return normalizeName(
    name
      .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " "),
  );
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

/** Compact keys below this length are too short to be evidence on their own. */
export const MIN_COMPACT_NAME_KEY_LENGTH = 3;

/**
 * Normalize a name to a comparable key. Lowercase, collapse whitespace,
 * strip middle initials (one-letter tokens followed by an optional period).
 * Used to match attendee names to action-item owner names across minor
 * formatting variation ("Vedant Parikh" vs "Vedant K. Parikh" vs "vedant
 * parikh").
 */
export function normalizeParticipantNameKey(name: string): string {
  return name
    .toLowerCase()
    .split(/\s+/)
    .filter((tok) => tok.length > 0)
    .filter((tok) => !/^[a-z]\.?$/.test(tok))
    .join(" ");
}
