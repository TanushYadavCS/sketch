/**
 * Replace the tenant-shaped declaration registry with the two-axis counterparty
 * declaration. The subject is now a generic entity id, not a company id, so a
 * future team declaration costs nothing to store while remaining unread by
 * project minting today. Pending verdicts are superseded because their stored
 * relationship state uses the retired vocabulary; decided rows remain history.
 */
import { type Kysely, sql } from "kysely";

const DECLARATIONS = "company_relationship_declarations";
const DECLARATIONS_NEXT = "company_relationship_declarations_next";

async function createAxesDeclarationsTable(db: Kysely<unknown>, tableName: string): Promise<void> {
  await db.schema
    .createTable(tableName)
    .addColumn("subject_entity_id", "text", (col) => col.notNull().primaryKey())
    .addColumn("counterparty_kind", "text", (col) => col.notNull())
    .addColumn("client_stage", "text")
    .addColumn("note", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

async function createLegacyDeclarationsTable(db: Kysely<unknown>, tableName: string): Promise<void> {
  await db.schema
    .createTable(tableName)
    .addColumn("company_entity_id", "text", (col) => col.notNull().primaryKey())
    .addColumn("declared_state", "text", (col) => col.notNull())
    .addColumn("note", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await createAxesDeclarationsTable(db, DECLARATIONS_NEXT);
  await sql`
    INSERT INTO company_relationship_declarations_next
      (subject_entity_id, counterparty_kind, client_stage, note, created_at, updated_at)
    SELECT
      company_entity_id,
      'client',
      CASE declared_state
        WHEN 'paying' THEN 'active'
        WHEN 'trial' THEN 'pilot'
      END,
      note,
      created_at,
      updated_at
    FROM company_relationship_declarations
    WHERE declared_state IN ('paying', 'trial')
  `.execute(db);
  await db.schema.dropTable(DECLARATIONS).execute();
  await db.schema.alterTable(DECLARATIONS_NEXT).renameTo(DECLARATIONS).execute();
  await sql`
    UPDATE project_minting_verdicts
    SET superseded_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'pending' AND superseded_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await createLegacyDeclarationsTable(db, DECLARATIONS_NEXT);
  await sql`
    INSERT INTO company_relationship_declarations_next
      (company_entity_id, declared_state, note, created_at, updated_at)
    SELECT
      subject_entity_id,
      CASE client_stage
        WHEN 'active' THEN 'paying'
        WHEN 'pilot' THEN 'trial'
      END,
      note,
      created_at,
      updated_at
    FROM company_relationship_declarations
    WHERE counterparty_kind = 'client' AND client_stage IN ('active', 'pilot')
  `.execute(db);
  await db.schema.dropTable(DECLARATIONS).execute();
  await db.schema.alterTable(DECLARATIONS_NEXT).renameTo(DECLARATIONS).execute();
}
