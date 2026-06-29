import { normalizeName } from "./name-normalize";

export const GENERIC_ENGAGEMENT_NAME_DENYLIST = new Set(
  [
    "cloud",
    "data & ai",
    "data and ai",
    "aml",
    "fraud",
    "risk",
    "compliance",
    "governance",
    "strategy",
    "tech vendor strategy",
    "vendor management tool",
    "vendor management tool/integrated view",
    "alignment with stakeholders",
    "priority rfps follow-ups",
    "dashboard",
    "new dashboard",
  ].map(normalizeName),
);

export const PROCESS_PHRASE_RE = /(follow[- ]?ups?|next steps|action items|updates?)$/i;

export function isGenericEngagementName(name: string): boolean {
  return GENERIC_ENGAGEMENT_NAME_DENYLIST.has(normalizeName(name)) || PROCESS_PHRASE_RE.test(name.trim());
}
