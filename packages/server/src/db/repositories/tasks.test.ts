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
    await seedUser(db, "brief-u1", "u1@example.com", { emailVerified: true });
    await seedUser(db, "brief-u2", "u2@example.com", { emailVerified: true });
    await seedPerson(db, "person-u1", "Brief Owner One", ["u1@example.com"]);
    await seedPerson(db, "person-u2", "Brief Owner Two", ["u2@example.com"]);
    await seedProject(db, "project-x", "Project X");
    await seedIndexedFile(db, "brief-file-1");
    const repo = createTaskRepository(db);

    const first = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ label: "todo", structuredPayload: { assigneeName: "Brief Owner One" } }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });
    const second = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ label: "in_progress", structuredPayload: { assigneeName: "Brief Owner One" } }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });
    const otherUser = await repo.promoteBriefTask({
      userId: "brief-u2",
      todo: briefTodo({ label: "todo", structuredPayload: { assigneeName: "Brief Owner Two" } }),
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
          assignee_entity_id: "person-u1",
          assignee_name: "Brief Owner One",
          parent_entity_id: "project-x",
        }),
        expect.objectContaining({
          source: "brief",
          provenance: "brief",
          status: "open",
          status_authority: "local",
          created_by_user_id: "brief-u2",
          assignee_entity_id: "person-u2",
          assignee_name: "Brief Owner Two",
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

  it("keeps same-title Brief work separate by owner and creates a new recurrence after completion", async () => {
    await seedUser(db, "brief-u1", "u1@example.com", { emailVerified: true });
    await seedUser(db, "brief-u2", "u2@example.com", { emailVerified: true });
    await seedPerson(db, "person-u1", "Brief Owner One", ["u1@example.com"]);
    await seedPerson(db, "person-u2", "Brief Owner Two", ["u2@example.com"]);
    await seedProject(db, "project-x", "Project X");
    await seedIndexedFile(db, "brief-file-1");
    const repo = createTaskRepository(db);
    const refs = { entityIds: ["project-x"], fileIds: ["brief-file-1"] };

    const firstOwner = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ structuredPayload: { assigneeName: "Brief Owner One" } }),
      knowledgeRefs: refs,
    });
    const secondOwner = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ structuredPayload: { assigneeName: "Brief Owner Two" } }),
      knowledgeRefs: refs,
    });
    const firstTaskId = firstOwner.status === "upserted" ? firstOwner.taskId : "";
    await db
      .updateTable("tasks")
      .set({
        status: "done",
        status_raw: "done",
        completed_at: "2026-07-16T09:00:00.000Z",
        status_changed_at: "2026-07-16T09:00:00.000Z",
      })
      .where("id", "=", firstTaskId)
      .execute();
    const recurrence = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ structuredPayload: { assigneeName: "Brief Owner One" } }),
      knowledgeRefs: refs,
    });
    const replay = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ structuredPayload: { assigneeName: "Brief Owner One" } }),
      knowledgeRefs: refs,
    });
    const rows = await db
      .selectFrom("tasks")
      .select(["id", "status", "assignee_entity_id"])
      .where("source", "=", "brief")
      .where("normalized_title", "=", "ship slack capture")
      .orderBy("assignee_entity_id")
      .orderBy("status")
      .execute();

    expect(firstOwner.status).toBe("upserted");
    expect(secondOwner).toMatchObject({ status: "upserted", created: true });
    expect(secondOwner.status === "upserted" ? secondOwner.taskId : "").not.toBe(firstTaskId);
    expect(recurrence).toMatchObject({ status: "upserted", created: true });
    expect(recurrence.status === "upserted" ? recurrence.taskId : "").not.toBe(firstTaskId);
    expect(replay).toMatchObject({
      status: "upserted",
      taskId: recurrence.status === "upserted" ? recurrence.taskId : "",
      created: false,
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: firstTaskId, status: "done", assignee_entity_id: "person-u1" },
        {
          id: recurrence.status === "upserted" ? recurrence.taskId : "",
          status: "open",
          assignee_entity_id: "person-u1",
        },
        {
          id: secondOwner.status === "upserted" ? secondOwner.taskId : "",
          status: "open",
          assignee_entity_id: "person-u2",
        },
      ]),
    );
    expect(rows).toHaveLength(3);
  });

  it("collates brief todos into structural tasks and keeps orphan expiry off brief tasks", async () => {
    await seedUser(db, "brief-u1", "u1@example.com", { emailVerified: true });
    await seedPerson(db, "person-u1", "Brief Owner One", ["u1@example.com"]);
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
      todo: briefTodo({
        title: "Follow up on launch note",
        structuredPayload: { assigneeName: "Brief Owner One" },
      }),
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

    expect(collated).toMatchObject({ status: "collated", taskId: structural.taskId });
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

  it("skips Brief tasks without an eligible internal assignee", async () => {
    await seedUser(db, "brief-u1", "u1@example.com");
    await seedProject(db, "project-x", "Project X");
    await seedIndexedFile(db, "brief-file-1");
    const repo = createTaskRepository(db);

    const missingAssignee = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ title: "Document Sketch acceptance criteria" }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });
    const graphOnlyAssignee = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({
        title: "Review Sketch dashboard copy",
        structuredPayload: { assigneeName: "Vedant" },
      }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });

    const rows = await db.selectFrom("tasks").selectAll().where("source", "=", "brief").execute();

    expect(missingAssignee).toEqual({ status: "skipped", reason: "ineligible_assignee" });
    expect(graphOnlyAssignee).toEqual({ status: "skipped", reason: "ineligible_assignee" });
    expect(rows).toHaveLength(0);
  });

  it("promotes Summarizer action items idempotently and collates them into structural tasks", async () => {
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
    await seedPerson(db, "person-summary", "Summary Owner", ["summary@example.com"]);
    await seedProject(db, "project-x", "Project X");
    const repo = createTaskRepository(db);

    const first = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Send launch notes",
        structuredPayload: {
          assigneeName: "Summary Owner",
          parentEntityId: "project-x",
          messageIds: ["message-1", "message-2"],
        },
        knowledgeRefs: { entityIds: ["project-x"], fileIds: [] },
      }),
    });
    const second = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Send launch notes",
        structuredPayload: {
          assigneeName: "Summary Owner",
          parentEntityId: "project-x",
          messageIds: ["message-2"],
        },
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
      assignee_entity_id: "person-summary",
      assignee_name: "Summary Owner",
      parent_entity_id: "project-x",
    });
    expect(evidence).toEqual([
      { task_id: first.status === "upserted" ? first.taskId : "", kind: "conversation_message", ref_id: "message-1" },
      { task_id: first.status === "upserted" ? first.taskId : "", kind: "conversation_message", ref_id: "message-2" },
      { task_id: first.status === "upserted" ? first.taskId : "", kind: "entity", ref_id: "project-x" },
    ]);
    expect(collated).toMatchObject({ status: "collated", taskId: structural.taskId });
    await expect(
      db.selectFrom("tasks").selectAll().where("title", "=", "Ship Slack capture").execute(),
    ).resolves.toHaveLength(1);
  });

  it("keeps same-title Summarizer tasks separate across conversation source anchors", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    const firstConversation = await seedTaskConversation(db, "slack", "channel", "C_ONE");
    const secondConversation = await seedTaskConversation(db, "slack", "channel", "C_TWO");
    const repo = createTaskRepository(db);
    const item = summaryAction({
      title: "Send the revised proposal",
      structuredPayload: { assigneeName: "Ashish", messageIds: ["message-1"] },
    });

    const first = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item,
      sourceAnchor: {
        platform: "slack",
        conversationId: firstConversation,
        providerThreadId: "thread-1",
        key: `slack:${firstConversation}:thread-1`,
      },
      originOutputId: null,
    });
    const second = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item,
      sourceAnchor: {
        platform: "slack",
        conversationId: secondConversation,
        providerThreadId: "thread-2",
        key: `slack:${secondConversation}:thread-2`,
      },
      originOutputId: null,
    });

    expect(first.status).toBe("upserted");
    expect(second.status).toBe("upserted");
    expect(first.status === "upserted" && second.status === "upserted" ? first.taskId : "").not.toBe(
      second.status === "upserted" ? second.taskId : "",
    );
    await expect(
      db.selectFrom("tasks").select(["source_anchor_key"]).where("title", "=", item.title).execute(),
    ).resolves.toEqual(
      expect.arrayContaining([
        { source_anchor_key: `slack:${firstConversation}:thread-1` },
        { source_anchor_key: `slack:${secondConversation}:thread-2` },
      ]),
    );
  });

  it("keeps same-anchor same-title Summarizer work separate for different owners", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    const conversationId = await seedTaskConversation(db, "slack", "channel", "C_OWNER_IDENTITY");
    const repo = createTaskRepository(db);
    const sourceAnchor = {
      platform: "slack" as const,
      conversationId,
      providerThreadId: "thread-owner",
      key: `slack:${conversationId}:thread-owner`,
    };

    const first = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Send the revised proposal",
        structuredPayload: { assigneeName: "External Ashish", messageIds: ["message-owner-1"] },
      }),
      sourceAnchor,
    });
    const second = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Send the revised proposal",
        structuredPayload: { assigneeName: "External Vedant", messageIds: ["message-owner-2"] },
      }),
      sourceAnchor,
    });

    expect(first.status).toBe("upserted");
    expect(second.status).toBe("upserted");
    expect(first.status === "upserted" && second.status === "upserted" ? first.taskId : "").not.toBe(
      second.status === "upserted" ? second.taskId : "",
    );
    await expect(
      db
        .selectFrom("tasks")
        .select(["id", "proposed_assignee_name"])
        .where("source_anchor_key", "=", sourceAnchor.key)
        .where("normalized_title", "=", "send the revised proposal")
        .orderBy("proposed_assignee_name")
        .execute(),
    ).resolves.toEqual([
      expect.objectContaining({ proposed_assignee_name: "External Ashish" }),
      expect.objectContaining({ proposed_assignee_name: "External Vedant" }),
    ]);
  });

  it("upgrades a proposed Summarizer owner to the matching resolved owner without duplicating", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    const conversationId = await seedTaskConversation(db, "slack", "channel", "C_OWNER_RESOLUTION");
    const repo = createTaskRepository(db);
    const sourceAnchor = {
      platform: "slack" as const,
      conversationId,
      providerThreadId: "thread-owner-resolution",
      key: `slack:${conversationId}:thread-owner-resolution`,
    };
    const first = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Review the launch brief",
        structuredPayload: { assigneeName: "Vedant", messageIds: ["message-owner-proposed"] },
      }),
      sourceAnchor,
    });
    await seedUser(db, "vedant-user", "vedant@example.com", { emailVerified: true });
    await seedPerson(db, "person-vedant", "Vedant", ["vedant@example.com"]);
    const resolved = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Review the launch brief",
        structuredPayload: {
          assigneeEntityId: "person-vedant",
          assigneeName: "Vedant",
          messageIds: ["message-owner-resolved"],
        },
      }),
      sourceAnchor,
    });
    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source_anchor_key", "=", sourceAnchor.key)
      .where("normalized_title", "=", "review the launch brief")
      .execute();

    expect(first.status).toBe("upserted");
    expect(resolved).toMatchObject({
      status: "upserted",
      taskId: first.status === "upserted" ? first.taskId : "",
      created: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assignee_entity_id: "person-vedant",
      assignee_name: "Vedant",
      proposed_assignee_name: null,
    });
  });

  it.each(["done", "dropped"] as const)(
    "creates a new recurrence instead of reusing a %s Summarizer task",
    async (terminalStatus) => {
      await seedUser(db, "summary-u1", "summary@example.com");
      const conversationId = await seedTaskConversation(db, "slack", "channel", `C_RECURRENCE_${terminalStatus}`);
      const repo = createTaskRepository(db);
      const sourceAnchor = {
        platform: "slack" as const,
        conversationId,
        providerThreadId: "thread-recurrence",
        key: `slack:${conversationId}:thread-recurrence`,
      };
      const item = summaryAction({
        title: "Send the weekly customer update",
        structuredPayload: { assigneeName: "External Ashish", messageIds: ["message-recurrence"] },
      });

      const first = await repo.promoteSummaryTask({ userId: "summary-u1", item, sourceAnchor });
      const firstTaskId = first.status === "upserted" ? first.taskId : "";
      await db
        .updateTable("tasks")
        .set({
          status: terminalStatus,
          status_raw: terminalStatus,
          status_changed_at: "2026-07-16T09:00:00.000Z",
          completed_at: terminalStatus === "done" ? "2026-07-16T09:00:00.000Z" : null,
        })
        .where("id", "=", firstTaskId)
        .execute();

      const recurrence = await repo.promoteSummaryTask({ userId: "summary-u1", item, sourceAnchor });
      const replay = await repo.promoteSummaryTask({ userId: "summary-u1", item, sourceAnchor });
      const rows = await db
        .selectFrom("tasks")
        .select(["id", "status"])
        .where("source_anchor_key", "=", sourceAnchor.key)
        .where("normalized_title", "=", "send the weekly customer update")
        .orderBy("status")
        .execute();

      expect(recurrence).toMatchObject({ status: "upserted", created: true });
      expect(recurrence.status === "upserted" ? recurrence.taskId : "").not.toBe(firstTaskId);
      expect(replay).toMatchObject({
        status: "upserted",
        taskId: recurrence.status === "upserted" ? recurrence.taskId : "",
        created: false,
      });
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: firstTaskId, status: terminalStatus },
          { id: recurrence.status === "upserted" ? recurrence.taskId : "", status: "open" },
        ]),
      );
      expect(rows).toHaveLength(2);
    },
  );

  it("links Summarizer tasks to one unambiguous project with a qualified name", async () => {
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
    await seedPerson(db, "person-summary", "Summary Owner", ["summary@example.com"]);
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Vedant to integrate Aimfox into the LinkedIn Workflow",
        structuredPayload: {
          assigneeName: "Summary Owner",
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
      parent_entity_id: "linkedin-workflow-connect",
      parent_name: "Linkedin Workflow Connect",
      title: "Vedant to integrate Aimfox into the LinkedIn Workflow",
    });
  });

  it("resolves Summarizer assignees only when a matched person belongs to an eligible team user", async () => {
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
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
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
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
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
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

  it("preserves an unverified Summarizer owner as a proposed assignee", async () => {
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

    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source", "=", "summary")
      .where("title", "=", "Vedant to test summarizer task creation")
      .execute();

    expect(result.status).toBe("upserted");
    expect(rows).toEqual([
      expect.objectContaining({
        assignee_entity_id: null,
        assignee_name: null,
        proposed_assignee_name: "Vedant",
      }),
    ]);
  });

  it("preserves graph-only Summarizer assignees as proposed assignees", async () => {
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

    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source", "=", "summary")
      .where("title", "=", "Vedant to test summarizer task creation")
      .execute();

    expect(result.status).toBe("upserted");
    expect(rows).toEqual([
      expect.objectContaining({
        assignee_entity_id: null,
        assignee_name: null,
        proposed_assignee_name: "Vedant",
      }),
    ]);
  });

  it("does not resolve same-name roster users without a verified identity link", async () => {
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

    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source", "=", "summary")
      .where("title", "=", "Vedant to test summarizer task creation")
      .execute();

    expect(result.status).toBe("upserted");
    expect(rows).toEqual([
      expect.objectContaining({
        assignee_entity_id: null,
        assignee_name: null,
        proposed_assignee_name: "Vedant",
      }),
    ]);
  });

  it("preserves an ambiguous Summarizer person name without resolving ownership", async () => {
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

    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source", "=", "summary")
      .where("title", "=", "Apeksha to deliver dashboard designs")
      .execute();

    expect(result.status).toBe("upserted");
    expect(rows).toEqual([
      expect.objectContaining({
        assignee_entity_id: null,
        assignee_name: null,
        proposed_assignee_name: "Apeksha",
      }),
    ]);
  });

  it("preserves raw text-only Summarizer assignees as proposed assignees", async () => {
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

    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source", "=", "summary")
      .where("title", "=", "Roopak to review backend task extraction logic")
      .execute();

    expect(result.status).toBe("upserted");
    expect(rows).toEqual([
      expect.objectContaining({
        assignee_entity_id: null,
        assignee_name: null,
        proposed_assignee_name: "Roopak",
      }),
    ]);
  });

  it("preserves reader-owned ownerless Summarizer action items in durable task memory", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Document acceptance criteria for Sketch task assignment",
        structuredPayload: {
          parentName: "LinkedIn Workflow",
          messageIds: ["message-no-assignee"],
        },
      }),
    });

    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source", "=", "summary")
      .where("title", "=", "Document acceptance criteria for Sketch task assignment")
      .execute();
    const personal = await repo.loadOpenDurableTasksForBrief({
      userId: "summary-u1",
      userEmails: ["summary@example.com"],
      activeSummarySourceKeys: ["route:inactive"],
      activeSummaryConversationIds: [],
    });

    expect(result.status).toBe("upserted");
    expect(rows).toEqual([
      expect.objectContaining({
        assignee_entity_id: null,
        assignee_name: null,
        proposed_assignee_name: null,
      }),
    ]);
    expect(personal.map((task) => task.id)).toContain(rows[0]?.id);
  });

  it("leaves Summarizer task parents unlinked when qualified project names are ambiguous", async () => {
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
    await seedPerson(db, "person-summary", "Summary Owner", ["summary@example.com"]);
    await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");
    await seedProject(db, "linkedin-workflow-dashboard", "Linkedin Workflow Dashboard");
    const repo = createTaskRepository(db);

    const result = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Vedant to integrate Aimfox into the LinkedIn Workflow",
        structuredPayload: {
          assigneeName: "Summary Owner",
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
      parent_entity_id: null,
      parent_name: "LinkedIn Workflow",
    });
  });

  it("reanchors a previous null-parent Summarizer task when a rerun adds a parent", async () => {
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
    await seedPerson(db, "person-summary", "Summary Owner", ["summary@example.com"]);
    await seedProject(db, "project-x", "Project X");
    const repo = createTaskRepository(db);

    const first = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Confirm Atlas launch checklist",
        structuredPayload: { assigneeName: "Summary Owner", messageIds: [101] },
      }),
    });
    const second = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Confirm Atlas launch checklist",
        structuredPayload: { assigneeName: "Summary Owner", parentEntityId: "project-x", messageIds: [102] },
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

  it("reanchors a source-anchored null-parent Summarizer task without duplicating it", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedProject(db, "project-x", "Project X");
    const conversationId = await seedTaskConversation(db, "slack", "channel", "C_REANCHOR_SOURCE");
    const repo = createTaskRepository(db);
    const sourceAnchor = {
      platform: "slack" as const,
      conversationId,
      providerThreadId: "thread-reanchor",
      key: `slack:${conversationId}:thread-reanchor`,
    };

    const first = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Confirm Atlas launch checklist",
        structuredPayload: { assigneeName: "External Ashish", messageIds: [201] },
      }),
      sourceAnchor,
    });
    const second = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Confirm Atlas launch checklist",
        structuredPayload: {
          assigneeName: "External Ashish",
          parentEntityId: "project-x",
          messageIds: [202],
        },
      }),
      sourceAnchor,
    });
    const rows = await db
      .selectFrom("tasks")
      .selectAll()
      .where("source_anchor_key", "=", sourceAnchor.key)
      .where("normalized_title", "=", "confirm atlas launch checklist")
      .execute();

    expect(first.status).toBe("upserted");
    expect(second).toMatchObject({
      status: "upserted",
      taskId: first.status === "upserted" ? first.taskId : "",
      created: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.status === "upserted" ? first.taskId : "",
      parent_entity_id: "project-x",
      parent_name: "Project X",
      proposed_assignee_name: "External Ashish",
    });
  });

  it("reuses a reanchored Summarizer task when a rerun resolves the parent key", async () => {
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
    await seedPerson(db, "person-summary", "Summary Owner", ["summary@example.com"]);
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
        structuredPayload: {
          assigneeName: "Summary Owner",
          parentName: "LinkedIn Workflow",
          messageIds: ["message-2"],
        },
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
    await seedUser(db, "brief-u1", "u1@example.com", { emailVerified: true });
    await seedPerson(db, "person-u1", "Brief Owner One", ["u1@example.com"]);
    await seedProject(db, "project-x", "Project X");
    await seedIndexedFile(db, "brief-file-1");
    const repo = createTaskRepository(db);

    const first = await repo.promoteBriefTask({
      userId: "brief-u1",
      todo: briefTodo({ label: "todo", structuredPayload: { assigneeName: "Brief Owner One" } }),
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
      todo: briefTodo({ label: "in_progress", structuredPayload: { assigneeName: "Brief Owner One" } }),
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

  it("includes reader-owned ownerless summary tasks and updates only local task statuses", async () => {
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
    const adminUpdate = await repo.updateLocalTaskStatus({
      taskId: local.taskId,
      userId: "summary-u2",
      status: "open",
      canEditAllLocalTasks: true,
    });
    const repeatedDone = await repo.updateLocalTaskStatus({
      taskId: local.taskId,
      userId: "summary-u1",
      status: "done",
    });
    const externalUpdate = await repo.updateLocalTaskStatus({
      taskId: external.taskId,
      userId: "summary-u1",
      status: "done",
    });
    const activity = await db
      .selectFrom("task_activity_events")
      .select(["event_kind", "changes_json"])
      .where("task_id", "=", local.taskId)
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();

    expect(durable.map((task) => task.id)).toContain(local.taskId);
    expect(updated).toMatchObject({
      id: local.taskId,
      status: "done",
      status_raw: "done",
      status_authority: "local",
      completed_at: expect.any(String),
    });
    expect(otherUserUpdate).toBeNull();
    expect(adminUpdate).toMatchObject({
      id: local.taskId,
      status: "open",
      status_raw: "open",
      status_authority: "local",
      completed_at: null,
    });
    expect(repeatedDone).toMatchObject({
      id: local.taskId,
      status: "done",
      status_raw: "done",
      status_authority: "local",
      completed_at: expect.any(String),
    });
    expect(externalUpdate).toBeNull();
    expect(activity).toHaveLength(3);
    expect(activity.map((event) => event.event_kind)).toEqual([
      "task_status_changed",
      "task_status_changed",
      "task_status_changed",
    ]);
    expect(activity.map((event) => JSON.parse(event.changes_json ?? "{}"))).toEqual([
      { status: { before: "open", after: "done" } },
      { status: { before: "done", after: "open" } },
      { status: { before: "open", after: "done" } },
    ]);
  });

  it("loads recent user-owned summary tasks for Daily Brief including completed protection rows", async () => {
    await seedUser(db, "summary-u1", "summary@example.com");
    await seedUser(db, "summary-u2", "other@example.com");
    await seedProject(db, "project-x", "Project X");
    const repo = createTaskRepository(db);
    const open = await repo.upsertTask({
      parentEntityId: "project-x",
      parentSourceRef: null,
      parentName: "Project X",
      source: "summary",
      externalRef: null,
      title: "Open summary task",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "summary-open",
      createdByUserId: "summary-u1",
    });
    const done = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Done summary task",
      status: "done",
      statusRaw: "done",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: "low",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "summary-done",
      createdByUserId: "summary-u1",
    });
    const old = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Old summary task",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "summary-old",
      createdByUserId: "summary-u1",
    });
    await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Other user summary task",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "summary-other-user",
      createdByUserId: "summary-u2",
    });
    await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "brief",
      externalRef: null,
      title: "Brief task",
      status: "open",
      statusRaw: "todo",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: "medium",
      dueAt: null,
      provenance: "brief",
      sourceTaskId: "brief-task",
      createdByUserId: "summary-u1",
    });
    await db
      .updateTable("tasks")
      .set({ updated_at: "2026-07-09T12:00:00.000Z" })
      .where("id", "in", [open.taskId, done.taskId])
      .execute();
    await db
      .updateTable("tasks")
      .set({ updated_at: "2026-07-08T12:00:00.000Z" })
      .where("id", "=", old.taskId)
      .execute();

    const rows = await repo.loadSummaryTasksForBrief({
      userId: "summary-u1",
      since: "2026-07-09T00:00:00.000Z",
      limit: 10,
    });

    expect(rows.map((task) => task.id)).toEqual([open.taskId, done.taskId]);
    expect(rows.map((task) => task.status)).toEqual(["open", "done"]);
  });

  it("collates Brief todos with matching Summary tasks even when Brief evidence has no file", async () => {
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
    await seedPerson(db, "person-summary", "Summary Owner", ["summary@example.com"]);
    await seedProject(db, "project-x", "Project X");
    const repo = createTaskRepository(db);

    const summary = await repo.promoteSummaryTask({
      userId: "summary-u1",
      item: summaryAction({
        title: "Send launch notes",
        structuredPayload: {
          assigneeName: "Summary Owner",
          parentEntityId: "project-x",
          messageIds: ["message-1"],
        },
        knowledgeRefs: { entityIds: ["project-x"], fileIds: [] },
      }),
    });
    const brief = await repo.promoteBriefTask({
      userId: "summary-u1",
      todo: briefTodo({
        title: "Send launch notes",
        structuredPayload: { assigneeName: "Summary Owner" },
        knowledgeRefs: { entityIds: ["project-x"], fileIds: [] },
      }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: [] },
    });

    const tasks = await db
      .selectFrom("tasks")
      .selectAll()
      .where("normalized_title", "=", "send launch notes")
      .execute();

    expect(summary.status).toBe("upserted");
    expect(brief).toMatchObject({ status: "collated", taskId: summary.status === "upserted" ? summary.taskId : "" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ source: "summary", provenance: "summary", status: "open" });
  });

  it("collates Brief todos with parentless Summary tasks when Brief has only entity evidence", async () => {
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
    await seedProject(db, "project-x", "Project X");
    const repo = createTaskRepository(db);
    const summary = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Send launch notes",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "summary-parentless",
      createdByUserId: "summary-u1",
    });
    const brief = await repo.promoteBriefTask({
      userId: "summary-u1",
      todo: briefTodo({
        title: "Send launch notes",
        knowledgeRefs: { entityIds: ["project-x"], fileIds: [] },
      }),
      knowledgeRefs: { entityIds: ["project-x"], fileIds: [] },
    });

    const tasks = await db
      .selectFrom("tasks")
      .selectAll()
      .where("normalized_title", "=", "send launch notes")
      .execute();

    expect(brief).toMatchObject({ status: "collated", taskId: summary.taskId });
    expect(tasks).toHaveLength(1);
  });

  it("collates Brief todos with parentless Summary tasks when Brief has no evidence", async () => {
    await seedUser(db, "summary-u1", "summary@example.com", { emailVerified: true });
    const repo = createTaskRepository(db);
    const summary = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Send launch notes",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "summary-parentless-no-evidence",
      createdByUserId: "summary-u1",
    });
    const brief = await repo.promoteBriefTask({
      userId: "summary-u1",
      todo: briefTodo({ title: "Send launch notes", knowledgeRefs: { entityIds: [], fileIds: [] } }),
      knowledgeRefs: { entityIds: [], fileIds: [] },
    });

    const tasks = await db
      .selectFrom("tasks")
      .selectAll()
      .where("normalized_title", "=", "send launch notes")
      .execute();

    expect(brief).toMatchObject({ status: "collated", taskId: summary.taskId });
    expect(tasks).toHaveLength(1);
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

async function seedTaskConversation(
  db: Kysely<DB>,
  platform: string,
  kind: string,
  providerConversationId: string,
): Promise<number> {
  await db
    .insertInto("conversations")
    .values({
      platform,
      kind,
      provider_conversation_id: providerConversationId,
      display_name: providerConversationId,
    })
    .execute();
  return (
    await db
      .selectFrom("conversations")
      .select("id")
      .where("platform", "=", platform)
      .where("kind", "=", kind)
      .where("provider_conversation_id", "=", providerConversationId)
      .executeTakeFirstOrThrow()
  ).id;
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
