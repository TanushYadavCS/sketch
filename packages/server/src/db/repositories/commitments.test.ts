import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitFactsForSyncedItem } from "../../connectors/sync-facts";
import type { Connector, SyncedItem } from "../../connectors/types";
import {
  buildMaterializeDeps,
  materializeFromFact,
  materializeUnmaterializedFacts,
  shouldMarkMaterialized,
} from "../../entities/materialize";
import { createTestDb, createTestLogger } from "../../test-utils";
import type { DB } from "../schema";
import { listOpenCommitments, markCommitmentDone, upsertCommitmentFact } from "./commitments";
import { createEntityRepository } from "./entities";
import { createIndexedFileFactRepository } from "./indexed-file-facts";
import { TEST_ACCOUNT_ENTITY_ID } from "./tasks";

const USER_ID = "commitment-user";
const CONNECTOR_ID = "commitment-config";

describe("commitment facts", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("materializes with parent and due date while flag-gating emission and materialization counters", async () => {
    await seedBase(db);
    const project = await seedProject(db, { id: "commitment-project", name: "Commitment Project" });
    await seedProject(db, { id: TEST_ACCOUNT_ENTITY_ID, name: "Test Account" });
    const connector = { type: "linear" } as Connector;
    const item = commitmentItem(project.id);

    await emitFactsForSyncedItem({
      db,
      factRepo: createIndexedFileFactRepository(db),
      connector,
      connectorType: "linear",
      factContext: { connectorConfigId: CONNECTOR_ID, createdByUserId: USER_ID, lastSeenSyncRunId: "sync-off" },
      item,
      indexedFileId: "commitment-file-1",
      experimentalFlag: false,
    });
    let count = await db
      .selectFrom("indexed_file_facts")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("fact_type", "=", "commitment")
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(0);

    await emitFactsForSyncedItem({
      db,
      factRepo: createIndexedFileFactRepository(db),
      connector,
      connectorType: "linear",
      factContext: { connectorConfigId: CONNECTOR_ID, createdByUserId: USER_ID, lastSeenSyncRunId: "sync-on" },
      item,
      indexedFileId: "commitment-file-1",
      experimentalFlag: true,
    });
    const fact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("fact_type", "=", "commitment")
      .executeTakeFirstOrThrow();
    const depsOff = await buildMaterializeDeps(db, { experimentalFlag: false });
    const offResult = await materializeFromFact(depsOff, fact);
    expect(offResult).toEqual({ kind: "skipped", reason: "experimental_off" });
    expect(shouldMarkMaterialized(offResult)).toBe(true);

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });
    const materializedFact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("fact_type", "=", "commitment")
      .executeTakeFirstOrThrow();
    const raw = JSON.parse(materializedFact.raw ?? "{}");
    expect(raw).toMatchObject({
      commitmentId: "commitment-1",
      parentEntityId: project.id,
      parent_entity_id: project.id,
      dueAt: "2026-07-01T00:00:00.000Z",
      status: "open",
    });
    expect(raw.parentEntityId).not.toBe(TEST_ACCOUNT_ENTITY_ID);
    expect(materializedFact.materialized_at).not.toBeNull();
    expect(summary).toMatchObject({
      factsRead: 1,
      entitiesCreated: 0,
      entitiesLinked: 0,
      queued: 0,
      mentionsWritten: 0,
      relationshipsWritten: 0,
      skipped: 0,
      materialized: 1,
      deferred: 0,
      deferredBelowThreshold: 0,
    });
    count = await db
      .selectFrom("tasks")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(0);
  });

  it("mark-done persists within a run and removes the row from open commitments", async () => {
    await seedBase(db);
    const project = await seedProject(db, { id: "commitment-project", name: "Commitment Project" });
    await upsertCommitmentFact(db, {
      experimentalFlag: true,
      indexedFileId: "commitment-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      lastSeenSyncRunId: "sync-1",
      source: "linear",
      commitmentId: "commitment-1",
      parentEntityId: project.id,
      title: "Send the follow-up",
      dueAt: "2026-07-01T00:00:00.000Z",
      evidence: { fileIds: ["commitment-file-1"], entityIds: [project.id] },
    });

    await expect(listOpenCommitments(db, { parentEntityId: project.id })).resolves.toHaveLength(1);
    await expect(markCommitmentDone(db, "commitment-1")).resolves.toBe(true);
    await expect(listOpenCommitments(db, { parentEntityId: project.id })).resolves.toHaveLength(0);
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(JSON.parse(fact.raw ?? "{}").status).toBe("done");
  });
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Commitment User",
      email: "commitment-user@example.com",
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
      created_by: USER_ID,
      scope_config: "{}",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "commitment-file-1",
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "commitment-file-1",
      provider_url: null,
      file_name: "Commitment file",
      file_type: "issue",
      content_category: "structured",
      content: "Commitment file",
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

async function seedProject(db: Kysely<DB>, input: { id: string; name: string }) {
  const repo = createEntityRepository(db);
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: "project",
      subtype: "external",
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await repo.upsertSourceRef({ entityId: input.id, source: "linear", sourceId: `${input.id}-source` });
  return db.selectFrom("entities").selectAll().where("id", "=", input.id).executeTakeFirstOrThrow();
}

function commitmentItem(projectId: string): SyncedItem {
  return {
    providerFileId: "commitment-file-1",
    providerUrl: null,
    fileName: "Commitment file",
    fileType: "issue",
    contentCategory: "structured",
    content: "Commitment file",
    sourcePath: null,
    contentHash: "hash-1",
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    commitments: [
      {
        commitmentId: "commitment-1",
        parentRef: { source: "linear", sourceId: `${projectId}-source` },
        title: "Send the follow-up",
        status: "open",
        dueAt: "2026-07-01T00:00:00.000Z",
        evidence: { fileIds: ["commitment-file-1"], entityIds: [projectId, TEST_ACCOUNT_ENTITY_ID] },
      },
    ],
  };
}
