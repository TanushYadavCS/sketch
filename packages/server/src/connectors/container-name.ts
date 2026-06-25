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
