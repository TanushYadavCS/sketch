/**
 * Manual entity sharing + entity RBAC v1.
 *
 * - entity_share_emails: per-(entity, email) grants. Mirrors file_share_emails.
 * - entities.share_with_everyone: org-wide flag (admin-only toggle).
 * - Backfill: org-curated system entities (clickup_workspace, clickup_space) are
 *   set share_with_everyone = 1 so they remain visible to members after the
 *   default-deny RBAC change. Mirrors the SYSTEM_SOURCE_TYPES set in
 *   packages/server/src/entities/profile-facts.ts.
 */
import { type Kysely, sql } from "kysely";

const SYSTEM_SOURCE_TYPES = ["clickup_workspace", "clickup_space"];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("entity_share_emails")
    .addColumn("entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("email", "text", (col) => col.notNull())
    .addColumn("granted_by_user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("granted_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("entity_share_emails_pk", ["entity_id", "email"])
    .execute();

  await sql`CREATE INDEX idx_entity_share_emails_email ON entity_share_emails(email)`.execute(db);

  await db.schema
    .alterTable("entities")
    .addColumn("share_with_everyone", "integer", (col) => col.notNull().defaultTo(0))
    .execute();

  await sql`CREATE INDEX idx_entities_share_with_everyone ON entities(share_with_everyone)`.execute(db);

  // Backfill: keep system-typed entities org-visible after the RBAC change.
  await sql`UPDATE entities SET share_with_everyone = 1 WHERE source_type IN (${sql.join(
    SYSTEM_SOURCE_TYPES.map((t) => sql`${t}`),
  )})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_entities_share_with_everyone`.execute(db);
  await db.schema.alterTable("entities").dropColumn("share_with_everyone").execute();
  await sql`DROP INDEX IF EXISTS idx_entity_share_emails_email`.execute(db);
  await db.schema.dropTable("entity_share_emails").execute();
}
