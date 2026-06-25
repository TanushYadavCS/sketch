import { tokenizeName } from "../entities/name-tokenize";

export function qualifyContainerName(leaf: string, qualifier: string | null): string {
  const trimmedLeaf = leaf.trim();
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedLeaf || !trimmedQualifier) return leaf;

  const leafTokens = new Set(tokenizeName(trimmedLeaf));
  const qualifierTokens = tokenizeName(trimmedQualifier);
  if (qualifierTokens.length > 0 && qualifierTokens.every((token) => leafTokens.has(token))) return leaf;

  return `${trimmedQualifier} ${trimmedLeaf}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const nested = value[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;
}

function rawAliases(raw: Record<string, unknown>): string[] {
  const aliases = raw.aliases;
  if (!Array.isArray(aliases)) return [];
  return aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0);
}

function unionAlias(aliases: string[], alias: string): string[] {
  const trimmed = alias.trim();
  if (!trimmed || aliases.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return aliases;
  return [...aliases, trimmed];
}

/**
 * The scope qualifier carried in a structural seed's raw metadata: the single
 * Linear team or the ClickUp space. Mirrors the connector emit logic so that
 * replaying a pre-qualification fact (bare `subject_name`, no `aliases`)
 * recovers the same qualified name the live sync would now produce.
 */
export function readSeedQualifier(source: string, raw: Record<string, unknown>): string | null {
  const metadata = readNestedRecord(raw, "metadata");
  if (!metadata) return null;
  if (source === "linear") {
    const teams = metadata.teams;
    if (!Array.isArray(teams) || teams.length !== 1) return null;
    return readString(teams[0]);
  }
  if (source === "clickup") return readString(metadata.spaceName);
  return null;
}

/**
 * Durable, replay-safe qualification for a container seed. Derives the
 * qualified name from the fact's raw metadata rather than trusting a possibly
 * bare `subject_name`, and is idempotent on an already-qualified fact (the
 * token guard in `qualifyContainerName` prevents double-qualification).
 */
export function deriveQualifiedSeedName(params: {
  source: string;
  subjectName: string;
  raw: Record<string, unknown>;
}): { name: string; aliases: string[] } {
  const metadataAliases = rawAliases(params.raw);
  const leaf = readString(params.raw.name) ?? params.subjectName;
  const qualified = qualifyContainerName(leaf, readSeedQualifier(params.source, params.raw));
  const aliases = qualified === leaf ? metadataAliases : unionAlias(metadataAliases, leaf);
  return { name: qualified, aliases };
}
