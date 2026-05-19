import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("agent_environment_variable_shares")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("variable_id", "text", (col) =>
      col.notNull().references("agent_environment_variables.id").onDelete("cascade"),
    )
    .addColumn("variable_name", "text", (col) => col.notNull())
    .addColumn("target_type", "text", (col) => col.notNull())
    .addColumn("target_id", "text", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_agent_environment_variable_shares_unique_target")
    .on("agent_environment_variable_shares")
    .columns(["variable_id", "target_type", "target_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_agent_environment_variable_shares_unique_target_name")
    .on("agent_environment_variable_shares")
    .columns(["target_type", "target_id", "variable_name"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_agent_environment_variable_shares_target")
    .on("agent_environment_variable_shares")
    .columns(["target_type", "target_id"])
    .execute();

  await db.schema
    .createIndex("idx_agent_environment_variable_shares_variable")
    .on("agent_environment_variable_shares")
    .column("variable_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("agent_environment_variable_shares").execute();
}
