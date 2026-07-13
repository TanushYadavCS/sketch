import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performReset } from "../api/entities/reset-service";
import { upsertCommitmentFact } from "../db/repositories/commitments";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { MAX_MATERIALIZATION_ATTEMPTS, materializeUnmaterializedFacts } from "./materialize";

const USER_ID = "quarantine-user";
const CONNECTOR_ID = "quarantine-config";

describe("materialization owner fallback", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("materializes facts whose owner id matches no user instead of failing the owner foreign key", async () => {
    await seedBase(db, { connectorOwner: "admin" });
    await seedCommitmentFact(db, { createdByUserId: "admin" });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), {});

    expect(summary).toMatchObject({ factsRead: 1, skipped: 0 });
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.materialized_at).not.toBeNull();
    expect(fact.materialization_attempts).toBe(0);
    const commitment = await db.selectFrom("sub_entities").selectAll().executeTakeFirstOrThrow();
    expect(commitment.created_by_user_id).toBeNull();
  });

  it("falls back to the connector owner when the fact owner is not a real user", async () => {
    await seedBase(db, { connectorOwner: USER_ID });
    await seedCommitmentFact(db, { createdByUserId: "sketch-api-key" });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), {});

    expect(summary).toMatchObject({ factsRead: 1, skipped: 0 });
    const commitment = await db.selectFrom("sub_entities").selectAll().executeTakeFirstOrThrow();
    expect(commitment.created_by_user_id).toBe(USER_ID);
  });

  it("resolves connector-level facts without an indexed file through the fact's connector", async () => {
    await seedBase(db, { connectorOwner: USER_ID });
    await seedCommitmentFact(db, { createdByUserId: "admin", indexedFileId: null });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), {});

    expect(summary).toMatchObject({ factsRead: 1, skipped: 0 });
    const commitment = await db.selectFrom("sub_entities").selectAll().executeTakeFirstOrThrow();
    expect(commitment.created_by_user_id).toBe(USER_ID);
  });
});

describe("materialization quarantine", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db, { connectorOwner: USER_ID });
    await seedCommitmentFact(db, { createdByUserId: USER_ID });
    await sql`
      CREATE TRIGGER fail_sub_entities BEFORE INSERT ON sub_entities
      BEGIN SELECT RAISE(ABORT, 'forced materialization failure'); END
    `.execute(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("stops retrying a fact after the attempt cap and resumes when its content changes", async () => {
    for (let attempt = 1; attempt <= MAX_MATERIALIZATION_ATTEMPTS; attempt++) {
      const summary = await materializeUnmaterializedFacts(db, createTestLogger(), {});
      expect(summary).toMatchObject({ factsRead: 1, skipped: 1 });
      const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(fact.materialization_attempts).toBe(attempt);
      expect(fact.materialized_at).toBeNull();
    }

    const quarantined = await materializeUnmaterializedFacts(db, createTestLogger(), {});
    expect(quarantined).toMatchObject({ factsRead: 0, skipped: 0 });

    await seedCommitmentFact(db, { createdByUserId: USER_ID, contentHash: "hash-v2" });
    const resumed = await materializeUnmaterializedFacts(db, createTestLogger(), {});
    expect(resumed).toMatchObject({ factsRead: 1, skipped: 1 });
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.materialization_attempts).toBe(1);
  });

  it("keeps the attempt counter across same-content re-syncs so the cap can engage", async () => {
    await materializeUnmaterializedFacts(db, createTestLogger(), {});
    await materializeUnmaterializedFacts(db, createTestLogger(), {});

    await seedCommitmentFact(db, { createdByUserId: USER_ID });
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.materialization_attempts).toBe(2);
  });

  it("operator reset clears the quarantine counter", async () => {
    for (let attempt = 1; attempt <= MAX_MATERIALIZATION_ATTEMPTS; attempt++) {
      await materializeUnmaterializedFacts(db, createTestLogger(), {});
    }
    const quarantined = await materializeUnmaterializedFacts(db, createTestLogger(), {});
    expect(quarantined).toMatchObject({ factsRead: 0 });

    await performReset(db, {
      includeConnectors: false,
      includeAi: false,
      includeManual: false,
      orgSourceTypes: [],
      factTypes: ["commitment"],
    });

    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.materialization_attempts).toBe(0);
    const resumed = await materializeUnmaterializedFacts(db, createTestLogger(), {});
    expect(resumed).toMatchObject({ factsRead: 1, skipped: 1 });
  });
});

async function seedBase(db: Kysely<DB>, opts: { connectorOwner: string }): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Quarantine User",
      email: "quarantine-user@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "linear",
      auth_type: "api_key",
      credentials: "{}",
      created_by: opts.connectorOwner,
      scope_config: "{}",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "quarantine-file-1",
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "quarantine-file-1",
      provider_url: null,
      file_name: "Quarantine file",
      file_type: "issue",
      content_category: "structured",
      content: "Quarantine file",
      source: "linear",
      source_path: null,
      content_hash: "hash-1",
      source_created_at: now,
      source_updated_at: now,
      synced_at: now,
      access_scope_id: null,
      share_with_everyone: 1,
    })
    .execute();
}

async function seedCommitmentFact(
  db: Kysely<DB>,
  opts: { createdByUserId: string; contentHash?: string; indexedFileId?: string | null },
): Promise<void> {
  const indexedFileId = opts.indexedFileId === undefined ? "quarantine-file-1" : opts.indexedFileId;
  await upsertCommitmentFact(db, {
    indexedFileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: opts.createdByUserId,
    lastSeenSyncRunId: "sync-1",
    source: "linear",
    contentHash: opts.contentHash ?? "hash-v1",
    commitmentId: "quarantine-commitment-1",
    title: "Send the follow-up",
    status: "open",
    dueAt: "2026-07-01T00:00:00.000Z",
    evidence: { fileIds: indexedFileId ? [indexedFileId] : [], entityIds: [] },
  });
}
