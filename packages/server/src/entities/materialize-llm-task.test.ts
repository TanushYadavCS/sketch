import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertLlmTaskFact } from "../db/repositories/indexed-file-facts";
import { TEST_ACCOUNT_ENTITY_ID, createTaskRepository } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import {
  buildMaterializeDeps,
  materializeFromFact,
  materializeUnmaterializedFacts,
  shouldMarkMaterialized,
} from "./materialize";

const U1 = "llm-task-u1";
const U2 = "llm-task-u2";
const CONNECTOR_ID = "llm-task-connector";
const PROMPT_VERSION = "llm-task-v1";

describe("llm task materialization", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("drops chatter and keeps flag-off emission and materialization invisible", async () => {
    const offEmission = await upsertLlmTaskFact(db, {
      experimentalFlag: false,
      indexedFileId: "llm-file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: U1,
      source: "gmail",
      candidate: { title: "let's circle back on pricing", hasOwnerVerbObject: false },
      corroborationKey: "lets circle back on pricing|global",
      evidence: { fileIds: ["llm-file-1"], entityIds: [] },
      promptVersion: PROMPT_VERSION,
    });
    let factCount = await countRows("indexed_file_facts");
    expect(offEmission).toEqual({ emitted: false });
    expect(factCount).toBe(0);

    await seedLlmFact({
      fileId: "llm-file-1",
      candidateId: "chatter-1",
      title: "let's circle back on pricing",
      hasOwnerVerbObject: false,
      ownerUserId: U1,
      corroborationKey: "lets circle back on pricing|global",
    });
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    const depsOff = await buildMaterializeDeps(db, { experimentalFlag: false });
    const offResult = await materializeFromFact(depsOff, fact);
    expect(offResult).toEqual({ kind: "skipped", reason: "experimental_off" });
    expect(shouldMarkMaterialized(offResult)).toBe(true);

    const depsOn = await buildMaterializeDeps(db, { experimentalFlag: true, llmTaskCorroborationThreshold: 2 });
    const onResult = await materializeFromFact(depsOn, fact);
    factCount = await countRows("tasks");
    expect(onResult).toEqual({ kind: "skipped", reason: "llm_task_ungated" });
    expect(factCount).toBe(0);
  });

  it("mints only after owner-scoped distinct-file corroboration", async () => {
    await seedLlmFact({
      fileId: "llm-file-1",
      candidateId: "u1-same-file-1",
      title: "Send pricing deck",
      hasOwnerVerbObject: false,
      ownerUserId: U1,
      corroborationKey: "send pricing deck|global",
    });
    await seedLlmFact({
      fileId: "llm-file-1",
      candidateId: "u1-same-file-2",
      title: "Send pricing deck",
      hasOwnerVerbObject: false,
      ownerUserId: U1,
      corroborationKey: "send pricing deck|global",
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      experimentalFlag: true,
      llmTaskCorroborationThreshold: 2,
    });
    expect(await countRows("tasks")).toBe(0);

    await seedLlmFact({
      fileId: "llm-file-2",
      candidateId: "u1-distinct-file",
      title: "Send pricing deck",
      hasOwnerVerbObject: false,
      ownerUserId: U1,
      corroborationKey: "send pricing deck|global",
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {
      experimentalFlag: true,
      llmTaskCorroborationThreshold: 2,
    });

    let tasks = await db.selectFrom("tasks").selectAll().execute();
    let evidence = await db.selectFrom("task_evidence").selectAll().orderBy("ref_id", "asc").execute();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      source: "llm",
      provenance: "llm",
      status: "open",
      status_authority: "local",
      created_by_user_id: U1,
    });
    expect(
      evidence
        .filter((row) => row.kind === "file")
        .map((row) => row.ref_id)
        .sort(),
    ).toEqual(["llm-file-1", "llm-file-2"]);

    await seedLlmFact({
      fileId: "llm-file-3",
      candidateId: "u2-distinct-file",
      title: "Send pricing deck",
      hasOwnerVerbObject: false,
      ownerUserId: U2,
      corroborationKey: "send pricing deck|global",
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {
      experimentalFlag: true,
      llmTaskCorroborationThreshold: 2,
    });

    tasks = await db.selectFrom("tasks").selectAll().execute();
    evidence = await db.selectFrom("task_evidence").selectAll().where("kind", "=", "file").execute();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].created_by_user_id).toBe(U1);
    expect(evidence.map((row) => row.ref_id).sort()).toEqual(["llm-file-1", "llm-file-2"]);
  });

  it("materializes llm task due dates and leaves absent due dates null", async () => {
    await seedLlmFact({
      fileId: "llm-file-1",
      candidateId: "due-date-1",
      title: "Fix outstanding queries",
      hasOwnerVerbObject: true,
      ownerUserId: U1,
      corroborationKey: "fix outstanding queries|global",
      dueDate: "2025-04-30",
    });
    await seedLlmFact({
      fileId: "llm-file-2",
      candidateId: "due-date-2",
      title: "Share meeting notes",
      hasOwnerVerbObject: true,
      ownerUserId: U1,
      corroborationKey: "share meeting notes|global",
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      experimentalFlag: true,
      llmTaskCorroborationThreshold: 2,
    });

    const tasks = await db.selectFrom("tasks").selectAll().orderBy("title", "asc").execute();
    expect(tasks).toEqual([
      expect.objectContaining({ title: "Fix outstanding queries", due_at: "2025-04-30" }),
      expect.objectContaining({ title: "Share meeting notes", due_at: null }),
    ]);
  });

  it("resolves unique owner names and preserves raw owner names when names are ambiguous", async () => {
    await seedPerson(db, "person-alice", "Alice Owner");
    await seedPerson(db, "person-sam-1", "Sam Owner");
    await seedPerson(db, "person-sam-2", "Sam Owner");
    await seedLlmFact({
      fileId: "llm-file-1",
      candidateId: "owner-unique",
      title: "Prepare launch notes",
      owner: { name: "Alice Owner" },
      hasOwnerVerbObject: true,
      ownerUserId: U1,
      corroborationKey: "prepare launch notes|global",
    });
    await seedLlmFact({
      fileId: "llm-file-2",
      candidateId: "owner-ambiguous",
      title: "Review pricing deck",
      owner: { name: "Sam Owner" },
      hasOwnerVerbObject: true,
      ownerUserId: U1,
      corroborationKey: "review pricing deck|global",
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      experimentalFlag: true,
      llmTaskCorroborationThreshold: 2,
    });

    const unique = await db
      .selectFrom("tasks")
      .selectAll()
      .where("title", "=", "Prepare launch notes")
      .executeTakeFirstOrThrow();
    const ambiguous = await db
      .selectFrom("tasks")
      .selectAll()
      .where("title", "=", "Review pricing deck")
      .executeTakeFirstOrThrow();
    expect(unique).toMatchObject({ assignee_entity_id: "person-alice", assignee_name: "Alice Owner" });
    expect(ambiguous).toMatchObject({ assignee_entity_id: null, assignee_name: "Sam Owner" });
  });

  it("collates onto structural tasks without duplicating and leaves llm tasks out of orphan expiry", async () => {
    await seedProject(db, "project-x", "Project X", "linear", "project-x");
    await seedPerson(db, "person-existing-assignee", "Existing Assignee");
    const repo = createTaskRepository(db);
    const structural = await repo.upsertTask({
      parentEntityId: "project-x",
      parentSourceRef: "linear:project-x",
      parentName: "Project X",
      source: "linear",
      externalRef: "SKE-150",
      title: "Ship Slack capture",
      status: "open",
      statusRaw: "Todo",
      statusAuthority: "external",
      assigneeEntityId: "person-existing-assignee",
      priority: null,
      dueAt: "2025-01-01",
      provenance: "structural",
      sourceTaskId: "linear-150",
    });
    const beforeCount = await countRows("tasks");

    const collatedFactId = await seedLlmFact({
      fileId: "llm-file-1",
      candidateId: "collate-1",
      title: "Ship Slack capture",
      owner: { name: "Alice Owner" },
      hasOwnerVerbObject: false,
      ownerUserId: U1,
      corroborationKey: "ship slack capture|linear:project-x",
      dueDate: "2025-04-30",
      parentRef: { source: "linear", sourceId: "project-x" },
      entityIds: ["project-x", TEST_ACCOUNT_ENTITY_ID],
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {
      experimentalFlag: true,
      llmTaskCorroborationThreshold: 2,
    });

    const afterCollation = await db.selectFrom("tasks").selectAll().execute();
    const structuralEvidence = await db
      .selectFrom("task_evidence")
      .selectAll()
      .where("task_id", "=", structural.taskId)
      .orderBy("kind", "asc")
      .execute();
    expect(afterCollation).toHaveLength(beforeCount);
    expect(afterCollation[0]).toMatchObject({
      id: structural.taskId,
      status_authority: "external",
      assignee_entity_id: "person-existing-assignee",
      due_at: "2025-01-01",
    });
    expect(structuralEvidence).toEqual([
      { task_id: structural.taskId, kind: "entity", ref_id: "project-x" },
      { task_id: structural.taskId, kind: "fact", ref_id: collatedFactId },
      { task_id: structural.taskId, kind: "file", ref_id: "llm-file-1" },
    ]);

    await seedLlmFact({
      fileId: "llm-file-2",
      candidateId: "mint-expiry-guard",
      title: "Follow up on launch note",
      hasOwnerVerbObject: true,
      ownerUserId: U1,
      corroborationKey: "follow up on launch note|global",
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {
      experimentalFlag: true,
      llmTaskCorroborationThreshold: 2,
    });
    await repo.expireOrphanedTasks();

    const llmTask = await db.selectFrom("tasks").selectAll().where("provenance", "=", "llm").executeTakeFirstOrThrow();
    expect(llmTask).toMatchObject({ source: "llm", valid_to: null });
  });

  async function seedLlmFact(input: {
    fileId: string;
    candidateId: string;
    title: string;
    owner?: { name?: string; email?: string };
    dueDate?: string;
    hasOwnerVerbObject: boolean;
    ownerUserId: string;
    corroborationKey: string;
    parentRef?: { source: string; sourceId: string };
    entityIds?: string[];
  }): Promise<string> {
    await upsertLlmTaskFact(db, {
      experimentalFlag: true,
      indexedFileId: input.fileId,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: input.ownerUserId,
      source: "gmail",
      candidateId: input.candidateId,
      candidate: {
        title: input.title,
        owner: input.owner,
        dueDate: input.dueDate,
        hasOwnerVerbObject: input.hasOwnerVerbObject,
      },
      corroborationKey: input.corroborationKey,
      parentRef: input.parentRef,
      evidence: { fileIds: [input.fileId], entityIds: input.entityIds ?? [] },
      promptVersion: PROMPT_VERSION,
    });
    const fact = await db
      .selectFrom("indexed_file_facts")
      .select("id")
      .where("subject_source_id", "=", input.candidateId)
      .executeTakeFirstOrThrow();
    return fact.id;
  }

  async function countRows(table: "indexed_file_facts" | "tasks"): Promise<number> {
    const row = await db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  await seedUser(db, U1, "llm-task-u1@example.com");
  await seedUser(db, U2, "llm-task-u2@example.com");
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "gmail",
      auth_type: "oauth",
      credentials: "{}",
      created_by: U1,
    })
    .execute();
  for (const fileId of ["llm-file-1", "llm-file-2", "llm-file-3"]) {
    await seedIndexedFile(db, fileId);
  }
}

async function seedUser(db: Kysely<DB>, id: string, email: string): Promise<void> {
  await db.insertInto("users").values({ id, name: id, email }).execute();
}

async function seedIndexedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      file_name: `${id}.md`,
      file_type: "document",
      content_category: "document",
      source: "gmail",
      content: "Task source",
      content_hash: id,
      synced_at: new Date().toISOString(),
    })
    .execute();
}

async function seedProject(db: Kysely<DB>, id: string, name: string, source: string, sourceId: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ai_brief: null,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  await db
    .insertInto("entity_source_refs")
    .values({
      id: `${source}-${sourceId}`,
      entity_id: id,
      source,
      source_id: sourceId,
      source_url: null,
      last_seen_at: new Date().toISOString(),
    })
    .execute();
}

async function seedPerson(db: Kysely<DB>, id: string, name: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "person",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ai_brief: null,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
}
