import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { markCommitmentDone, measureCommitmentStomp, upsertCommitmentFact } from "./commitments";
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
