import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { materializeUnmaterializedFacts } from "../../entities/materialize";
import { createTestLogger, createTestPgDb, getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { markCommitmentDone, measureCommitmentStomp, upsertCommitmentFact } from "./commitments";
import { createEntityRepository } from "./entities";
import { createIndexedFileFactRepository } from "./indexed-file-facts";

const USER_ID = "commitment-pg-user";
const CONNECTOR_ID = "commitment-pg-config";

describe("commitment stomp measurement postgres", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("measures done markers stomped on re-sync with isolated overwrite and tombstone cohorts", async () => {
    await seedBase(db);
    await seedCommitment(db, "overwrite-1");
    await seedCommitment(db, "overwrite-2");
    await seedCommitment(db, "tombstone-1");
    await seedCommitment(db, "tombstone-2");
    await seedOtherFact(db, "other-1");
    await seedOtherFact(db, "other-2");
    await markCommitmentDone(db, "overwrite-1");
    await markCommitmentDone(db, "overwrite-2");
    await markCommitmentDone(db, "tombstone-1");
    await markCommitmentDone(db, "tombstone-2");

    const result = await measureCommitmentStomp(db, CONNECTOR_ID, {
      overwriteCohort: ["overwrite-1", "overwrite-2"],
      tombstoneCohort: ["tombstone-1", "tombstone-2"],
      priorSyncRunId: "sync-prior",
      nextSyncRunId: "sync-next",
    });

    expect(result).toEqual({ overwritten: 2, tombstoned: 2, survived: 0, reconcileSkipped: false });
  });
});

describe("commitment sub-entities postgres", () => {
  it("preserves local status across re-materialization with the partial unique index", async () => {
    const freshDb = await createTestPgDb();
    try {
      await seedBase(freshDb);
      const project = await seedProject(freshDb, { id: "commitment-pg-project", name: "Commitment PG Project" });

      await upsertCommitmentFact(freshDb, {
        experimentalFlag: true,
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        lastSeenSyncRunId: "sync-1",
        source: "linear",
        commitmentId: "pg-survives",
        parentEntityId: project.id,
        title: "Send the PG follow-up",
        status: "open",
        evidence: { fileIds: [], entityIds: [project.id] },
      });
      await materializeUnmaterializedFacts(freshDb, createTestLogger(), { experimentalFlag: true });
      await expect(markCommitmentDone(freshDb, "pg-survives")).resolves.toBe(true);

      await upsertCommitmentFact(freshDb, {
        experimentalFlag: true,
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        lastSeenSyncRunId: "sync-2",
        source: "linear",
        commitmentId: "pg-survives",
        parentEntityId: project.id,
        title: "Send the PG follow-up",
        status: "open",
        evidence: { fileIds: [], entityIds: [project.id] },
      });
      await createIndexedFileFactRepository(freshDb).reconcileStaleFacts(
        { kind: "connector", connectorConfigId: CONNECTOR_ID, syncRunId: "sync-2" },
        null,
      );
      await materializeUnmaterializedFacts(freshDb, createTestLogger(), { experimentalFlag: true });

      const rows = await freshDb
        .selectFrom("sub_entities")
        .selectAll()
        .where("kind", "=", "commitment")
        .where("normalized_name", "=", "send the pg follow-up")
        .where("valid_to", "is", null)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "done", status_authority: "local", parent_scope_key: project.id });

      await upsertCommitmentFact(freshDb, {
        experimentalFlag: true,
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        lastSeenSyncRunId: "sync-3",
        source: "linear",
        commitmentId: "pg-external",
        parentEntityId: project.id,
        title: "Track external status",
        status: "open",
        evidence: { fileIds: [], entityIds: [project.id] },
      });
      await materializeUnmaterializedFacts(freshDb, createTestLogger(), { experimentalFlag: true });
      await upsertCommitmentFact(freshDb, {
        experimentalFlag: true,
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        lastSeenSyncRunId: "sync-4",
        source: "linear",
        commitmentId: "pg-external",
        parentEntityId: project.id,
        title: "Track external status",
        status: "dropped",
        evidence: { fileIds: [], entityIds: [project.id] },
      });
      await materializeUnmaterializedFacts(freshDb, createTestLogger(), { experimentalFlag: true });
      const external = await freshDb
        .selectFrom("sub_entities")
        .selectAll()
        .where("kind", "=", "commitment")
        .where("normalized_name", "=", "track external status")
        .where("valid_to", "is", null)
        .executeTakeFirstOrThrow();
      expect(external).toMatchObject({ status: "dropped", status_authority: "external" });
    } finally {
      await freshDb.destroy();
    }
  }, 30000);
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Commitment PG User", email: "commitment-pg-user@example.com" })
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
}

async function seedCommitment(db: Kysely<DB>, commitmentId: string): Promise<void> {
  await upsertCommitmentFact(db, {
    experimentalFlag: true,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    lastSeenSyncRunId: "sync-prior",
    source: "linear",
    commitmentId,
    title: commitmentId,
    evidence: { fileIds: [], entityIds: [] },
  });
}

async function seedOtherFact(db: Kysely<DB>, id: string): Promise<void> {
  await createIndexedFileFactRepository(db).upsertFact({
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    lastSeenSyncRunId: "sync-prior",
    source: "linear",
    factType: "structural_seed",
    relation: "seeded",
    subjectName: id,
    subjectSource: "linear",
    subjectSourceId: id,
    raw: { sourceType: "project", sourcePath: id },
  });
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
