/**
 * Tests for createDatabase().
 *
 * The SQLite path is exercised directly. The Postgres path is exercised
 * end-to-end via the PGlite migration tests in migrate-pg.test.ts (we can't
 * test createDatabase() with DB_TYPE=postgres here without a running Postgres
 * server since it creates a real pg.Pool).
 */
import { CompiledQuery, Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createTestConfig } from "../test-utils";
import { createDatabase } from "./index";
import type { DB } from "./schema";

describe("createDatabase", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    if (db) {
      await db.destroy();
      db = undefined;
    }
  });

  it("returns a Promise that resolves to a Kysely instance with DB_TYPE=sqlite", async () => {
    const config = createTestConfig({ DB_TYPE: "sqlite", SQLITE_PATH: ":memory:" });
    const result = createDatabase(config);
    expect(result).toBeInstanceOf(Promise);
    db = await result;
    expect(db).toBeInstanceOf(Kysely);
  });

  it("can execute a simple query on the sqlite instance", async () => {
    const config = createTestConfig({ DB_TYPE: "sqlite", SQLITE_PATH: ":memory:" });
    db = await createDatabase(config);
    await expect(db.executeQuery(CompiledQuery.raw("SELECT 1 AS n"))).resolves.toBeDefined();
  });

  it("sets sqliteVecAvailable flag for SQLite", async () => {
    const config = createTestConfig({ DB_TYPE: "sqlite", SQLITE_PATH: ":memory:" });
    db = await createDatabase(config);
    // After creating a SQLite DB, sqliteVecAvailable should be set (true if extension loaded, false otherwise)
    const { sqliteVecAvailable } = await import("./index");
    expect(typeof sqliteVecAvailable).toBe("boolean");
  });
});
