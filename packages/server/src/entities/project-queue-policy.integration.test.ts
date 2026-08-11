import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import { materializeUnmaterializedFacts } from "./materialize";
import type { ProposeEntityType } from "./propose";

const USER_ID = "project-queue-user";
const CONNECTOR_ID = "project-queue-connector";
const BIRTH_GATE_TYPES = new Set<ProposeEntityType>(["project", "product", "team"]);
const LIVE_TYPES = new Set<ProposeEntityType>(["product", "project"]);
const STRUCTURAL_AUTO_BIRTH_TYPES = new Set<ProposeEntityType>(["project"]);

describe("project lifecycle queue policy postgres", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("queues LLM projects at threshold, defers below threshold, and keeps structural projects auto-birthed", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    await seedFile(db, "queue-file-1");
    await seedFile(db, "queue-file-2");
    await seedFile(db, "queue-file-3");

    await upsertLlmMention(db, "queue-file-1", "Atlas Migration", "project");
    await upsertLlmMention(db, "queue-file-2", "Atlas Migration", "project");
    await upsertLlmMention(db, "queue-file-3", "Solo Initiative", "project");
    await upsertStructuralProject(db, "queue-file-1", "Referral Service", "linear-project-referral");

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 2,
      birthGateTypes: BIRTH_GATE_TYPES,
      birthGateLiveTypes: LIVE_TYPES,
      structuralAutoBirthTypes: STRUCTURAL_AUTO_BIRTH_TYPES,
      birthGateDryRun: true,
    });

    await expect(entityRows(db, "Atlas Migration")).resolves.toEqual([]);
    await expect(entityRows(db, "Solo Initiative")).resolves.toEqual([]);
    await expect(entityRows(db, "Referral Service")).resolves.toEqual([
      expect.objectContaining({
        source_type: "project",
        provenance_tier: "structural",
      }),
    ]);

    const queueRows = await db
      .selectFrom("entity_review_queue")
      .select(["entity_type", "proposed_name", "candidate_reason", "status"])
      .orderBy("proposed_name", "asc")
      .execute();
    expect(queueRows).toEqual([
      {
        entity_type: "project",
        proposed_name: "Atlas Migration",
        candidate_reason: "birth-gated",
        status: "pending",
      },
    ]);
  }, 30000);
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Project Queue User", email: "project-queue@example.com" })
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

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      provider_url: null,
      file_name: `${id}.txt`,
      file_type: "doc",
      content_category: "document",
      content: `${id} content`,
      source: "linear",
      source_path: null,
      content_hash: `hash-${id}`,
      source_created_at: new Date().toISOString(),
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
      access_scope_id: null,
      share_with_everyone: 1,
    })
    .execute();
}

async function upsertLlmMention(db: Kysely<DB>, fileId: string, name: string, type: string): Promise<void> {
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    contentHash: `hash-${fileId}`,
    source: "llm_extraction",
    factType: "llm_extracted",
    relation: "mentioned",
    subjectName: name,
    subjectSource: "llm_extraction",
    subjectSourceId: `${fileId}:hash-${fileId}:llm-extraction-v9:${name}`,
    raw: {
      contentHash: `hash-${fileId}`,
      promptVersion: "llm-extraction-v9",
      model: "gemini",
      mention: name,
      type,
      variations: [],
      confidence: 0.92,
    },
  });
}

async function upsertStructuralProject(db: Kysely<DB>, fileId: string, name: string, sourceId: string): Promise<void> {
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    contentHash: `hash-${fileId}`,
    source: "linear",
    factType: "structural_seed",
    relation: "seeded",
    subjectName: name,
    subjectSource: "linear",
    subjectSourceId: sourceId,
    raw: {
      sourceType: "project",
      sourceUrl: `https://linear.example/projects/${sourceId}`,
      metadata: { state: "started" },
    },
  });
}

async function entityRows(db: Kysely<DB>, name: string) {
  return db.selectFrom("entities").selectAll().where("name", "=", name).execute();
}
