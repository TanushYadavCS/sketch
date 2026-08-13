import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import { createMigrator } from "../migrate";
import { createCompanyRelationshipDeclarationRepository } from "../repositories/company-relationship-declarations";
import type { DB } from "../schema";

describe("194 counterparty axes migration", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  async function migrateTo187(): Promise<void> {
    const result = await createMigrator(db).migrateTo("200-project-minting-acceptance");
    expect(result.error).toBeUndefined();
  }

  async function migrateToLatest(): Promise<void> {
    const result = await createMigrator(db).migrateToLatest();
    expect(result.error).toBeUndefined();
  }

  it("backfills paying and trial declarations into axes and preserves only row metadata", async () => {
    await migrateTo187();
    await sql`
      INSERT INTO company_relationship_declarations
        (company_entity_id, declared_state, note, created_at, updated_at)
      VALUES
        ('company-paying', 'paying', 'active note', '2026-08-01T10:00:00.000Z', '2026-08-02T11:00:00.000Z'),
        ('company-trial', 'trial', 'pilot note', '2026-08-03T12:00:00.000Z', '2026-08-04T13:00:00.000Z')
    `.execute(db);

    await migrateToLatest();

    const rows = await sql<{
      subject_entity_id: string;
      counterparty_kind: string;
      client_stage: string | null;
      note: string | null;
      created_at: string;
      updated_at: string;
    }>`
      SELECT subject_entity_id, counterparty_kind, client_stage, note, created_at, updated_at
      FROM company_relationship_declarations
      ORDER BY subject_entity_id ASC
    `.execute(db);
    expect(rows.rows).toEqual([
      {
        subject_entity_id: "company-paying",
        counterparty_kind: "client",
        client_stage: "active",
        note: "active note",
        created_at: "2026-08-01T10:00:00.000Z",
        updated_at: "2026-08-02T11:00:00.000Z",
      },
      {
        subject_entity_id: "company-trial",
        counterparty_kind: "client",
        client_stage: "pilot",
        note: "pilot note",
        created_at: "2026-08-03T12:00:00.000Z",
        updated_at: "2026-08-04T13:00:00.000Z",
      },
    ]);

    const columns = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'company_relationship_declarations'
    `.execute(db);
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain("company_entity_id");
    expect(names).not.toContain("declared_state");
  });

  it("supersedes pending old-vocabulary verdicts and leaves decided verdicts byte-identical", async () => {
    await migrateTo187();
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
          relationship_state,
          flags,
          vote_stats,
          decided_at,
          decided_by_user_id,
          struck_projects,
          accepted_result,
          created_at,
          updated_at
        )
      VALUES
        (
          'pending-verdict',
          'pending-company',
          'Pending Co',
          2,
          'pending dossier',
          '{"relationshipState":"trial","projects":[]}',
          'test-model',
          'old-prompt',
          'pending',
          NULL,
          'trial',
          '["flag"]',
          '{"votes":1}',
          NULL,
          NULL,
          NULL,
          NULL,
          '2026-08-01T10:00:00.000Z',
          '2026-08-01T10:00:00.000Z'
        ),
        (
          'accepted-verdict',
          'accepted-company',
          'Accepted Co',
          3,
          'accepted dossier',
          '{"relationshipState":"customer","projects":[]}',
          'test-model',
          'old-prompt',
          'accepted',
          NULL,
          'customer',
          NULL,
          NULL,
          '2026-08-02T10:00:00.000Z',
          'reviewer',
          '[]',
          '{"entityIds":{"projectIds":[]}}',
          '2026-08-02T09:00:00.000Z',
          '2026-08-02T10:00:00.000Z'
        ),
        (
          'rejected-verdict',
          'rejected-company',
          'Rejected Co',
          4,
          'rejected dossier',
          '{"relationshipState":"vendor","projects":[]}',
          'test-model',
          'old-prompt',
          'rejected',
          NULL,
          'vendor',
          '[]',
          NULL,
          '2026-08-03T10:00:00.000Z',
          'reviewer',
          NULL,
          NULL,
          '2026-08-03T09:00:00.000Z',
          '2026-08-03T10:00:00.000Z'
        )
    `.execute(db);
    const before = await sql<Record<string, unknown>>`
      SELECT * FROM project_minting_verdicts
      WHERE id IN ('accepted-verdict', 'rejected-verdict')
      ORDER BY id ASC
    `.execute(db);

    await migrateToLatest();

    const pending = await sql<{ superseded_at: string | null }>`
      SELECT superseded_at FROM project_minting_verdicts WHERE id = 'pending-verdict'
    `.execute(db);
    expect(pending.rows[0].superseded_at).not.toBeNull();

    const after = await sql<Record<string, unknown>>`
      SELECT * FROM project_minting_verdicts
      WHERE id IN ('accepted-verdict', 'rejected-verdict')
      ORDER BY id ASC
    `.execute(db);
    expect(after.rows).toEqual(before.rows);
  });

  it("rejects stages for non-stage kinds and requires stages for stage-carrying kinds", async () => {
    const declarations = createCompanyRelationshipDeclarationRepository(db);

    await expect(
      declarations.declare({
        subjectEntityId: "vendor-with-stage",
        counterpartyKind: "vendor",
        clientStage: "active",
      }),
    ).rejects.toThrow("client_stage must be null");
    await expect(
      declarations.declare({
        subjectEntityId: "client-without-stage",
        counterpartyKind: "client",
        clientStage: null,
      }),
    ).rejects.toThrow("client_stage is required");

    await declarations.declare({
      subjectEntityId: "vendor",
      counterpartyKind: "vendor",
      clientStage: null,
    });
    await declarations.declare({
      subjectEntityId: "client",
      counterpartyKind: "client",
      clientStage: "active",
    });

    await expect(declarations.list()).resolves.toEqual([
      expect.objectContaining({
        subject_entity_id: "client",
        counterparty_kind: "client",
        client_stage: "active",
      }),
      expect.objectContaining({
        subject_entity_id: "vendor",
        counterparty_kind: "vendor",
        client_stage: null,
      }),
    ]);
  });
});
