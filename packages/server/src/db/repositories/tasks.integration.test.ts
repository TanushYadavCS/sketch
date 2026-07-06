import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
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

async function seedPgIndexedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: `connector-${id}`,
      connector_type: "google-drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "pg-brief-u1",
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
