/**
 * Deterministic duplicate grouping for company entities.
 *
 * Three edge types, all deterministic — no LLM, no fuzzy scoring:
 *   - `domain`     two companies hold the same corporate domain in `entity_domains`
 *   - `name`       their compact name keys are equal (`One Stop` == `Onestop`)
 *   - `name_alias` one company's name equals another's committed alias, exactly
 *
 * Union-find over those edges yields groups. The groups are the unit that
 * downstream consumers should reason about: a company shard that carries no
 * domain of its own still belongs to the same real-world company as the shard
 * that does, so own-org exclusion has to travel across the whole group rather
 * than stopping at the row holding the domain.
 */
import type { Kysely } from "kysely";
import { normalizeName } from "../connectors/name-normalize";
import { whereLiveEntity } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { compactEntityNameKey } from "./match-normalize";

export type CompanyDedupEdgeKind = "domain" | "name" | "name_alias";

/** Compact keys below this length are too short to be evidence on their own. */
const MIN_COMPACT_NAME_KEY_LENGTH = 3;

export interface CompanyDedupMember {
  entityId: string;
  name: string;
  aliases: string[];
  corporateDomains: string[];
  mentionFileCount: number;
  createdAt: string;
  status: string;
  /** The entity itself holds a domain listed in `organization_domains`. */
  ownOrgSeed: boolean;
}

export interface CompanyDedupEdge {
  kind: CompanyDedupEdgeKind;
  value: string;
  entityIds: string[];
}

export interface CompanyDedupGroup {
  members: CompanyDedupMember[];
  edges: CompanyDedupEdge[];
  /** True when any member is an own-org seed — the whole group is then own-org. */
  ownOrg: boolean;
}

function createUnionFind(ids: string[]) {
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  function find(id: string): string {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }
  return {
    find,
    union(a: string, b: string): void {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootA, rootB);
    },
  };
}

function collectEdges(members: CompanyDedupMember[]): CompanyDedupEdge[] {
  const byDomain = new Map<string, Set<string>>();
  const byCompactName = new Map<string, Set<string>>();
  const nameKeyByEntity = new Map<string, string>();
  const entitiesByAliasKey = new Map<string, Set<string>>();

  for (const member of members) {
    for (const domain of member.corporateDomains) {
      const key = domain.trim().toLowerCase();
      if (!key) continue;
      const bucket = byDomain.get(key);
      if (bucket) bucket.add(member.entityId);
      else byDomain.set(key, new Set([member.entityId]));
    }

    const compact = compactEntityNameKey("company", member.name);
    if (compact.length >= MIN_COMPACT_NAME_KEY_LENGTH) {
      const bucket = byCompactName.get(compact);
      if (bucket) bucket.add(member.entityId);
      else byCompactName.set(compact, new Set([member.entityId]));
    }

    const nameKey = normalizeName(member.name);
    if (nameKey) nameKeyByEntity.set(member.entityId, nameKey);
    for (const alias of member.aliases) {
      const aliasKey = normalizeName(alias);
      if (!aliasKey) continue;
      const bucket = entitiesByAliasKey.get(aliasKey);
      if (bucket) bucket.add(member.entityId);
      else entitiesByAliasKey.set(aliasKey, new Set([member.entityId]));
    }
  }

  const edges: CompanyDedupEdge[] = [];
  for (const [value, ids] of byDomain) {
    if (ids.size > 1) edges.push({ kind: "domain", value, entityIds: [...ids].sort() });
  }
  for (const [value, ids] of byCompactName) {
    if (ids.size > 1) edges.push({ kind: "name", value, entityIds: [...ids].sort() });
  }
  for (const [entityId, nameKey] of nameKeyByEntity) {
    const holders = entitiesByAliasKey.get(nameKey);
    if (!holders) continue;
    const others = [...holders].filter((id) => id !== entityId);
    if (others.length === 0) continue;
    edges.push({ kind: "name_alias", value: nameKey, entityIds: [entityId, ...others].sort() });
  }

  return edges.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value) || a.entityIds[0].localeCompare(b.entityIds[0]),
  );
}

/**
 * Union-find over the three deterministic edge types. Returns every group,
 * including singletons, so callers can use it as a complete partition of the
 * input. Members and groups are ordered deterministically.
 */
export function buildCompanyDedupGroups(
  members: CompanyDedupMember[],
  allowedEdgeKinds?: ReadonlySet<CompanyDedupEdgeKind>,
): CompanyDedupGroup[] {
  const edges = collectEdges(members).filter((edge) => !allowedEdgeKinds || allowedEdgeKinds.has(edge.kind));
  const uf = createUnionFind(members.map((member) => member.entityId));
  for (const edge of edges) {
    for (let i = 1; i < edge.entityIds.length; i += 1) uf.union(edge.entityIds[0], edge.entityIds[i]);
  }

  const membersByRoot = new Map<string, CompanyDedupMember[]>();
  for (const member of members) {
    const root = uf.find(member.entityId);
    const bucket = membersByRoot.get(root);
    if (bucket) bucket.push(member);
    else membersByRoot.set(root, [member]);
  }

  const edgesByRoot = new Map<string, CompanyDedupEdge[]>();
  for (const edge of edges) {
    const root = uf.find(edge.entityIds[0]);
    const bucket = edgesByRoot.get(root);
    if (bucket) bucket.push(edge);
    else edgesByRoot.set(root, [edge]);
  }

  return [...membersByRoot.entries()]
    .map(([root, groupMembers]) => ({
      members: [...groupMembers].sort((a, b) => a.name.localeCompare(b.name) || a.entityId.localeCompare(b.entityId)),
      edges: edgesByRoot.get(root) ?? [],
      ownOrg: groupMembers.some((member) => member.ownOrgSeed),
    }))
    .sort(
      (a, b) =>
        b.members.length - a.members.length ||
        a.members[0].name.localeCompare(b.members[0].name) ||
        a.members[0].entityId.localeCompare(b.members[0].entityId),
    );
}

/**
 * Every company id that own-org exclusion should cover. A shard with no domain
 * of its own is still our own org when it shares a duplicate group with a shard
 * that holds an `organization_domains` domain, so exclusion is group-wide.
 */
export function ownOrgCompanyIds(groups: CompanyDedupGroup[]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    if (!group.ownOrg) continue;
    for (const member of group.members) ids.add(member.entityId);
  }
  return ids;
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Read-only load of every live company plus the evidence the grouping needs.
 * File-mention counts are distinct non-archived files, matching how the rest of
 * the pipeline counts entity evidence.
 */
export async function loadCompanyDedupMembers(db: Kysely<DB>): Promise<CompanyDedupMember[]> {
  const companies = await db
    .selectFrom("entities")
    .select(["id", "name", "aliases", "created_at", "status"])
    .where("source_type", "=", "company")
    .where(whereLiveEntity())
    .execute();
  if (companies.length === 0) return [];

  const companyIds = companies.map((row) => row.id);

  const domainRows = await db
    .selectFrom("entity_domains")
    .select(["entity_id", "domain"])
    .where("kind", "=", "corporate")
    .where("entity_id", "in", companyIds)
    .execute();
  const domainsByEntity = new Map<string, string[]>();
  for (const row of domainRows) {
    if (!row.entity_id) continue;
    const domain = row.domain.trim().toLowerCase();
    const bucket = domainsByEntity.get(row.entity_id);
    if (bucket) bucket.push(domain);
    else domainsByEntity.set(row.entity_id, [domain]);
  }

  const orgDomainRows = await db.selectFrom("organization_domains").select("domain").execute();
  const orgDomains = new Set(orgDomainRows.map((row) => row.domain.trim().toLowerCase()));

  const mentionRows = await db
    .selectFrom("entity_mentions")
    .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
    .select([
      "entity_mentions.entity_id",
      db.fn.count<number>("entity_mentions.indexed_file_id").distinct().as("count"),
    ])
    .where("entity_mentions.entity_id", "in", companyIds)
    .where("indexed_files.is_archived", "=", 0)
    .groupBy("entity_mentions.entity_id")
    .execute();
  const mentionCounts = new Map(mentionRows.map((row) => [row.entity_id, Number(row.count)]));

  return companies.map((row) => {
    const corporateDomains = (domainsByEntity.get(row.id) ?? []).sort();
    return {
      entityId: row.id,
      name: row.name,
      aliases: parseAliases(row.aliases),
      corporateDomains,
      mentionFileCount: mentionCounts.get(row.id) ?? 0,
      createdAt: row.created_at,
      status: row.status,
      ownOrgSeed: corporateDomains.some((domain) => orgDomains.has(domain)),
    };
  });
}

/**
 * Group-wide own-org company ids, loaded straight from the database. This is
 * the seam any caller that today derives own-org companies from
 * `organization_domains` ∩ `entity_domains` should use instead: that derivation
 * only sees the shard holding the domain, and leaves every other shard of the
 * same org looking like an outside company.
 */
export async function loadOwnOrgCompanyIds(db: Kysely<DB>): Promise<Set<string>> {
  return ownOrgCompanyIds(buildCompanyDedupGroups(await loadCompanyDedupMembers(db)));
}

/**
 * Canonical survivor for a group: a member holding a corporate domain wins,
 * then most file mentions, then oldest, then id. Domain first because the
 * domain is the only externally verifiable identity a company row carries.
 */
export function chooseCanonicalCompany(group: CompanyDedupGroup): CompanyDedupMember {
  return [...group.members].sort((a, b) => {
    const domainRank = Number(b.corporateDomains.length > 0) - Number(a.corporateDomains.length > 0);
    if (domainRank !== 0) return domainRank;
    if (b.mentionFileCount !== a.mentionFileCount) return b.mentionFileCount - a.mentionFileCount;
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
    return a.entityId.localeCompare(b.entityId);
  })[0];
}
