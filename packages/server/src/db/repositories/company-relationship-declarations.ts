/**
 * The declared counterparty registry for outside companies.
 *
 * Kind and stage are declared, never inferred: measured on two full stage-3
 * re-runs, inferred-pilot precision was 2 of 6 and payment never appears in
 * communication exhaust, so any product access reads as a pilot and the richest
 * active client reads as one too. A declaration here is authoritative over
 * inference; deterministic signals (support channel, onboarding families) only
 * nominate candidates for declaration.
 *
 * When a CRM is connected, its stage becomes the declaration source.
 */
import type { Kysely, Selectable } from "kysely";
import type { CompanyRelationshipDeclarationsTable, DB } from "../schema";

export type CounterpartyKind = "client" | "vendor" | "investor" | "partner" | "other";
export type ClientStage = "prospect" | "pilot" | "active" | "dormant" | "ended";

export type CompanyRelationshipDeclarationRow = Selectable<CompanyRelationshipDeclarationsTable>;

const COUNTERPARTY_KINDS = new Set<CounterpartyKind>(["client", "vendor", "investor", "partner", "other"]);
const CLIENT_STAGES = new Set<ClientStage>(["prospect", "pilot", "active", "dormant", "ended"]);
/**
 * Precedence when two shards of one duplicate group disagree: the kind that
 * mints wins. `client` first, then `partner` — both carry a container and a
 * stage, and a declaration that suppresses real work is the destructive
 * direction. Ordering `partner` below `vendor` would resolve a
 * partner/vendor disagreement to silence.
 */
const KIND_PRECEDENCE: Record<CounterpartyKind, number> = {
  client: 0,
  partner: 1,
  vendor: 2,
  investor: 3,
  other: 4,
};

export function isCounterpartyKind(value: string): value is CounterpartyKind {
  return COUNTERPARTY_KINDS.has(value as CounterpartyKind);
}

export function isClientStage(value: string): value is ClientStage {
  return CLIENT_STAGES.has(value as ClientStage);
}

export function kindCarriesStage(kind: CounterpartyKind): boolean {
  return kind === "client" || kind === "partner";
}

export function assertStageMatchesKind(kind: CounterpartyKind, stage: ClientStage | null): void {
  if (kindCarriesStage(kind)) {
    if (stage === null) throw new Error("client_stage is required for client and partner declarations");
    return;
  }
  if (stage !== null) throw new Error("client_stage must be null unless counterparty_kind is client or partner");
}

export interface DeclareRelationshipInput {
  subjectEntityId: string;
  counterpartyKind: CounterpartyKind;
  clientStage: ClientStage | null;
  note?: string;
}

export function resolveDeclaration(
  rows: CompanyRelationshipDeclarationRow[],
): CompanyRelationshipDeclarationRow | null {
  let chosen: CompanyRelationshipDeclarationRow | null = null;
  for (const row of rows) {
    if (!isCounterpartyKind(row.counterparty_kind)) continue;
    if (
      !chosen ||
      KIND_PRECEDENCE[row.counterparty_kind] < KIND_PRECEDENCE[chosen.counterparty_kind as CounterpartyKind]
    ) {
      chosen = row;
    }
  }
  return chosen;
}

export function createCompanyRelationshipDeclarationRepository(db: Kysely<DB>) {
  return {
    async declare(input: DeclareRelationshipInput): Promise<void> {
      assertStageMatchesKind(input.counterpartyKind, input.clientStage);
      const now = new Date().toISOString();
      await db
        .insertInto("company_relationship_declarations")
        .values({
          subject_entity_id: input.subjectEntityId,
          counterparty_kind: input.counterpartyKind,
          client_stage: input.clientStage,
          note: input.note ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column("subject_entity_id").doUpdateSet({
            counterparty_kind: input.counterpartyKind,
            client_stage: input.clientStage,
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
        .orderBy("subject_entity_id", "asc")
        .execute();
    },

    async remove(subjectEntityId: string): Promise<void> {
      await db
        .deleteFrom("company_relationship_declarations")
        .where("subject_entity_id", "=", subjectEntityId)
        .execute();
    },
  };
}

export type CompanyRelationshipDeclarationRepository = ReturnType<
  typeof createCompanyRelationshipDeclarationRepository
>;
