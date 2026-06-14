import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { DB, EntityProjectBindingsTable } from "../schema";

export type EntityProjectBindingRow = {
  id: string;
  entityId: string;
  source: string;
  containerId: string;
  containerKind: string;
  label: string | null;
  connectorConfigId: string | null;
};

export interface CreateBindingInput {
  entityId: string;
  source: string;
  containerId: string;
  containerKind: string;
  label?: string | null;
  connectorConfigId?: string | null;
  createdBy: string;
}

function toRow(r: Selectable<EntityProjectBindingsTable>): EntityProjectBindingRow {
  return {
    id: r.id,
    entityId: r.entity_id,
    source: r.source,
    containerId: r.container_id,
    containerKind: r.container_kind,
    label: r.label,
    connectorConfigId: r.connector_config_id,
  };
}

export function createEntityProjectBindingsRepository(db: Kysely<DB>) {
  return {
    async create(input: CreateBindingInput): Promise<EntityProjectBindingRow> {
      const id = randomUUID();
      await db
        .insertInto("entity_project_bindings")
        .values({
          id,
          entity_id: input.entityId,
          source: input.source,
          container_id: input.containerId,
          container_kind: input.containerKind,
          label: input.label ?? null,
          connector_config_id: input.connectorConfigId ?? null,
          created_by: input.createdBy,
        })
        .execute();
      const row = await db
        .selectFrom("entity_project_bindings")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return toRow(row);
    },

    async deleteById(id: string, entityId: string): Promise<boolean> {
      const res = await db
        .deleteFrom("entity_project_bindings")
        .where("id", "=", id)
        .where("entity_id", "=", entityId)
        .executeTakeFirst();
      return Number(res.numDeletedRows ?? 0n) > 0;
    },

    async listForEntities(entityIds: string[]): Promise<EntityProjectBindingRow[]> {
      if (entityIds.length === 0) return [];
      const rows = await db
        .selectFrom("entity_project_bindings")
        .selectAll()
        .where("entity_id", "in", entityIds)
        .execute();
      return rows.map(toRow);
    },
  };
}
