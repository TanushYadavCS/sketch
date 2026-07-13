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

  it("materializes feature facts with default materialization dependencies", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const product = await seedEntity(db, {
      id: "feature-default-product",
      name: "Feature Default Product",
      type: "product",
    });

    await upsertFeatureFact(db, {
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      featureId: "feature-default-materialize",
      featureName: "Default Feature",
      parentEntityId: product.id,
      status: "building",
      evidence: { fileIds: ["feature-file-1"], entityIds: [product.id] },
    });
    const fact = await featureFact(db, "feature-default-materialize");

    await expect(materializeFromFact(await buildMaterializeDeps(db, {}), fact)).resolves.toEqual({
      kind: "feature_materialized",
    });
    await expect(featureRow(db, "default feature")).resolves.toMatchObject({
      parent_entity_id: product.id,
      valid_to: null,
    });
  }, 30000);

  it("materializes features under an existing product by product ref and product entity id", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const product = await seedEntity(db, { id: "feature-product-ref", name: "Feature Product", type: "product" });

    await upsertFeatureFact(db, {
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
    await materializeUnmaterializedFacts(db, createTestLogger(), {});

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
    await materializeUnmaterializedFacts(db, createTestLogger(), {});
    const row = await featureRow(db, "usage dashboards");
    await expect(createSubEntityRepository(db).markSubEntityStatus(row.id, "shipped")).resolves.toBe(true);

    await upsertFeatureFact(db, {
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
    await materializeUnmaterializedFacts(db, createTestLogger(), {});

    await expect(featureRow(db, "usage dashboards")).resolves.toMatchObject({
      status: "shipped",
      status_authority: "local",
      valid_to: null,
    });
  }, 30000);

  it("materializes LLM features by parent name under products or projects", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const project = await seedEntity(db, { id: "feature-project-parent", name: "Feature Project", type: "project" });
    const product = await seedEntity(db, {
      id: "feature-product-default",
      name: "Feature Product Default",
      type: "product",
    });

    await upsertFeatureFact(db, {
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "llm_extraction",
      featureId: "feature-project-by-name",
      featureName: "Project by name feature",
      corroborationKey: "feature-project-by-name-key",
      parentProductName: "Feature Project",
      status: "proposed",
      evidence: { fileIds: ["feature-file-1"], entityIds: [] },
    });
    const projectFact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("subject_source_id", "=", "feature-project-by-name")
      .executeTakeFirstOrThrow();
    const raw = JSON.parse(projectFact.raw ?? "{}") as { parentProductName?: unknown; parentEntityId?: unknown };
    expect(raw.parentProductName).toBe("Feature Project");
    expect(raw.parentEntityId).toBeUndefined();
    await expect(
      materializeFromFact(await buildMaterializeDeps(db, { featureAutoMintThreshold: 1 }), projectFact),
    ).resolves.toEqual({ kind: "feature_materialized" });
    await expect(featureRow(db, "project by name feature")).resolves.toMatchObject({
      parent_entity_id: project.id,
      provenance: "corroborated_llm",
      valid_to: null,
    });

    await expect(
      upsertFeatureFact(db, {
        indexedFileId: "feature-file-1",
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        source: "linear",
        featureId: "feature-emit-default",
        featureName: "Default emitted feature",
        parentEntityId: product.id,
        status: "building",
        evidence: { fileIds: ["feature-file-1"], entityIds: [product.id] },
      }),
    ).resolves.toEqual({ emitted: true, factKey: expect.any(String) });

    await upsertFeatureFact(db, {
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      featureId: "feature-materialize-default",
      featureName: "Default materialized feature",
      parentEntityId: product.id,
      status: "building",
      evidence: { fileIds: ["feature-file-1"], entityIds: [product.id] },
    });
    const directFact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("subject_source_id", "=", "feature-materialize-default")
      .executeTakeFirstOrThrow();
    await expect(materializeFromFact(await buildMaterializeDeps(db, {}), directFact)).resolves.toEqual({
      kind: "feature_materialized",
    });
    await expect(featureRow(db, "default materialized feature")).resolves.toMatchObject({
      parent_entity_id: product.id,
      valid_to: null,
    });
  }, 30000);

  it("defers LLM features until parent approval and rejects inferred or ambiguous parents", async () => {
    db = await createTestPgDb();
    await seedBase(db);

    await upsertFeatureFact(db, {
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "llm_extraction",
      featureId: "feature-defer-product",
      featureName: "Smart Search",
      corroborationKey: "feature-defer-product-key",
      parentProductName: "Canvas CRM",
      status: "proposed",
      evidence: { fileIds: ["feature-file-1"], entityIds: [] },
    });
    const deferredFact = await featureFact(db, "feature-defer-product");
    await expect(
      materializeFromFact(await buildMaterializeDeps(db, { featureAutoMintThreshold: 1 }), deferredFact),
    ).resolves.toEqual({ kind: "deferred_below_threshold", reason: "feature_parent_absent" });
    await expect(countFeatureRows(db)).resolves.toBe(0);
    await expect(db.selectFrom("entity_mentions").selectAll().execute()).resolves.toEqual([]);
    await expect(
      db.selectFrom("entity_candidates").selectAll().where("name", "=", "Smart Search").execute(),
    ).resolves.toEqual([]);
    await expect(db.selectFrom("entities").selectAll().where("name", "=", "Smart Search").execute()).resolves.toEqual(
      [],
    );

    const product = await seedEntity(db, {
      id: "feature-approved-product",
      name: "Canvas CRM",
      type: "product",
      provenanceTier: "human_confirmed",
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {
      featureAutoMintThreshold: 1,
      factTypes: ["feature"],
    });
    await expect(featureRow(db, "smart search")).resolves.toMatchObject({
      parent_entity_id: product.id,
      provenance: "corroborated_llm",
      valid_to: null,
    });

    const project = await seedEntity(db, {
      id: "feature-structural-project",
      name: "Referral Service",
      type: "project",
      provenanceTier: "structural",
    });
    await upsertFeatureFact(db, {
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "llm_extraction",
      featureId: "feature-project-parent",
      featureName: "Daily Habits",
      corroborationKey: "feature-project-parent-key",
      parentProductName: "Referral Service",
      status: "proposed",
      evidence: { fileIds: ["feature-file-1"], entityIds: [] },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {
      featureAutoMintThreshold: 1,
      factTypes: ["feature"],
    });
    await expect(featureRow(db, "daily habits")).resolves.toMatchObject({
      parent_entity_id: project.id,
      provenance: "corroborated_llm",
      valid_to: null,
    });

    await seedEntity(db, {
      id: "feature-inferred-product",
      name: "Inferred Product",
      type: "product",
      provenanceTier: "inferred",
    });
    await upsertFeatureFact(db, {
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "llm_extraction",
      featureId: "feature-inferred-product",
      featureName: "Inferred Product Feature",
      corroborationKey: "feature-inferred-product-key",
      parentProductName: "Inferred Product",
      status: "proposed",
      evidence: { fileIds: ["feature-file-1"], entityIds: [] },
    });
    await expect(
      materializeFromFact(
        await buildMaterializeDeps(db, { featureAutoMintThreshold: 1 }),
        await featureFact(db, "feature-inferred-product"),
      ),
    ).resolves.toEqual({ kind: "deferred_below_threshold", reason: "feature_parent_absent" });
    await expect(
      db.selectFrom("sub_entities").selectAll().where("normalized_name", "=", "inferred product feature").execute(),
    ).resolves.toEqual([]);

    await seedEntity(db, {
      id: "feature-ambiguous-product",
      name: "Ambiguous Parent",
      type: "product",
      provenanceTier: "human_confirmed",
    });
    await seedEntity(db, {
      id: "feature-ambiguous-project",
      name: "Ambiguous Parent",
      type: "project",
      provenanceTier: "structural",
    });
    await upsertFeatureFact(db, {
      indexedFileId: "feature-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "llm_extraction",
      featureId: "feature-ambiguous-parent",
      featureName: "Ambiguous Parent Feature",
      corroborationKey: "feature-ambiguous-parent-key",
      parentProductName: "Ambiguous Parent",
      status: "proposed",
      evidence: { fileIds: ["feature-file-1"], entityIds: [] },
    });
    await expect(
      materializeFromFact(
        await buildMaterializeDeps(db, { featureAutoMintThreshold: 1 }),
        await featureFact(db, "feature-ambiguous-parent"),
      ),
    ).resolves.toEqual({ kind: "deferred_below_threshold", reason: "feature_parent_absent" });
    await expect(
      db.selectFrom("sub_entities").selectAll().where("normalized_name", "=", "ambiguous parent feature").execute(),
    ).resolves.toEqual([]);
  }, 30000);

  it("keeps the shared parent resolver scoped by explicit allowed types", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const project = await seedEntity(db, { id: "resolver-project", name: "Resolver Project", type: "project" });
    const person = await seedEntity(db, { id: "resolver-person", name: "Resolver Person", type: "person" });
    const product = await seedEntity(db, { id: "resolver-product", name: "Resolver Product", type: "product" });
    const team = await seedEntity(db, { id: "resolver-team", name: "Resolver Team", type: "team" });
    const deps = await buildMaterializeDeps(db, {});

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

async function seedEntity(db: Kysely<DB>, input: { id: string; name: string; type: string; provenanceTier?: string }) {
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
      provenance_tier: input.provenanceTier ?? (input.type === "product" ? "declared" : "inferred"),
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await repo.upsertSourceRef({ entityId: input.id, source: "linear", sourceId: `${input.id}-source` });
  return db.selectFrom("entities").selectAll().where("id", "=", input.id).executeTakeFirstOrThrow();
}

async function featureFact(db: Kysely<DB>, featureId: string) {
  return db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("subject_source_id", "=", featureId)
    .executeTakeFirstOrThrow();
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
