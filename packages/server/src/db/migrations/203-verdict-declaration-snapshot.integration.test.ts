import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import { createMigrator } from "../migrate";
import type { DB } from "../schema";

describe("196 verdict declaration snapshot migration", () => {
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

  it("adds declaration snapshot columns, drops relationship_state, and supersedes pending verdicts", async () => {
    const migrator = createMigrator(db);
    expect((await migrator.migrateTo("202-verdict-counterparty-axes")).error).toBeUndefined();
    await sql`
      INSERT INTO project_minting_verdicts
        (
          id,
          company_entity_id,
          company_name,
          file_count,
          dossier,
          verdict,
          model,
          prompt_version,
          status,
          superseded_at,
          counterparty_kind,
          client_stage,
          relationship_state,
          created_at,
          updated_at
        )
      VALUES
        (
          'pending-verdict',
          'company-1',
          'Company',
          1,
          'dossier',
          '{"counterpartyKind":"client","clientStage":"active","engagement":null,"projects":[],"existingEntities":[],"trackerFit":"no_containers","notes":[]}',
          'model',
          'prompt',
          'pending',
          NULL,
          'client',
          'active',
          'customer',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
    `.execute(db);

    expect((await migrator.migrateTo("203-verdict-declaration-snapshot")).error).toBeUndefined();
    const columns = await columnNames();
    expect(columns).toContain("declared_counterparty_kind");
    expect(columns).toContain("declared_client_stage");
    expect(columns).not.toContain("relationship_state");
    const row = await db
      .selectFrom("project_minting_verdicts")
      .select(["declared_counterparty_kind", "declared_client_stage", "superseded_at"])
      .where("id", "=", "pending-verdict")
      .executeTakeFirstOrThrow();
    expect(row.declared_counterparty_kind).toBeNull();
    expect(row.declared_client_stage).toBeNull();
    expect(row.superseded_at).not.toBeNull();

    expect((await migrator.migrateTo("202-verdict-counterparty-axes")).error).toBeUndefined();
    const downColumns = await columnNames();
    expect(downColumns).toContain("relationship_state");
    expect(downColumns).not.toContain("declared_counterparty_kind");
    expect(downColumns).not.toContain("declared_client_stage");
  });
});
