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
 * Whitespace-free match key: the normalized name with separators folded away.
 * `One Stop`, `Onestop` and `one-stop` all collapse to `onestop`. Used by the
 * domain↔name comparison in the entity-domains repository and by company
 * duplicate grouping, so both agree on what "the same compact name" means.
 */
export function compactEntityNameKey(entityType: string, value: string): string {
  return normalizeEntityMatchName(entityType, value.replace(/[._-]+/g, " ")).replace(/\s+/g, "");
}
