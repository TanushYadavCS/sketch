/**
 * Six-state relationship verdicts and the declared-state registry.
 *
 * `relationship_state` mirrors the verdict JSON's state axis so pipeline views
 * (a lead list is a query over verdicts, not over entities) never parse JSON.
 * `flags` carries deterministic post-check hits such as the product-name
 * tripwire; `vote_stats` carries self-consistency metadata when a cluster is
 * run more than once. All three are nullable: rows written by the five-state
 * prompt version predate them.
 *
 * `company_relationship_declarations` is the one-line tenant registry the
 * validation demanded: trial and customer are declared, never inferred,
 * because payment and tenancy do not appear in communication exhaust. A
 * declared row wins over inference for every company in the same duplicate
 * group.
 */
import { type Kysely, sql } from "kysely";

const VERDICTS = "project_minting_verdicts";
const DECLARATIONS = "company_relationship_declarations";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(VERDICTS).addColumn("relationship_state", "text").execute();
  await db.schema.alterTable(VERDICTS).addColumn("flags", "text").execute();
  await db.schema.alterTable(VERDICTS).addColumn("vote_stats", "text").execute();

  await db.schema
    .createTable(DECLARATIONS)
    .addColumn("company_entity_id", "text", (col) => col.notNull().primaryKey())
    .addColumn("declared_state", "text", (col) => col.notNull())
    .addColumn("note", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(DECLARATIONS).execute();
  await db.schema.alterTable(VERDICTS).dropColumn("vote_stats").execute();
  await db.schema.alterTable(VERDICTS).dropColumn("flags").execute();
  await db.schema.alterTable(VERDICTS).dropColumn("relationship_state").execute();
}
