export type ProvenanceTier = "declared" | "human_confirmed" | "structural" | "inferred";

export const PRODUCT_MATCH_TARGET_PROVENANCE_TIERS = new Set<ProvenanceTier>(["declared", "human_confirmed"]);

const PROVENANCE_TIER_PRECEDENCE: Record<ProvenanceTier, number> = {
  inferred: 0,
  structural: 1,
  human_confirmed: 2,
  declared: 3,
};

export function strongestProvenanceTier(a: string | null | undefined, b: string | null | undefined): ProvenanceTier {
  const left = toProvenanceTier(a);
  const right = toProvenanceTier(b);
  return PROVENANCE_TIER_PRECEDENCE[left] >= PROVENANCE_TIER_PRECEDENCE[right] ? left : right;
}

function toProvenanceTier(value: string | null | undefined): ProvenanceTier {
  if (value === "declared" || value === "human_confirmed" || value === "structural" || value === "inferred") {
    return value;
  }
  return "inferred";
}

export function canUseEntityAsMatchTarget(
  entityType: string | null | undefined,
  provenanceTier: string | null | undefined,
): boolean {
  if (entityType !== "product") return true;
  return provenanceTier === "declared" || provenanceTier === "human_confirmed";
}
