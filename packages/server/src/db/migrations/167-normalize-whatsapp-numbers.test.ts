import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { up } from "./167-normalize-whatsapp-numbers";

type MigrationDb = {
  users: { id: string; name: string; whatsapp_number: string | null };
};

function createDb(): Kysely<MigrationDb> {
  return new Kysely<MigrationDb>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("167-normalize-whatsapp-numbers migration", () => {
  const databases: Kysely<MigrationDb>[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
  });

  async function seed(rows: { id: string; whatsapp_number: string | null }[]): Promise<Kysely<MigrationDb>> {
    const db = createDb();
    databases.push(db);
    await db.schema
      .createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("whatsapp_number", "text", (col) => col.unique())
      .execute();
    for (const row of rows) {
      await db.insertInto("users").values({ id: row.id, name: row.id, whatsapp_number: row.whatsapp_number }).execute();
    }
    return db;
  }

  async function numbers(db: Kysely<MigrationDb>): Promise<Record<string, string | null>> {
    const rows = await db.selectFrom("users").select(["id", "whatsapp_number"]).execute();
    return Object.fromEntries(rows.map((row) => [row.id, row.whatsapp_number]));
  }

  it("rewrites the spellings observed in production to E.164", async () => {
    const db = await seed([
      { id: "spaced", whatsapp_number: "+91 9101299347" },
      { id: "dashed", whatsapp_number: "+91-9667704669" },
      { id: "clean", whatsapp_number: "+917007413075" },
    ]);

    await up(db as never);

    expect(await numbers(db)).toEqual({
      spaced: "+919101299347",
      dashed: "+919667704669",
      clean: "+917007413075",
    });
  });

  it("leaves a row alone when normalising it would collide with another user", async () => {
    const db = await seed([
      { id: "canonical", whatsapp_number: "+919101299347" },
      { id: "duplicate", whatsapp_number: "+91 9101299347" },
    ]);

    await up(db as never);

    expect(await numbers(db)).toEqual({
      canonical: "+919101299347",
      duplicate: "+91 9101299347",
    });
  });

  it("leaves unparseable and absent values untouched", async () => {
    const db = await seed([
      { id: "junk", whatsapp_number: "not a number" },
      { id: "absent", whatsapp_number: null },
    ]);

    await up(db as never);

    expect(await numbers(db)).toEqual({ junk: "not a number", absent: null });
  });

  it("leaves both rows alone when two noncanonical spellings claim one free number", async () => {
    const db = await seed([
      { id: "spaced", whatsapp_number: "+91 9101299347" },
      { id: "dashed", whatsapp_number: "+91-9101299347" },
    ]);

    await up(db as never);

    expect(await numbers(db)).toEqual({
      spaced: "+91 9101299347",
      dashed: "+91-9101299347",
    });
  });

  it("picks no winner regardless of row order", async () => {
    const forward = await seed([
      { id: "a", whatsapp_number: "+91 9101299347" },
      { id: "b", whatsapp_number: "+91-9101299347" },
    ]);
    const reversed = await seed([
      { id: "b", whatsapp_number: "+91-9101299347" },
      { id: "a", whatsapp_number: "+91 9101299347" },
    ]);

    await up(forward as never);
    await up(reversed as never);

    expect(await numbers(forward)).toEqual(await numbers(reversed));
  });

  it("still normalises uncontested numbers alongside a contested pair", async () => {
    const db = await seed([
      { id: "spaced", whatsapp_number: "+91 9101299347" },
      { id: "dashed", whatsapp_number: "+91-9101299347" },
      { id: "lonely", whatsapp_number: "+91 9667704669" },
    ]);

    await up(db as never);

    expect(await numbers(db)).toEqual({
      spaced: "+91 9101299347",
      dashed: "+91-9101299347",
      lonely: "+919667704669",
    });
  });

  it("is safe to run twice", async () => {
    const db = await seed([{ id: "spaced", whatsapp_number: "+91 9101299347" }]);

    await up(db as never);
    await up(db as never);

    expect(await numbers(db)).toEqual({ spaced: "+919101299347" });
  });
});
