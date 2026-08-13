/**
 * The declared-state registry for outside companies.
 *
 * Trial and customer are declared, never inferred: measured on two full
 * stage-3 re-runs, inferred-trial precision was 2 of 6 and payment never
 * appears in communication exhaust, so any product access reads as a trial
 * and the richest paying customer reads as one too. A declaration here is
 * authoritative over inference; deterministic signals (support channel,
 * onboarding families) only nominate candidates for declaration.
 *
 * `paying` maps to the `customer` relationship state; `trial` to `trial`.
 * When a CRM is connected, its stage becomes the declaration source.
 */
import type { Kysely, Selectable } from "kysely";
import type { CompanyRelationshipDeclarationsTable, DB } from "../schema";

export type DeclaredRelationshipState = "trial" | "paying";

export type CompanyRelationshipDeclarationRow = Selectable<CompanyRelationshipDeclarationsTable>;

export function isDeclaredRelationshipState(value: string): value is DeclaredRelationshipState {
  return value === "trial" || value === "paying";
}

export interface DeclareRelationshipInput {
  companyEntityId: string;
  declaredState: DeclaredRelationshipState;
  note?: string;
}

export function createCompanyRelationshipDeclarationRepository(db: Kysely<DB>) {
  return {
    async declare(input: DeclareRelationshipInput): Promise<void> {
      const now = new Date().toISOString();
      await db
        .insertInto("company_relationship_declarations")
        .values({
          company_entity_id: input.companyEntityId,
          declared_state: input.declaredState,
          note: input.note ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column("company_entity_id").doUpdateSet({
            declared_state: input.declaredState,
            note: input.note ?? null,
            updated_at: now,
          }),
        )
        .execute();
    },

    async list(): Promise<CompanyRelationshipDeclarationRow[]> {
      return db
        .selectFrom("company_relationship_declarations")
        .selectAll()
        .orderBy("company_entity_id", "asc")
        .execute();
    },

    async remove(companyEntityId: string): Promise<void> {
      await db
        .deleteFrom("company_relationship_declarations")
        .where("company_entity_id", "=", companyEntityId)
        .execute();
    },
  };
}

export type CompanyRelationshipDeclarationRepository = ReturnType<
  typeof createCompanyRelationshipDeclarationRepository
>;
