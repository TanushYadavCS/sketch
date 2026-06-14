import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import {
  type EntityProjectBindingRow,
  createEntityProjectBindingsRepository,
} from "../db/repositories/entity-project-bindings";
import type { DB } from "../db/schema";

const PART_OF = "part_of";
const GROUPING_SOURCE = "user_grouping";
const MAX_DEPTH = 32;

export type EffectiveBinding = EntityProjectBindingRow & { viaProjectId: string; origin: boolean };
export type GroupedProjectChild = { id: string; name: string };

export class ProjectBindingError extends Error {
  constructor(public code: "NOT_A_PROJECT" | "ALREADY_GROUPED" | "WOULD_CYCLE") {
    super(code);
  }
}

export async function isLiveProject(db: Kysely<DB>, entityId: string): Promise<boolean> {
  const row = await db
    .selectFrom("entities")
    .select(["source_type", "status", "deleted_at"])
    .where("id", "=", entityId)
    .executeTakeFirst();
  return Boolean(row && row.source_type === "project" && row.status === "confirmed" && row.deleted_at === null);
}

async function childrenOf(db: Kysely<DB>, parentId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("entity_relationships")
    .select("source_entity_id")
    .where("relationship_type", "=", PART_OF)
    .where("target_entity_id", "=", parentId)
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

async function subtreeIds(db: Kysely<DB>, rootId: string): Promise<string[]> {
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
      if (parentId === childId) throw new ProjectBindingError("WOULD_CYCLE");
      if (!(await isLiveProject(db, parentId)) || !(await isLiveProject(db, childId))) {
        throw new ProjectBindingError("NOT_A_PROJECT");
      }
      if ((await groupingParentOf(db, childId)) !== null) throw new ProjectBindingError("ALREADY_GROUPED");
      if ((await subtreeIds(db, childId)).includes(parentId)) throw new ProjectBindingError("WOULD_CYCLE");
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
