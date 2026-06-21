import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createTaskRepository } from "./tasks";

describe("createTaskRepository sqlite", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("upserts on source and source task id without duplicating rows", async () => {
    const repo = createTaskRepository(db);
    const first = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "linear",
      externalRef: "SKE-1",
      title: "First title",
      status: "open",
      statusRaw: "Backlog",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "issue-1",
    });
    const second = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "linear",
      externalRef: "SKE-1",
      title: "Renamed title",
      status: "done",
      statusRaw: "Done",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "issue-1",
    });
    const rows = await db.selectFrom("tasks").selectAll().execute();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.taskId, title: "Renamed title", status: "done", valid_to: null });
  });

  it("promotes brief tasks with stable owner identity, read isolation, and a fileId gate", async () => {
    await seedUser(db, "brief-u1", "u1@example.com");
    await seedUser(db, "brief-u2", "u2@example.com");
    await seedProject(db, "project-x", "Project X");
    await seedIndexedFile(db, "brief-file-1");
    const repo = createTaskRepository(db);

    const first = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ label: "todo" }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });
    const second = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ label: "in_progress" }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });
    const otherUser = await repo.promoteBriefTask({
      userId: "brief-u2",
      todo: briefTodo({ label: "todo" }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });
    const skipped = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ title: "Entity-only todo" }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: [] },
    });
    const typedBrief = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "brief-typed",
      externalRef: null,
      title: "Typed brief provenance",
      status: "open",
      statusRaw: "todo",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "brief",
      sourceTaskId: "typed-brief",
    });

    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("title", "in", ["Ship Slack capture", "Entity-only todo", "Typed brief provenance"])
      .execute();
    const durable = rows.filter((row) => row.title === "Ship Slack capture").sort((a, b) => a.id.localeCompare(b.id));
    const u1Visible = await repo.loadOpenDurableTasksForBrief({
      userId: "brief-u1",
      userEmails: ["u1@example.com", "alias-u1@example.com"],
    });

    expect(first.status).toBe("upserted");
    expect(second).toMatchObject({ status: "upserted", taskId: first.status === "upserted" ? first.taskId : "" });
    expect(otherUser.status).toBe("upserted");
    expect(otherUser.status === "upserted" ? otherUser.taskId : "").not.toBe(
      first.status === "upserted" ? first.taskId : "",
    );
    expect(skipped).toEqual({ status: "skipped", reason: "missing_file_id" });
    expect(durable).toHaveLength(2);
    expect(durable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "brief",
          provenance: "brief",
          status: "in_progress",
          status_raw: "in_progress",
          status_authority: "local",
          created_by_user_id: "brief-u1",
          parent_entity_id: "project-x",
        }),
        expect.objectContaining({
          source: "brief",
          provenance: "brief",
          status: "open",
          status_authority: "local",
          created_by_user_id: "brief-u2",
          parent_entity_id: "project-x",
        }),
      ]),
    );
    expect(rows.some((row) => row.title === "Entity-only todo")).toBe(false);
    expect(rows.find((row) => row.id === typedBrief.taskId)).toMatchObject({
      source: "brief-typed",
      provenance: "brief",
      status_authority: "local",
      created_by_user_id: null,
    });
    expect(u1Visible.map((task) => task.created_by_user_id)).toEqual(["brief-u1"]);
  });

  it("collates brief todos into structural tasks and keeps orphan expiry off brief tasks", async () => {
    await seedUser(db, "brief-u1", "u1@example.com");
    await seedProject(db, "project-x", "Project X");
    await seedIndexedFile(db, "brief-file-1");
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
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "linear-150",
    });

    const collated = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo(),
      knowledgeRefs: {
        entityIds: ["project-x"],
        fileIds: ["brief-file-1"],
        factIds: ["fact-1"],
        mentionIds: ["mention-1"],
      },
    });
    const countAfterCollation = await db
      .selectFrom("tasks")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    const brief = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ title: "Follow up on launch note" }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });
    await repo.expireOrphanedTasks();

    const tasks = await db.selectFrom("tasks").selectAll().orderBy("source", "asc").execute();
    const evidence = await db
      .selectFrom("task_evidence")
      .selectAll()
      .where("task_id", "=", structural.taskId)
      .orderBy("kind", "asc")
      .execute();
    const briefRow = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", brief.status === "upserted" ? brief.taskId : "")
      .executeTakeFirstOrThrow();

    expect(collated).toEqual({ status: "collated", taskId: structural.taskId });
    expect(Number(countAfterCollation.count)).toBe(1);
    expect(tasks.filter((task) => task.title === "Ship Slack capture")).toHaveLength(1);
    expect(tasks.find((task) => task.id === structural.taskId)).toMatchObject({
      status_authority: "external",
      provenance: "structural",
    });
    expect(evidence).toEqual([
      { task_id: structural.taskId, kind: "entity", ref_id: "project-x" },
      { task_id: structural.taskId, kind: "fact", ref_id: "fact-1" },
      { task_id: structural.taskId, kind: "file", ref_id: "brief-file-1" },
      { task_id: structural.taskId, kind: "mention", ref_id: "mention-1" },
    ]);
    expect(briefRow.valid_to).toBeNull();
  });
});

async function seedUser(db: Kysely<DB>, id: string, email: string): Promise<void> {
  await db.insertInto("users").values({ id, name: id, email }).execute();
}

async function seedProject(db: Kysely<DB>, id: string, name: string): Promise<void> {
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

async function seedIndexedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: `connector-${id}`,
      connector_type: "google-drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "brief-u1",
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

function briefTodo(overrides: Partial<DailyBriefTodo> = {}): DailyBriefTodo {
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

type DailyBriefTodo = Parameters<ReturnType<typeof createTaskRepository>["promoteBriefTask"]>[0]["todo"];
