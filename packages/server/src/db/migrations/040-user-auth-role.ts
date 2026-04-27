import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").addColumn("password_hash", "text").execute();
  await db.schema
    .alterTable("users")
    .addColumn("auth_role", "text", (col) => col.notNull().defaultTo("member"))
    .execute();

  const duplicateEmails = await sql<{ normalized_email: string; count: number | string | bigint }>`
    SELECT lower(trim(email)) AS normalized_email, count(*) AS count
    FROM users
    WHERE email IS NOT NULL AND trim(email) != ''
    GROUP BY lower(trim(email))
    HAVING count(*) > 1
  `.execute(db);

  if (duplicateEmails.rows.length > 0) {
    const emails = duplicateEmails.rows.map((row) => row.normalized_email).join(", ");
    throw new Error(`Cannot migrate user auth: duplicate normalized user emails found: ${emails}`);
  }

  const settings = await sql<{ admin_email: string | null; admin_password_hash: string | null }>`
    SELECT admin_email, admin_password_hash
    FROM settings
    WHERE id = 'default'
  `.execute(db);

  const adminEmail = settings.rows[0]?.admin_email?.trim().toLowerCase();
  const adminPasswordHash = settings.rows[0]?.admin_password_hash;

  if (adminEmail) {
    const existing = await sql<{ id: string; email_verified_at: string | null }>`
      SELECT id, email_verified_at
      FROM users
      WHERE lower(trim(email)) = ${adminEmail}
      LIMIT 1
    `.execute(db);

    const now = new Date().toISOString();
    if (existing.rows[0]) {
      await sql`
        UPDATE users
        SET
          email = ${adminEmail},
          email_verified_at = COALESCE(email_verified_at, ${now}),
          password_hash = ${adminPasswordHash},
          auth_role = 'admin'
        WHERE id = ${existing.rows[0].id}
      `.execute(db);
    } else {
      await sql`
        INSERT INTO users (id, name, email, email_verified_at, password_hash, auth_role, type)
        VALUES (${randomUUID()}, ${adminEmail.split("@")[0]}, ${adminEmail}, ${now}, ${adminPasswordHash}, 'admin', 'human')
      `.execute(db);
    }
  }

  await sql`
    CREATE UNIQUE INDEX users_email_normalized_uidx
    ON users(lower(trim(email)))
    WHERE email IS NOT NULL AND trim(email) != ''
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS users_email_normalized_uidx`.execute(db);
  await db.schema.alterTable("users").dropColumn("auth_role").execute();
  await db.schema.alterTable("users").dropColumn("password_hash").execute();
}
