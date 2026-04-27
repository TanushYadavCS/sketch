import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "./040-user-auth-role";

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function createTables(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("settings")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("admin_email", "text")
    .addColumn("admin_password_hash", "text")
    .execute();

  await db.schema
    .createTable("users")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("email", "text")
    .addColumn("email_verified_at", "text")
    .addColumn("slack_user_id", "text")
    .addColumn("whatsapp_number", "text")
    .addColumn("description", "text")
    .addColumn("type", "text", (col) => col.notNull().defaultTo("human"))
    .addColumn("role", "text")
    .addColumn("reports_to", "text")
    .addColumn("tool_progress", "text")
    .addColumn("reasoning_text", "integer")
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

let db: Kysely<unknown>;

beforeEach(async () => {
  db = createBlankDb();
  await createTables(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("040-user-auth-role", () => {
  it("merges the legacy settings admin into an existing user by normalized email", async () => {
    await sql`
      INSERT INTO settings (id, admin_email, admin_password_hash)
      VALUES ('default', 'Admin@Test.com', 'hash-1')
    `.execute(db);
    await sql`
      INSERT INTO users (id, name, email)
      VALUES ('existing-user', 'Existing Admin', ' admin@test.com ')
    `.execute(db);

    await up(db);

    const users = await sql<{ id: string; email: string; password_hash: string; auth_role: string }>`
      SELECT id, email, password_hash, auth_role FROM users
    `.execute(db);
    expect(users.rows).toEqual([
      { id: "existing-user", email: "admin@test.com", password_hash: "hash-1", auth_role: "admin" },
    ]);
  });

  it("creates an admin user when the legacy settings admin is not already in users", async () => {
    await sql`
      INSERT INTO settings (id, admin_email, admin_password_hash)
      VALUES ('default', 'admin@test.com', 'hash-1')
    `.execute(db);

    await up(db);

    const users = await sql<{ name: string; email: string; password_hash: string; auth_role: string }>`
      SELECT name, email, password_hash, auth_role FROM users
    `.execute(db);
    expect(users.rows).toEqual([
      { name: "admin", email: "admin@test.com", password_hash: "hash-1", auth_role: "admin" },
    ]);
  });

  it("fails before choosing an arbitrary row when duplicate normalized emails exist", async () => {
    await sql`INSERT INTO users (id, name, email) VALUES ('u1', 'One', 'admin@test.com')`.execute(db);
    await sql`INSERT INTO users (id, name, email) VALUES ('u2', 'Two', 'Admin@Test.com')`.execute(db);

    await expect(up(db)).rejects.toThrow("duplicate normalized user emails");
  });

  it("allows multiple blank email rows because they are not login identities", async () => {
    await sql`INSERT INTO users (id, name, email) VALUES ('u1', 'One', '')`.execute(db);
    await sql`INSERT INTO users (id, name, email) VALUES ('u2', 'Two', '   ')`.execute(db);

    await up(db);

    await sql`INSERT INTO users (id, name, email) VALUES ('u3', 'Three', '')`.execute(db);
  });

  it("adds a unique normalized email index for future users", async () => {
    await up(db);

    await sql`INSERT INTO users (id, name, email) VALUES ('u1', 'One', 'admin@test.com')`.execute(db);
    await expect(
      sql`INSERT INTO users (id, name, email) VALUES ('u2', 'Two', 'Admin@Test.com')`.execute(db),
    ).rejects.toThrow();
  });
});
