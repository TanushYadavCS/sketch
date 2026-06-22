import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import type { DB, SubEntitiesTable } from "../schema";

export type SubEntityStatus = "open" | "done" | "dropped" | string;
export type SubEntityStatusAuthority = "external" | "local";

export interface UpsertSubEntityInput {
  parentEntityId?: string | null;
  kind: string;
  displayName: string;
  status: SubEntityStatus;
  provenance: string;
  dueAt?: string | null;
  ownerUserId?: string | null;
  sourceFactId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ListOpenSubEntitiesOptions {
  parentEntityId?: string | null;
  kind: string;
}

export type SubEntityRow = Selectable<SubEntitiesTable>;

const GLOBAL_PARENT_SCOPE_KEY = "global";
const TERMINAL_STATUSES = ["done", "dropped"];

export function createSubEntityRepository(db: Kysely<DB>) {
  return {
    async upsertSubEntity(input: UpsertSubEntityInput): Promise<{ subEntityId: string; created: boolean }> {
      try {
        return await upsertInTransaction(db, input);
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        return upsertInTransaction(db, input);
      }
    },

    async markSubEntityStatus(subEntityId: string, status: SubEntityStatus): Promise<boolean> {
      const result = await db
        .updateTable("sub_entities")
        .set({ status, status_authority: "local", updated_at: new Date().toISOString() })
        .where("id", "=", subEntityId)
        .where("valid_to", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },

    async listOpenSubEntities(opts: ListOpenSubEntitiesOptions): Promise<SubEntityRow[]> {
      let query = db
        .selectFrom("sub_entities")
        .selectAll()
        .where("valid_to", "is", null)
        .where("kind", "=", opts.kind)
        .where("status", "not in", TERMINAL_STATUSES)
        .orderBy("updated_at", "desc");
      if (opts.parentEntityId !== undefined) {
        query =
          opts.parentEntityId === null
            ? query.where("parent_entity_id", "is", null)
            : query.where("parent_entity_id", "=", opts.parentEntityId);
      }
      return query.execute();
    },

    async upsertSubEntityEvidence(subEntityId: string, kind: string, refId: string): Promise<void> {
      await db
        .insertInto("sub_entity_evidence")
        .values({ sub_entity_id: subEntityId, kind, ref_id: refId })
        .onConflict((oc) => oc.columns(["sub_entity_id", "kind", "ref_id"]).doNothing())
        .execute();
    },
  };
}

async function upsertInTransaction(
  db: Kysely<DB>,
  input: UpsertSubEntityInput,
): Promise<{ subEntityId: string; created: boolean }> {
  return db.transaction().execute(async (trx) => {
    const parentScopeKey = input.parentEntityId ?? GLOBAL_PARENT_SCOPE_KEY;
    const normalized = normalizeName(input.displayName);
    const existing = await selectCurrent(trx, parentScopeKey, input.kind, normalized);
    const now = new Date().toISOString();
    if (!existing) {
      const id = randomUUID();
      await trx
        .insertInto("sub_entities")
        .values({
          id,
          parent_entity_id: input.parentEntityId ?? null,
          parent_scope_key: parentScopeKey,
          kind: input.kind,
          normalized_name: normalized,
          display_name: input.displayName,
          status: input.status,
          status_authority: "external",
          valid_to: null,
          provenance: input.provenance,
          due_at: input.dueAt ?? null,
          created_by_user_id: input.ownerUserId ?? null,
          source_fact_id: input.sourceFactId ?? null,
          metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
          updated_at: now,
        })
        .execute();
      return { subEntityId: id, created: true };
    }

    await updateExisting(trx, existing, input, now);
    return { subEntityId: existing.id, created: false };
  });
}

async function selectCurrent(
  db: Kysely<DB>,
  parentScopeKey: string,
  kind: string,
  normalizedName: string,
): Promise<SubEntityRow | undefined> {
  return db
    .selectFrom("sub_entities")
    .selectAll()
    .where("parent_scope_key", "=", parentScopeKey)
    .where("kind", "=", kind)
    .where("normalized_name", "=", normalizedName)
    .where("valid_to", "is", null)
    .executeTakeFirst();
}

async function updateExisting(
  db: Kysely<DB>,
  existing: SubEntityRow,
  input: UpsertSubEntityInput,
  now: string,
): Promise<void> {
  await db
    .updateTable("sub_entities")
    .set({
      display_name: input.displayName,
      status: existing.status_authority === "local" ? existing.status : input.status,
      due_at: input.dueAt ?? null,
      source_fact_id: input.sourceFactId ?? null,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : existing.metadata_json,
      updated_at: now,
    })
    .where("id", "=", existing.id)
    .execute();
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique constraint") || message.includes("duplicate key");
}
