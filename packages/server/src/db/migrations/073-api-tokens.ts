import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("api_tokens")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("prefix", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("last_used_at", "text")
    .addColumn("expires_at", "text")
    .addColumn("revoked_at", "text")
    .execute();

  await sql`CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id)`.execute(db);
  await sql`CREATE INDEX idx_api_tokens_hash ON api_tokens(token_hash)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_api_tokens_hash`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_api_tokens_user_id`.execute(db);
  await db.schema.dropTable("api_tokens").execute();
}
