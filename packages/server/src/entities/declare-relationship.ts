import type { Kysely } from "kysely";
import { isPg } from "../db/dialect";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";
import { strongestProvenanceTier } from "./provenance";
import { DECLARED_RELATIONSHIP_SOURCE } from "./relationship-provenance";

/**
 * Manual person→company links. The vocabulary is deliberately closed:
 * `works_at` is single-employer (declaring replaces any prior *declared*
 * works_at for that person; inferred rows are left for read-time precedence),
 * `engaged_with` is many-to-many and additive. Project→company declarations
 * go through `restructureProject` — no second path here.
 *
 * Declaring also promotes both endpoints to at least `human_confirmed`: a
 * declared edge on an inferred endpoint would die with the endpoint on graph
 * reset, and asserting the link is a human confirmation that both ends exist.
 */

export type DeclarableRelationshipType = "works_at" | "engaged_with";

export class DeclareRelationshipError extends Error {
  constructor(
    public code: "ENTITY_NOT_FOUND" | "NOT_A_PERSON" | "NOT_A_COMPANY" | "UNSUPPORTED_TYPE",
    message: string,
  ) {
    super(message);
  }
}

export interface DeclareRelationshipResult {
  relationshipId: string;
  replacedRelationshipIds: string[];
}

async function loadLiveEntity(db: Kysely<DB>, id: string): Promise<{ id: string; source_type: string | null }> {
  const row = await db
    .selectFrom("entities")
    .select(["id", "source_type"])
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new DeclareRelationshipError("ENTITY_NOT_FOUND", `entity ${id} not found`);
  return row;
}

async function promoteEndpoint(db: Kysely<DB>, id: string): Promise<void> {
  const row = await db.selectFrom("entities").select("provenance_tier").where("id", "=", id).executeTakeFirstOrThrow();
  const next = strongestProvenanceTier(row.provenance_tier, "human_confirmed");
  if (next === row.provenance_tier) return;
  await db
    .updateTable("entities")
    .set({ provenance_tier: next, updated_at: new Date().toISOString() })
    .where("id", "=", id)
    .execute();
}

/**
 * Runs in one transaction so a failure between the replacement delete, the
 * declared upsert, and the endpoint promotions cannot strand partial state.
 * On Postgres the person row is locked first, serializing concurrent
 * declarations for the same person (SQLite serializes writers on its own).
 */
export async function declareRelationship(
  db: Kysely<DB>,
  input: { personEntityId: string; companyEntityId: string; relationshipType: DeclarableRelationshipType },
): Promise<DeclareRelationshipResult> {
  if (input.relationshipType !== "works_at" && input.relationshipType !== "engaged_with") {
    throw new DeclareRelationshipError("UNSUPPORTED_TYPE", `cannot declare ${input.relationshipType}`);
  }
  return db.transaction().execute(async (trx) => {
    if (isPg(trx)) {
      await trx
        .selectFrom("entities")
        .select("id")
        .where("id", "=", input.personEntityId)
        .forUpdate()
        .executeTakeFirst();
    }
    const person = await loadLiveEntity(trx, input.personEntityId);
    const company = await loadLiveEntity(trx, input.companyEntityId);
    if (person.source_type !== "person") {
      throw new DeclareRelationshipError("NOT_A_PERSON", `entity ${person.id} is not a person`);
    }
    if (company.source_type !== "company") {
      throw new DeclareRelationshipError("NOT_A_COMPANY", `entity ${company.id} is not a company`);
    }

    const replacedRelationshipIds: string[] = [];
    if (input.relationshipType === "works_at") {
      const priorDeclared = await trx
        .selectFrom("entity_relationships")
        .select("id")
        .where("source_entity_id", "=", person.id)
        .where("relationship_type", "=", "works_at")
        .where("source", "=", DECLARED_RELATIONSHIP_SOURCE)
        .where("target_entity_id", "!=", company.id)
        .execute();
      if (priorDeclared.length > 0) {
        const ids = priorDeclared.map((row) => row.id);
        await trx.deleteFrom("entity_relationships").where("id", "in", ids).execute();
        replacedRelationshipIds.push(...ids);
      }
    }

    const repo = createEntityDomainsRepository(trx);
    const relationshipId = await repo.upsertRelationship({
      sourceEntityId: person.id,
      targetEntityId: company.id,
      relationshipType: input.relationshipType,
      confidence: "CONFIRMED",
      confidenceScore: 1,
      source: DECLARED_RELATIONSHIP_SOURCE,
    });
    if (!relationshipId) throw new Error("declared relationship upsert returned no row");

    await promoteEndpoint(trx, person.id);
    await promoteEndpoint(trx, company.id);
    return { relationshipId, replacedRelationshipIds };
  });
}

/**
 * Scoped to the pairs this API declares: person-owned works_at/engaged_with
 * rows only. Declared project engagement_for edges stay behind
 * restructureProject and cannot be deleted here.
 */
export async function removeDeclaredRelationship(
  db: Kysely<DB>,
  input: { entityId: string; relationshipId: string },
): Promise<boolean> {
  const result = await db
    .deleteFrom("entity_relationships")
    .where("id", "=", input.relationshipId)
    .where("source_entity_id", "=", input.entityId)
    .where("source", "=", DECLARED_RELATIONSHIP_SOURCE)
    .where("relationship_type", "in", ["works_at", "engaged_with"])
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}
