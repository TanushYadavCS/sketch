import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { materializeUnmaterializedFacts } from "./materialize";
import { confirmReview, rejectReview } from "./resolve";

const USER_ID = "project-user";
const CONNECTOR_ID = "project-config";

async function seedLinearFile(db: Kysely<DB>, fileId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Project User",
      email: "project-user@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "linear",
      auth_type: "oauth",
      credentials: "{}",
      created_by: USER_ID,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: fileId,
      provider_url: `https://linear.example/${fileId}`,
      file_name: `${fileId}.md`,
      file_type: "project",
      content_category: "document",
      source: "linear",
      content_hash: `hash-${fileId}`,
      synced_at: now,
    })
    .execute();
}

async function upsertProjectSeedFact(db: Kysely<DB>, input: { fileId: string; sourceId: string; name: string }) {
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: input.fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    contentHash: `hash-${input.fileId}`,
    source: "linear",
    factType: "structural_seed",
    relation: "seeded",
    subjectName: input.name,
    subjectSource: "linear",
    subjectSourceId: input.sourceId,
    raw: {
      sourceType: "project",
      sourceUrl: `https://linear.example/projects/${input.sourceId}`,
      metadata: { state: "started" },
    },
  });
}

describe("project structural seed materialization", () => {
  let db: Kysely<DB>;
  let entityRepo: ReturnType<typeof createEntityRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    entityRepo = createEntityRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("keeps a colliding project seed held until confirm writes the connector source ref", async () => {
    const existing = await entityRepo.upsertEntity({
      name: "Atlas",
      sourceType: "project",
      subtype: "external",
      status: "confirmed",
    });
    await seedLinearFile(db, "linear-project-1");
    await upsertProjectSeedFact(db, {
      fileId: "linear-project-1",
      sourceId: "proj-1",
      name: "Atlas Launch",
    });

    const first = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(first.queued).toBe(1);
    expect(first.deferred).toBe(1);
    expect(first.materialized).toBe(0);
    const fact = await db.selectFrom("indexed_file_facts").select(["materialized_at"]).executeTakeFirstOrThrow();
    expect(fact.materialized_at).toBeNull();
    const row = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(row.source).toBe("linear");
    expect(row.source_id).toBe("proj-1");
    if (!row.candidate_generated_at) throw new Error("missing candidate_generated_at");

    const repeat = await materializeUnmaterializedFacts(db, createTestLogger());
    expect(repeat.queued).toBe(1);
    const repeatedRows = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(repeatedRows).toHaveLength(1);
    const repeatedRow = repeatedRows[0];
    if (!repeatedRow.candidate_generated_at) throw new Error("missing candidate_generated_at");

    await confirmReview({ db, userId: USER_ID }, repeatedRow.id, {
      candidateGeneratedAt: repeatedRow.candidate_generated_at,
    });

    const ref = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source", "=", "linear")
      .where("source_id", "=", "proj-1")
      .executeTakeFirstOrThrow();
    expect(ref.entity_id).toBe(existing.id);

    const second = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(second.entitiesLinked).toBe(1);
    expect(second.queued).toBe(0);
    const rows = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(rows).toHaveLength(1);
    const rematerializedFact = await db
      .selectFrom("indexed_file_facts")
      .select(["materialized_at"])
      .executeTakeFirstOrThrow();
    expect(rematerializedFact.materialized_at).not.toBeNull();
  });

  it("keeps connector identity when reject creates a separate project entity", async () => {
    await entityRepo.upsertEntity({
      name: "Atlas",
      sourceType: "project",
      subtype: "external",
      status: "confirmed",
    });
    await seedLinearFile(db, "linear-project-2");
    await upsertProjectSeedFact(db, {
      fileId: "linear-project-2",
      sourceId: "proj-2",
      name: "Atlas Launch",
    });
    await materializeUnmaterializedFacts(db, createTestLogger());
    const row = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    if (!row.candidate_generated_at) throw new Error("missing candidate_generated_at");

    const result = await rejectReview({ db, userId: USER_ID }, row.id, {
      candidateGeneratedAt: row.candidate_generated_at,
    });

    expect(result.createdEntityId).toBe(result.targetEntityId);
    const ref = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("entity_id", "=", result.targetEntityId)
      .executeTakeFirstOrThrow();
    expect(ref.source).toBe("linear");
    expect(ref.source_id).toBe("proj-2");
    expect(ref.source_id).not.toBe(`review:${row.id}`);
  });

  it("creates a novel project seed with the connector source ref", async () => {
    await seedLinearFile(db, "linear-project-3");
    await upsertProjectSeedFact(db, {
      fileId: "linear-project-3",
      sourceId: "proj-3",
      name: "Clean Room",
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.entitiesCreated).toBe(1);
    expect(summary.materialized).toBe(1);
    const projects = await db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("Clean Room");
    const ref = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("entity_id", "=", projects[0].id)
      .executeTakeFirstOrThrow();
    expect(ref.source).toBe("linear");
    expect(ref.source_id).toBe("proj-3");
  });
});
