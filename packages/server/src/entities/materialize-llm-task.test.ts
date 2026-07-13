import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertLlmTaskFact } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { buildMaterializeDeps, materializeFromFact, materializeUnmaterializedFacts } from "./materialize";

const USER_ID = "llm-task-u1";
const CONNECTOR_ID = "llm-task-connector";

describe("legacy llm task materialization", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("skips legacy llm_task facts without minting task rows", async () => {
    await seedLlmFact(db);
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();

    await expect(materializeFromFact(await buildMaterializeDeps(db, {}), fact)).resolves.toEqual({
      kind: "skipped",
      reason: "llm_task_disabled",
    });
    await expect(countTasks(db)).resolves.toBe(0);
  });

  it("marks skipped legacy llm_task facts materialized during replay", async () => {
    await seedLlmFact(db);

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), {});
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();

    expect(summary).toMatchObject({ factsRead: 1, skipped: 1, materialized: 1 });
    expect(fact.materialized_at).not.toBeNull();
    await expect(countTasks(db)).resolves.toBe(0);
  });
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: USER_ID, name: "LLM Task User", email: "llm-task@example.com" }).execute();
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
      id: "llm-file-1",
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "message-1",
      file_name: "message.md",
      file_type: "email_message",
      content_category: "document",
      source: "gmail",
      source_path: "Gmail/Inbox",
      content: "Alice will send the pricing deck.",
      content_hash: "hash-1",
      synced_at: new Date().toISOString(),
    })
    .execute();
}

async function seedLlmFact(db: Kysely<DB>): Promise<void> {
  await upsertLlmTaskFact(db, {
    indexedFileId: "llm-file-1",
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    source: "gmail",
    candidateId: "owner-action-1",
    candidate: {
      title: "Send pricing deck",
      owner: { name: "Owner One" },
      dueDate: "2025-04-30",
      hasOwnerVerbObject: true,
    },
    corroborationKey: "send pricing deck|global",
    evidence: { fileIds: ["llm-file-1"], entityIds: [] },
    promptVersion: "llm-task-v1",
  });
}

async function countTasks(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("tasks")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
