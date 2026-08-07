import { type Kysely, sql } from "kysely";

async function hasColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  return tables.some((table) => table.name === tableName && table.columns.some((column) => column.name === columnName));
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (await hasColumn(db, "access_scope_members", "email")) {
    await db.schema
      .alterTable("access_scope_members")
      .addColumn("principal_type", "text", (col) => col.notNull().defaultTo("email"))
      .execute();
    await db.schema.alterTable("access_scope_members").renameColumn("email", "principal_value").execute();
  }
  if (await hasColumn(db, "file_access", "email")) {
    await db.schema
      .alterTable("file_access")
      .addColumn("principal_type", "text", (col) => col.notNull().defaultTo("email"))
      .execute();
    await db.schema.alterTable("file_access").renameColumn("email", "principal_value").execute();
  }

  await sql`DROP INDEX IF EXISTS idx_scope_members_pk`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_scope_members_email`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_scope_members_pk
    ON access_scope_members(access_scope_id, principal_type, principal_value)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_scope_members_principal
    ON access_scope_members(principal_type, principal_value)`.execute(db);

  await sql`DROP INDEX IF EXISTS idx_file_access_pk`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_file_access_email`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_file_access_pk
    ON file_access(indexed_file_id, principal_type, principal_value)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_file_access_principal
    ON file_access(principal_type, principal_value)`.execute(db);

  if (!(await hasColumn(db, "users", "whatsapp_lid"))) {
    await db.schema.alterTable("users").addColumn("whatsapp_lid", "text").execute();
  }
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_whatsapp_lid ON users(whatsapp_lid)`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
