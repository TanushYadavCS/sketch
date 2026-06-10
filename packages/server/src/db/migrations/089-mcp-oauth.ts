import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("oauth_clients")
    .addColumn("client_id", "text", (col) => col.primaryKey())
    .addColumn("client_secret_hash", "text")
    .addColumn("client_name", "text")
    .addColumn("redirect_uris", "text", (col) => col.notNull())
    .addColumn("grant_types", "text", (col) => col.notNull())
    .addColumn("scopes", "text", (col) => col.notNull())
    .addColumn("token_endpoint_auth_method", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable("oauth_authorization_codes")
    .addColumn("code_hash", "text", (col) => col.primaryKey())
    .addColumn("client_id", "text", (col) => col.notNull().references("oauth_clients.client_id").onDelete("cascade"))
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("redirect_uri", "text", (col) => col.notNull())
    .addColumn("code_challenge", "text", (col) => col.notNull())
    .addColumn("scopes", "text", (col) => col.notNull())
    .addColumn("resource", "text")
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("consumed_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .alterTable("api_tokens")
    .addColumn("kind", "text", (col) => col.notNull().defaultTo("pat"))
    .execute();
  await db.schema.alterTable("api_tokens").addColumn("client_id", "text").execute();
  await db.schema.alterTable("api_tokens").addColumn("scopes", "text").execute();
  await db.schema.alterTable("api_tokens").addColumn("refresh_token_hash", "text").execute();

  await sql`CREATE INDEX idx_oauth_authorization_codes_client_id ON oauth_authorization_codes(client_id)`.execute(db);
  await sql`CREATE INDEX idx_oauth_authorization_codes_user_id ON oauth_authorization_codes(user_id)`.execute(db);
  await sql`CREATE INDEX idx_api_tokens_client_id ON api_tokens(client_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_api_tokens_refresh_token_hash ON api_tokens(refresh_token_hash)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_api_tokens_refresh_token_hash`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_api_tokens_client_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_oauth_authorization_codes_user_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_oauth_authorization_codes_client_id`.execute(db);
  await db.schema.alterTable("api_tokens").dropColumn("refresh_token_hash").execute();
  await db.schema.alterTable("api_tokens").dropColumn("scopes").execute();
  await db.schema.alterTable("api_tokens").dropColumn("client_id").execute();
  await db.schema.alterTable("api_tokens").dropColumn("kind").execute();
  await db.schema.dropTable("oauth_authorization_codes").execute();
  await db.schema.dropTable("oauth_clients").execute();
}
