import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema";

export interface SuppressInput {
  normalizedName: string;
  entityType: string;
  originalEntityId?: string | null;
  reason?: string | null;
  createdBy: string;
}

/**
 * Durable suppression of entity (re)creation, keyed on
 * (normalized_name, entity_type). Written when an admin soft-deletes an entity
 * so the loose LLM creation paths don't re-mint the same junk. See
 * migration 102 and the consulting call sites in `materialize-llm-mentions.ts`
 * and `materialize-relations.ts`.
 */
export function createEntitySuppressionRepository(db: Kysely<DB>) {
  return {
    async isSuppressed(normalizedName: string, entityType: string): Promise<boolean> {
      const row = await db
        .selectFrom("entity_creation_suppressions")
        .select("id")
        .where("normalized_name", "=", normalizedName)
        .where("entity_type", "=", entityType)
        .executeTakeFirst();
      return Boolean(row);
    },

    /** Idempotent: a second suppression of the same (name, type) is a no-op. */
    async suppress(input: SuppressInput): Promise<void> {
      await db
        .insertInto("entity_creation_suppressions")
        .values({
          id: randomUUID(),
          normalized_name: input.normalizedName,
          entity_type: input.entityType,
          original_entity_id: input.originalEntityId ?? null,
          reason: input.reason ?? null,
          created_by: input.createdBy,
        })
        .onConflict((oc) => oc.columns(["normalized_name", "entity_type"]).doNothing())
        .execute();
    },

    async clear(normalizedName: string, entityType: string): Promise<void> {
      await db
        .deleteFrom("entity_creation_suppressions")
        .where("normalized_name", "=", normalizedName)
        .where("entity_type", "=", entityType)
        .execute();
    },
  };
}

export type EntitySuppressionRepository = ReturnType<typeof createEntitySuppressionRepository>;
