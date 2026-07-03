import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";

interface CommitmentBackfillDb {
  indexed_file_facts: {
    id: string;
    source: string;
    raw: string | null;
    created_by_user_id: string | null;
    deleted_at: string | null;
  };
  sub_entities: {
    id: string;
    parent_entity_id: string | null;
    parent_scope_key: string;
    kind: string;
    normalized_name: string;
    display_name: string;
    status: string;
    status_authority: string;
    valid_to: string | null;
    provenance: string;
    due_at: string | null;
    created_by_user_id: string | null;
    source_fact_id: string | null;
    metadata_json: string | null;
    updated_at: string;
  };
  sub_entity_evidence: {
    sub_entity_id: string;
    kind: string;
    ref_id: string;
  };
}

interface CommitmentRaw {
  parentEntityId?: string;
  title: string;
  status: string;
  dueAt?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sub_entities")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("parent_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("parent_scope_key", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("normalized_name", "text", (col) => col.notNull())
    .addColumn("display_name", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("status_authority", "text", (col) => col.notNull().defaultTo("local"))
    .addColumn("valid_from", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("valid_to", "text")
    .addColumn("provenance", "text", (col) => col.notNull())
    .addColumn("due_at", "text")
    .addColumn("created_by_user_id", "text", (col) => col.references("users.id"))
    .addColumn("source_fact_id", "text")
    .addColumn("metadata_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable("sub_entity_evidence")
    .addColumn("sub_entity_id", "text", (col) => col.notNull().references("sub_entities.id").onDelete("cascade"))
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("ref_id", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("sub_entity_evidence_pkey", ["sub_entity_id", "kind", "ref_id"])
    .execute();

  await backfillCommitmentSubEntities(db as Kysely<CommitmentBackfillDb>);

  await sql`
    CREATE UNIQUE INDEX idx_sub_entities_current_scope_kind_name
    ON sub_entities(parent_scope_key, kind, normalized_name)
    WHERE valid_to IS NULL
  `.execute(db);
  await db.schema
    .createIndex("idx_sub_entities_parent_kind_status")
    .on("sub_entities")
    .columns(["parent_entity_id", "kind", "status"])
    .execute();
  await db.schema
    .createIndex("idx_sub_entity_evidence_kind_ref")
    .on("sub_entity_evidence")
    .columns(["kind", "ref_id"])
    .execute();
}

async function backfillCommitmentSubEntities(db: Kysely<CommitmentBackfillDb>): Promise<void> {
  const facts = await db
    .selectFrom("indexed_file_facts")
    .select(["id", "source", "raw", "created_by_user_id"])
    .where("fact_type", "=", "commitment")
    .where("deleted_at", "is", null)
    .execute();
  const subEntityIdsByKey = new Map<string, string>();
  const now = new Date().toISOString();
  for (const fact of facts) {
    const raw = readCommitmentRaw(fact.raw);
    if (!raw) continue;
    const parentScopeKey = raw.parentEntityId ?? "global";
    const normalizedName = normalizeName(raw.title);
    const key = `${parentScopeKey}\u001fcommitment\u001f${normalizedName}`;
    let subEntityId = subEntityIdsByKey.get(key);
    if (!subEntityId) {
      subEntityId = randomUUID();
      subEntityIdsByKey.set(key, subEntityId);
      await db
        .insertInto("sub_entities")
        .values({
          id: subEntityId,
          parent_entity_id: raw.parentEntityId ?? null,
          parent_scope_key: parentScopeKey,
          kind: "commitment",
          normalized_name: normalizedName,
          display_name: raw.title,
          status: raw.status,
          status_authority: "external",
          valid_to: null,
          provenance: fact.source === "llm" ? "corroborated_llm" : "structural",
          due_at: raw.dueAt ?? null,
          created_by_user_id: fact.created_by_user_id,
          source_fact_id: fact.id,
          metadata_json: null,
          updated_at: now,
        })
        .execute();
    }
    await insertSubEntityEvidence(db, subEntityId, "fact", fact.id);
    for (const fileId of raw.evidence.fileIds) {
      await insertSubEntityEvidence(db, subEntityId, "file", fileId);
    }
    for (const entityId of raw.evidence.entityIds) {
      await insertSubEntityEvidence(db, subEntityId, "entity", entityId);
    }
  }
}

async function insertSubEntityEvidence(
  db: Kysely<CommitmentBackfillDb>,
  subEntityId: string,
  kind: string,
  refId: string,
): Promise<void> {
  await db
    .insertInto("sub_entity_evidence")
    .values({ sub_entity_id: subEntityId, kind, ref_id: refId })
    .onConflict((oc) => oc.columns(["sub_entity_id", "kind", "ref_id"]).doNothing())
    .execute();
}

function readCommitmentRaw(raw: string | null): CommitmentRaw | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) return null;
    const status = typeof parsed.status === "string" && parsed.status.length > 0 ? parsed.status : "open";
    const evidence = readEvidence(parsed.evidence);
    if (!evidence) return null;
    return {
      parentEntityId: readOptionalString(parsed.parentEntityId),
      title: parsed.title.trim(),
      status,
      dueAt: readOptionalString(parsed.dueAt),
      evidence,
    };
  } catch {
    return null;
  }
}

function readEvidence(value: unknown): CommitmentRaw["evidence"] | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.fileIds) || !value.fileIds.every((id) => typeof id === "string")) return null;
  if (!Array.isArray(value.entityIds) || !value.entityIds.every((id) => typeof id === "string")) return null;
  return { fileIds: value.fileIds, entityIds: value.entityIds };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_sub_entity_evidence_kind_ref").ifExists().execute();
  await db.schema.dropIndex("idx_sub_entities_parent_kind_status").ifExists().execute();
  await sql`DROP INDEX IF EXISTS idx_sub_entities_current_scope_kind_name`.execute(db);
  await db.schema.dropTable("sub_entity_evidence").execute();
  await db.schema.dropTable("sub_entities").execute();
}
