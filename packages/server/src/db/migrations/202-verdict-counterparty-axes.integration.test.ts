import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import { createMigrator } from "../migrate";
import type { DB } from "../schema";

describe("195 verdict counterparty axes migration", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  async function columnNames(): Promise<string[]> {
    const columns = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'project_minting_verdicts'
    `.execute(db);
    return columns.rows.map((row) => row.column_name).sort();
  }

  it("adds and removes verdict axis columns without dropping the legacy bridge column", async () => {
    const migrator = createMigrator(db);
    expect((await migrator.migrateTo("201-counterparty-axes")).error).toBeUndefined();
    expect(await columnNames()).not.toContain("counterparty_kind");
    expect(await columnNames()).not.toContain("client_stage");

    expect((await migrator.migrateTo("202-verdict-counterparty-axes")).error).toBeUndefined();
    expect(await columnNames()).toContain("counterparty_kind");
    expect(await columnNames()).toContain("client_stage");
    expect(await columnNames()).toContain("relationship_state");

    expect((await migrator.migrateTo("201-counterparty-axes")).error).toBeUndefined();
    expect(await columnNames()).not.toContain("counterparty_kind");
    expect(await columnNames()).not.toContain("client_stage");
    expect(await columnNames()).toContain("relationship_state");
  });
});
