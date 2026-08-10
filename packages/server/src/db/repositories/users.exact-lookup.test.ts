import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate";
import type { DB } from "../schema";
import { createUserRepository } from "./users";

describe("findByWhatsappNumber exact-match priority", () => {
  const databases: Kysely<DB>[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
  });

  async function seeded(): Promise<Kysely<DB>> {
    const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: new SQLite(":memory:") }) });
    databases.push(db);
    await runMigrations(db, { quiet: true });
    await db
      .insertInto("users")
      .values([
        { id: "canonical", name: "Canonical", whatsapp_number: "+919101299347", type: "human" },
        { id: "legacy", name: "Legacy", whatsapp_number: "00919101299347", type: "human" },
      ])
      .execute();
    return db;
  }

  it("returns the row holding the spelling it was asked for, not a normalised sibling", async () => {
    const repo = createUserRepository(await seeded(), { slackEntitySyncEnabled: false });

    expect((await repo.findByWhatsappNumber("00919101299347"))?.id).toBe("legacy");
    expect((await repo.findByWhatsappNumber("+919101299347"))?.id).toBe("canonical");
  });

  it("still falls back to the normalised form when no row holds the given spelling", async () => {
    const repo = createUserRepository(await seeded(), { slackEntitySyncEnabled: false });

    expect((await repo.findByWhatsappNumber("+91 9101299347"))?.id).toBe("canonical");
  });
});
