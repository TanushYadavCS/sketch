export type ProvenanceTier = "declared" | "human_confirmed" | "structural" | "inferred";

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
