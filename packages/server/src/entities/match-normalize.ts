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
