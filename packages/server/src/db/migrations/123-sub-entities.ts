import { type Kysely, sql } from "kysely";

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

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_sub_entity_evidence_kind_ref").ifExists().execute();
  await db.schema.dropIndex("idx_sub_entities_parent_kind_status").ifExists().execute();
  await sql`DROP INDEX IF EXISTS idx_sub_entities_current_scope_kind_name`.execute(db);
  await db.schema.dropTable("sub_entity_evidence").execute();
  await db.schema.dropTable("sub_entities").execute();
}
