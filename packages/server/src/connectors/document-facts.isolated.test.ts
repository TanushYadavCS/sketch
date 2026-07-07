import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
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
const FILE_ID_2 = "doc-facts-file-2";
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

const whatsappConnector: Connector = {
  type: "whatsapp",
  perUserAuth: false,
  requiresOAuthClientSetup: false,
  promotableFileTypes: [],
  async validateCredentials(_credentials: ConnectorCredentials): Promise<void> {},
  async *sync(): AsyncGenerator<SyncedItem> {},
  async getCursor(): Promise<string | null> {
    return null;
  },
};

const taskCandidate = {
  title: "Ship Slack capture",
  owner: { name: "Alice", email: "alice@example.com" },
  dueDate: "2025-04-30",
  hasOwnerVerbObject: true,
  sourceExcerpt: "Alice will ship the Slack capture by Friday.",
};

const rewordedTaskCandidate = {
  ...taskCandidate,
  title: "Ship the Slack capture package",
};

const fakeGenerator = {
  async generate() {
    return "{}";
  },
  async generateJSON<T>() {
    return { tasks: [taskCandidate] } as T;
  },
} as GeminiGenerator;

describe("document-derived facts", () => {
  let db: Kysely<DB>;
  const extractMock = vi.mocked(extractLlmTaskCandidates);

  beforeEach(async () => {
    db = await createTestDb();
    extractMock.mockReset();
    extractMock.mockResolvedValue([taskCandidate]);
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("enrich emits and materializes llm_task facts for document content", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "pending", summaryStatus: "done" });

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });

    expect(await activeLlmTaskFacts(db)).toHaveLength(1);
    const task = await db.selectFrom("tasks").selectAll().executeTakeFirstOrThrow();
    expect(task.due_at).toBe("2025-04-30");
  });

  it("sync and enrich produce the same active llm_task fact key", async () => {
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
      item: {
        ...baseSyncedItem(),
        parentEntities: [
          { source: "linear", sourceId: "z-project" },
          { source: "linear", sourceId: "a-project" },
        ],
      },
      contentChanged: true,
      generator: fakeGenerator,
    });
    const syncFacts = await activeLlmTaskFacts(db);
    expect(extractMock).toHaveBeenLastCalledWith(expect.objectContaining({ sourceDate: "2025-04-25" }));

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });
    const enrichFacts = await activeLlmTaskFacts(db);

    expect(enrichFacts).toHaveLength(1);
    expect(enrichFacts[0].fact_key).toBe(syncFacts[0].fact_key);
    expect(extractMock).toHaveBeenLastCalledWith(expect.objectContaining({ sourceDate: "2025-04-25" }));
  });

  it("enriching structured content does not emit llm_task facts", async () => {
    await seedIndexedFile(db, { contentCategory: "structured", embeddingStatus: "pending", summaryStatus: "done" });

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
  });

  it("skips structural task records (file_type=issue) on both the sync and enrich paths", async () => {
    await seedIndexedFile(db, {
      contentCategory: "document",
      embeddingStatus: "done",
      summaryStatus: "done",
      fileType: "issue",
    });

    await emitFactsForSyncedItem({
      db,
      factRepo: createIndexedFileFactRepository(db),
      connector: testConnector,
      connectorType: "gmail",
      factContext: { connectorConfigId: CONNECTOR_ID, createdByUserId: USER_ID, lastSeenSyncRunId: "sync-1" },
      indexedFileId: FILE_ID,
      item: { ...baseSyncedItem(), fileType: "issue" },
      contentChanged: true,
      generator: fakeGenerator,
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);

    await seedIndexedFile(db, {
      id: FILE_ID_2,
      contentCategory: "document",
      embeddingStatus: "pending",
      summaryStatus: "done",
      fileType: "issue",
    });

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID_2],
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
  });

  it("skips WhatsApp-sourced task extraction on both the sync and enrich paths", async () => {
    await seedIndexedFile(db, {
      contentCategory: "document",
      embeddingStatus: "done",
      summaryStatus: "done",
      source: "whatsapp",
    });

    await emitFactsForSyncedItem({
      db,
      factRepo: createIndexedFileFactRepository(db),
      connector: whatsappConnector,
      connectorType: "whatsapp",
      factContext: { connectorConfigId: CONNECTOR_ID, createdByUserId: USER_ID, lastSeenSyncRunId: "sync-1" },
      indexedFileId: FILE_ID,
      item: baseSyncedItem(),
      contentChanged: true,
      generator: fakeGenerator,
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);

    await seedIndexedFile(db, {
      id: FILE_ID_2,
      contentCategory: "document",
      embeddingStatus: "pending",
      summaryStatus: "done",
      source: "whatsapp",
    });

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID_2],
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
    expect(await countRows(db, "tasks")).toBe(0);
  });

  it("reconstructs email correspondents as document-fact participants during enrich", async () => {
    await seedIndexedFile(db, {
      contentCategory: "document",
      embeddingStatus: "pending",
      summaryStatus: "done",
      fileType: "email_message",
    });
    await createIndexedFileFactRepository(db).upsertFact({
      indexedFileId: FILE_ID,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "gmail",
      factType: "correspondent",
      relation: "corresponded",
      subjectName: "Alice Sender",
      subjectEmail: "alice@example.com",
      subjectSource: "gmail",
      subjectSourceId: "message-1:alice@example.com",
      contentHash: "hash-1",
      raw: { providerFileId: "message-1", correspondent: { name: "Alice Sender", email: "alice@example.com" } },
    });

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });

    expect(extractMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attendees: [{ name: "Alice Sender", email: "alice@example.com" }],
      }),
    );
  });

  it("uses the same deterministic canonical parent for sync and enrich", async () => {
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
      item: {
        ...baseSyncedItem(),
        parentEntities: [
          { source: "notion", sourceId: "space-z" },
          { source: "linear", sourceId: "project-a" },
        ],
      },
      contentChanged: true,
      generator: fakeGenerator,
    });
    const syncRaw = JSON.parse((await activeLlmTaskFacts(db))[0].raw ?? "{}");

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });
    const enrichRaw = JSON.parse((await activeLlmTaskFacts(db))[0].raw ?? "{}");

    expect(syncRaw.parentRef).toEqual({ source: "linear", sourceId: "project-a" });
    expect(enrichRaw.parentRef).toEqual(syncRaw.parentRef);
    expect(enrichRaw.corroborationKey).toBe(syncRaw.corroborationKey);
  });

  it("enriching the same file twice leaves one active llm_task fact and one materialized task", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "pending", summaryStatus: "done" });

    for (let i = 0; i < 2; i++) {
      await runEnrichment({
        db,
        logger: createTestLogger(),
        embeddingProvider: null,
        generator: fakeGenerator,
        fileIds: [FILE_ID],
      });
    }

    expect(await activeLlmTaskFacts(db)).toHaveLength(1);
    expect(await countRows(db, "tasks")).toBe(1);
  });

  it("passes active llm_task titles back into re-extraction", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "pending", summaryStatus: "done" });

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });
    expect(extractMock).toHaveBeenLastCalledWith(expect.objectContaining({ priorTitles: [] }));

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });

    expect(extractMock).toHaveBeenLastCalledWith(expect.objectContaining({ priorTitles: ["Ship Slack capture"] }));
  });

  it("keeps active llm task count stable when re-extraction reuses or rewords titles", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "pending", summaryStatus: "done" });

    extractMock.mockResolvedValueOnce([taskCandidate]);
    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });
    expect(await activeTasks(db)).toHaveLength(1);
    expect(await countRows(db, "tasks")).toBe(1);

    extractMock.mockResolvedValueOnce([taskCandidate]);
    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });
    expect(await activeTasks(db)).toHaveLength(1);
    expect(await countRows(db, "tasks")).toBe(1);

    extractMock.mockResolvedValueOnce([rewordedTaskCandidate]);
    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });

    const allTasks = await db.selectFrom("tasks").selectAll().orderBy("title", "asc").execute();
    expect(await activeTasks(db)).toHaveLength(1);
    expect(allTasks).toHaveLength(2);
    expect(allTasks.find((task) => task.title === "Ship Slack capture")?.valid_to).not.toBeNull();
    expect(allTasks.find((task) => task.title === "Ship the Slack capture package")?.valid_to).toBeNull();
  });

  it("does not retire structural tasks when tombstoned llm_task facts only contributed evidence", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "pending", summaryStatus: "done" });
    const structural = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "linear",
      externalRef: "SKE-150",
      title: "Ship Slack capture",
      status: "open",
      statusRaw: "Todo",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "linear-150",
    });

    extractMock.mockResolvedValueOnce([taskCandidate]);
    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });

    extractMock.mockResolvedValueOnce([]);
    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });

    const task = await db.selectFrom("tasks").selectAll().where("id", "=", structural.taskId).executeTakeFirstOrThrow();
    expect(task.valid_to).toBeNull();
    expect(await activeTasks(db)).toHaveLength(1);
  });

  it("does not retire llm tasks while another active llm_task fact still supports them", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "pending", summaryStatus: "done" });
    await seedIndexedFile(db, {
      id: FILE_ID_2,
      contentCategory: "document",
      embeddingStatus: "pending",
      summaryStatus: "done",
    });

    extractMock.mockResolvedValueOnce([taskCandidate]);
    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });
    extractMock.mockResolvedValueOnce([taskCandidate]);
    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID_2],
    });

    extractMock.mockResolvedValueOnce([]);
    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: fakeGenerator,
      fileIds: [FILE_ID],
    });

    const tasks = await db.selectFrom("tasks").selectAll().execute();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ provenance: "llm", source: "llm", valid_to: null });
    expect(await activeLlmTaskFacts(db)).toHaveLength(1);
  });

  it("returns changed only when facts are emitted or tombstoned", async () => {
    await seedIndexedFile(db, { contentCategory: "document", embeddingStatus: "done", summaryStatus: "done" });

    const skipped = await emitDocumentDerivedFacts(
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
    expect(skipped.changed).toBe(false);

    const emitted = await emitDocumentDerivedFacts(
      db,
      {
        indexedFileId: FILE_ID,
        source: "gmail",
        content: CONTENT,
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
    expect(emitted.changed).toBe(true);
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
    id?: string;
    contentCategory: "document" | "structured";
    embeddingStatus: "pending" | "done";
    summaryStatus: "pending" | "done" | "skipped";
    fileType?: string;
    source?: string;
  },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: input.id ?? FILE_ID,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: input.id ?? "message-1",
      file_name: `${input.id ?? "message"}.md`,
      file_type: input.fileType ?? "document",
      content_category: input.contentCategory,
      source: input.source ?? "gmail",
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

async function activeTasks(db: Kysely<DB>) {
  return db.selectFrom("tasks").selectAll().where("valid_to", "is", null).orderBy("title", "asc").execute();
}

async function countRows(db: Kysely<DB>, table: "tasks"): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
