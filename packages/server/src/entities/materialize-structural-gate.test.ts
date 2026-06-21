import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { buildMaterializeDeps, materializeUnmaterializedFacts } from "./materialize";
import { materializeStructuralSeed } from "./materialize-structural";
import type { IndexedFileFactRow } from "./materialize-types";

const USER_ID = "user-1";
const CONNECTOR_ID = "connector-1";
const FILE_ID = "file-1";
const TEST_ACCOUNT_ENTITY_ID = "24d4ef8a-47eb-4510-a951-7d9bae036786";

async function countEntitiesBySourceType(db: Kysely<DB>, sourceType: string): Promise<number> {
  const row = await db
    .selectFrom("entities")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("source_type", "=", sourceType)
    .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countReviewQueueRows(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("entity_review_queue")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function seedConnectorFile(db: Kysely<DB>, source = "linear"): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "User One",
      email: "user@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: source,
      auth_type: "oauth",
      credentials: "{}",
      created_by: USER_ID,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: FILE_ID,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: FILE_ID,
      file_name: "Seed",
      file_type: "project",
      content_category: "project",
      source,
      content_hash: "hash-1",
      is_archived: 0,
      synced_at: now,
    })
    .execute();
}

async function seedStructuralFact(
  db: Kysely<DB>,
  input: {
    source?: string;
    fileType?: string;
    sourceType?: string;
    subjectName: string;
    subjectSource?: string;
    subjectSourceId: string;
  },
): Promise<IndexedFileFactRow> {
  const source = input.source ?? "linear";
  const repo = createIndexedFileFactRepository(db);
  const raw = {
    providerFileId: input.subjectSourceId,
    fileType: input.fileType ?? "project",
    sourcePath: `${source}/${input.subjectSourceId}`,
    ...(input.sourceType ? { sourceType: input.sourceType } : {}),
  };
  await repo.upsertFact({
    indexedFileId: FILE_ID,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    source,
    factType: "structural_seed",
    relation: "seeded",
    subjectName: input.subjectName,
    subjectSource: input.subjectSource ?? source,
    subjectSourceId: input.subjectSourceId,
    contextSnippet: `${input.subjectName} container`,
    raw,
  });
  return db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("subject_source", "=", input.subjectSource ?? source)
    .where("subject_source_id", "=", input.subjectSourceId)
    .executeTakeFirstOrThrow();
}

describe("materializeStructuralSeed project birth gate", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("queues Linear project containers by stable handle across renames without creating a project entity", async () => {
    await seedConnectorFile(db);
    const fact = await seedStructuralFact(db, {
      subjectName: "Sketch",
      subjectSourceId: "P1",
    });
    const deps = await buildMaterializeDeps(db);

    const result = await materializeStructuralSeed(deps, fact);

    expect(result.kind).toBe("queued");
    const review = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(review).toMatchObject({
      seed_source: "linear",
      seed_source_id: "P1",
      entity_type: "project",
      proposed_name: "Sketch",
      status: "pending",
    });
    await expect(
      db.selectFrom("entity_review_evidence").selectAll().where("review_id", "=", review.id).execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute(),
    ).resolves.toHaveLength(0);

    const renamed = await materializeStructuralSeed(deps, { ...fact, subject_name: "Ruler" });

    expect(renamed).toMatchObject({ kind: "queued", reviewId: review.id });
    const reviews = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ id: review.id, proposed_name: "Ruler" });
    await expect(
      db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute(),
    ).resolves.toHaveLength(0);
  });

  it("treats a rejected seed row as a durable skip", async () => {
    await seedConnectorFile(db);
    const reviewRepo = createEntityReviewRepo(db);
    const { row } = await reviewRepo.upsertSeedReviewRow({
      proposedName: "Sketch",
      normalizedName: "sketch",
      entityType: "project",
      seedSource: "linear",
      seedSourceId: "P1",
      candidateEntityId: null,
      triggeredByUserId: USER_ID,
    });
    await db.updateTable("entity_review_queue").set({ status: "rejected" }).where("id", "=", row.id).execute();
    const fact = await seedStructuralFact(db, {
      subjectName: "Sketch",
      subjectSourceId: "P1",
    });
    const deps = await buildMaterializeDeps(db);

    const result = await materializeStructuralSeed(deps, fact);

    expect(result).toEqual({ kind: "skipped", reason: "seed_durably_rejected" });
    await expect(
      db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute(),
    ).resolves.toHaveLength(0);
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(1);
    await expect(db.selectFrom("entity_review_evidence").selectAll().execute()).resolves.toHaveLength(0);
  });

  it("links a confirmed project container and writes a mention without re-queueing", async () => {
    await seedConnectorFile(db);
    const entityRepo = createEntityRepository(db);
    const project = await entityRepo.upsertEntityFromTool({
      name: "Sketch",
      sourceType: "project",
      source: "linear",
      sourceId: "P1",
      sourceRefId: FILE_ID,
    });
    const fact = await seedStructuralFact(db, {
      subjectName: "Sketch",
      subjectSourceId: "P1",
    });
    const deps = await buildMaterializeDeps(db);

    const result = await materializeStructuralSeed(deps, fact);

    expect(result).toMatchObject({ kind: "entity_linked", mentionWritten: true, countEntity: false });
    expect(result.kind === "entity_linked" ? result.entity.id : null).toBe(project.id);
    await expect(
      db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", project.id).execute(),
    ).resolves.toHaveLength(1);
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(0);
  });

  it("still auto-creates non-candidate structural seed entities", async () => {
    await seedConnectorFile(db, "clickup");
    const fact = await seedStructuralFact(db, {
      source: "clickup",
      fileType: "workspace",
      subjectName: "Workspace",
      subjectSource: "clickup",
      subjectSourceId: "W1",
    });
    const deps = await buildMaterializeDeps(db);

    const result = await materializeStructuralSeed(deps, fact);

    expect(result.kind).toBe("structural");
    const entity = await db.selectFrom("entities").selectAll().executeTakeFirstOrThrow();
    expect(entity).toMatchObject({ name: "Workspace", source_type: "clickup_workspace" });
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(0);
  });

  it("A0 documents current structural seed path creating replay-dispatched project and team seeds but queueing linear_project containers until A1 flips it", async () => {
    await seedConnectorFile(db);
    await seedStructuralFact(db, {
      sourceType: "project",
      subjectName: "Apollo",
      subjectSourceId: "P-live",
    });

    await materializeUnmaterializedFacts(db, createTestLogger());

    expect(await countEntitiesBySourceType(db, "project")).toBe(1);
    expect(await countReviewQueueRows(db)).toBe(0);

    await db.destroy();
    db = await createTestDb();

    await seedConnectorFile(db);
    const containerFact = await seedStructuralFact(db, {
      subjectName: "Zephyr",
      subjectSourceId: "P-container",
    });
    const containerDeps = await buildMaterializeDeps(db);

    await materializeStructuralSeed(containerDeps, containerFact);

    expect(await countEntitiesBySourceType(db, "project")).toBe(0);
    expect(await countReviewQueueRows(db)).toBe(1);

    await db.destroy();
    db = await createTestDb();

    await seedConnectorFile(db);
    const teamFact = await seedStructuralFact(db, {
      sourceType: "team",
      subjectName: "Engineering",
      subjectSourceId: "T1",
    });
    const teamDeps = await buildMaterializeDeps(db);

    await materializeStructuralSeed(teamDeps, teamFact);

    expect(await countEntitiesBySourceType(db, "team")).toBe(1);
    expect(await countReviewQueueRows(db)).toBe(0);
  });
});
