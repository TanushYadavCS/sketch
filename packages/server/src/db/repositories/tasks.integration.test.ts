import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { materializeUnmaterializedFacts } from "../../entities/materialize";
import { getSharedPgDb } from "../../test-utils";
import { createTestLogger } from "../../test-utils";
import type { DB } from "../schema";
import { upsertLlmTaskFact } from "./indexed-file-facts";
import { createTaskRepository } from "./tasks";

describe("createTaskRepository postgres", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("upserts on source and source task id without duplicating rows", async () => {
    const repo = createTaskRepository(db);
    const first = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "linear",
      externalRef: "SKE-PG-1",
      title: "PG first title",
      status: "open",
      statusRaw: "Backlog",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "pg-issue-1",
    });
    const second = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "linear",
      externalRef: "SKE-PG-1",
      title: "PG renamed title",
      status: "done",
      statusRaw: "Done",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "pg-issue-1",
    });
    const rows = await db.selectFrom("tasks").selectAll().where("source_task_id", "=", "pg-issue-1").execute();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.taskId, title: "PG renamed title", status: "done", valid_to: null });
  });

  it("promotes brief tasks and collates with structural tasks on postgres", async () => {
    await seedPgUser(db, "pg-brief-u1", "pg-u1@example.com");
    await seedPgProject(db, "pg-project-x", "PG Project X");
    await seedPgIndexedFile(db, "pg-brief-file-1");
    const repo = createTaskRepository(db);

    const first = await repo.promoteBriefTask({
      userId: "pg-brief-u1",
      todo: pgBriefTodo(),
      knowledgeRefs: { entityIds: ["pg-project-x"], fileIds: ["pg-brief-file-1"] },
    });
    const second = await repo.promoteBriefTask({
      userId: "pg-brief-u1",
      todo: pgBriefTodo({ label: "in_progress" }),
      knowledgeRefs: { entityIds: ["pg-project-x"], fileIds: ["pg-brief-file-1"] },
    });
    await db.deleteFrom("task_evidence").execute();
    await db.deleteFrom("tasks").execute();
    const structural = await repo.upsertTask({
      parentEntityId: "pg-project-x",
      parentSourceRef: "linear:pg-project-x",
      parentName: "PG Project X",
      source: "linear",
      externalRef: "SKE-PG-150",
      title: "Ship Slack capture",
      status: "open",
      statusRaw: "Todo",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "pg-linear-150",
    });
    const collated = await repo.promoteBriefTask({
      userId: "pg-brief-u1",
      todo: pgBriefTodo(),
      knowledgeRefs: { entityIds: ["pg-project-x"], fileIds: ["pg-brief-file-1"] },
    });

    const rows = await db.selectFrom("tasks").selectAll().orderBy("created_at", "asc").execute();
    const evidence = await db
      .selectFrom("task_evidence")
      .selectAll()
      .where("task_id", "=", structural.taskId)
      .orderBy("kind", "asc")
      .execute();

    expect(first.status).toBe("upserted");
    expect(second).toMatchObject({ status: "upserted", taskId: first.status === "upserted" ? first.taskId : "" });
    expect(collated).toEqual({ status: "collated", taskId: structural.taskId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: structural.taskId, provenance: "structural", status_authority: "external" });
    expect(evidence).toEqual([
      { task_id: structural.taskId, kind: "entity", ref_id: "pg-project-x" },
      { task_id: structural.taskId, kind: "file", ref_id: "pg-brief-file-1" },
    ]);
  });

  it("materializes llm corroboration mint and structural collation on postgres", async () => {
    await seedPgUser(db, "pg-llm-u1", "pg-llm-u1@example.com");
    await seedPgProject(db, "pg-llm-project", "PG LLM Project");
    await seedPgProjectRef(db, "pg-llm-project", "linear", "pg-llm-project");
    await seedPgIndexedFileForUser(db, "pg-llm-file-1", "pg-llm-u1");
    await seedPgIndexedFileForUser(db, "pg-llm-file-2", "pg-llm-u1");
    await seedPgIndexedFileForUser(db, "pg-llm-file-3", "pg-llm-u1");

    await seedPgLlmFact({
      db,
      fileId: "pg-llm-file-1",
      connectorConfigId: "connector-pg-llm-file-1",
      ownerUserId: "pg-llm-u1",
      candidateId: "pg-corroborate-1",
      title: "Send pricing deck",
      hasOwnerVerbObject: false,
      corroborationKey: "send pricing deck|global",
    });
    await seedPgLlmFact({
      db,
      fileId: "pg-llm-file-2",
      connectorConfigId: "connector-pg-llm-file-2",
      ownerUserId: "pg-llm-u1",
      candidateId: "pg-corroborate-2",
      title: "Send pricing deck",
      hasOwnerVerbObject: false,
      corroborationKey: "send pricing deck|global",
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {
      experimentalFlag: true,
      llmTaskCorroborationThreshold: 2,
    });

    const minted = await db.selectFrom("tasks").selectAll().where("provenance", "=", "llm").execute();
    const mintedEvidence = await db
      .selectFrom("task_evidence")
      .selectAll()
      .where("kind", "=", "file")
      .orderBy("ref_id", "asc")
      .execute();
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      source: "llm",
      status_authority: "local",
      created_by_user_id: "pg-llm-u1",
    });
    expect(mintedEvidence.map((row) => row.ref_id)).toEqual(["pg-llm-file-1", "pg-llm-file-2"]);

    const repo = createTaskRepository(db);
    const structural = await repo.upsertTask({
      parentEntityId: "pg-llm-project",
      parentSourceRef: "linear:pg-llm-project",
      parentName: "PG LLM Project",
      source: "linear",
      externalRef: "SKE-PG-LLM",
      title: "Ship Slack capture",
      status: "open",
      statusRaw: "Todo",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "pg-llm-structural",
    });
    await seedPgLlmFact({
      db,
      fileId: "pg-llm-file-3",
      connectorConfigId: "connector-pg-llm-file-3",
      ownerUserId: "pg-llm-u1",
      candidateId: "pg-collate-1",
      title: "Ship Slack capture",
      hasOwnerVerbObject: false,
      corroborationKey: "ship slack capture|linear:pg-llm-project",
      parentRef: { source: "linear", sourceId: "pg-llm-project" },
      entityIds: ["pg-llm-project"],
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {
      experimentalFlag: true,
      llmTaskCorroborationThreshold: 2,
    });

    const rows = await db.selectFrom("tasks").selectAll().orderBy("source", "asc").execute();
    const structuralEvidence = await db
      .selectFrom("task_evidence")
      .selectAll()
      .where("task_id", "=", structural.taskId)
      .orderBy("kind", "asc")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === structural.taskId)).toMatchObject({
      provenance: "structural",
      status_authority: "external",
    });
    expect(structuralEvidence.map((row) => row.kind).sort()).toEqual(["entity", "fact", "file"]);
  });
});

async function seedPgUser(db: Kysely<DB>, id: string, email: string): Promise<void> {
  await db.insertInto("users").values({ id, name: id, email }).execute();
}

async function seedPgProject(db: Kysely<DB>, id: string, name: string): Promise<void> {
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
}

async function seedPgProjectRef(db: Kysely<DB>, entityId: string, source: string, sourceId: string): Promise<void> {
  await db
    .insertInto("entity_source_refs")
    .values({
      id: `${source}-${sourceId}`,
      entity_id: entityId,
      source,
      source_id: sourceId,
      source_url: null,
      last_seen_at: new Date().toISOString(),
    })
    .execute();
}

async function seedPgIndexedFile(db: Kysely<DB>, id: string): Promise<void> {
  await seedPgIndexedFileForUser(db, id, "pg-brief-u1");
}

async function seedPgIndexedFileForUser(db: Kysely<DB>, id: string, userId: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: `connector-${id}`,
      connector_type: "google-drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: userId,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: `connector-${id}`,
      provider_file_id: `provider-${id}`,
      file_name: `${id}.md`,
      file_type: "document",
      content_category: "document",
      source: "google-drive",
      source_path: null,
      provider_url: null,
      content: "Task source",
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      source_updated_at: null,
      source_created_at: null,
      synced_at: new Date().toISOString(),
      embedding_status: "pending",
    })
    .execute();
}

async function seedPgLlmFact(input: {
  db: Kysely<DB>;
  fileId: string;
  connectorConfigId: string;
  ownerUserId: string;
  candidateId: string;
  title: string;
  hasOwnerVerbObject: boolean;
  corroborationKey: string;
  parentRef?: { source: string; sourceId: string };
  entityIds?: string[];
}): Promise<void> {
  await upsertLlmTaskFact(input.db, {
    experimentalFlag: true,
    indexedFileId: input.fileId,
    connectorConfigId: input.connectorConfigId,
    createdByUserId: input.ownerUserId,
    source: "gmail",
    candidateId: input.candidateId,
    candidate: { title: input.title, hasOwnerVerbObject: input.hasOwnerVerbObject },
    corroborationKey: input.corroborationKey,
    parentRef: input.parentRef,
    evidence: { fileIds: [input.fileId], entityIds: input.entityIds ?? [] },
    promptVersion: "llm-task-v1",
  });
}

type PgBriefTodo = Parameters<ReturnType<typeof createTaskRepository>["promoteBriefTask"]>[0]["todo"];

function pgBriefTodo(overrides: Partial<PgBriefTodo> = {}): PgBriefTodo {
  return {
    sectionKey: "todos",
    title: "Ship Slack capture",
    summary: "Capture Slack commitments.",
    priority: "high",
    label: "todo",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
    ...overrides,
  };
}
