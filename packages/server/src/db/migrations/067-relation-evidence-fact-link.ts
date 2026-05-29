import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE entity_relationship_evidence RENAME TO entity_relationship_evidence_old`.execute(db);

  await db.schema
    .createTable("entity_relationship_evidence")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("relationship_id", "text", (col) =>
      col.notNull().references("entity_relationships.id").onDelete("cascade"),
    )
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("chunk_index", "integer", (col) => col.notNull().defaultTo(-1))
    .addColumn("note", "text")
    .addColumn("source_fact_id", "text", (col) => col.references("indexed_file_facts.id"))
    .addColumn("evidence_key", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await sql`
    INSERT INTO entity_relationship_evidence (
      id,
      relationship_id,
      indexed_file_id,
      chunk_index,
      note,
      source_fact_id,
      evidence_key,
      created_at
    )
    SELECT
      id,
      relationship_id,
      indexed_file_id,
      chunk_index,
      note,
      NULL,
      'legacy:' || relationship_id || ':' || indexed_file_id || ':' || CAST(chunk_index AS TEXT),
      created_at
    FROM entity_relationship_evidence_old
  `.execute(db);

  await db.schema.dropTable("entity_relationship_evidence_old").execute();
  await db.schema
    .createIndex("idx_entity_relationship_evidence_file")
    .on("entity_relationship_evidence")
    .column("indexed_file_id")
    .execute();
  await db.schema
    .createIndex("idx_entity_relationship_evidence_source_fact")
    .on("entity_relationship_evidence")
    .column("source_fact_id")
    .execute();
  await db.schema
    .createIndex("idx_entity_relationship_evidence_key")
    .on("entity_relationship_evidence")
    .columns(["relationship_id", "evidence_key"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE entity_relationship_evidence RENAME TO entity_relationship_evidence_new`.execute(db);

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

  await sql`
    INSERT INTO entity_relationship_evidence (
      id,
      relationship_id,
      indexed_file_id,
      chunk_index,
      note,
      created_at
    )
    SELECT
      MIN(id),
      relationship_id,
      indexed_file_id,
      chunk_index,
      MAX(note),
      MIN(created_at)
    FROM entity_relationship_evidence_new
    GROUP BY relationship_id, indexed_file_id, chunk_index
  `.execute(db);

  await db.schema.dropTable("entity_relationship_evidence_new").execute();
  await db.schema
    .createIndex("idx_entity_relationship_evidence_file")
    .on("entity_relationship_evidence")
    .column("indexed_file_id")
    .execute();
}
