import { createHash } from "node:crypto";
import { normalizeName } from "./name-keys";

export const SUB_ENTITY_SIGNATURE_DELIM = "\x1f";

export function seriesKeyFor(parentScopeKey: string, kind: string, normalizedName: string): string {
  return createHash("sha256")
    .update([parentScopeKey, kind, normalizedName].join(SUB_ENTITY_SIGNATURE_DELIM))
    .digest("hex");
}

export function defaultValueSignature(displayName: string): string {
  return normalizeName(displayName);
}

export function valueSignatureForParts(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(SUB_ENTITY_SIGNATURE_DELIM)).digest("hex");
}
