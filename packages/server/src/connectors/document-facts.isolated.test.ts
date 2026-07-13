import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexedFileFactRepository, upsertLlmTaskFact } from "../db/repositories/indexed-file-facts";
import { createTaskRepository } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { emitDocumentDerivedFacts } from "./document-facts";
import { runEnrichment } from "./enrichment";
import type { GeminiGenerator } from "./gemini-generate";
import { extractLlmTaskCandidates } from "./llm-task-extraction";
import { emitFactsForSyncedItem } from "./sync-facts";
import type { Connector, ConnectorCredentials, SyncedItem } from "./types";

vi.mock("./llm-task-extraction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./llm-task-extraction")>();
  return {
    ...actual,
    extractLlmTaskCandidates: vi.fn(),
  };
});

const USER_ID = "doc-facts-user";
const CONNECTOR_ID = "doc-facts-connector";
const FILE_ID = "doc-facts-file";
const CONTENT = "Alice will ship the Slack capture by Friday.";

const testConnector: Connector = {
  type: "gmail",
  perUserAuth: true,
  requiresOAuthClientSetup: true,
  promotableFileTypes: [],
  async validateCredentials(_credentials: ConnectorCredentials): Promise<void> {},
  async *sync(): AsyncGenerator<SyncedItem> {},
  async getCursor(): Promise<string | null> {
    return null;
  },
};

const fakeGenerator = {
  async generate() {
    return "{}";
  },
  async generateJSON<T>() {
    return { tasks: [] } as T;
  },
} as GeminiGenerator;

describe("document-derived facts", () => {
  let db: Kysely<DB>;
  const extractMock = vi.mocked(extractLlmTaskCandidates);

  beforeEach(async () => {
    db = await createTestDb();
    extractMock.mockReset();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("enrichment does not call the retired llm_task extractor or materialize tasks", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "pending", summaryStatus: "done" });

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
    expect(await countTasks(db)).toBe(0);
  });

  it("sync does not call the retired llm_task extractor or emit llm_task facts", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "done", summaryStatus: "done" });

    await emitFactsForSyncedItem({
      db,
      factRepo: createIndexedFileFactRepository(db),
      connector: testConnector,
      connectorType: "gmail",
      factContext: {
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        lastSeenSyncRunId: "sync-1",
      },
      indexedFileId: FILE_ID,
      item: baseSyncedItem(),
      contentChanged: true,
      generator: fakeGenerator,
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
  });

  it("content refresh tombstones legacy llm_task facts and retires unsupported llm tasks", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "done", summaryStatus: "done" });
    const factId = await seedLegacyLlmTaskFact(db);
    const taskRepo = createTaskRepository(db);
    const task = await taskRepo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "llm",
      externalRef: null,
      title: "Ship Slack capture",
      status: "open",
      statusRaw: null,
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "llm",
      sourceTaskId: "legacy-llm-task",
      createdByUserId: USER_ID,
    });
    await taskRepo.upsertEvidence(task.taskId, "fact", factId);

    const result = await emitDocumentDerivedFacts(
      db,
      {
        indexedFileId: FILE_ID,
        source: "gmail",
        content: CONTENT,
        sourceDate: null,
        contentCategory: "document",
        contentHash: "hash-1",
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        lastSeenSyncRunId: null,
        attendees: [],
        parentRefs: [],
      },
      { contentChanged: true, generator: fakeGenerator },
    );

    const retiredTask = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", task.taskId)
      .executeTakeFirstOrThrow();
    expect(result.changed).toBe(true);
    expect(result.tombstonedFactIds).toEqual([factId]);
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
    expect(retiredTask.valid_to).not.toBeNull();
  });

  it("returns unchanged when content did not change", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "done", summaryStatus: "done" });

    const result = await emitDocumentDerivedFacts(
      db,
      {
        indexedFileId: FILE_ID,
        source: "gmail",
        content: CONTENT,
        sourceDate: null,
        contentCategory: "document",
        contentHash: "hash-1",
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        lastSeenSyncRunId: null,
        attendees: [],
        parentRefs: [],
      },
      { contentChanged: false, generator: fakeGenerator },
    );

    expect(result.changed).toBe(false);
    expect(extractMock).not.toHaveBeenCalled();
  });
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Doc Facts User", email: "doc-facts@example.com" })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "gmail",
      auth_type: "oauth",
      credentials: "{}",
      created_by: USER_ID,
    })
    .execute();
}
async function seedIndexedFile(
  db: Kysely<DB>,
  input: {
    contentCategory: "document" | "structured";
    embeddingStatus: "pending" | "done";
    summaryStatus: "pending" | "done" | "skipped";
  },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: FILE_ID,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "message-1",
      file_name: "message.md",
      file_type: "email_message",
      content_category: input.contentCategory,
      source: "gmail",
      source_path: "Gmail/Inbox",
      source_created_at: "2025-04-25",
      content: CONTENT,
      content_hash: "hash-1",
      embedding_status: input.embeddingStatus,
      summary_status: input.summaryStatus,
      synced_at: new Date().toISOString(),
    })
    .execute();
}

async function seedLegacyLlmTaskFact(db: Kysely<DB>): Promise<string> {
  await upsertLlmTaskFact(db, {
    indexedFileId: FILE_ID,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    source: "gmail",
    candidateId: "legacy-candidate",
    candidate: {
      title: "Ship Slack capture",
      owner: { name: "Alice" },
      dueDate: "2025-04-30",
      hasOwnerVerbObject: true,
    },
    corroborationKey: "ship slack capture|global",
    evidence: { fileIds: [FILE_ID], entityIds: [] },
    promptVersion: "llm-task-v1",
  });
  const fact = await db
    .selectFrom("indexed_file_facts")
    .select("id")
    .where("fact_type", "=", "llm_task")
    .where("indexed_file_id", "=", FILE_ID)
    .executeTakeFirstOrThrow();
  return fact.id;
}

function baseSyncedItem(): SyncedItem {
  return {
    providerFileId: "message-1",
    providerUrl: "https://mail.example/message-1",
    fileName: "message.md",
    fileType: "email_message",
    contentCategory: "document",
    content: CONTENT,
    sourcePath: "Gmail/Inbox",
    contentHash: "hash-1",
    sourceCreatedAt: "2025-04-25",
    sourceUpdatedAt: null,
    attendees: [{ name: "Alice", email: "alice@example.com" }],
  };
}

async function activeLlmTaskFacts(db: Kysely<DB>) {
  return db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("fact_type", "=", "llm_task")
    .where("deleted_at", "is", null)
    .orderBy("fact_key", "asc")
    .execute();
}

async function countTasks(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("tasks")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
