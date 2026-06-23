import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import type { IndexedFileFactRaw } from "../../connectors/types";
import { buildMaterializeDeps, materializeFromFact, materializeUnmaterializedFacts } from "../../entities/materialize";
import { resolveParent } from "../../entities/materialize-commitment";
import { createTestLogger, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository } from "./entities";
import { upsertFeatureFact } from "./features";
import { createIndexedFileFactRepository } from "./indexed-file-facts";
import { createSubEntityRepository } from "./sub-entities";

const USER_ID = "feature-pg-user";
const CONNECTOR_ID = "feature-pg-config";

describe("feature sub-entities postgres", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("materializes features under an existing product by product ref and product entity id", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const product = await seedEntity(db, { id: "feature-product-ref", name: "Feature Product", type: "product" });

    await upsertFeatureFact(db, {
      experimentalFlag: true,
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      lastSeenSyncRunId: "sync-1",
      source: "linear",
      featureId: "feature-ref",
      featureName: "Inline comments",
      parentProductRef: { source: "linear", sourceId: `${product.id}-source` },
      status: "building",
      dueAt: "2026-07-01T00:00:00.000Z",
      evidence: { fileIds: ["feature-file-1"], entityIds: [product.id] },
    });
    await upsertFeatureFact(db, {
      experimentalFlag: true,
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      lastSeenSyncRunId: "sync-1",
      source: "linear",
      featureId: "feature-id",
      featureName: "Bulk archive",
      parentEntityId: product.id,
      status: "building",
      evidence: { fileIds: ["feature-file-1"], entityIds: [product.id] },
    });

    const beforeProducts = await countEntitiesByType(db, "product");
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    await expect(featureRow(db, "inline comments")).resolves.toMatchObject({
      kind: "feature",
      parent_entity_id: product.id,
      parent_scope_key: product.id,
      normalized_name: "inline comments",
      status: "building",
      valid_to: null,
      due_at: "2026-07-01T00:00:00.000Z",
    });
    await expect(featureRow(db, "bulk archive")).resolves.toMatchObject({
      kind: "feature",
      parent_entity_id: product.id,
      parent_scope_key: product.id,
      normalized_name: "bulk archive",
      status: "building",
      valid_to: null,
    });
    await expect(countEntitiesByType(db, "product")).resolves.toBe(beforeProducts);
    await expect(
      db.selectFrom("entities").selectAll().where("name", "=", "Inline comments").execute(),
    ).resolves.toEqual([]);
    await expect(db.selectFrom("entities").selectAll().where("name", "=", "Bulk archive").execute()).resolves.toEqual(
      [],
    );
    await expect(
      db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", product.id).execute(),
    ).resolves.toEqual([]);
  }, 30000);

  it("preserves local feature status across re-sync", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const product = await seedEntity(db, {
      id: "feature-product-status",
      name: "Feature Product Status",
      type: "product",
    });

    await upsertFeatureFact(db, {
      experimentalFlag: true,
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      lastSeenSyncRunId: "sync-1",
      source: "linear",
      featureId: "feature-status",
      featureName: "Usage dashboards",
      parentEntityId: product.id,
      status: "building",
      evidence: { fileIds: ["feature-file-1"], entityIds: [product.id] },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });
    const row = await featureRow(db, "usage dashboards");
    await expect(createSubEntityRepository(db).markSubEntityStatus(row.id, "shipped")).resolves.toBe(true);

    await upsertFeatureFact(db, {
      experimentalFlag: true,
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      lastSeenSyncRunId: "sync-2",
      source: "linear",
      featureId: "feature-status",
      featureName: "Usage dashboards",
      parentEntityId: product.id,
      status: "deprecated",
      evidence: { fileIds: ["feature-file-1"], entityIds: [product.id] },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    await expect(featureRow(db, "usage dashboards")).resolves.toMatchObject({
      status: "shipped",
      status_authority: "local",
      valid_to: null,
    });
  }, 30000);

  it("skips non-product parents and feature materialization when the flag is off", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const project = await seedEntity(db, { id: "feature-project-parent", name: "Feature Project", type: "project" });
    const product = await seedEntity(db, { id: "feature-product-off", name: "Feature Product Off", type: "product" });

    await upsertFeatureFact(db, {
      experimentalFlag: true,
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      featureId: "feature-project-only",
      featureName: "Project-only feature",
      parentEntityId: project.id,
      status: "proposed",
      evidence: { fileIds: ["feature-file-1"], entityIds: [project.id] },
    });
    const projectFact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("subject_source_id", "=", "feature-project-only")
      .executeTakeFirstOrThrow();
    await expect(
      materializeFromFact(await buildMaterializeDeps(db, { experimentalFlag: true }), projectFact),
    ).resolves.toEqual({ kind: "skipped", reason: "missing_feature_parent" });
    await expect(countFeatureRows(db)).resolves.toBe(0);

    await expect(
      upsertFeatureFact(db, {
        experimentalFlag: false,
        indexedFileId: "feature-file-1",
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        source: "linear",
        featureId: "feature-emit-off",
        featureName: "Flag-off feature",
        parentEntityId: product.id,
        status: "building",
        evidence: { fileIds: ["feature-file-1"], entityIds: [product.id] },
      }),
    ).resolves.toEqual({ emitted: false });

    await upsertFeatureFact(db, {
      experimentalFlag: true,
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      featureId: "feature-materialize-off",
      featureName: "Materialize-off feature",
      parentEntityId: product.id,
      status: "building",
      evidence: { fileIds: ["feature-file-1"], entityIds: [product.id] },
    });
    const flagOffFact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("subject_source_id", "=", "feature-materialize-off")
      .executeTakeFirstOrThrow();
    await expect(
      materializeFromFact(await buildMaterializeDeps(db, { experimentalFlag: false }), flagOffFact),
    ).resolves.toEqual({ kind: "skipped", reason: "experimental_off" });
    await expect(countFeatureRows(db)).resolves.toBe(0);
  }, 30000);

  it("keeps the shared parent resolver scoped by explicit allowed types", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const project = await seedEntity(db, { id: "resolver-project", name: "Resolver Project", type: "project" });
    const person = await seedEntity(db, { id: "resolver-person", name: "Resolver Person", type: "person" });
    const product = await seedEntity(db, { id: "resolver-product", name: "Resolver Product", type: "product" });
    const team = await seedEntity(db, { id: "resolver-team", name: "Resolver Team", type: "team" });
    const deps = await buildMaterializeDeps(db, { experimentalFlag: true });

    expect(resolveParent(deps, resolverInput(project.id), ["project", "person"])?.id).toBe(project.id);
    expect(resolveParent(deps, resolverInput(person.id), ["project", "person"])?.id).toBe(person.id);
    expect(resolveParent(deps, resolverInput(product.id), ["project", "person"])).toBeNull();
    expect(resolveParent(deps, resolverInput(team.id), ["project", "person"])).toBeNull();
    expect(resolveParent(deps, resolverInput(product.id), ["product"])?.id).toBe(product.id);
    expect(resolveParent(deps, resolverInput(project.id), ["product"])).toBeNull();
  }, 30000);

  it("rejects feature facts with invalid statuses", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    await expect(
      createIndexedFileFactRepository(db).upsertFact({
        indexedFileId: "feature-file-1",
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        source: "linear",
        factType: "feature",
        relation: "mentioned",
        subjectName: "Invalid feature",
        subjectSource: "linear",
        subjectSourceId: "invalid-feature",
        raw: {
          featureId: "invalid-feature",
          featureName: "Invalid feature",
          status: "paused",
          evidence: { fileIds: [], entityIds: [] },
        } as unknown as IndexedFileFactRaw,
      }),
    ).rejects.toThrow("feature status must be proposed, building, shipped, or deprecated");
  }, 30000);
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Feature PG User", email: "feature-pg-user@example.com" })
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
      id: "feature-file-1",
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "feature-file-1",
      provider_url: null,
      file_name: "Feature file",
      file_type: "issue",
      content_category: "structured",
      content: "Feature file",
      source: "linear",
      source_path: null,
      content_hash: "feature-file-1-hash",
      source_created_at: new Date().toISOString(),
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
      access_scope_id: null,
      share_with_everyone: 1,
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, input: { id: string; name: string; type: string }) {
  const repo = createEntityRepository(db);
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.type,
      subtype: input.type === "person" ? "external" : null,
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

function resolverInput(entityId: string) {
  return { parentEntityId: entityId, evidence: { entityIds: [entityId] } };
}

async function featureRow(db: Kysely<DB>, normalizedName: string) {
  return db
    .selectFrom("sub_entities")
    .selectAll()
    .where("kind", "=", "feature")
    .where("normalized_name", "=", normalizedName)
    .where("valid_to", "is", null)
    .executeTakeFirstOrThrow();
}

async function countFeatureRows(db: Kysely<DB>): Promise<number> {
  const rows = await db.selectFrom("sub_entities").select("id").where("kind", "=", "feature").execute();
  return rows.length;
}

async function countEntitiesByType(db: Kysely<DB>, type: string): Promise<number> {
  const rows = await db.selectFrom("entities").select("id").where("source_type", "=", type).execute();
  return rows.length;
}
