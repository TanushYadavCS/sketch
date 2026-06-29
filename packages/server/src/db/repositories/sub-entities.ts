import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import { defaultValueSignature, seriesKeyFor } from "../../entities/sub-entity-signatures";
import type { DB, SubEntitiesTable } from "../schema";

export type SubEntityStatus = "open" | "done" | "dropped" | string;
export type SubEntityStatusAuthority = "external" | "local";

export interface UpsertSubEntityInput {
  parentEntityId?: string | null;
  kind: string;
  dedupName?: string | null;
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

export interface SupersedeSubEntityInput {
  parentEntityId: string;
  kind: string;
  dedupName: string;
  displayName: string;
  status?: string;
  dueAt?: string | null;
  valueSignature?: string;
  provenance: string;
  metadata?: Record<string, unknown> | null;
  sourceFactId?: string | null;
  effectiveAt: string;
  closeOnly?: boolean;
}

export interface ListCurrentByKindOptions {
  parentEntityId: string;
  kind: string;
}

export interface GetSubEntitiesAsOfOptions {
  parentEntityId: string;
  kind: string;
  at: string;
}

export type SubEntityRow = Selectable<SubEntitiesTable>;

export const GLOBAL_PARENT_SCOPE_KEY = "global";
const TERMINAL_STATUSES = ["done", "dropped"];
const MAX_SUPERSESSION_ATTEMPTS = 3;

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

    async supersedeSubEntity(
      input: SupersedeSubEntityInput,
    ): Promise<{ subEntityId: string; created: boolean; superseded: boolean }> {
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_SUPERSESSION_ATTEMPTS; attempt++) {
        try {
          return await supersedeInTransaction(db, input);
        } catch (err) {
          if (!isUniqueConstraintError(err) && !(err instanceof SupersessionRetryError)) throw err;
          lastError = err;
        }
      }
      throw lastError;
    },

    async listCurrentByKind(opts: ListCurrentByKindOptions): Promise<SubEntityRow[]> {
      return db
        .selectFrom("sub_entities")
        .selectAll()
        .where("parent_entity_id", "=", opts.parentEntityId)
        .where("kind", "=", opts.kind)
        .where("valid_to", "is", null)
        .orderBy("updated_at", "desc")
        .execute();
    },

    async getSubEntitiesAsOf(opts: GetSubEntitiesAsOfOptions): Promise<SubEntityRow[]> {
      const at = new Date(opts.at).toISOString();
      return db
        .selectFrom("sub_entities")
        .selectAll()
        .where("parent_entity_id", "=", opts.parentEntityId)
        .where("kind", "=", opts.kind)
        .where("valid_from", "<=", at)
        .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", at)]))
        .orderBy("valid_from", "desc")
        .execute();
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
    const normalized = normalizeName(input.dedupName ?? input.displayName);
    const valueSignature = defaultValueSignature(input.displayName);
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
          value_signature: valueSignature,
          series_key: seriesKeyFor(parentScopeKey, input.kind, normalized),
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

async function supersedeInTransaction(
  db: Kysely<DB>,
  input: SupersedeSubEntityInput,
): Promise<{ subEntityId: string; created: boolean; superseded: boolean }> {
  return db.transaction().execute(async (trx) => {
    const parentScopeKey = input.parentEntityId;
    const normalized = normalizeName(input.dedupName);
    const incomingSig = input.valueSignature ?? defaultValueSignature(input.displayName);
    const hasDomainStatus = input.status !== undefined;
    const effectiveAt = new Date(input.effectiveAt).toISOString();
    const now = new Date().toISOString();
    const rows = await trx
      .selectFrom("sub_entities")
      .selectAll()
      .where("parent_scope_key", "=", parentScopeKey)
      .where("kind", "=", input.kind)
      .where("normalized_name", "=", normalized)
      .orderBy("valid_from", "asc")
      .execute();
    if (input.closeOnly) {
      const current = rows.find((row) => row.valid_to === null);
      if (!current) return { subEntityId: "", created: false, superseded: false };
      const closeValues = hasDomainStatus
        ? { valid_to: effectiveAt, updated_at: now }
        : { valid_to: effectiveAt, status: "superseded", updated_at: now };
      const result = await trx
        .updateTable("sub_entities")
        .set(closeValues)
        .where("id", "=", current.id)
        .where("valid_to", "is", null)
        .executeTakeFirst();
      return { subEntityId: current.id, created: false, superseded: Number(result.numUpdatedRows ?? 0) > 0 };
    }
    const existingAtTime = rows.find((row) => row.valid_from === effectiveAt && row.value_signature === incomingSig);
    if (existingAtTime) {
      await refreshSupersededRow(trx, existingAtTime.id, input, now);
      return { subEntityId: existingAtTime.id, created: false, superseded: false };
    }

    const predecessor = [...rows].reverse().find((row) => row.valid_from <= effectiveAt);
    const successor = rows.find((row) => row.valid_from > effectiveAt);
    if (predecessor && predecessor.value_signature === incomingSig) {
      return { subEntityId: predecessor.id, created: false, superseded: false };
    }

    if (predecessor && (predecessor.valid_to === null || predecessor.valid_to > effectiveAt)) {
      const closeValues = hasDomainStatus
        ? { valid_to: effectiveAt, updated_at: now }
        : { valid_to: effectiveAt, status: "superseded", updated_at: now };
      const update = trx.updateTable("sub_entities").set(closeValues).where("id", "=", predecessor.id);
      const result =
        predecessor.valid_to === null
          ? await update.where("valid_to", "is", null).executeTakeFirst()
          : await update.where("valid_to", "=", predecessor.valid_to).executeTakeFirst();
      if (Number(result.numUpdatedRows ?? 0) !== 1) throw new SupersessionRetryError();
    }

    const id = randomUUID();
    const validTo = successor?.valid_from ?? null;
    await trx
      .insertInto("sub_entities")
      .values({
        id,
        parent_entity_id: input.parentEntityId,
        parent_scope_key: parentScopeKey,
        kind: input.kind,
        normalized_name: normalized,
        display_name: input.displayName,
        status: input.status ?? (validTo === null ? "active" : "superseded"),
        status_authority: "external",
        valid_from: effectiveAt,
        valid_to: validTo,
        provenance: input.provenance,
        due_at: input.dueAt ?? null,
        value_signature: incomingSig,
        series_key: seriesKeyFor(parentScopeKey, input.kind, normalized),
        created_by_user_id: null,
        source_fact_id: input.sourceFactId ?? null,
        metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
        updated_at: now,
      })
      .execute();
    return { subEntityId: id, created: true, superseded: Boolean(predecessor) };
  });
}

async function refreshSupersededRow(
  db: Kysely<DB>,
  subEntityId: string,
  input: SupersedeSubEntityInput,
  now: string,
): Promise<void> {
  const values = {
    display_name: input.displayName,
    provenance: input.provenance,
    due_at: input.dueAt ?? null,
    value_signature: input.valueSignature ?? defaultValueSignature(input.displayName),
    source_fact_id: input.sourceFactId ?? null,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    updated_at: now,
    ...(input.status !== undefined ? { status: input.status } : {}),
  };
  await db.updateTable("sub_entities").set(values).where("id", "=", subEntityId).execute();
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

export function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique constraint") || message.includes("duplicate key");
}

class SupersessionRetryError extends Error {}
