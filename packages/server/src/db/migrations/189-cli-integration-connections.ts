import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("cli_integration_connections")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("app_id", "text", (col) => col.notNull())
    .addColumn("owner_user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("credential_variable_id", "text", (col) =>
      col.notNull().references("agent_environment_variables.id").onDelete("cascade"),
    )
    .addColumn("account_external_id", "text")
    .addColumn("account_login", "text", (col) => col.notNull())
    .addColumn("account_avatar_url", "text")
    .addColumn("account_type", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("verified_at", "text", (col) => col.notNull())
    .addColumn("last_verification_error", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_cli_integration_connections_owner_app")
    .on("cli_integration_connections")
    .columns(["owner_user_id", "app_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_cli_integration_connections_credential_variable")
    .on("cli_integration_connections")
    .column("credential_variable_id")
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_cli_integration_connections_app_status")
    .on("cli_integration_connections")
    .columns(["app_id", "status"])
    .execute();

  await sql`UPDATE mcp_servers SET mode = 'skill' WHERE type = 'canvas' AND mode = 'mcp'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("cli_integration_connections").execute();
}
