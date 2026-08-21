import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { whereLiveEntity } from "../db/repositories/entities";
import {
  type EntityProjectBindingRow,
  createEntityProjectBindingsRepository,
} from "../db/repositories/entity-project-bindings";
import type { DB } from "../db/schema";

const PART_OF = "part_of";
const ENGAGEMENT_FOR = "engagement_for";
const GROUPING_SOURCE = "user_grouping";
const MAX_DEPTH = 32;

export type EffectiveBinding = EntityProjectBindingRow & { viaProjectId: string; origin: boolean };
export type GroupedProjectChild = { id: string; name: string };

export class ProjectBindingError extends Error {
  constructor(
    public code: "NOT_A_PROJECT" | "ALREADY_GROUPED" | "WOULD_CYCLE" | "NOT_A_COMPANY" | "COMPANY_ON_NESTED",
  ) {
    super(code);
  }
}

export async function isLiveProject(db: Kysely<DB>, entityId: string): Promise<boolean> {
  const row = await db
    .selectFrom("entities")
    .select(["source_type", "status", "deleted_at", "merged_into_entity_id"])
    .where("id", "=", entityId)
    .executeTakeFirst();
  return Boolean(
    row &&
      row.source_type === "project" &&
      row.status === "confirmed" &&
      row.deleted_at === null &&
      row.merged_into_entity_id === null,
  );
}

async function childrenOf(db: Kysely<DB>, parentId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("entity_relationships as r")
    .innerJoin("entities as e", "e.id", "r.source_entity_id")
    .select("r.source_entity_id")
    .where("r.relationship_type", "=", PART_OF)
    .where("r.target_entity_id", "=", parentId)
    .where(whereLiveEntity("e"))
    .execute();
  return rows.map((r) => r.source_entity_id);
}

async function groupingParentOf(db: Kysely<DB>, childId: string): Promise<string | null> {
  const row = await db
    .selectFrom("entity_relationships")
    .select("target_entity_id")
    .where("relationship_type", "=", PART_OF)
    .where("source", "=", GROUPING_SOURCE)
    .where("source_entity_id", "=", childId)
    .executeTakeFirst();
  return row?.target_entity_id ?? null;
}

export async function subtreeIds(db: Kysely<DB>, rootId: string): Promise<string[]> {
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  let depth = 0;
  while (frontier.length > 0 && depth < MAX_DEPTH) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of await childrenOf(db, id)) {
        if (!seen.has(child)) {
          seen.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  return [...seen];
}

/**
 * Shared cycle guard for every part_of writer, not just user grouping: adding
 * child→parent is illegal when the parent already sits inside the child's
 * subtree. The BFS is source-agnostic on purpose — a cycle through a
 * different writer's edges is still a cycle.
 */
export async function assertNoPartOfCycle(db: Kysely<DB>, childId: string, parentId: string): Promise<void> {
  if (childId === parentId) throw new ProjectBindingError("WOULD_CYCLE");
  if ((await subtreeIds(db, childId)).includes(parentId)) throw new ProjectBindingError("WOULD_CYCLE");
}

/**
 * Trust rank for picking one edge among several of the same type: a human
 * edit beats a reviewed minting verdict beats anything the loose LLM paths
 * wrote. Lower is better; ties break by age (oldest first) at call sites.
 */
export function rankRelationshipSource(source: string): number {
  if (source === GROUPING_SOURCE) return 0;
  if (source === "project_minting_acceptance") return 1;
  return 2;
}

type RankedEdge = { targetEntityId: string; source: string };

async function activeEdgesOf(db: Kysely<DB>, sourceEntityId: string, relationshipType: string): Promise<RankedEdge[]> {
  const rows = await db
    .selectFrom("entity_relationships as r")
    .innerJoin("entities as target", "target.id", "r.target_entity_id")
    .select(["r.target_entity_id", "r.source"])
    .where("r.relationship_type", "=", relationshipType)
    .where("r.source_entity_id", "=", sourceEntityId)
    .where("r.valid_to", "is", null)
    .where(whereLiveEntity("target"))
    .orderBy("r.created_at", "asc")
    .orderBy("r.id", "asc")
    .execute();
  return rows
    .map((row) => ({ targetEntityId: row.target_entity_id, source: row.source }))
    .sort((a, b) => rankRelationshipSource(a.source) - rankRelationshipSource(b.source));
}

async function activeParentOf(db: Kysely<DB>, childId: string): Promise<string | null> {
  const edges = await activeEdgesOf(db, childId, PART_OF);
  return edges[0]?.targetEntityId ?? null;
}

async function engagementCompanyOf(db: Kysely<DB>, projectId: string): Promise<string | null> {
  const edges = await activeEdgesOf(db, projectId, ENGAGEMENT_FOR);
  return edges[0]?.targetEntityId ?? null;
}

async function isLiveGroupingParentTarget(db: Kysely<DB>, entityId: string): Promise<boolean> {
  const row = await db
    .selectFrom("entities")
    .select(["source_type", "status", "deleted_at", "merged_into_entity_id"])
    .where("id", "=", entityId)
    .executeTakeFirst();
  return Boolean(
    row &&
      (row.source_type === "project" || row.source_type === "product") &&
      row.status === "confirmed" &&
      row.deleted_at === null &&
      row.merged_into_entity_id === null,
  );
}

async function isLiveConfirmedCompany(db: Kysely<DB>, entityId: string): Promise<boolean> {
  const row = await db
    .selectFrom("entities")
    .select(["source_type", "status", "deleted_at", "merged_into_entity_id"])
    .where("id", "=", entityId)
    .executeTakeFirst();
  return Boolean(
    row &&
      row.source_type === "company" &&
      row.status === "confirmed" &&
      row.deleted_at === null &&
      row.merged_into_entity_id === null,
  );
}

async function insertGroupingEdge(
  tx: Kysely<DB>,
  sourceEntityId: string,
  targetEntityId: string,
  relationshipType: string,
): Promise<void> {
  await sql`
    INSERT INTO entity_relationships
      (id, source_entity_id, target_entity_id, relationship_type, confidence, confidence_score, source, valid_from, valid_to, created_at, updated_at)
    VALUES
      (${randomUUID()}, ${sourceEntityId}, ${targetEntityId}, ${relationshipType}, 'CONFIRMED', 1, ${GROUPING_SOURCE}, '', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (source_entity_id, target_entity_id, relationship_type, valid_from)
    DO UPDATE SET source = EXCLUDED.source, updated_at = CURRENT_TIMESTAMP
  `.execute(tx);
}

export type ProjectStructureInput = {
  /** Present = rewrite the parent; string nests, null un-nests. Absent = leave part_of alone. */
  parentEntityId?: string | null;
  /** Present = rewrite the client company; string assigns, null clears. Absent = derive on un-nest. */
  companyEntityId?: string | null;
};

/**
 * Rewrite a project's structural edges — part_of parent and/or
 * engagement_for company — as ONE validated transaction. Unlike
 * groupProject this replaces edges from ANY source (acceptance writes
 * part_of under its own source) and never throws ALREADY_GROUPED.
 *
 * Everything is validated before anything is written, so a mixed request
 * (un-nest + bad company) can never leave a partial apply behind. The two
 * rewrites can't be separate helpers with their own transactions: Kysely
 * forbids nesting, and two sequential transactions would not be atomic.
 *
 * Un-nesting without an explicit company keeps the child in the section
 * the user sees (the old root's): accepted children carry no
 * engagement_for edge of their own, and children with junk llm_extraction
 * edges must not jump sections. Only a prior user_grouping company edge —
 * an earlier human override — survives untouched.
 */
export async function restructureProject(
  db: Kysely<DB>,
  projectId: string,
  input: ProjectStructureInput,
): Promise<void> {
  const parentGiven = input.parentEntityId !== undefined;
  const companyGiven = input.companyEntityId !== undefined;
  if (!parentGiven && !companyGiven) return;
  if (!(await isLiveProject(db, projectId))) throw new ProjectBindingError("NOT_A_PROJECT");

  const parentId = input.parentEntityId ?? null;
  if (parentGiven && parentId !== null) {
    if (!(await isLiveGroupingParentTarget(db, parentId))) throw new ProjectBindingError("NOT_A_PROJECT");
    await assertNoPartOfCycle(db, projectId, parentId);
  }

  const companyId = input.companyEntityId ?? null;
  if (companyGiven) {
    if (companyId !== null && !(await isLiveConfirmedCompany(db, companyId))) {
      throw new ProjectBindingError("NOT_A_COMPANY");
    }
    if (!parentGiven && (await activeParentOf(db, projectId)) !== null) {
      throw new ProjectBindingError("COMPANY_ON_NESTED");
    }
  }

  let reanchorCompanyId: string | null = null;
  let reanchor = false;
  if (parentGiven && parentId === null && !companyGiven) {
    const ownEdges = await activeEdgesOf(db, projectId, ENGAGEMENT_FOR);
    reanchor = !ownEdges.some((edge) => edge.source === GROUPING_SOURCE);
    if (reanchor) {
      let rootId = projectId;
      for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
        const parent = await activeParentOf(db, rootId);
        if (parent === null) break;
        rootId = parent;
      }
      reanchorCompanyId = rootId === projectId ? null : await engagementCompanyOf(db, rootId);
    }
  }

  await db.transaction().execute(async (tx) => {
    if (parentGiven) {
      await tx
        .deleteFrom("entity_relationships")
        .where("relationship_type", "=", PART_OF)
        .where("source_entity_id", "=", projectId)
        .execute();
      if (parentId !== null) {
        await insertGroupingEdge(tx, projectId, parentId, PART_OF);
      } else if (reanchor) {
        await tx
          .deleteFrom("entity_relationships")
          .where("relationship_type", "=", ENGAGEMENT_FOR)
          .where("source_entity_id", "=", projectId)
          .execute();
        if (reanchorCompanyId !== null) {
          await insertGroupingEdge(tx, projectId, reanchorCompanyId, ENGAGEMENT_FOR);
        }
      }
    }
    if (companyGiven) {
      await tx
        .deleteFrom("entity_relationships")
        .where("relationship_type", "=", ENGAGEMENT_FOR)
        .where("source_entity_id", "=", projectId)
        .execute();
      if (companyId !== null) {
        await insertGroupingEdge(tx, projectId, companyId, ENGAGEMENT_FOR);
      }
    }
  });
}

export function createProjectBindingsService(db: Kysely<DB>) {
  const bindings = createEntityProjectBindingsRepository(db);

  async function ownBindings(entityId: string): Promise<EntityProjectBindingRow[]> {
    const explicit = await bindings.listForEntities([entityId]);
    const refs = await db
      .selectFrom("entity_source_refs")
      .select(["id", "source", "source_id"])
      .where("entity_id", "=", entityId)
      .execute();
    const origin: EntityProjectBindingRow[] = refs.map((r) => ({
      id: `origin:${r.id}`,
      entityId,
      source: r.source,
      containerId: r.source_id,
      containerKind: `${r.source}_origin`,
      label: null,
      connectorConfigId: null,
    }));
    return [...origin, ...explicit];
  }

  async function resolveEffectiveBindings(projectId: string): Promise<EffectiveBinding[]> {
    const nodes = await subtreeIds(db, projectId);
    const out: EffectiveBinding[] = [];
    const seenKey = new Set<string>();
    for (const node of nodes) {
      for (const b of await ownBindings(node)) {
        const key = `${b.source}:${b.containerId}`;
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        out.push({ ...b, viaProjectId: node, origin: b.id.startsWith("origin:") });
      }
    }
    return out;
  }

  return {
    resolveEffectiveBindings,

    async listBindings(projectId: string, effective: boolean): Promise<EffectiveBinding[] | EntityProjectBindingRow[]> {
      if (effective) return resolveEffectiveBindings(projectId);
      return ownBindings(projectId);
    },

    async listGroupedChildren(projectId: string): Promise<GroupedProjectChild[]> {
      return db
        .selectFrom("entity_relationships")
        .innerJoin("entities", "entities.id", "entity_relationships.source_entity_id")
        .select(["entities.id", "entities.name"])
        .where("entity_relationships.relationship_type", "=", PART_OF)
        .where("entity_relationships.source", "=", GROUPING_SOURCE)
        .where("entity_relationships.target_entity_id", "=", projectId)
        .where("entities.deleted_at", "is", null)
        .where("entities.merged_into_entity_id", "is", null)
        .orderBy("entities.name")
        .execute();
    },

    async addBinding(
      projectId: string,
      input: {
        source: string;
        containerId: string;
        containerKind: string;
        label?: string | null;
        connectorConfigId?: string | null;
      },
      userId: string,
    ): Promise<EntityProjectBindingRow> {
      if (!(await isLiveProject(db, projectId))) throw new ProjectBindingError("NOT_A_PROJECT");
      return bindings.create({
        entityId: projectId,
        source: input.source,
        containerId: input.containerId,
        containerKind: input.containerKind,
        label: input.label ?? null,
        connectorConfigId: input.connectorConfigId ?? null,
        createdBy: userId,
      });
    },

    async removeBinding(projectId: string, bindingId: string): Promise<boolean> {
      return bindings.deleteById(bindingId, projectId);
    },

    async groupProject(parentId: string, childId: string): Promise<void> {
      if (!(await isLiveProject(db, parentId)) || !(await isLiveProject(db, childId))) {
        throw new ProjectBindingError("NOT_A_PROJECT");
      }
      if ((await groupingParentOf(db, childId)) !== null) throw new ProjectBindingError("ALREADY_GROUPED");
      await assertNoPartOfCycle(db, childId, parentId);
      await sql`
        INSERT INTO entity_relationships
          (id, source_entity_id, target_entity_id, relationship_type, confidence, confidence_score, source, valid_from, valid_to, created_at, updated_at)
        VALUES
          (${randomUUID()}, ${childId}, ${parentId}, ${PART_OF}, 'CONFIRMED', 1, ${GROUPING_SOURCE}, '', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (source_entity_id, target_entity_id, relationship_type, valid_from)
        DO UPDATE SET source = EXCLUDED.source, updated_at = CURRENT_TIMESTAMP
      `.execute(db);
    },

    async ungroupProject(parentId: string, childId: string): Promise<void> {
      await db
        .deleteFrom("entity_relationships")
        .where("relationship_type", "=", PART_OF)
        .where("source", "=", GROUPING_SOURCE)
        .where("source_entity_id", "=", childId)
        .where("target_entity_id", "=", parentId)
        .execute();
    },
  };
}
