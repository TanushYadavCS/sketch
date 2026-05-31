/**
 * Manual file sharing on top of connector-derived access.
 *
 * - file_share_emails: per-(file, email) grants. Independent of file_access and
 *   access_scope_members so connector reconcile cannot trample manual shares.
 * - indexed_files.share_with_everyone: org-wide visibility flag (admin-only toggle).
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("file_share_emails")
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("email", "text", (col) => col.notNull())
    .addColumn("granted_by_user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("granted_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("file_share_emails_pk", ["indexed_file_id", "email"])
    .execute();

  await sql`CREATE INDEX idx_file_share_emails_email ON file_share_emails(email)`.execute(db);

  await db.schema
    .alterTable("indexed_files")
    .addColumn("share_with_everyone", "integer", (col) => col.notNull().defaultTo(0))
    .execute();

  await sql`CREATE INDEX idx_indexed_files_share_with_everyone ON indexed_files(share_with_everyone)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_indexed_files_share_with_everyone`.execute(db);
  await db.schema.alterTable("indexed_files").dropColumn("share_with_everyone").execute();
  await sql`DROP INDEX IF EXISTS idx_file_share_emails_email`.execute(db);
  await db.schema.dropTable("file_share_emails").execute();
}
