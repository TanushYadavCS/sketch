import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { emitDocumentDerivedFacts } from "./document-facts";
import type { GeminiGenerator } from "./gemini-generate";

const USER_ID = "doc-facts-real-user";
const CONNECTOR_ID = "doc-facts-real-connector";
const FILE_ID = "doc-facts-real-file";
const CONTENT = "Alice will ship the Slack capture by Friday.";

describe("document-derived llm_task extraction", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("does not call the Gemini generator or emit llm_task facts", async () => {
    const generateJSONCalls: Array<{ prompt: string; opts?: Parameters<GeminiGenerator["generateJSON"]>[1] }> = [];
    const generateJSON: GeminiGenerator["generateJSON"] = async <T>(
      prompt: string,
      opts?: Parameters<GeminiGenerator["generateJSON"]>[1],
    ) => {
      generateJSONCalls.push({ prompt, opts });
      return { tasks: [] } as T;
    };
    const generator = fakeGenerator(generateJSON);

    const result = await emitDocumentDerivedFacts(db, baseContext(), {
      contentChanged: true,
      generator,
    });

    expect(result.changed).toBe(false);
    expect(generateJSONCalls).toEqual([]);
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
  });

  it("does not invoke or warn from the retired extraction path", async () => {
    const logger = { warn: vi.fn() } as unknown as Logger;
    const generator = fakeGenerator(async () => {
      throw new Error("provider unavailable");
    });

    const result = await emitDocumentDerivedFacts(db, baseContext(), {
      contentChanged: true,
      generator,
      logger,
    });

    expect(result.changed).toBe(false);
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips gracefully when no generator is available", async () => {
    const result = await emitDocumentDerivedFacts(db, baseContext(), {
      contentChanged: true,
    });

    expect(result.changed).toBe(false);
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
  });

  it("skips structural task records (issue/task/subtask) without calling the generator", async () => {
    for (const fileType of ["issue", "task", "subtask", "Issue"]) {
      let calls = 0;
      const generator = fakeGenerator(async <T>() => {
        calls++;
        return { tasks: [] } as T;
      });

      const result = await emitDocumentDerivedFacts(
        db,
        { ...baseContext(), fileType },
        { contentChanged: true, generator },
      );

      expect(result.changed).toBe(false);
      expect(calls).toBe(0);
    }
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
  });

  it("skips non-task document types and when fileType is absent", async () => {
    for (const fileType of ["meeting_transcript", "email_message", "doc", undefined]) {
      let calls = 0;
      const generator = fakeGenerator(async <T>() => {
        calls++;
        return { tasks: [] } as T;
      });

      const result = await emitDocumentDerivedFacts(
        db,
        { ...baseContext(), fileType },
        { contentChanged: true, generator },
      );

      expect(result.changed).toBe(false);
      expect(calls).toBe(0);
    }
    expect(await activeLlmTaskFacts(db)).toHaveLength(0);
  });
});

function fakeGenerator(generateJSON: GeminiGenerator["generateJSON"]): GeminiGenerator {
  return {
    async generate() {
      return "{}";
    },
    generateJSON,
  };
}

function baseContext() {
  return {
    indexedFileId: FILE_ID,
    source: "gmail",
    content: CONTENT,
    sourceDate: "2025-04-25",
    contentCategory: "document",
    contentHash: "hash-1",
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    lastSeenSyncRunId: null,
    attendees: [{ name: "Alice", email: "alice@example.com" }],
    parentRefs: [{ source: "linear", sourceId: "project-a" }],
  };
}

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
  await db
    .insertInto("indexed_files")
    .values({
      id: FILE_ID,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "message-1",
      file_name: "message.md",
      file_type: "document",
      content_category: "document",
      source: "gmail",
      source_path: "Gmail/Inbox",
      content: CONTENT,
      content_hash: "hash-1",
      embedding_status: "done",
      summary_status: "done",
      synced_at: new Date().toISOString(),
    })
    .execute();
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
