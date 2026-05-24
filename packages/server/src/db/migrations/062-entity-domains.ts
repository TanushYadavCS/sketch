/**
 * ELP-02: entity_domains, entity_relationships, entity_relationship_evidence,
 * plus structured fields on entity_candidates for domain_observation rows.
 *
 * `valid_from` defaults to '' and `chunk_index` defaults to -1 so they
 * participate in UNIQUE keys without being nullable — SQLite and Postgres
 * both allow multiple NULL values in a unique key, which would defeat
 * idempotent upserts.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("entity_domains")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("entity_id", "text", (col) => col.references("entities.id").onDelete("cascade"))
    .addColumn("domain", "text", (col) => col.notNull().unique())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("is_primary", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("confidence", "real", (col) => col.notNull())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_entity_domains_kind_domain")
    .on("entity_domains")
    .columns(["kind", "domain"])
    .execute();
  await db.schema.createIndex("idx_entity_domains_entity").on("entity_domains").column("entity_id").execute();

  await db.schema
    .createTable("entity_relationships")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("source_entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("target_entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("relationship_type", "text", (col) => col.notNull())
    .addColumn("confidence", "text", (col) => col.notNull())
    .addColumn("confidence_score", "real", (col) => col.notNull())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("valid_from", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("valid_to", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("entity_relationships_unique", [
      "source_entity_id",
      "target_entity_id",
      "relationship_type",
      "valid_from",
    ])
    .execute();

  await db.schema
    .createIndex("idx_entity_relationships_source")
    .on("entity_relationships")
    .columns(["source_entity_id", "relationship_type"])
    .execute();
  await db.schema
    .createIndex("idx_entity_relationships_target")
    .on("entity_relationships")
    .columns(["target_entity_id", "relationship_type"])
    .execute();

  await db.schema
    .createTable("entity_relationship_evidence")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("relationship_id", "text", (col) =>
      col.notNull().references("entity_relationships.id").onDelete("cascade"),
    )
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("chunk_index", "integer", (col) => col.notNull().defaultTo(-1))
    .addColumn("note", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("entity_relationship_evidence_unique", ["relationship_id", "indexed_file_id", "chunk_index"])
    .execute();

  await db.schema
    .createIndex("idx_entity_relationship_evidence_file")
    .on("entity_relationship_evidence")
    .column("indexed_file_id")
    .execute();

  // Extend entity_candidates to carry structured fields for type='domain_observation'.
  await db.schema.alterTable("entity_candidates").addColumn("domain", "text").execute();
  await db.schema.alterTable("entity_candidates").addColumn("proposed_company_name", "text").execute();
  // Tracking field, no FK — the plan's ON DELETE SET NULL is a soft guarantee
  // and SQLite has no deferred constraint, so production callers may insert
  // user IDs that survive past the user row. Treat the field as informational.
  await db.schema.alterTable("entity_candidates").addColumn("first_observed_by_user_id", "text").execute();
  await db.schema.alterTable("entity_candidates").addColumn("observed_person_entity_ids", "text").execute();
  await db.schema.alterTable("entity_candidates").addColumn("evidence_file_ids", "text").execute();

  // Partial unique index: domain observations dedup on (type, domain) when domain is set.
  // Non-domain candidates leave `domain` NULL and bypass this index — their existing
  // `LOWER(name)` lookup pattern continues to work.
  await sql`CREATE UNIQUE INDEX idx_entity_candidates_type_domain ON entity_candidates(type, domain) WHERE domain IS NOT NULL`.execute(
    db,
  );
  await db.schema
    .createIndex("idx_entity_candidates_type_promoted")
    .on("entity_candidates")
    .columns(["type", "promoted_entity_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_entity_candidates_type_promoted").ifExists().execute();
  await sql`DROP INDEX IF EXISTS idx_entity_candidates_type_domain`.execute(db);

  // SQLite can't drop columns pre-3.35, but the schema lives in dev DBs; Postgres can.
  try {
    await db.schema.alterTable("entity_candidates").dropColumn("evidence_file_ids").execute();
    await db.schema.alterTable("entity_candidates").dropColumn("observed_person_entity_ids").execute();
    await db.schema.alterTable("entity_candidates").dropColumn("first_observed_by_user_id").execute();
    await db.schema.alterTable("entity_candidates").dropColumn("proposed_company_name").execute();
    await db.schema.alterTable("entity_candidates").dropColumn("domain").execute();
  } catch {
    // SQLite: columns remain but are unused.
  }

  await db.schema.dropTable("entity_relationship_evidence").execute();
  await db.schema.dropTable("entity_relationships").execute();
  await db.schema.dropTable("entity_domains").execute();
}
