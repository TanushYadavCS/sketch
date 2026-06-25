/**
 * Profile-facts: the structured input that powers the entity drawer's "What"
 * row (Phase 1, deterministic) and — in Phase 2 — the Gemini-generated Signal
 * / So-what rows. Same fact set drives both, so a future stale-cache check can
 * hash this shape directly.
 */
import type { RelationListEntry } from "../db/repositories/entity-relationships";

export type DrawerEntityType = "person" | "company" | "product" | "project" | "team" | "system" | "other";

export const SYSTEM_SOURCE_TYPES = new Set(["clickup_workspace", "clickup_space"]);

export function mapSourceTypeToEntityType(sourceType: string): DrawerEntityType {
  switch (sourceType) {
    case "person":
      return "person";
    case "company":
      return "company";
    case "product":
      return "product";
    case "project":
      return "project";
    case "team":
      return "team";
    default:
      return SYSTEM_SOURCE_TYPES.has(sourceType) ? "system" : "other";
  }
}

export interface CompanyDomainFact {
  domain: string;
  confidence: number;
  isPrimary: boolean;
}

export interface EntityProfileFacts {
  entityId: string;
  name: string;
  sourceType: string;
  entityType: DrawerEntityType;
  metadata: Record<string, unknown> | null;
  mentionCount: number;
  sourceCounts: Record<string, number>;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  domainsForCompany: CompanyDomainFact[];
  crmActivityBrief: { summary: string; activityCount: number; updatedAt: string } | null;
  topRelationships: RelationListEntry[];
  incomingCounts: Record<string, number>;
  outgoingCounts: Record<string, number>;
}

function relativeDate(iso: string | null): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "today";
  const day = 24 * 60 * 60 * 1000;
  const days = Math.floor(diffMs / day);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

function findRelation(
  facts: EntityProfileFacts,
  type: string,
  direction: "outgoing" | "either",
): RelationListEntry | undefined {
  return facts.topRelationships.find(
    (r) => r.relationshipType === type && (direction === "either" || r.sourceEntityId === facts.entityId),
  );
}

function metadataString(meta: Record<string, unknown> | null, key: string): string | null {
  if (!meta) return null;
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Deterministic one-liner for the drawer's What row. Computed per-request
 * (cheap; no LLM) so it updates as soon as the underlying facts change.
 * No-LLM contract: this row never depends on Gemini and never goes through
 * the brief cache.
 */
export function buildWhatRow(facts: EntityProfileFacts): string {
  const sourceCount = Object.keys(facts.sourceCounts).length;
  const lastSeen = relativeDate(facts.lastSeenAt);

  switch (facts.entityType) {
    case "person": {
      const role = metadataString(facts.metadata, "role");
      const employer = findRelation(facts, "works_at", "outgoing")?.other.name ?? null;
      const head = `Person${role ? ` · ${role}` : ""}${employer ? ` at ${employer}` : ""}`;
      return `${head} · ${facts.mentionCount} mentions across ${sourceCount} ${sourceCount === 1 ? "source" : "sources"} · last seen ${lastSeen}`;
    }
    case "company": {
      const primary = facts.domainsForCompany.find((d) => d.isPrimary) ?? facts.domainsForCompany[0];
      const peopleCount = facts.incomingCounts.works_at ?? 0;
      const head = `Company${primary ? ` · ${primary.domain}` : ""}`;
      return `${head} · ${peopleCount} ${peopleCount === 1 ? "person" : "people"} · ${facts.mentionCount} mentions · last seen ${lastSeen}`;
    }
    case "product": {
      const builder = findRelation(facts, "builds", "either")?.other.name ?? null;
      const head = `Product${builder ? ` · built by ${builder}` : ""}`;
      return `${head} · ${facts.mentionCount} mentions · last seen ${lastSeen}`;
    }
    case "project": {
      const lead = findRelation(facts, "leads", "either")?.other.name ?? null;
      const head = `Project${lead ? ` · led by ${lead}` : ""}`;
      const contributors = facts.incomingCounts.contributes_to ?? 0;
      return `${head} · ${contributors} ${contributors === 1 ? "contributor" : "contributors"} · ${facts.mentionCount} mentions · last seen ${lastSeen}`;
    }
    case "team":
      return `Team · ${facts.mentionCount} mentions · last seen ${lastSeen}`;
    case "system":
      return `System container · ${facts.mentionCount} mentions`;
    default:
      return `${facts.sourceType} · ${facts.mentionCount} mentions · last seen ${lastSeen}`;
  }
}
