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
    const u1Listed = await repo.listTasksByParent("project-x", {
      viewer: { email: "u1@example.com", isAdmin: false },
      userId: "brief-u1",
    });
    const u2Listed = await repo.listTasksByParent("project-x", {
      viewer: { email: "u2@example.com", isAdmin: false },
      userId: "brief-u2",
    });
    const adminListed = await repo.listTasksByParent("project-x", {
      viewer: { email: "admin@example.com", isAdmin: false },
      userId: "admin-u1",
      canReadAllLocalTasks: true,
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
          status: "open",
          status_raw: "todo",
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
    expect(u1Listed.map((task) => task.created_by_user_id)).toEqual(["brief-u1"]);
    expect(u2Listed.map((task) => task.created_by_user_id)).toEqual(["brief-u2"]);
    expect(adminListed.map((task) => task.created_by_user_id).sort()).toEqual(["brief-u1", "brief-u2"]);
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

  it("promotes Summarizer action items idempotently and collates them into structural tasks", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedProject(db, "project-x", "Project X");
    const repo = createTaskRepository(db);

    const first = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Send launch notes",
        structuredPayload: { parentEntityId: "project-x", messageIds: ["message-1", "message-2"] },
        knowledgeRefs: { entityIds: ["project-x"], fileIds: [] },
      }),
    });
    const second = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Send launch notes",
        structuredPayload: { parentEntityId: "project-x", messageIds: ["message-2"] },
        knowledgeRefs: { entityIds: ["project-x"], fileIds: [] },
      }),
    });
    const structural = await repo.upsertTask({
      parentEntityId: "project-x",
      parentSourceRef: null,
      parentName: "Project X",
      source: "linear",
      externalRef: "SKE-200",
      title: "Ship Slack capture",
      status: "in_progress",
      statusRaw: "In Progress",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "linear-200",
    });
    const collated = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Ship Slack capture",
        structuredPayload: { parentEntityId: "project-x", messageIds: ["message-3"] },
        knowledgeRefs: { entityIds: ["project-x"], fileIds: [] },
      }),
    });

    const summaryRows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source", "=", "summary")
      .where("title", "=", "Send launch notes")
      .execute();
    const evidence = await db
      .selectFrom("task_evidence")
      .selectAll()
      .where("task_id", "=", first.status === "upserted" ? first.taskId : "")
      .orderBy("kind", "asc")
      .orderBy("ref_id", "asc")
      .execute();

    expect(first.status).toBe("upserted");
    expect(second).toMatchObject({ status: "upserted", taskId: first.status === "upserted" ? first.taskId : "" });
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0]).toMatchObject({
      source: "summary",
      provenance: "summary",
      status: "open",
      status_authority: "local",
      created_by_user_id: "summary-u1",
      parent_entity_id: "project-x",
    });
    expect(evidence).toEqual([
      { task_id: first.status === "upserted" ? first.taskId : "", kind: "conversation_message", ref_id: "message-1" },
      { task_id: first.status === "upserted" ? first.taskId : "", kind: "conversation_message", ref_id: "message-2" },
      { task_id: first.status === "upserted" ? first.taskId : "", kind: "entity", ref_id: "project-x" },
    ]);
    expect(collated).toEqual({ status: "collated", taskId: structural.taskId });
    await expect(
      db.selectFrom("tasks").selectAll().where("title", "=", "Ship Slack capture").execute(),
    ).resolves.toHaveLength(1);
  });

  it("links Summarizer tasks to one unambiguous project with a qualified name", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Vedant to integrate Aimfox into the LinkedIn Workflow",
        structuredPayload: { parentName: "LinkedIn Workflow", messageIds: ["message-1"] },
      }),
    });

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", result.status === "upserted" ? result.taskId : "")
      .executeTakeFirstOrThrow();

    expect(task).toMatchObject({
      parent_entity_id: "linkedin-workflow-connect",
      parent_name: "Linkedin Workflow Connect",
      title: "Vedant to integrate Aimfox into the LinkedIn Workflow",
    });
  });

  it("resolves Summarizer assignees only when a matched person belongs to an eligible team user", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedUser(db, "vedant-user", "vedant@canvasx.ai", { name: "Vedant", emailVerified: true });
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    await seedPerson(db, "person-vedant", "Vedant", ["vedant@canvasx.ai"]);
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Vedant to integrate Aimfox into the LinkedIn Workflow",
        structuredPayload: {
          assigneeName: "Vedant",
          parentName: "LinkedIn Workflow",
          messageIds: ["message-1"],
        },
      }),
    });

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", result.status === "upserted" ? result.taskId : "")
      .executeTakeFirstOrThrow();

    expect(task).toMatchObject({
      assignee_entity_id: "person-vedant",
      assignee_name: "Vedant",
      proposed_assignee_name: null,
      parent_entity_id: "linkedin-workflow-connect",
    });
  });

  it("resolves Summarizer assignees through provider email identities", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedUser(db, "vedant-user", "vedant.primary@example.com", { name: "Vedant Primary" });
    await seedProviderIdentity(db, "vedant-user", "google", "vedant@canvasx.ai");
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    await seedPerson(db, "person-vedant", "Vedant", ["vedant@canvasx.ai"]);
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Integrate Aimfox into the LinkedIn Workflow",
        structuredPayload: {
          assigneeEmail: "vedant@canvasx.ai",
          parentName: "LinkedIn Workflow",
          messageIds: ["message-1"],
        },
      }),
    });

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", result.status === "upserted" ? result.taskId : "")
      .executeTakeFirstOrThrow();

    expect(task).toMatchObject({
      assignee_entity_id: "person-vedant",
      assignee_name: "Vedant",
      proposed_assignee_name: null,
      parent_entity_id: "linkedin-workflow-connect",
    });
  });

  it("resolves Summarizer assignees when a Slack hint confirms the eligible user identity", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedUser(db, "vedant-user", "vedant@canvasx.ai", {
      name: "Vedant",
      emailVerified: true,
      slackUserId: "U_VEDANT",
    });
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    await seedPerson(db, "person-vedant", "Vedant", ["vedant@canvasx.ai"]);
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Vedant to test summarizer task creation",
        structuredPayload: {
          assigneeEntityId: "person-vedant",
          assigneeSlackUserId: "U_VEDANT",
          parentName: "LinkedIn Workflow",
          messageIds: ["message-slack-confirmed"],
        },
      }),
    });

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", result.status === "upserted" ? result.taskId : "")
      .executeTakeFirstOrThrow();

    expect(task).toMatchObject({
      assignee_entity_id: "person-vedant",
      assignee_name: "Vedant",
      proposed_assignee_name: null,
      parent_entity_id: "linkedin-workflow-connect",
    });
  });

  it("keeps unverified user-email matches proposed instead of assigning them", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedUser(db, "vedant-user", "vedant@canvasx.ai", { name: "Vedant" });
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    await seedPerson(db, "person-vedant", "Vedant", ["vedant@canvasx.ai"]);
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Vedant to test summarizer task creation",
        structuredPayload: {
          assigneeName: "Vedant",
          parentName: "LinkedIn Workflow",
          messageIds: ["message-unverified-user-email"],
        },
      }),
    });

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", result.status === "upserted" ? result.taskId : "")
      .executeTakeFirstOrThrow();

    expect(task).toMatchObject({
      assignee_entity_id: null,
      assignee_name: null,
      proposed_assignee_name: "Vedant",
      parent_entity_id: "linkedin-workflow-connect",
    });
  });

  it("keeps graph-only Summarizer assignees proposed instead of assigning them", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    await seedPerson(db, "person-vedant", "Vedant", ["vedant@canvasx.ai"]);
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Vedant to test summarizer task creation",
        structuredPayload: {
          assigneeName: "Vedant",
          parentName: "LinkedIn Workflow",
          messageIds: ["message-graph-only"],
        },
      }),
    });

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", result.status === "upserted" ? result.taskId : "")
      .executeTakeFirstOrThrow();

    expect(task).toMatchObject({
      assignee_entity_id: null,
      assignee_name: null,
      proposed_assignee_name: "Vedant",
      parent_entity_id: "linkedin-workflow-connect",
    });
  });

  it("keeps same-name roster users proposed when no verified identity links to the person", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedUser(db, "vedant-user", "vedant@canvasx.ai", { name: "Vedant", emailVerified: true });
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    await seedPerson(db, "person-vedant", "Vedant", ["other-vedant@example.com"]);
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Vedant to test summarizer task creation",
        structuredPayload: {
          assigneeName: "Vedant",
          parentName: "LinkedIn Workflow",
          messageIds: ["message-same-name"],
        },
      }),
    });

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", result.status === "upserted" ? result.taskId : "")
      .executeTakeFirstOrThrow();

    expect(task).toMatchObject({
      assignee_entity_id: null,
      assignee_name: null,
      proposed_assignee_name: "Vedant",
      parent_entity_id: "linkedin-workflow-connect",
    });
  });

  it("keeps Summarizer assignee text when a person name is ambiguous", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    await seedPerson(db, "person-apeksha-1", "Apeksha", ["apeksha@canvasx.ai"]);
    await seedPerson(db, "person-apeksha-2", "Apeksha", ["apeksha.alt@canvasx.ai"]);
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Apeksha to deliver dashboard designs",
        structuredPayload: {
          assigneeName: "Apeksha",
          parentName: "LinkedIn Workflow",
          messageIds: ["message-2"],
        },
      }),
    });

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", result.status === "upserted" ? result.taskId : "")
      .executeTakeFirstOrThrow();

    expect(task).toMatchObject({
      assignee_entity_id: null,
      assignee_name: null,
      proposed_assignee_name: "Apeksha",
    });
  });

  it("keeps raw text-only Summarizer assignees proposed instead of assigning them", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Roopak to review backend task extraction logic",
        structuredPayload: {
          assigneeName: "Roopak",
          parentName: "LinkedIn Workflow",
          messageIds: ["message-text-only"],
        },
      }),
    });

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", result.status === "upserted" ? result.taskId : "")
      .executeTakeFirstOrThrow();

    expect(task).toMatchObject({
      assignee_entity_id: null,
      assignee_name: null,
      proposed_assignee_name: "Roopak",
      parent_entity_id: "linkedin-workflow-connect",
    });
  });

  it("leaves Summarizer task parents unlinked when qualified project names are ambiguous", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    await seedProject(db, "linkedin-workflow-dashboard", "Linkedin Workflow Dashboard");
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Vedant to integrate Aimfox into the LinkedIn Workflow",
        structuredPayload: { parentName: "LinkedIn Workflow", messageIds: ["message-1"] },
      }),
    });

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", result.status === "upserted" ? result.taskId : "")
      .executeTakeFirstOrThrow();

    expect(task).toMatchObject({
      parent_entity_id: null,
      parent_name: "LinkedIn Workflow",
    });
  });

  it("reanchors a previous null-parent Summarizer task when a rerun adds a parent", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedProject(db, "project-x", "Project X");
    const repo = createTaskRepository(db);

    const first = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Confirm Atlas launch checklist",
        structuredPayload: { messageIds: [101] },
      }),
    });
    const second = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Confirm Atlas launch checklist",
        structuredPayload: { parentEntityId: "project-x", messageIds: [102] },
      }),
    });

    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source", "=", "summary")
      .where("title", "=", "Confirm Atlas launch checklist")
      .execute();
    const evidence = await db
      .selectFrom("task_evidence")
      .selectAll()
      .where("task_id", "=", first.status === "upserted" ? first.taskId : "")
      .orderBy("ref_id", "asc")
      .execute();

    expect(first.status).toBe("upserted");
    expect(second).toMatchObject({ status: "upserted", taskId: first.status === "upserted" ? first.taskId : "" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.status === "upserted" ? first.taskId : "",
      parent_entity_id: "project-x",
      parent_name: "Project X",
    });
    expect(evidence).toEqual([
      { task_id: first.status === "upserted" ? first.taskId : "", kind: "conversation_message", ref_id: "101" },
      { task_id: first.status === "upserted" ? first.taskId : "", kind: "conversation_message", ref_id: "102" },
    ]);
  });

  it("reuses a reanchored Summarizer task when a rerun resolves the parent key", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    const repo = createTaskRepository(db);
    const legacy = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: "LinkedIn Workflow",
      source: "summary",
      externalRef: null,
      title: "Integrate Aimfox into LinkedIn Workflow",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: "high",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "legacy-parent-name-key",
      createdByUserId: "summary-u1",
    });

    await repo.reanchorNullParentTasks();
    const rerun = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Integrate Aimfox into LinkedIn Workflow",
        structuredPayload: { parentName: "LinkedIn Workflow", messageIds: ["message-2"] },
      }),
    });

    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source", "=", "summary")
      .where("normalized_title", "=", "integrate aimfox into linkedin workflow")
      .execute();

    expect(rerun).toMatchObject({ status: "upserted", taskId: legacy.taskId, created: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: legacy.taskId,
      parent_entity_id: "linkedin-workflow-connect",
      parent_name: "Linkedin Workflow Connect",
    });
  });

  it("preserves existing local status when an agent observes the same task again", async () => {
    await seedUser(db, "brief-u1", "u1@example.com");
    await seedProject(db, "project-x", "Project X");
    await seedIndexedFile(db, "brief-file-1");
    const repo = createTaskRepository(db);

    const first = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ label: "todo" }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });
    const taskId = first.status === "upserted" ? first.taskId : "";
    await db
      .updateTable("tasks")
      .set({
        status: "done",
        status_raw: "Done",
        status_authority: "local",
        status_changed_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      })
      .where("id", "=", taskId)
      .execute();

    await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ label: "in_progress" }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });

    await expect(
      db.selectFrom("tasks").selectAll().where("id", "=", taskId).executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "done",
      status_raw: "Done",
      status_authority: "local",
    });
  });

  it("loads user-owned summary tasks without file evidence and updates only local task statuses", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedUser(db, "summary-u2", "other@example.com");
    await seedProject(db, "project-x", "Project X");
    const repo = createTaskRepository(db);
    const local = await repo.upsertTask({
      parentEntityId: "project-x",
      parentSourceRef: null,
      parentName: "Project X",
      source: "summary",
      externalRef: null,
      title: "No file summary task",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "summary-no-file",
      createdByUserId: "summary-u1",
    });
    const external = await repo.upsertTask({
      parentEntityId: "project-x",
      parentSourceRef: null,
      parentName: "Project X",
      source: "linear",
      externalRef: "SKE-300",
      title: "External task",
      status: "open",
      statusRaw: "Todo",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "linear-300",
    });

    const durable = await repo.loadOpenDurableTasksForBrief({
      userId: "summary-u1",
      userEmails: ["summary@example.com"],
    });
    const updated = await repo.updateLocalTaskStatus({ taskId: local.taskId, userId: "summary-u1", status: "done" });
    const otherUserUpdate = await repo.updateLocalTaskStatus({
      taskId: local.taskId,
      userId: "summary-u2",
      status: "dropped",
    });
    const externalUpdate = await repo.updateLocalTaskStatus({
      taskId: external.taskId,
      userId: "summary-u1",
      status: "done",
    });

    expect(durable.map((task) => task.id)).toContain(local.taskId);
    expect(updated).toMatchObject({
      id: local.taskId,
      status: "done",
      status_raw: "done",
      status_authority: "local",
      completed_at: expect.any(String),
    });
    expect(otherUserUpdate).toBeNull();
    expect(externalUpdate).toBeNull();
  });

  it("loads and updates assigned local tasks for non-creator assignees", async () => {
    await seedUser(db, "summary-owner", "owner@example.com");
    await seedUser(db, "summary-assignee", "assignee@example.com");
    await seedProject(db, "project-x", "Project X");
    await seedPerson(db, "person-assignee", "Assignee User", ["assignee@example.com"]);
    const repo = createTaskRepository(db);
    const assigned = await repo.upsertTask({
      parentEntityId: "project-x",
      parentSourceRef: null,
      parentName: "Project X",
      source: "summary",
      externalRef: null,
      title: "Assigned summary task",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: "person-assignee",
      assigneeName: "Assignee User",
      priority: "high",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "summary-assigned-task",
      createdByUserId: "summary-owner",
    });

    const hiddenFromUnrelated = await repo.listTasksByParent("project-x", {
      viewer: { email: "unrelated@example.com", isAdmin: false },
      userId: "summary-unrelated",
    });
    const visibleToAssignee = await repo.listTasksByParent("project-x", {
      viewer: { email: "assignee@example.com", isAdmin: false },
      userId: "summary-assignee",
      assigneeEntityIds: ["person-assignee"],
    });
    const deniedWithoutAssigneeIdentity = await repo.updateLocalTaskStatus({
      taskId: assigned.taskId,
      userId: "summary-assignee",
      status: "done",
    });
    const updated = await repo.updateLocalTaskStatus({
      taskId: assigned.taskId,
      userId: "summary-assignee",
      assigneeEntityIds: ["person-assignee"],
      status: "done",
    });

    expect(hiddenFromUnrelated.map((task) => task.id)).not.toContain(assigned.taskId);
    expect(visibleToAssignee.map((task) => task.id)).toEqual([assigned.taskId]);
    expect(deniedWithoutAssigneeIdentity).toBeNull();
    expect(updated).toMatchObject({
      id: assigned.taskId,
      status: "done",
      status_raw: "done",
      status_authority: "local",
      completed_at: expect.any(String),
    });
  });
});

async function seedUser(
  db: Kysely<DB>,
  id: string,
  email: string,
  overrides: Partial<{
    name: string;
    type: string;
    slackUserId: string;
    whatsappNumber: string;
    emailVerified: boolean;
  }> = {},
): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id,
      name: overrides.name ?? id,
      email,
      email_verified_at: overrides.emailVerified ? new Date().toISOString() : null,
      type: overrides.type,
      slack_user_id: overrides.slackUserId,
      whatsapp_number: overrides.whatsappNumber,
    })
    .execute();
}

async function seedProviderIdentity(
  db: Kysely<DB>,
  userId: string,
  provider: string,
  providerEmail: string,
): Promise<void> {
  await db
    .insertInto("user_provider_identities")
    .values({
      id: `provider-${userId}-${provider}`,
      user_id: userId,
      provider,
      provider_user_id: `${provider}-${userId}`,
      provider_email: providerEmail,
    })
    .execute();
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

async function seedPerson(db: Kysely<DB>, id: string, name: string, aliases: string[] = []): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "person",
      subtype: null,
      aliases: aliases.length > 0 ? JSON.stringify(aliases) : null,
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

function summaryAction(overrides: Partial<SummaryActionItem> = {}): SummaryActionItem {
  return {
    sectionKey: "action_items",
    title: "Send launch notes",
    summary: "Share the launch notes with the team.",
    priority: "medium",
    label: "action_item",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
    ...overrides,
  };
}

type SummaryActionItem = Parameters<ReturnType<typeof createTaskRepository>["promoteSummaryTask"]>[0]["item"];
