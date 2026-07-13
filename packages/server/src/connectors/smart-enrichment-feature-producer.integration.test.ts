import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { upsertFeatureFact } from "../db/repositories/features";
import type { DB, IndexedFileFactsTable, SubEntitiesTable } from "../db/schema";
import { buildMaterializeDeps, materializeFromFact } from "../entities/materialize";
import { createTestLogger, createTestPgDb } from "../test-utils";
import type { GeminiGenerator } from "./gemini-generate";
import { smartEnrichFile } from "./smart-enrichment";

const USER_ID = "feature-producer-user";
const CONNECTOR_ID = "feature-producer-connector";
let db: Kysely<DB>;

type Mention = {
  mention: string;
  type: string;
  variations: string[];
  confidence?: number;
  parentProduct?: string;
};

describe("smartEnrichFile LLM feature producer postgres", () => {
  beforeEach(async () => {
    db = await createTestPgDb();
    await seedBase(db);
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("attaches corroborated LLM features under a declared product without entity leakage", async () => {
    const product = await seedProduct(db, "Canvas CRM");
    const beforeProductCount = await countEntitiesByType(db, "product");
    const files = [
      {
        id: `feature-happy-${randomUUID()}`,
        hash: "hash-feature-happy-1",
        content: "Canvas CRM includes CRM Analytics for pipeline reporting.",
      },
      {
        id: `feature-happy-${randomUUID()}`,
        hash: "hash-feature-happy-2",
        content: "The CRM Analytics screen in Canvas CRM tracks conversion and revenue.",
      },
    ];
    for (const file of files) await seedFile(db, file);

    const generator = generatorWithMentions([
      {
        mention: "CRM Analytics",
        type: "feature",
        parentProduct: "Canvas CRM",
        variations: ["Analytics screen"],
        confidence: 0.94,
      },
    ]);
    for (const file of files) {
      await smartEnrichFile(deps(generator), fileContext(file));
    }

    const feature = await currentFeatureRows(db, "crm analytics");
    expect(feature).toHaveLength(1);
    expect(feature[0]).toMatchObject({
      kind: "feature",
      parent_entity_id: product.id,
      parent_scope_key: product.id,
      normalized_name: "crm analytics",
      provenance: "corroborated_llm",
      valid_to: null,
    });
    expect(await countEntitiesByType(db, "product")).toBe(beforeProductCount);
    await expect(db.selectFrom("entities").selectAll().where("name", "=", "CRM Analytics").execute()).resolves.toEqual(
      [],
    );
    await expect(
      db.selectFrom("indexed_file_facts").selectAll().where("fact_type", "=", "llm_extracted").execute(),
    ).resolves.toEqual([]);
    await expect(
      db.selectFrom("entity_candidates").selectAll().where("name", "=", "CRM Analytics").execute(),
    ).resolves.toEqual([]);
    await expect(
      db.selectFrom("entity_mentions").selectAll().where("source", "=", "llm_extraction").execute(),
    ).resolves.toEqual([]);

    const featureFacts = await activeFeatureFacts(db);
    expect(featureFacts).toHaveLength(2);
    const raws = featureFacts.map((fact) => readFeatureRaw(fact.raw));
    for (const file of files) {
      expect(raws.some((raw) => raw.featureId.includes(file.id))).toBe(true);
    }
    expect(new Set(raws.map((raw) => raw.corroborationKey)).size).toBe(1);
  }, 30000);

  it("defers unresolved and ambiguous parents", async () => {
    const missingParentFile = {
      id: `feature-missing-parent-${randomUUID()}`,
      hash: "hash-feature-missing-parent",
      content: "Ghost Analytics is listed as a module in Ghost Product.",
    };
    await seedFile(db, missingParentFile);
    await smartEnrichFile(
      deps(
        generatorWithMentions([
          {
            mention: "Ghost Analytics",
            type: "feature",
            parentProduct: "Ghost Product",
            variations: [],
            confidence: 0.94,
          },
        ]),
      ),
      fileContext(missingParentFile),
    );
    let featureFacts = await activeFeatureFacts(db);
    expect(featureFacts).toHaveLength(1);
    expect(readFeatureRaw(featureFacts[0].raw)).toMatchObject({
      parentProductName: "Ghost Product",
      parentEntityId: undefined,
    });
    expect(await countFeatureSubEntities(db)).toBe(0);
    expect(await countEntitiesByType(db, "product")).toBe(0);

    await seedProduct(db, "Ambiguous Product");
    await seedProduct(db, "Ambiguous Product");
    const ambiguousFile = {
      id: `feature-ambiguous-parent-${randomUUID()}`,
      hash: "hash-feature-ambiguous-parent",
      content: "Shared Analytics belongs inside Ambiguous Product.",
    };
    await seedFile(db, ambiguousFile);
    await smartEnrichFile(
      deps(
        generatorWithMentions([
          {
            mention: "Shared Analytics",
            type: "feature",
            parentProduct: "Ambiguous Product",
            variations: [],
            confidence: 0.93,
          },
        ]),
      ),
      fileContext(ambiguousFile),
    );
    featureFacts = await activeFeatureFacts(db);
    expect(featureFacts).toHaveLength(2);
    expect(await countFeatureSubEntities(db)).toBe(0);
  }, 30000);

  it("filters code-shaped feature names in the producer and materializer", async () => {
    const product = await seedProduct(db, "Canvas CRM");
    const file = {
      id: `feature-noise-${randomUUID()}`,
      hash: "hash-feature-noise",
      content: "Canvas CRM includes QuestionRequestDto internals, PayLater, and Daily Habits.",
    };
    await seedFile(db, file);

    await smartEnrichFile(
      deps(
        generatorWithMentions([
          {
            mention: "QuestionRequestDto",
            type: "feature",
            parentProduct: "Canvas CRM",
            variations: [],
            confidence: 0.9,
          },
          {
            mention: "PayLater",
            type: "feature",
            parentProduct: "Canvas CRM",
            variations: [],
            confidence: 0.92,
          },
          {
            mention: "Daily Habits",
            type: "feature",
            parentProduct: "Canvas CRM",
            variations: [],
            confidence: 0.92,
          },
        ]),
      ),
      fileContext(file),
    );

    const featureFacts = await activeFeatureFacts(db);
    expect(featureFacts.map((fact) => fact.subject_name).sort()).toEqual(["Daily Habits", "PayLater"]);
    await expect(currentFeatureRows(db, "paylater")).resolves.toHaveLength(1);
    await expect(currentFeatureRows(db, "daily habits")).resolves.toHaveLength(1);
    await expect(currentFeatureRows(db, "questionrequestdto")).resolves.toHaveLength(0);

    await upsertFeatureFact(db, {
      indexedFileId: file.id,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "llm_extraction",
      featureId: "feature-stored-noise",
      featureName: "AnswerResponseDto",
      corroborationKey: "feature-stored-noise-key",
      parentProductName: "Canvas CRM",
      status: "proposed",
      evidence: { fileIds: [file.id], entityIds: [] },
    });
    const storedNoiseFact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("subject_source_id", "=", "feature-stored-noise")
      .executeTakeFirstOrThrow();
    await expect(
      materializeFromFact(await buildMaterializeDeps(db, { featureAutoMintThreshold: 1 }), storedNoiseFact),
    ).resolves.toEqual({ kind: "deferred_below_threshold", reason: "noise_rejected" });
    await expect(currentFeatureRows(db, "answerresponsedto")).resolves.toHaveLength(0);
    await expect(currentFeatureRows(db, "paylater")).resolves.toEqual([
      expect.objectContaining({ parent_entity_id: product.id }),
    ]);
  }, 30000);

  it("auto-mints from a single mention and supersedes the feature when support reaches zero", async () => {
    const product = await seedProduct(db, "Canvas CRM");
    const firstFile = {
      id: `feature-lifecycle-${randomUUID()}`,
      hash: "hash-feature-lifecycle-1",
      content: "Canvas CRM has Usage Dashboards for revenue teams.",
    };
    const secondFile = {
      id: `feature-lifecycle-${randomUUID()}`,
      hash: "hash-feature-lifecycle-2",
      content: "Usage Dashboards in Canvas CRM show renewal health.",
    };
    await seedFile(db, firstFile);
    await seedFile(db, secondFile);

    const featureGenerator = generatorWithMentions([
      {
        mention: "Usage Dashboards",
        type: "feature",
        parentProduct: "Canvas CRM",
        variations: ["Dashboards"],
        confidence: 0.94,
      },
    ]);
    await smartEnrichFile(deps(featureGenerator), fileContext(firstFile));
    expect(await activeFeatureFacts(db)).toHaveLength(1);
    let current = await currentFeatureRows(db, "usage dashboards");
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ parent_entity_id: product.id, provenance: "corroborated_llm" });

    await smartEnrichFile(deps(featureGenerator), fileContext(secondFile));
    current = await currentFeatureRows(db, "usage dashboards");
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ parent_entity_id: product.id, provenance: "corroborated_llm" });
    await expect(currentEvidenceRefs(db, current[0].id, "file")).resolves.toEqual([firstFile.id, secondFile.id].sort());

    const updatedSecondFile = {
      ...secondFile,
      hash: "hash-feature-lifecycle-2b",
      content: "Canvas CRM release notes cover cleanup work without that dashboard module.",
    };
    await updateFileContent(db, updatedSecondFile);
    await smartEnrichFile(deps(generatorWithMentions([])), fileContext(updatedSecondFile));

    const secondFact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("indexed_file_id", "=", secondFile.id)
      .where("fact_type", "=", "feature")
      .executeTakeFirstOrThrow();
    expect(secondFact.deleted_at).not.toBeNull();
    current = await currentFeatureRows(db, "usage dashboards");
    expect(current).toHaveLength(1);
    await expect(currentEvidenceRefs(db, current[0].id, "file")).resolves.toEqual([firstFile.id]);

    const updatedFirstFile = {
      ...firstFile,
      hash: "hash-feature-lifecycle-1b",
      content: "Canvas CRM release notes cover cleanup work without that dashboard module.",
    };
    await updateFileContent(db, updatedFirstFile);
    await smartEnrichFile(deps(generatorWithMentions([])), fileContext(updatedFirstFile));

    current = await currentFeatureRows(db, "usage dashboards");
    expect(current).toHaveLength(0);
    const allRows = await featureRows(db, "usage dashboards");
    expect(allRows).toHaveLength(1);
    expect(allRows[0].valid_to).not.toBeNull();
    await expect(currentEvidenceRefs(db, allRows[0].id, "file")).resolves.toEqual([]);
  }, 30000);
});

function deps(generator: GeminiGenerator) {
  return {
    db,
    logger: createTestLogger(),
    generator,
    embeddingProvider: null,
  };
}

function generatorWithMentions(mentions: Mention[], capturePrompt?: (prompt: string) => void): GeminiGenerator {
  return {
    generate: async () => "Summary for the indexed file.",
    generateJSON: async <T>(prompt: string, opts?: { label?: string }) => {
      if (opts?.label?.startsWith("extractEntities")) {
        capturePrompt?.(prompt);
        return { mentions, relations: [] } as T;
      }
      return {} as T;
    },
  } as GeminiGenerator;
}

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Feature Producer User", email: "feature-producer@example.com" })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: USER_ID,
      scope_config: "{}",
    })
    .execute();
}

async function seedProduct(db: Kysely<DB>, name: string) {
  return createEntityRepository(db).createEntity({
    name,
    sourceType: "product",
    status: "confirmed",
    provenanceTier: "declared",
  });
}

async function seedFile(db: Kysely<DB>, file: { id: string; hash: string; content: string }): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: file.id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: file.id,
      provider_url: null,
      file_name: `${file.id}.txt`,
      file_type: "doc",
      content_category: "document",
      content: file.content,
      source: "google_drive",
      source_path: "/features",
      content_hash: file.hash,
      source_created_at: new Date().toISOString(),
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
      access_scope_id: null,
      share_with_everyone: 1,
    })
    .execute();
}

async function updateFileContent(db: Kysely<DB>, file: { id: string; hash: string; content: string }): Promise<void> {
  await db
    .updateTable("indexed_files")
    .set({
      content: file.content,
      content_hash: file.hash,
      summary_status: "pending",
      source_updated_at: new Date().toISOString(),
    })
    .where("id", "=", file.id)
    .execute();
}

function fileContext(file: { id: string; hash: string; content: string }): Parameters<typeof smartEnrichFile>[1] {
  return {
    id: file.id,
    fileName: `${file.id}.txt`,
    content: file.content,
    contentCategory: "document",
    fileType: "doc",
    source: "google_drive",
    sourcePath: "/features",
    contentHash: file.hash,
    connectorConfigId: CONNECTOR_ID,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
  };
}

async function activeFeatureFacts(db: Kysely<DB>): Promise<Array<Selectable<IndexedFileFactsTable>>> {
  return db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("fact_type", "=", "feature")
    .where("deleted_at", "is", null)
    .orderBy("indexed_file_id", "asc")
    .execute();
}

async function featureRows(db: Kysely<DB>, normalizedName: string): Promise<Array<Selectable<SubEntitiesTable>>> {
  return db
    .selectFrom("sub_entities")
    .selectAll()
    .where("kind", "=", "feature")
    .where("normalized_name", "=", normalizedName)
    .orderBy("valid_from", "asc")
    .execute();
}

async function currentFeatureRows(
  db: Kysely<DB>,
  normalizedName: string,
): Promise<Array<Selectable<SubEntitiesTable>>> {
  return db
    .selectFrom("sub_entities")
    .selectAll()
    .where("kind", "=", "feature")
    .where("normalized_name", "=", normalizedName)
    .where("valid_to", "is", null)
    .execute();
}

async function currentEvidenceRefs(db: Kysely<DB>, subEntityId: string, kind: string): Promise<string[]> {
  const rows = await db
    .selectFrom("sub_entity_evidence")
    .select("ref_id")
    .where("sub_entity_id", "=", subEntityId)
    .where("kind", "=", kind)
    .orderBy("ref_id", "asc")
    .execute();
  return rows.map((row) => row.ref_id);
}

async function countFeatureSubEntities(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("sub_entities")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("kind", "=", "feature")
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countEntitiesByType(db: Kysely<DB>, sourceType: string): Promise<number> {
  const row = await db
    .selectFrom("entities")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("source_type", "=", sourceType)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

function readFeatureRaw(raw: string | null): {
  featureId: string;
  corroborationKey: string;
  parentProductName?: string;
  parentEntityId?: string;
} {
  const parsed = JSON.parse(raw ?? "{}") as {
    featureId?: unknown;
    corroborationKey?: unknown;
    parentProductName?: unknown;
    parentEntityId?: unknown;
  };
  if (typeof parsed.featureId !== "string" || typeof parsed.corroborationKey !== "string") {
    throw new Error("invalid feature raw");
  }
  return {
    featureId: parsed.featureId,
    corroborationKey: parsed.corroborationKey,
    parentProductName: typeof parsed.parentProductName === "string" ? parsed.parentProductName : undefined,
    parentEntityId: typeof parsed.parentEntityId === "string" ? parsed.parentEntityId : undefined,
  };
}
