import { type Kysely, sql } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema
    .alterTable("entity_mentions")
    .addColumn("confidence", "text", (col) => col.notNull().defaultTo("INFERRED"))
    .execute();
  await db.schema
    .alterTable("entity_mentions")
    .addColumn("source", "text", (col) => col.notNull().defaultTo("llm_extraction"))
    .execute();
  await db.schema
    .alterTable("entity_mentions")
    .addColumn("relation", "text", (col) => col.notNull().defaultTo("mentioned"))
    .execute();

  await sql`
    UPDATE entity_mentions
       SET relation = 'assigned'
     WHERE context_snippet LIKE 'Assigned to %'
  `.execute(db);

  await db.schema.dropIndex("idx_entity_mentions_entity_file_unique").ifExists().execute();
  await db.schema.dropIndex("idx_entity_mentions_entity_file").ifExists().execute();

  const duplicates = await sql<{ entity_id: string; indexed_file_id: string; relation: string; cnt: number }>`
    SELECT entity_id, indexed_file_id, relation, COUNT(*) AS cnt
      FROM entity_mentions
     GROUP BY entity_id, indexed_file_id, relation
    HAVING COUNT(*) > 1
     LIMIT 5
  `.execute(db);

  if (duplicates.rows.length > 0) {
    const sample = duplicates.rows
      .map(
        (r) =>
          `(entity_id=${r.entity_id}, indexed_file_id=${r.indexed_file_id}, relation=${r.relation}, count=${r.cnt})`,
      )
      .join("; ");
    throw new Error(
      `migration 059-mention-provenance: duplicate (entity_id, indexed_file_id, relation) rows found in entity_mentions. Sample: ${sample}. Dedupe before re-running migration.`,
    );
  }

  await db.schema
    .createIndex("uq_entity_mentions_entity_file_relation")
    .on("entity_mentions")
    .columns(["entity_id", "indexed_file_id", "relation"])
    .unique()
    .execute();
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.dropIndex("uq_entity_mentions_entity_file_relation").ifExists().execute();
  await db.schema
    .createIndex("idx_entity_mentions_entity_file_unique")
    .on("entity_mentions")
    .columns(["entity_id", "indexed_file_id"])
    .unique()
    .execute();
  await db.schema.alterTable("entity_mentions").dropColumn("relation").execute();
  await db.schema.alterTable("entity_mentions").dropColumn("source").execute();
  await db.schema.alterTable("entity_mentions").dropColumn("confidence").execute();
}
