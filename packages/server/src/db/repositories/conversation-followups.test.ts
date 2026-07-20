import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import {
  type SummarizerTaskChange,
  type TaskMemoryItem,
  createConversationFollowupsRepository,
} from "./conversation-followups";

const USER_ID = "user-followups";
const ASSIGNEE_ID = "person-followups";
const OTHER_ASSIGNEE_ID = "person-other";
const PROJECT_ID = "project-followups";
const OTHER_PROJECT_ID = "project-other";
const OTHER_USER_ID = "user-other";
const NOW = "2026-07-16T10:00:00.000Z";

describe("createConversationFollowupsRepository", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUserAndEntities(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("normalizes Slack top-level, Slack thread, and WhatsApp evidence from internal messages", async () => {
    const slack = await seedConversation(db, "slack", "channel", "C-followups");
    const whatsapp = await seedConversation(db, "whatsapp", "group", "120363-followups");
    const topLevel = await seedMessage(db, slack, {
      providerMessageId: "171.001",
      providerThreadId: "171.001",
      isThreadReply: false,
    });
    const threadReply = await seedMessage(db, slack, {
      providerMessageId: "171.002",
      providerThreadId: "171.000",
      isThreadReply: true,
    });
    const whatsappReply = await seedMessage(db, whatsapp, {
      providerMessageId: "wamid.1",
      providerThreadId: "quoted-wamid",
      isThreadReply: true,
    });
    const repo = createConversationFollowupsRepository(db);

    await expect(
      repo.deriveNormalizedEvidence({
        messageIds: [topLevel],
        allowedMessageIds: [topLevel, threadReply, whatsappReply],
        allowedConversationIds: [slack, whatsapp],
      }),
    ).resolves.toMatchObject({
      status: "ok",
      anchor: {
        platform: "slack",
        conversationId: slack,
        providerThreadId: null,
        key: `slack:${slack}:root`,
      },
    });
    await expect(
      repo.deriveNormalizedEvidence({
        messageIds: [threadReply],
        allowedMessageIds: [topLevel, threadReply, whatsappReply],
        allowedConversationIds: [slack, whatsapp],
      }),
    ).resolves.toMatchObject({
      status: "ok",
      anchor: {
        platform: "slack",
        conversationId: slack,
        providerThreadId: "171.000",
        key: `slack:${slack}:171.000`,
      },
    });
    await expect(
      repo.deriveNormalizedEvidence({
        messageIds: [whatsappReply],
        allowedMessageIds: [topLevel, threadReply, whatsappReply],
        allowedConversationIds: [slack, whatsapp],
      }),
    ).resolves.toMatchObject({
      status: "ok",
      anchor: {
        platform: "whatsapp",
        conversationId: whatsapp,
        providerThreadId: null,
        key: `whatsapp:${whatsapp}:root`,
      },
    });
  });

  it("normalizes Slack and WhatsApp direct-message evidence with the shared root anchor", async () => {
    const slackDm = await seedConversation(db, "slack", "dm", "D-followups");
    const whatsappDm = await seedConversation(db, "whatsapp", "dm", "dm:+15550001111");
    const slackMessage = await seedMessage(db, slackDm, { providerMessageId: "dm-slack" });
    const whatsappMessage = await seedMessage(db, whatsappDm, { providerMessageId: "dm-whatsapp" });
    const repo = createConversationFollowupsRepository(db);

    await expect(
      repo.deriveNormalizedEvidence({
        messageIds: [slackMessage],
        allowedMessageIds: [slackMessage, whatsappMessage],
        allowedConversationIds: [slackDm, whatsappDm],
      }),
    ).resolves.toMatchObject({
      status: "ok",
      anchor: { platform: "slack", conversationId: slackDm, providerThreadId: null },
    });
    await expect(
      repo.deriveNormalizedEvidence({
        messageIds: [whatsappMessage],
        allowedMessageIds: [slackMessage, whatsappMessage],
        allowedConversationIds: [slackDm, whatsappDm],
      }),
    ).resolves.toMatchObject({
      status: "ok",
      anchor: { platform: "whatsapp", conversationId: whatsappDm, providerThreadId: null },
    });
  });

  it("rejects outside-window and ambiguous multi-anchor evidence", async () => {
    const firstConversation = await seedConversation(db, "slack", "channel", "C-first");
    const secondConversation = await seedConversation(db, "slack", "channel", "C-second");
    const first = await seedMessage(db, firstConversation, { providerMessageId: "1" });
    const second = await seedMessage(db, secondConversation, { providerMessageId: "2" });
    const repo = createConversationFollowupsRepository(db);

    await expect(
      repo.deriveNormalizedEvidence({
        messageIds: [second],
        allowedMessageIds: [first],
        allowedConversationIds: [firstConversation],
      }),
    ).resolves.toEqual({ status: "invalid", reason: "outside_allowed_window" });
    await expect(
      repo.deriveNormalizedEvidence({
        messageIds: [first, second],
        allowedMessageIds: [first, second],
        allowedConversationIds: [firstConversation, secondConversation],
      }),
    ).resolves.toEqual({ status: "invalid", reason: "ambiguous_source_anchor" });
  });

  it("keeps same-title tasks separate across unrelated Slack threads and preserves ownerless tasks", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-project");
    const first = await seedMessage(db, conversationId, {
      providerMessageId: "10.1",
      providerThreadId: "10.0",
      isThreadReply: true,
    });
    const second = await seedMessage(db, conversationId, {
      providerMessageId: "20.1",
      providerThreadId: "20.0",
      isThreadReply: true,
    });
    const repo = createConversationFollowupsRepository(db);

    const results = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [first, second],
      allowedConversationIds: [conversationId],
      changes: [
        newChange("Send revised proposal", [first], { assigneeName: "External Ashish" }),
        newChange("Send revised proposal", [second], { assigneeName: "External Ashish" }),
      ],
      now: NOW,
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "applied")).toBe(true);
    const tasks = await db
      .selectFrom("tasks")
      .select(["id", "source_provider_thread_id", "assignee_entity_id", "proposed_assignee_name"])
      .where("source", "=", "summary")
      .orderBy("source_provider_thread_id")
      .execute();
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.source_provider_thread_id)).toEqual(["10.0", "20.0"]);
    expect(tasks.every((task) => task.assignee_entity_id === null)).toBe(true);
    expect(tasks.every((task) => task.proposed_assignee_name === "External Ashish")).toBe(true);
  });

  it("loads bounded open task memory with anchors and dedicated evidence", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "group", "group-memory");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "wamid.memory" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Prepare launch brief", [messageId], { assigneeName: "Unresolved owner" })],
      now: NOW,
    });
    expect(created.status).toBe("applied");

    const memory = await repo.loadTaskMemory({
      userId: USER_ID,
      conversationIds: [conversationId],
      limit: 1,
    });

    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatchObject({
      taskId: appliedTaskId(created),
      title: "Prepare launch brief",
      status: "open",
      proposedAssigneeName: "Unresolved owner",
      sourceAnchor: {
        platform: "whatsapp",
        conversationId,
        providerThreadId: null,
      },
      evidenceMessageIds: [messageId],
    });
  });

  it("limits task memory to fifty tasks and twenty evidence message ids per task", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-memory-limits");
    const messageIds: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      messageIds.push(
        await seedMessage(db, conversationId, {
          providerMessageId: `memory-limit-${String(index).padStart(2, "0")}`,
        }),
      );
    }
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: messageIds,
      allowedConversationIds: [conversationId],
      changes: [newChange("Bounded evidence task", [messageIds[0]])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    await db
      .insertInto("task_message_evidence")
      .values(
        messageIds.slice(1).map((messageId) => ({
          task_id: taskId,
          conversation_message_id: messageId,
          source_platform: "slack",
          source_conversation_id: conversationId,
          source_provider_thread_id: null,
          source_anchor_key: `slack:${conversationId}:root`,
        })),
      )
      .execute();
    await db.updateTable("tasks").set({ updated_at: "2026-07-17T00:00:00.000Z" }).where("id", "=", taskId).execute();
    await db
      .insertInto("tasks")
      .values(
        Array.from({ length: 50 }, (_, index) => ({
          ...summaryTaskRow({
            id: `memory-task-limit-${index}`,
            title: `Memory task limit ${index}`,
            status: "open",
            conversationId,
            originOutputId: null,
          }),
          updated_at: "2026-07-15T00:00:00.000Z",
        })),
      )
      .execute();

    const memory = await repo.loadTaskMemory({
      userId: USER_ID,
      conversationIds: [conversationId],
      limit: 200,
    });

    expect(memory).toHaveLength(50);
    expect(memory.find((task) => task.taskId === taskId)?.evidenceMessageIds).toEqual(messageIds.slice(0, 20));
  });

  it("loads a bounded visible union of source, creator, assignee, and resolved-parent task memory", async () => {
    const sourceConversation = await seedConversation(db, "slack", "channel", "C-memory-source");
    const otherConversation = await seedConversation(db, "slack", "channel", "C-memory-other");
    const sourceMessage = await seedMessage(db, sourceConversation, { providerMessageId: "memory-source" });
    const userOwnedMessage = await seedMessage(db, otherConversation, { providerMessageId: "memory-user" });
    const assigneeOwnedMessage = await seedMessage(db, otherConversation, { providerMessageId: "memory-assignee" });
    const parentLinkedMessage = await seedMessage(db, otherConversation, { providerMessageId: "memory-parent" });
    const hiddenMessage = await seedMessage(db, otherConversation, { providerMessageId: "memory-hidden" });
    const repo = createConversationFollowupsRepository(db);
    const created = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [sourceMessage, userOwnedMessage, assigneeOwnedMessage, parentLinkedMessage, hiddenMessage],
      allowedConversationIds: [sourceConversation, otherConversation],
      changes: [
        newChange("Source relevant", [sourceMessage]),
        newChange("User owned", [userOwnedMessage]),
        newChange("Assignee owned", [assigneeOwnedMessage]),
        newChange("Parent linked", [parentLinkedMessage]),
        newChange("Hidden unrelated", [hiddenMessage]),
      ],
      now: NOW,
    });
    const [sourceTaskId, userOwnedTaskId, assigneeOwnedTaskId, parentLinkedTaskId, hiddenTaskId] =
      created.map(appliedTaskId);
    await db
      .updateTable("tasks")
      .set({ created_by_user_id: OTHER_USER_ID, assignee_entity_id: OTHER_ASSIGNEE_ID })
      .where("id", "in", [sourceTaskId, assigneeOwnedTaskId, parentLinkedTaskId, hiddenTaskId])
      .execute();
    await db
      .updateTable("tasks")
      .set({ assignee_entity_id: ASSIGNEE_ID })
      .where("id", "=", assigneeOwnedTaskId)
      .execute();
    await db.updateTable("tasks").set({ parent_entity_id: PROJECT_ID }).where("id", "=", parentLinkedTaskId).execute();
    await db.updateTable("tasks").set({ parent_entity_id: OTHER_PROJECT_ID }).where("id", "=", hiddenTaskId).execute();

    const memory = await repo.loadTaskMemory({
      userId: USER_ID,
      conversationIds: [sourceConversation],
      assigneeEntityIds: [ASSIGNEE_ID],
      parentEntityIds: [PROJECT_ID],
      limit: 10,
    });
    const bounded = await repo.loadTaskMemory({
      userId: USER_ID,
      conversationIds: [sourceConversation],
      assigneeEntityIds: [ASSIGNEE_ID],
      parentEntityIds: [PROJECT_ID],
      limit: 2,
    });

    expect(memory.map((task) => task.taskId).sort()).toEqual(
      [sourceTaskId, userOwnedTaskId, assigneeOwnedTaskId, parentLinkedTaskId].sort(),
    );
    expect(memory.map((task) => task.taskId)).not.toContain(hiddenTaskId);
    expect(bounded).toHaveLength(2);
    expect(bounded.every((task) => memory.some((visible) => visible.taskId === task.taskId))).toBe(true);

    const updateMessage = await seedMessage(db, otherConversation, { providerMessageId: "memory-assignee-update" });
    const [updated] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      authorizedAssigneeEntityIds: [ASSIGNEE_ID],
      allowedMessageIds: [updateMessage],
      allowedConversationIds: [otherConversation],
      changes: [changedChange(assigneeOwnedTaskId, [updateMessage], { title: "Assignee maintained" })],
      now: NOW,
    });
    expect(updated).toMatchObject({ status: "applied", kind: "changed", taskId: assigneeOwnedTaskId });
  });

  it("rejects IDs outside exact memory, cross-platform matches, and unrelated thread matches without side effects", async () => {
    const slack = await seedConversation(db, "slack", "channel", "C-guard");
    const whatsapp = await seedConversation(db, "whatsapp", "group", "group-guard");
    const slackMessage = await seedMessage(db, slack, {
      providerMessageId: "30.1",
      providerThreadId: "30.0",
      isThreadReply: true,
    });
    const unrelatedThread = await seedMessage(db, slack, {
      providerMessageId: "31.1",
      providerThreadId: "31.0",
      isThreadReply: true,
    });
    const whatsappMessage = await seedMessage(db, whatsapp, { providerMessageId: "wamid.guard" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [slackMessage],
      allowedConversationIds: [slack],
      changes: [newChange("Guarded task", [slackMessage])],
      now: NOW,
    });
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [slack] });
    const taskId = appliedTaskId(created);

    const results = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [unrelatedThread, whatsappMessage],
      allowedConversationIds: [slack, whatsapp],
      changes: [
        changedChange("made-up-id", [unrelatedThread], { title: "Must not apply" }),
        changedChange(taskId, [whatsappMessage], { title: "Must not cross platforms" }),
        changedChange(taskId, [unrelatedThread], { title: "Must not cross threads" }),
      ],
      now: NOW,
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "rejected", reason: "task_not_in_memory" }),
      expect.objectContaining({ status: "rejected", reason: "match_outside_scope" }),
      expect.objectContaining({ status: "rejected", reason: "match_outside_scope" }),
    ]);
    const task = await db.selectFrom("tasks").selectAll().where("id", "=", taskId).executeTakeFirstOrThrow();
    expect(task.title).toBe("Guarded task");
    const evidence = await db
      .selectFrom("task_message_evidence")
      .select("conversation_message_id")
      .where("task_id", "=", taskId)
      .execute();
    expect(evidence.map((row) => row.conversation_message_id)).toEqual([slackMessage]);
  });

  it("allows same-parent ownership-compatible widening and applies safe metadata without changing status", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-widen");
    const first = await seedMessage(db, conversationId, {
      providerMessageId: "40.1",
      providerThreadId: "40.0",
      isThreadReply: true,
    });
    const second = await seedMessage(db, conversationId, {
      providerMessageId: "41.1",
      providerThreadId: "41.0",
      isThreadReply: true,
    });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [first],
      allowedConversationIds: [conversationId],
      changes: [
        newChange("Draft partner update", [first], {
          parentEntityId: PROJECT_ID,
          assigneeName: "External Ashish",
        }),
      ],
      now: NOW,
    });
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });

    const [changed] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [second],
      allowedConversationIds: [conversationId],
      changes: [
        changedChange(appliedTaskId(created), [second], {
          title: "Draft final partner update",
          priority: "high",
          parentEntityId: PROJECT_ID,
          proposedAssigneeName: "External Ashish",
        }),
      ],
      now: NOW,
    });

    expect(changed).toMatchObject({ status: "applied", kind: "changed" });
    const task = await db
      .selectFrom("tasks")
      .select(["title", "priority", "status"])
      .where("id", "=", appliedTaskId(created))
      .executeTakeFirstOrThrow();
    expect(task).toEqual({ title: "Draft final partner update", priority: "high", status: "open" });
  });

  it("accepts metadata-free same-anchor matches but rejects conflicting parent or owner metadata", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-same-anchor-guard");
    const original = await seedMessage(db, conversationId, { providerMessageId: "same-anchor-original" });
    const metadataFree = await seedMessage(db, conversationId, { providerMessageId: "same-anchor-empty" });
    const parentConflict = await seedMessage(db, conversationId, { providerMessageId: "same-anchor-parent" });
    const assigneeConflict = await seedMessage(db, conversationId, {
      providerMessageId: "same-anchor-assignee",
    });
    const proposedOwnerConflict = await seedMessage(db, conversationId, {
      providerMessageId: "same-anchor-proposed-owner",
    });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [original],
      allowedConversationIds: [conversationId],
      changes: [newChange("Guard exact anchor metadata", [original])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    await db
      .updateTable("tasks")
      .set({
        parent_entity_id: PROJECT_ID,
        assignee_entity_id: ASSIGNEE_ID,
        assignee_name: "Follow-up User",
      })
      .where("id", "=", taskId)
      .execute();
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });

    const results = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [metadataFree, parentConflict, assigneeConflict, proposedOwnerConflict],
      allowedConversationIds: [conversationId],
      changes: [
        changedChange(taskId, [metadataFree], {}),
        changedChange(taskId, [parentConflict], { parentEntityId: OTHER_PROJECT_ID }),
        changedChange(taskId, [assigneeConflict], { assigneeEntityId: OTHER_ASSIGNEE_ID }),
        changedChange(taskId, [proposedOwnerConflict], { proposedAssigneeName: "Different external owner" }),
      ],
      now: NOW,
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "applied", kind: "changed", taskId }),
      expect.objectContaining({ status: "rejected", reason: "match_outside_scope" }),
      expect.objectContaining({ status: "rejected", reason: "match_outside_scope" }),
      expect.objectContaining({ status: "rejected", reason: "match_outside_scope" }),
    ]);
    await expect(
      db
        .selectFrom("task_message_evidence")
        .select("conversation_message_id")
        .where("task_id", "=", taskId)
        .orderBy("conversation_message_id")
        .execute(),
    ).resolves.toEqual([{ conversation_message_id: original }, { conversation_message_id: metadataFree }]);
    await expect(
      db
        .selectFrom("tasks")
        .select(["parent_entity_id", "assignee_entity_id", "assignee_name", "proposed_assignee_name"])
        .where("id", "=", taskId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      parent_entity_id: PROJECT_ID,
      assignee_entity_id: ASSIGNEE_ID,
      assignee_name: "Follow-up User",
      proposed_assignee_name: null,
    });
  });

  it("replays exact evidence to the same open task despite a paraphrased title", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-open-exact-replay");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "open-exact-replay" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [
        newChange("Prepare the launch brief", [messageId], {
          parentEntityId: PROJECT_ID,
          assigneeEntityId: ASSIGNEE_ID,
        }),
      ],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    await assignTask(db, taskId);

    const [replayed] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [
        newChange("Finish drafting the launch brief", [messageId], {
          parentEntityId: PROJECT_ID,
          assigneeEntityId: ASSIGNEE_ID,
        }),
      ],
      now: "2026-07-16T10:05:00.000Z",
    });

    expect(replayed).toMatchObject({ status: "applied", kind: "new", taskId });
    await expect(db.selectFrom("tasks").select("id").execute()).resolves.toHaveLength(1);
  });

  it("keeps distinct unowned tasks extracted from the same message separate", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-shared-evidence");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "shared-evidence" });
    const results = await createConversationFollowupsRepository(db).applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Send the revised proposal", [messageId]), newChange("Book the launch review", [messageId])],
      now: NOW,
    });

    expect(results.map(appliedTaskId)).toHaveLength(2);
    expect(new Set(results.map(appliedTaskId))).toHaveLength(2);
    await expect(db.selectFrom("tasks").select("title").orderBy("title").execute()).resolves.toEqual([
      { title: "Book the launch review" },
      { title: "Send the revised proposal" },
    ]);
  });

  it("does not replay terminal exact evidence across incompatible task identity metadata", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "group", "group-terminal-identity");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "terminal-identity" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Send the project update", [messageId], { parentEntityId: PROJECT_ID })],
      now: NOW,
    });
    const originalTaskId = appliedTaskId(created);
    await db
      .updateTable("tasks")
      .set({ status: "done", status_raw: "done", completed_at: "2026-07-16T10:01:00.000Z" })
      .where("id", "=", originalTaskId)
      .execute();

    const [replayed] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Send the project update", [messageId], { parentEntityId: OTHER_PROJECT_ID })],
      now: "2026-07-16T10:05:00.000Z",
    });
    const replayedTaskId = appliedTaskId(replayed);

    expect(replayedTaskId).not.toBe(originalTaskId);
    await expect(
      db
        .selectFrom("tasks")
        .select(["id", "parent_entity_id"])
        .where("id", "=", replayedTaskId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ id: replayedTaskId, parent_entity_id: OTHER_PROJECT_ID });
  });

  it("replays exact evidence for a non-creator task through authorized assignee scope", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-assignee-exact-replay");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "assignee-exact-replay" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: OTHER_USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [
        newChange("Prepare assigned launch notes", [messageId], {
          parentEntityId: PROJECT_ID,
          assigneeEntityId: ASSIGNEE_ID,
        }),
      ],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    await assignTask(db, taskId);

    const [replayed] = await repo.applyTaskChanges({
      userId: USER_ID,
      authorizedAssigneeEntityIds: [ASSIGNEE_ID],
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [
        newChange("Finish the assigned launch notes", [messageId], {
          parentEntityId: PROJECT_ID,
          assigneeEntityId: ASSIGNEE_ID,
        }),
      ],
      now: "2026-07-16T10:05:00.000Z",
    });

    expect(replayed).toMatchObject({ status: "applied", kind: "new", taskId });
    await expect(db.selectFrom("tasks").select("id").execute()).resolves.toHaveLength(1);
  });

  it("creates a genuine recurrence when a terminal task receives new evidence", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-new-evidence-recurrence");
    const originalMessage = await seedMessage(db, conversationId, { providerMessageId: "recurrence-original" });
    const recurrenceMessage = await seedMessage(db, conversationId, { providerMessageId: "recurrence-new" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [originalMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("Send the weekly update", [originalMessage], { parentEntityId: PROJECT_ID })],
      now: NOW,
    });
    const originalTaskId = appliedTaskId(created);
    await db
      .updateTable("tasks")
      .set({ status: "done", status_raw: "done", completed_at: "2026-07-16T10:01:00.000Z" })
      .where("id", "=", originalTaskId)
      .execute();

    const [recurrence] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [recurrenceMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("Send the weekly update", [recurrenceMessage], { parentEntityId: PROJECT_ID })],
      now: "2026-07-16T10:05:00.000Z",
    });

    expect(appliedTaskId(recurrence)).not.toBe(originalTaskId);
    await expect(db.selectFrom("tasks").select("id").execute()).resolves.toHaveLength(2);
  });

  it("rejects stale changed and resolved verdicts after the remembered task becomes terminal", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-stale-terminal");
    const originalMessage = await seedMessage(db, conversationId, { providerMessageId: "stale-terminal-original" });
    const changedMessage = await seedMessage(db, conversationId, { providerMessageId: "stale-terminal-changed" });
    const resolvedMessage = await seedMessage(db, conversationId, { providerMessageId: "stale-terminal-resolved" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [originalMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("Prepare the rollout note", [originalMessage])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    await db
      .updateTable("tasks")
      .set({
        status: "done",
        status_raw: "done",
        completed_at: "2026-07-16T10:01:00.000Z",
      })
      .where("id", "=", taskId)
      .execute();

    const results = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [changedMessage, resolvedMessage],
      allowedConversationIds: [conversationId],
      changes: [
        changedChange(taskId, [changedMessage], { title: "Mutated after completion" }),
        resolvedChange(taskId, [resolvedMessage], "Already completed."),
      ],
      now: "2026-07-16T10:05:00.000Z",
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "rejected", kind: "changed", reason: "task_not_editable" }),
      expect.objectContaining({ status: "rejected", kind: "resolved", reason: "task_not_editable" }),
    ]);
    await expect(
      db.selectFrom("task_message_evidence").select("conversation_message_id").where("task_id", "=", taskId).execute(),
    ).resolves.toEqual([{ conversation_message_id: originalMessage }]);
    await expect(db.selectFrom("task_completion_recommendations").selectAll().execute()).resolves.toEqual([]);
    await expect(
      db.selectFrom("tasks").select(["title", "status"]).where("id", "=", taskId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ title: "Prepare the rollout note", status: "done" });
  });

  it("rolls back stale summarizer mutations when task authorization changes during evidence application", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-stale-authorization");
    const originalMessage = await seedMessage(db, conversationId, { providerMessageId: "stale-auth-original" });
    const changedMessage = await seedMessage(db, conversationId, { providerMessageId: "stale-auth-changed" });
    const resolvedMessage = await seedMessage(db, conversationId, { providerMessageId: "stale-auth-resolved" });
    const repo = createConversationFollowupsRepository(db);
    const created = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [originalMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("Authorization race", [originalMessage])],
      now: NOW,
    });
    const taskId = appliedTaskId(created[0]);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    await sql`
      CREATE TRIGGER revoke_task_access_during_evidence
      AFTER INSERT ON task_message_evidence
      BEGIN
        UPDATE tasks
        SET created_by_user_id = 'user-other',
            assignee_entity_id = 'person-other'
        WHERE id = NEW.task_id;
      END
    `.execute(db);

    const [changed] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [changedMessage],
      allowedConversationIds: [conversationId],
      changes: [
        {
          kind: "changed",
          taskId,
          evidenceMessageIds: [changedMessage],
          metadata: { title: "Unauthorized changed title" },
        },
      ],
      now: "2026-07-16T10:05:00.000Z",
    });
    const [resolved] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [resolvedMessage],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [resolvedMessage], "Unauthorized resolution")],
      now: "2026-07-16T10:06:00.000Z",
    });

    expect(changed).toEqual({ status: "rejected", kind: "changed", reason: "task_not_editable" });
    expect(resolved).toEqual({ status: "rejected", kind: "resolved", reason: "task_not_editable" });
    await expect(
      db.selectFrom("tasks").select(["title", "created_by_user_id"]).where("id", "=", taskId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ title: "Authorization race", created_by_user_id: USER_ID });
    await expect(
      db
        .selectFrom("task_message_evidence")
        .select("conversation_message_id")
        .where("task_id", "=", taskId)
        .orderBy("conversation_message_id")
        .execute(),
    ).resolves.toEqual([{ conversation_message_id: originalMessage }]);
    await expect(
      db.selectFrom("task_completion_recommendations").select("id").where("task_id", "=", taskId).execute(),
    ).resolves.toEqual([]);
  });

  it("rejects task mutations from an in-flight run after its route source changes", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-stale-route");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "stale-route-message" });
    await db
      .insertInto("task_durability_route_state")
      .values({
        agent_key: "conversation_summary",
        user_id: USER_ID,
        route_id: "route-stale",
        source_key: "slack:channel:C_NEW",
        mode: "hybrid",
        seed_state: "reviewed",
        seed_started_at: NOW,
        seed_reviewed_at: NOW,
        incremental_success_at: null,
        last_error: null,
      })
      .execute();

    const [result] = await createConversationFollowupsRepository(db).applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Must not survive a route change", [messageId])],
      routeGuard: {
        agentKey: "conversation_summary",
        routeId: "route-stale",
        sourceKey: "slack:channel:C_OLD",
      },
      now: NOW,
    });

    expect(result).toEqual({ status: "rejected", kind: "new", reason: "route_source_changed" });
    await expect(db.selectFrom("tasks").select("id").execute()).resolves.toEqual([]);
  });

  it("allows same-parent ownership-compatible widening for an explicit resolution", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-resolve-widen");
    const rootMessage = await seedMessage(db, conversationId, {
      providerMessageId: "45.0",
      providerThreadId: "45.0",
      isThreadReply: false,
    });
    const completionReply = await seedMessage(db, conversationId, {
      providerMessageId: "45.1",
      providerThreadId: "45.0",
      isThreadReply: true,
    });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [rootMessage],
      allowedConversationIds: [conversationId],
      changes: [
        newChange("Draft partner update", [rootMessage], {
          parentEntityId: PROJECT_ID,
          assigneeEntityId: ASSIGNEE_ID,
          assigneeName: "Follow-up User",
        }),
      ],
      now: NOW,
    });
    await assignTask(db, appliedTaskId(created));
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });

    const [resolved] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [completionReply],
      allowedConversationIds: [conversationId],
      changes: [
        resolvedChange(appliedTaskId(created), [completionReply], "The owner explicitly confirmed completion.", {
          parentEntityId: PROJECT_ID,
          assigneeEntityId: ASSIGNEE_ID,
        }),
      ],
      now: NOW,
    });

    expect(resolved).toMatchObject({
      status: "applied",
      kind: "resolved",
      taskId: appliedTaskId(created),
      recommendation: { state: "pending" },
    });
  });

  it("clarifies and resolves a Slack root task from ordinary thread replies using only task ID and evidence", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-root-thread-resolution");
    const rootMessage = await seedMessage(db, conversationId, {
      providerMessageId: "46.0",
      providerThreadId: "46.0",
      isThreadReply: false,
    });
    const clarificationReply = await seedMessage(db, conversationId, {
      providerMessageId: "46.1",
      providerThreadId: "46.0",
      isThreadReply: true,
    });
    const completionReply = await seedMessage(db, conversationId, {
      providerMessageId: "46.2",
      providerThreadId: "46.0",
      isThreadReply: true,
    });
    const conflictingReply = await seedMessage(db, conversationId, {
      providerMessageId: "46.3",
      providerThreadId: "46.0",
      isThreadReply: true,
    });
    const unrelatedReply = await seedMessage(db, conversationId, {
      providerMessageId: "47.1",
      providerThreadId: "47.0",
      isThreadReply: true,
    });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [rootMessage],
      allowedConversationIds: [conversationId],
      changes: [
        newChange("Resolve from Slack thread", [rootMessage], {
          assigneeEntityId: ASSIGNEE_ID,
          assigneeName: "Follow-up User",
        }),
      ],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    await assignTask(db, taskId);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });

    const [clarified] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [clarificationReply],
      allowedConversationIds: [conversationId],
      changes: [changedChange(taskId, [clarificationReply], { title: "Clarified from Slack thread" })],
      now: NOW,
    });
    const [unrelated] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [unrelatedReply],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [unrelatedReply], "An unrelated thread reported completion.")],
      now: NOW,
    });
    const [conflicting] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [conflictingReply],
      allowedConversationIds: [conversationId],
      changes: [changedChange(taskId, [conflictingReply], { assigneeEntityId: OTHER_ASSIGNEE_ID })],
      now: NOW,
    });
    const [resolved] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [completionReply],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [completionReply], "The task's thread reported completion.")],
      now: NOW,
    });

    expect(clarified).toMatchObject({ status: "applied", kind: "changed", taskId });
    expect(unrelated).toMatchObject({ status: "rejected", reason: "match_outside_scope" });
    expect(conflicting).toMatchObject({ status: "rejected", reason: "match_outside_scope" });
    await expect(
      db.selectFrom("tasks").select("title").where("id", "=", taskId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      title: "Clarified from Slack thread",
    });
    expect(resolved).toMatchObject({
      status: "applied",
      kind: "resolved",
      taskId,
      recommendation: { state: "pending" },
    });
  });

  it("stores task evidence idempotently and creates one fingerprinted recommendation even after rejection", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-resolution");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "50.0" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Resolve customer issue", [messageId])],
      now: NOW,
    });
    await assignTask(db, appliedTaskId(created));
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const resolution = resolvedChange(appliedTaskId(created), [messageId], "Ashish reported that this is fixed.");

    const [first] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [resolution],
      now: NOW,
    });
    const code = appliedRecommendationCode(first);
    await expect(
      repo.reviewRecommendation({
        code,
        action: "keep_open",
        userId: USER_ID,
        assigneeEntityIds: [ASSIGNEE_ID],
        surface: "slack",
        now: "2026-07-16T11:00:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "kept_open" });
    const [second] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [resolution],
      now: "2026-07-16T12:00:00.000Z",
    });

    expect(second).toMatchObject({
      status: "applied",
      kind: "resolved",
      recommendation: { created: false, state: "rejected", code },
    });
    expect(
      await db
        .selectFrom("task_completion_recommendations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .selectFrom("task_message_evidence")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 1 });
  });

  it("rejects invalid entity metadata without attaching partial evidence", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-invalid-metadata");
    const originalMessage = await seedMessage(db, conversationId, { providerMessageId: "invalid-metadata-1" });
    const updateMessage = await seedMessage(db, conversationId, { providerMessageId: "invalid-metadata-2" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [originalMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("Validate metadata", [originalMessage])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });

    const [result] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [updateMessage],
      allowedConversationIds: [conversationId],
      changes: [changedChange(taskId, [updateMessage], { assigneeEntityId: "missing-person" })],
      now: NOW,
    });

    expect(result).toMatchObject({ status: "rejected" });
    await expect(
      db
        .selectFrom("task_message_evidence")
        .select("conversation_message_id")
        .where("task_id", "=", taskId)
        .orderBy("conversation_message_id")
        .execute(),
    ).resolves.toEqual([{ conversation_message_id: originalMessage }]);
  });

  it("keeps only one pending completion recommendation when newer evidence arrives", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "group", "group-one-recommendation");
    const originalMessage = await seedMessage(db, conversationId, { providerMessageId: "wamid.original" });
    const firstCompletion = await seedMessage(db, conversationId, { providerMessageId: "wamid.complete-1" });
    const secondCompletion = await seedMessage(db, conversationId, { providerMessageId: "wamid.complete-2" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [originalMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("One recommendation", [originalMessage])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    await assignTask(db, taskId);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });

    const [firstRecommendation] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [firstCompletion],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [firstCompletion], "First completion signal.")],
      now: NOW,
    });
    const firstRecommendationId = appliedRecommendationId(firstRecommendation);
    const firstRecommendationCode = appliedRecommendationCode(firstRecommendation);
    const [deliveryId] = await seedDeliveries(db, 1);
    await repo.recordRecommendationDelivery({
      recommendationId: firstRecommendationId,
      agentOutputDeliveryId: deliveryId,
    });
    const firstExpiry = (
      await db
        .selectFrom("task_completion_recommendations")
        .select("expires_at")
        .where("id", "=", firstRecommendationId)
        .executeTakeFirstOrThrow()
    ).expires_at;
    const [secondRecommendation] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [secondCompletion],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [secondCompletion], "Newer completion signal.")],
      now: "2026-07-16T10:05:00.000Z",
    });

    const recommendations = await db
      .selectFrom("task_completion_recommendations")
      .select(["id", "review_code", "review_state", "delivery_count", "expires_at"])
      .where("task_id", "=", taskId)
      .orderBy("created_at")
      .execute();
    expect(secondRecommendation).toMatchObject({
      status: "applied",
      kind: "resolved",
      recommendation: { id: firstRecommendationId, code: firstRecommendationCode, created: false },
    });
    expect(recommendations).toEqual([
      expect.objectContaining({
        id: firstRecommendationId,
        review_code: firstRecommendationCode,
        review_state: "pending",
        delivery_count: 1,
        expires_at: firstExpiry,
      }),
    ]);
    await expect(
      db
        .selectFrom("task_completion_recommendation_evidence")
        .select("conversation_message_id")
        .where("recommendation_id", "=", firstRecommendationId)
        .orderBy("conversation_message_id")
        .execute(),
    ).resolves.toEqual([{ conversation_message_id: firstCompletion }, { conversation_message_id: secondCompletion }]);
  });

  it("recovers a concurrent pending-recommendation collision by reusing the winner and preserving evidence", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "group", "group-recommendation-race");
    const originalMessage = await seedMessage(db, conversationId, { providerMessageId: "wamid.race-original" });
    const concurrentMessage = await seedMessage(db, conversationId, { providerMessageId: "wamid.race-concurrent" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [originalMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("Recommendation race", [originalMessage])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const [winner] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [originalMessage],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [originalMessage], "First completion signal.")],
      now: NOW,
    });
    const winnerId = appliedRecommendationId(winner);

    await sql`
      CREATE TRIGGER force_pending_recommendation_collision
      BEFORE INSERT ON task_completion_recommendations
      WHEN NEW.review_code <> 'RACER001'
      BEGIN
        INSERT INTO task_completion_recommendations (
          id,
          task_id,
          proposed_status,
          review_state,
          review_code,
          evidence_fingerprint,
          origin_agent_output_id,
          rationale,
          delivery_count,
          expires_at,
          created_at,
          updated_at
        )
        VALUES (
          'racer-recommendation',
          NEW.task_id,
          NEW.proposed_status,
          'pending',
          'RACER001',
          'racer-fingerprint',
          NULL,
          'Concurrent recommendation',
          0,
          NEW.expires_at,
          NEW.created_at,
          NEW.updated_at
        );
      END
    `.execute(db);

    const [recovered] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [concurrentMessage],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [concurrentMessage], "Concurrent completion signal.")],
      now: "2026-07-16T10:05:00.000Z",
    });

    expect(recovered).toMatchObject({
      status: "applied",
      kind: "resolved",
      taskId,
      recommendation: { id: winnerId, created: false, state: "pending" },
    });
    await expect(
      db
        .selectFrom("task_message_evidence")
        .select("conversation_message_id")
        .where("task_id", "=", taskId)
        .orderBy("conversation_message_id")
        .execute(),
    ).resolves.toEqual([{ conversation_message_id: originalMessage }, { conversation_message_id: concurrentMessage }]);
    await expect(
      db
        .selectFrom("task_completion_recommendation_evidence")
        .select("conversation_message_id")
        .where("recommendation_id", "=", winnerId)
        .orderBy("conversation_message_id")
        .execute(),
    ).resolves.toEqual([{ conversation_message_id: originalMessage }, { conversation_message_id: concurrentMessage }]);

    await sql`DROP TRIGGER force_pending_recommendation_collision`.execute(db);
    const replayRepo = createConversationFollowupsRepository(db);
    const [replayed] = await replayRepo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [concurrentMessage],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [concurrentMessage], "Concurrent completion signal replay.")],
      now: "2026-07-16T10:10:00.000Z",
    });

    expect(replayed).toMatchObject({
      status: "applied",
      kind: "resolved",
      taskId,
      recommendation: { id: winnerId, created: false, state: "pending" },
    });
    await expect(
      db
        .selectFrom("task_completion_recommendations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("task_id", "=", taskId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 });
  });

  it("keeps pending tasks and looks-resolved recommendations mutually exclusive and suppresses tracked legacy titles", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "group", "group-reminders");
    const pendingMessage = await seedMessage(db, conversationId, { providerMessageId: "wamid.pending" });
    const resolvedMessage = await seedMessage(db, conversationId, { providerMessageId: "wamid.resolved" });
    const repo = createConversationFollowupsRepository(db);
    const created = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [pendingMessage, resolvedMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("Pending task", [pendingMessage]), newChange("Looks fixed", [resolvedMessage])],
      now: NOW,
    });
    const [pendingTaskId, resolvedTaskId] = created.map(appliedTaskId);
    await assignTask(db, pendingTaskId);
    await assignTask(db, resolvedTaskId);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [resolvedMessage],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(resolvedTaskId, [resolvedMessage], "The customer confirmed the fix.")],
      now: NOW,
    });

    const reminders = await repo.queryPersonalReminders({
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      legacyCandidates: [{ title: " pending TASK " }, { title: "Looks fixed" }, { title: "Legacy-only follow-up" }],
      now: "2026-07-16T12:00:00.000Z",
    });

    expect(reminders).toMatchObject({
      status: "ok",
      pending: [{ taskId: pendingTaskId, title: "Pending task" }],
      looksResolved: [{ taskId: resolvedTaskId, title: "Looks fixed" }],
      untracked: [{ title: "Legacy-only follow-up" }],
    });
    if (reminders.status === "ok") {
      expect(reminders.pending.map((item) => item.taskId)).not.toContain(resolvedTaskId);
    }
  });

  it("suppresses legacy duplicates only within the durable task's source scope", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "group", "group-source-aware");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "wamid.source-aware" });
    await db
      .insertInto("agent_outputs")
      .values({
        id: "source-aware-output",
        agent_key: "conversation_summary",
        user_id: USER_ID,
        output_date: "2026-07-16",
        source_key: "whatsapp:group:group-source-aware",
        source_label: "Source aware",
        timezone: "UTC",
        status: "completed",
        trigger_type: "manual",
        agent_version: "test",
      })
      .execute();
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      outputId: "source-aware-output",
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Send revised proposal", [messageId])],
      now: NOW,
    });
    await assignTask(db, appliedTaskId(created));

    const reminders = await repo.queryPersonalReminders({
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      legacyCandidates: [
        { title: "Send revised proposal", sourceKey: "whatsapp:group:group-source-aware" },
        { title: "Send revised proposal", sourceKey: "slack:channel:C_UNRELATED" },
      ],
      now: NOW,
    });

    expect(reminders.status).toBe("ok");
    if (reminders.status === "ok") {
      expect(reminders.untracked).toEqual([{ title: "Send revised proposal", sourceKey: "slack:channel:C_UNRELATED" }]);
    }
  });

  it("scopes route-based legacy suppression to the durable task source anchor", async () => {
    const firstConversation = await seedConversation(db, "slack", "channel", "C-route-anchor-first");
    const secondConversation = await seedConversation(db, "slack", "channel", "C-route-anchor-second");
    const firstMessage = await seedMessage(db, firstConversation, { providerMessageId: "route-anchor-first" });
    const secondMessage = await seedMessage(db, secondConversation, { providerMessageId: "route-anchor-second" });
    await db
      .insertInto("agent_outputs")
      .values({
        id: "combined-route-output",
        agent_key: "conversation_summary",
        user_id: USER_ID,
        output_date: "2026-07-16",
        source_key: "route:combined-hash",
        source_label: "Combined route",
        timezone: "UTC",
        status: "completed",
        trigger_type: "manual",
        agent_version: "test",
      })
      .execute();
    const repo = createConversationFollowupsRepository(db);
    const created = await repo.applyTaskChanges({
      userId: USER_ID,
      outputId: "combined-route-output",
      taskMemory: [],
      allowedMessageIds: [firstMessage, secondMessage],
      allowedConversationIds: [firstConversation, secondConversation],
      changes: [
        newChange("Follow up on combined route", [firstMessage]),
        newChange("Follow up on combined route", [secondMessage]),
      ],
      now: NOW,
    });
    for (const result of created) await assignTask(db, appliedTaskId(result));
    const firstAnchor = `slack:${firstConversation}:root`;
    const secondAnchor = `slack:${secondConversation}:root`;

    const reminders = await repo.queryPersonalReminders({
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      legacyCandidates: [
        {
          title: "Follow up on combined route",
          sourceKey: "slack:channel:C-route-anchor-first",
          sourceAnchorKey: firstAnchor,
        },
        { title: "Follow up on combined route", sourceKey: "route:new-topology-hash", sourceAnchorKey: firstAnchor },
        { title: "Follow up on combined route", sourceKey: "route:combined-hash", sourceAnchorKey: secondAnchor },
        {
          title: "Follow up on combined route",
          sourceKey: "route:combined-hash",
          sourceAnchorKey: "slack:999999:root",
        },
      ],
      now: NOW,
    });

    expect(reminders.status).toBe("ok");
    if (reminders.status === "ok") {
      expect(reminders.untracked).toEqual([
        {
          title: "Follow up on combined route",
          sourceKey: "route:combined-hash",
          sourceAnchorKey: "slack:999999:root",
        },
      ]);
    }
  });

  it("filters personal reminders to active Summarizer route source keys", async () => {
    const activeConversation = await seedConversation(db, "slack", "channel", "C-active-reminder");
    const disabledConversation = await seedConversation(db, "slack", "channel", "C-disabled-reminder");
    const activeMessage = await seedMessage(db, activeConversation, { providerMessageId: "active-reminder" });
    const disabledMessage = await seedMessage(db, disabledConversation, { providerMessageId: "disabled-reminder" });
    await db
      .insertInto("agent_outputs")
      .values([
        {
          id: "active-reminder-output",
          agent_key: "conversation_summary",
          user_id: USER_ID,
          output_date: "2026-07-16",
          source_key: "slack:channel:C-active-reminder",
          source_label: "Active",
          timezone: "UTC",
          status: "completed",
          trigger_type: "manual",
          agent_version: "test",
        },
        {
          id: "disabled-reminder-output",
          agent_key: "conversation_summary",
          user_id: USER_ID,
          output_date: "2026-07-16",
          source_key: "slack:channel:C-disabled-reminder",
          source_label: "Disabled",
          timezone: "UTC",
          status: "completed",
          trigger_type: "manual",
          agent_version: "test",
        },
      ])
      .execute();
    const repo = createConversationFollowupsRepository(db);
    const created = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [activeMessage, disabledMessage],
      allowedConversationIds: [activeConversation, disabledConversation],
      changes: [newChange("Active route task", [activeMessage]), newChange("Disabled route task", [disabledMessage])],
      now: NOW,
    });
    await db
      .updateTable("tasks")
      .set({ assignee_entity_id: ASSIGNEE_ID, assignee_name: "Follow-up User" })
      .where("id", "in", created.map(appliedTaskId))
      .execute();
    await db
      .updateTable("tasks")
      .set({ origin_agent_output_id: "active-reminder-output" })
      .where("id", "=", appliedTaskId(created[0]))
      .execute();
    await db
      .updateTable("tasks")
      .set({ origin_agent_output_id: "disabled-reminder-output" })
      .where("id", "=", appliedTaskId(created[1]))
      .execute();

    const reminders = await repo.queryPersonalReminders({
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      activeSourceKeys: ["slack:channel:C-active-reminder"],
      now: NOW,
    });

    expect(reminders).toMatchObject({
      status: "ok",
      pending: [{ title: "Active route task" }],
    });
  });

  it("keeps ownerless tasks assigned to the current user outside active route sources", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-ownerless-assigned");
    await db
      .insertInto("tasks")
      .values({
        ...summaryTaskRow({
          id: "ownerless-assigned-task",
          title: "Ownerless assigned follow-up",
          status: "open",
          conversationId,
          originOutputId: null,
        }),
        created_by_user_id: null,
      })
      .execute();

    const reminders = await createConversationFollowupsRepository(db).queryPersonalReminders({
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      activeSourceKeys: ["slack:channel:C-different-active-route"],
      now: NOW,
    });

    expect(reminders).toMatchObject({
      status: "ok",
      pending: [{ taskId: "ownerless-assigned-task", title: "Ownerless assigned follow-up" }],
    });
  });

  it("returns bounded reminder collections with an explicit overflow signal", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-reminder-limits");
    await db
      .insertInto("agent_outputs")
      .values({
        id: "reminder-limit-output",
        agent_key: "conversation_summary",
        user_id: USER_ID,
        output_date: "2026-07-16",
        source_key: "slack:channel:C-reminder-limits",
        source_label: "Reminder limits",
        timezone: "UTC",
        status: "completed",
        trigger_type: "manual",
        agent_version: "test",
      })
      .execute();
    const pendingTasks = Array.from({ length: 51 }, (_, index) =>
      summaryTaskRow({
        id: `pending-limit-${index}`,
        title: `Pending limit ${index}`,
        status: "open",
        conversationId,
        originOutputId: "reminder-limit-output",
      }),
    );
    const proposedTasks = Array.from({ length: 26 }, (_, index) =>
      summaryTaskRow({
        id: `proposal-limit-${index}`,
        title: `Proposal limit ${index}`,
        status: "open",
        conversationId,
        originOutputId: "reminder-limit-output",
      }),
    );
    const suppressedTasks = Array.from({ length: 101 }, (_, index) =>
      summaryTaskRow({
        id: `suppressed-limit-${index}`,
        title: `Suppressed limit ${index}`,
        status: "done",
        conversationId,
        originOutputId: "reminder-limit-output",
      }),
    );
    await db
      .insertInto("tasks")
      .values([...pendingTasks, ...proposedTasks, ...suppressedTasks])
      .execute();
    await db
      .insertInto("task_completion_recommendations")
      .values(
        proposedTasks.map((task, index) => ({
          id: `recommendation-limit-${index}`,
          task_id: task.id,
          proposed_status: "done",
          review_state: "pending",
          review_code: `RL${String(index).padStart(4, "0")}`,
          evidence_fingerprint: `recommendation-limit-${index}`,
          origin_agent_output_id: "reminder-limit-output",
          rationale: "Completion was reported.",
          expires_at: "2099-01-01T00:00:00.000Z",
          reviewed_at: null,
          reviewed_by_user_id: null,
          review_surface: null,
        })),
      )
      .execute();

    const reminders = await createConversationFollowupsRepository(db).queryPersonalReminders({
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      activeSourceKeys: ["slack:channel:C-reminder-limits"],
      legacyCandidates: Array.from({ length: 26 }, (_, index) => ({
        title: `Legacy limit ${index}`,
        sourceKey: "slack:channel:C-reminder-limits",
      })),
      now: NOW,
    });

    expect(reminders).toMatchObject({
      status: "error",
      code: "reminder_query_overflow",
      pending: expect.any(Array),
      looksResolved: expect.any(Array),
      untracked: expect.any(Array),
      suppressedTitles: expect.any(Array),
    });
    if (reminders.status !== "error" || reminders.code !== "reminder_query_overflow") {
      throw new Error("Expected reminder query overflow");
    }
    expect(reminders.pending).toHaveLength(50);
    expect(reminders.looksResolved).toHaveLength(25);
    expect(reminders.untracked).toHaveLength(25);
    expect(reminders.suppressedTitles).toHaveLength(100);
  });

  it("caps legacy fallback items when durable reminder queries fail", async () => {
    await db.schema.dropTable("task_completion_recommendations").execute();

    const reminders = await createConversationFollowupsRepository(db).queryPersonalReminders({
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      legacyCandidates: Array.from({ length: 30 }, (_, index) => ({
        title: `Fallback ${index}`,
        sourceKey: "slack:channel:C-fallback",
      })),
      now: NOW,
    });

    expect(reminders).toMatchObject({
      status: "error",
      code: "durable_query_failed",
      untracked: expect.any(Array),
    });
    expect(reminders.untracked).toHaveLength(25);
  });

  it("returns only tasks assigned to the current user's person entities in personal reminders", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "group", "group-personal-reminders");
    const mineMessage = await seedMessage(db, conversationId, { providerMessageId: "wamid.mine" });
    const teammateMessage = await seedMessage(db, conversationId, { providerMessageId: "wamid.teammate" });
    const repo = createConversationFollowupsRepository(db);
    const created = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [mineMessage, teammateMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("My follow-up", [mineMessage]), newChange("Teammate follow-up", [teammateMessage])],
      now: NOW,
    });
    const [mineTaskId, teammateTaskId] = created.map(appliedTaskId);
    await assignTask(db, mineTaskId);
    await db
      .updateTable("tasks")
      .set({ assignee_entity_id: OTHER_ASSIGNEE_ID, assignee_name: "Other Teammate" })
      .where("id", "=", teammateTaskId)
      .execute();
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [mineMessage, teammateMessage],
      allowedConversationIds: [conversationId],
      changes: [
        resolvedChange(mineTaskId, [mineMessage], "Mine is complete."),
        resolvedChange(teammateTaskId, [teammateMessage], "The teammate's is complete."),
      ],
      now: NOW,
    });

    const reminders = await repo.queryPersonalReminders({
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      now: NOW,
    });

    expect(reminders.status).toBe("ok");
    if (reminders.status === "ok") {
      expect(reminders.pending).toEqual([]);
      expect(reminders.looksResolved.map((item) => item.taskId)).toEqual([mineTaskId]);
    }
  });

  it("confirms or keeps open with authorization and records actor, surface, and task status atomically", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-review");
    const firstMessage = await seedMessage(db, conversationId, { providerMessageId: "60.0" });
    const secondMessage = await seedMessage(db, conversationId, { providerMessageId: "61.0" });
    const repo = createConversationFollowupsRepository(db);
    const created = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [firstMessage, secondMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("Confirm me", [firstMessage]), newChange("Keep me", [secondMessage])],
      now: NOW,
    });
    const [confirmTaskId, keepTaskId] = created.map(appliedTaskId);
    await assignTask(db, confirmTaskId);
    await assignTask(db, keepTaskId);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const recommendations = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [firstMessage, secondMessage],
      allowedConversationIds: [conversationId],
      changes: [
        resolvedChange(confirmTaskId, [firstMessage], "Done"),
        resolvedChange(keepTaskId, [secondMessage], "Maybe done"),
      ],
      now: NOW,
    });
    const confirmCode = appliedRecommendationCode(recommendations[0]);
    const keepCode = appliedRecommendationCode(recommendations[1]);

    await expect(
      repo.reviewRecommendation({
        code: keepCode,
        action: "keep_open",
        userId: "different-user",
        assigneeEntityIds: [],
        surface: "whatsapp",
        now: "2026-07-16T11:00:00.000Z",
      }),
    ).resolves.toEqual({ status: "unauthorized" });
    await expect(
      repo.reviewRecommendation({
        code: confirmCode,
        action: "confirm_done",
        userId: USER_ID,
        assigneeEntityIds: [],
        surface: "slack",
        now: "2026-07-16T11:00:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "confirmed", taskId: confirmTaskId });
    await expect(
      repo.reviewRecommendation({
        code: keepCode,
        action: "keep_open",
        userId: USER_ID,
        assigneeEntityIds: [],
        surface: "whatsapp",
        now: "2026-07-16T11:05:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "kept_open", taskId: keepTaskId });
    await expect(
      repo.reviewRecommendation({
        code: confirmCode,
        action: "confirm_done",
        userId: USER_ID,
        assigneeEntityIds: [],
        surface: "slack",
        now: "2026-07-16T11:10:00.000Z",
      }),
    ).resolves.toEqual({ status: "stale" });

    const tasks = await db
      .selectFrom("tasks")
      .select(["id", "status"])
      .where("id", "in", [confirmTaskId, keepTaskId])
      .orderBy("id")
      .execute();
    expect(new Map(tasks.map((task) => [task.id, task.status]))).toEqual(
      new Map([
        [confirmTaskId, "done"],
        [keepTaskId, "open"],
      ]),
    );
    const reviewed = await db
      .selectFrom("task_completion_recommendations")
      .select(["review_state", "reviewed_by_user_id", "review_surface", "reviewed_at"])
      .where("review_code", "=", confirmCode)
      .executeTakeFirstOrThrow();
    expect(reviewed).toEqual({
      review_state: "accepted",
      reviewed_by_user_id: USER_ID,
      review_surface: "slack",
      reviewed_at: "2026-07-16T11:00:00.000Z",
    });
  });

  it("expires pending reviews without mutating tasks that became terminal before review", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-terminal-review");
    const confirmMessage = await seedMessage(db, conversationId, { providerMessageId: "terminal-confirm" });
    const keepMessage = await seedMessage(db, conversationId, { providerMessageId: "terminal-keep" });
    const repo = createConversationFollowupsRepository(db);
    const created = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [confirmMessage, keepMessage],
      allowedConversationIds: [conversationId],
      changes: [
        newChange("Terminal before confirmation", [confirmMessage]),
        newChange("Terminal before keep-open", [keepMessage]),
      ],
      now: NOW,
    });
    const [confirmTaskId, keepTaskId] = created.map(appliedTaskId);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const recommendations = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [confirmMessage, keepMessage],
      allowedConversationIds: [conversationId],
      changes: [
        resolvedChange(confirmTaskId, [confirmMessage], "Reported complete."),
        resolvedChange(keepTaskId, [keepMessage], "Possibly complete."),
      ],
      now: NOW,
    });
    const confirmCode = appliedRecommendationCode(recommendations[0]);
    const keepCode = appliedRecommendationCode(recommendations[1]);
    await db
      .updateTable("tasks")
      .set({ status: "dropped", status_raw: "dropped", status_changed_at: "2026-07-16T10:30:00.000Z" })
      .where("id", "=", confirmTaskId)
      .execute();
    await db
      .updateTable("tasks")
      .set({
        status: "done",
        status_raw: "done",
        status_changed_at: "2026-07-16T10:30:00.000Z",
        completed_at: "2026-07-16T10:30:00.000Z",
      })
      .where("id", "=", keepTaskId)
      .execute();

    await expect(
      repo.reviewRecommendation({
        code: confirmCode,
        action: "confirm_done",
        userId: USER_ID,
        assigneeEntityIds: [],
        surface: "slack",
        now: "2026-07-16T11:00:00.000Z",
      }),
    ).resolves.toEqual({ status: "stale" });
    await expect(
      repo.reviewRecommendation({
        code: keepCode,
        action: "keep_open",
        userId: USER_ID,
        assigneeEntityIds: [],
        surface: "slack",
        now: "2026-07-16T11:00:00.000Z",
      }),
    ).resolves.toEqual({ status: "stale" });
    await expect(
      db
        .selectFrom("tasks")
        .select(["id", "status"])
        .where("id", "in", [confirmTaskId, keepTaskId])
        .orderBy("id")
        .execute(),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: confirmTaskId, status: "dropped" },
        { id: keepTaskId, status: "done" },
      ]),
    );
    await expect(
      db
        .selectFrom("task_completion_recommendations")
        .select(["review_code", "review_state"])
        .where("review_code", "in", [confirmCode, keepCode])
        .execute(),
    ).resolves.toEqual(
      expect.arrayContaining([
        { review_code: confirmCode, review_state: "expired" },
        { review_code: keepCode, review_state: "expired" },
      ]),
    );
  });

  it("returns stale when keep-open review concurrently observes a terminalized task", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-keep-open-race");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "keep-open-race" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Keep-open race", [messageId])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const [resolved] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [messageId], "Reported complete.")],
      now: NOW,
    });
    await sql`
      CREATE TRIGGER terminalize_task_during_keep_open
      AFTER UPDATE OF review_state ON task_completion_recommendations
      WHEN NEW.review_state = 'rejected'
      BEGIN
        UPDATE tasks
        SET status = 'done',
            status_raw = 'done',
            completed_at = '2026-07-16T10:59:00.000Z'
        WHERE id = NEW.task_id;
      END
    `.execute(db);

    await expect(
      repo.reviewRecommendation({
        code: appliedRecommendationCode(resolved),
        action: "keep_open",
        userId: USER_ID,
        assigneeEntityIds: [],
        surface: "slack",
        now: "2026-07-16T11:00:00.000Z",
      }),
    ).resolves.toEqual({ status: "stale" });
    await expect(
      db
        .selectFrom("task_completion_recommendations")
        .select("review_state")
        .where("task_id", "=", taskId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ review_state: "expired" });
    await expect(
      db.selectFrom("tasks").select("status").where("id", "=", taskId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "done" });
  });

  it("does not let a former assignee review after authorization changes during the review transaction", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-review-authorization-race");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "review-authorization-race" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: OTHER_USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Review authorization race", [messageId])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    await db
      .updateTable("tasks")
      .set({ assignee_entity_id: ASSIGNEE_ID, assignee_name: "Current assignee" })
      .where("id", "=", taskId)
      .execute();
    const memory = await repo.loadTaskMemory({
      userId: OTHER_USER_ID,
      conversationIds: [conversationId],
      assigneeEntityIds: [ASSIGNEE_ID],
    });
    const [resolved] = await repo.applyTaskChanges({
      userId: OTHER_USER_ID,
      taskMemory: memory,
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [messageId], "Reported complete.")],
      now: NOW,
    });
    await sql`
      CREATE TRIGGER reassign_task_during_review
      AFTER UPDATE OF review_state ON task_completion_recommendations
      WHEN NEW.review_state = 'accepted'
      BEGIN
        UPDATE tasks
        SET assignee_entity_id = 'person-other'
        WHERE id = NEW.task_id;
      END
    `.execute(db);

    await expect(
      repo.reviewRecommendation({
        code: appliedRecommendationCode(resolved),
        action: "confirm_done",
        userId: USER_ID,
        assigneeEntityIds: [ASSIGNEE_ID],
        surface: "slack",
        now: "2026-07-16T11:00:00.000Z",
      }),
    ).resolves.toEqual({ status: "unauthorized" });
    await expect(
      db
        .selectFrom("tasks")
        .select(["status", "assignee_entity_id"])
        .where("id", "=", taskId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "open", assignee_entity_id: ASSIGNEE_ID });
    await expect(
      db
        .selectFrom("task_completion_recommendations")
        .select("review_state")
        .where("task_id", "=", taskId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ review_state: "pending" });
  });

  it("expires recommendations after 48 hours or three unique deliveries and re-surfaces tasks as pending", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-expiry");
    const timeMessage = await seedMessage(db, conversationId, { providerMessageId: "70.0" });
    const countMessage = await seedMessage(db, conversationId, { providerMessageId: "71.0" });
    const repo = createConversationFollowupsRepository(db);
    const created = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [timeMessage, countMessage],
      allowedConversationIds: [conversationId],
      changes: [newChange("Time expiry", [timeMessage]), newChange("Count expiry", [countMessage])],
      now: NOW,
    });
    const [timeTaskId, countTaskId] = created.map(appliedTaskId);
    await assignTask(db, timeTaskId);
    await assignTask(db, countTaskId);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const recommendations = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [timeMessage, countMessage],
      allowedConversationIds: [conversationId],
      changes: [
        resolvedChange(timeTaskId, [timeMessage], "Done by time"),
        resolvedChange(countTaskId, [countMessage], "Done by count"),
      ],
      now: NOW,
    });
    const countRecommendationId = appliedRecommendationId(recommendations[1]);
    const deliveryIds = await seedDeliveries(db, 3);
    for (const deliveryId of deliveryIds) {
      await repo.recordRecommendationDelivery({
        recommendationId: countRecommendationId,
        agentOutputDeliveryId: deliveryId,
      });
    }

    const reminders = await repo.queryPersonalReminders({
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      now: "2026-07-18T10:00:00.000Z",
    });

    expect(reminders.status).toBe("ok");
    if (reminders.status === "ok") {
      expect(reminders.looksResolved).toEqual([]);
      expect(reminders.pending.map((item) => item.taskId).sort()).toEqual([countTaskId, timeTaskId].sort());
    }
    const states = await db
      .selectFrom("task_completion_recommendations")
      .select(["task_id", "review_state"])
      .orderBy("task_id")
      .execute();
    expect(states.every((row) => row.review_state === "expired")).toBe(true);
  });

  it("keeps the review code from the third delivery actionable", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-final-delivery-review");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "final-delivery-review" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Review after final delivery", [messageId])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const [resolved] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [messageId], "Reported complete.")],
      now: NOW,
    });
    const recommendationId = appliedRecommendationId(resolved);
    for (const deliveryId of await seedDeliveries(db, 3)) {
      await repo.recordRecommendationDelivery({
        recommendationId,
        agentOutputDeliveryId: deliveryId,
      });
    }

    await expect(
      repo.reviewRecommendation({
        code: appliedRecommendationCode(resolved),
        action: "confirm_done",
        userId: USER_ID,
        assigneeEntityIds: [],
        surface: "slack",
        now: "2026-07-16T11:00:00.000Z",
      }),
    ).resolves.toEqual({ status: "confirmed", taskId });
    await expect(
      db.selectFrom("tasks").select("status").where("id", "=", taskId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "done" });
  });

  it("records recommendation deliveries idempotently and does not increment on replay", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "group", "group-delivery");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "wamid.delivery" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Delivery replay", [messageId])],
      now: NOW,
    });
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const [resolved] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(appliedTaskId(created), [messageId], "Done")],
      now: NOW,
    });
    const recommendationId = appliedRecommendationId(resolved);
    const [deliveryId] = await seedDeliveries(db, 1);

    await expect(
      repo.recordRecommendationDelivery({
        recommendationId,
        agentOutputDeliveryId: deliveryId,
      }),
    ).resolves.toEqual({ recorded: true, deliveryCount: 1 });
    await expect(
      repo.recordRecommendationDelivery({
        recommendationId,
        agentOutputDeliveryId: deliveryId,
      }),
    ).resolves.toEqual({ recorded: false, deliveryCount: 1 });
  });

  it("keeps confirmation actionable when a third delivery lands after review lookup", async () => {
    const conversationId = await seedConversation(db, "slack", "channel", "C-delivery-review-race");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "72.0" });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Review delivery race", [messageId])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    const memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const [resolved] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [messageId], "Done")],
      now: NOW,
    });
    const recommendationId = appliedRecommendationId(resolved);
    const deliveryIds = await seedDeliveries(db, 3);
    for (const deliveryId of deliveryIds.slice(0, 2)) {
      await repo.recordRecommendationDelivery({
        recommendationId,
        agentOutputDeliveryId: deliveryId,
      });
    }

    const review = repo.reviewRecommendation({
      code: appliedRecommendationCode(resolved),
      action: "confirm_done",
      userId: USER_ID,
      assigneeEntityIds: [],
      surface: "slack",
      now: "2026-07-16T11:00:00.000Z",
    });
    await repo.recordRecommendationDelivery({
      recommendationId,
      agentOutputDeliveryId: deliveryIds[2],
    });

    await expect(review).resolves.toEqual({ status: "confirmed", taskId });
    await expect(
      db.selectFrom("tasks").select("status").where("id", "=", taskId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "done" });
    await expect(
      db
        .selectFrom("task_completion_recommendations")
        .select(["review_state", "delivery_count"])
        .where("id", "=", recommendationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ review_state: "accepted", delivery_count: 3 });
  });

  it("returns an error with fallback candidates when the durable query fails", async () => {
    const repo = createConversationFollowupsRepository(db);
    await db.destroy();
    db = await createTestDb();

    const result = await repo.queryPersonalReminders({
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      legacyCandidates: [{ title: "Fallback item" }],
      now: NOW,
    });

    expect(result).toEqual({
      status: "error",
      code: "durable_query_failed",
      untracked: [{ title: "Fallback item" }],
    });
  });

  it("keeps a Goosebumps-shaped WhatsApp follow-up absent for five later reminders after confirmation", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "group", "goosebumps-five-reads");
    const messageId = await seedMessage(db, conversationId, { providerMessageId: "wamid.goosebumps-open" });
    const updateMessage = await seedMessage(db, conversationId, { providerMessageId: "wamid.goosebumps-update" });
    const completionMessage = await seedMessage(db, conversationId, {
      providerMessageId: "wamid.goosebumps-complete",
    });
    const repo = createConversationFollowupsRepository(db);
    const [created] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Durably complete", [messageId])],
      now: NOW,
    });
    const taskId = appliedTaskId(created);
    await assignTask(db, taskId);
    let memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const [changed] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [updateMessage],
      allowedConversationIds: [conversationId],
      changes: [changedChange(taskId, [updateMessage], { title: "Durably complete after update" })],
      now: "2026-07-16T10:30:00.000Z",
    });
    expect(changed).toMatchObject({ status: "applied", kind: "changed", taskId });
    memory = await repo.loadTaskMemory({ userId: USER_ID, conversationIds: [conversationId] });
    const [resolved] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: memory,
      allowedMessageIds: [completionMessage],
      allowedConversationIds: [conversationId],
      changes: [resolvedChange(taskId, [completionMessage], "Ashish confirmed this was fixed.")],
      now: NOW,
    });
    await repo.reviewRecommendation({
      code: appliedRecommendationCode(resolved),
      action: "confirm_done",
      userId: USER_ID,
      assigneeEntityIds: [ASSIGNEE_ID],
      surface: "whatsapp",
      now: "2026-07-16T11:00:00.000Z",
    });

    const [replayed] = await repo.applyTaskChanges({
      userId: USER_ID,
      taskMemory: [],
      allowedMessageIds: [messageId],
      allowedConversationIds: [conversationId],
      changes: [newChange("Durably complete", [messageId])],
      now: "2026-07-16T11:05:00.000Z",
    });
    expect(replayed).toMatchObject({ status: "applied", kind: "new", taskId });
    await expect(db.selectFrom("tasks").select("id").execute()).resolves.toHaveLength(1);

    for (let read = 0; read < 5; read += 1) {
      const result = await repo.queryPersonalReminders({
        userId: USER_ID,
        assigneeEntityIds: [ASSIGNEE_ID],
        legacyCandidates: [{ title: "Durably complete after update" }],
        now: `2026-07-${17 + read}T10:00:00.000Z`,
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.pending).toEqual([]);
        expect(result.looksResolved).toEqual([]);
        expect(result.untracked).toEqual([]);
      }
    }
  });
});

function newChange(
  title: string,
  evidenceMessageIds: number[],
  structuredPayload: Record<string, unknown> = {},
): SummarizerTaskChange {
  return {
    kind: "new",
    evidenceMessageIds,
    item: {
      sectionKey: "task_changes",
      title,
      summary: title,
      priority: "medium",
      label: "todo",
      structuredPayload,
      knowledgeRefs: { entityIds: [], fileIds: [] },
      sortOrder: 0,
    },
  };
}

function changedChange(
  taskId: string,
  evidenceMessageIds: number[],
  metadata: Extract<SummarizerTaskChange, { kind: "changed" }>["metadata"],
): SummarizerTaskChange {
  return { kind: "changed", taskId, evidenceMessageIds, metadata };
}

function resolvedChange(
  taskId: string,
  evidenceMessageIds: number[],
  rationale: string,
  metadata?: Extract<SummarizerTaskChange, { kind: "resolved" }>["metadata"],
): SummarizerTaskChange {
  return { kind: "resolved", taskId, evidenceMessageIds, rationale, metadata };
}

function appliedTaskId(
  result: Awaited<ReturnType<ReturnType<typeof createConversationFollowupsRepository>["applyTaskChanges"]>>[number],
): string {
  if (result.status !== "applied") throw new Error(`Expected applied result, received ${result.status}`);
  return result.taskId;
}

function appliedRecommendationCode(
  result: Awaited<ReturnType<ReturnType<typeof createConversationFollowupsRepository>["applyTaskChanges"]>>[number],
): string {
  if (result.status !== "applied" || result.kind !== "resolved") throw new Error("Expected resolved result");
  return result.recommendation.code;
}

function appliedRecommendationId(
  result: Awaited<ReturnType<ReturnType<typeof createConversationFollowupsRepository>["applyTaskChanges"]>>[number],
): string {
  if (result.status !== "applied" || result.kind !== "resolved") throw new Error("Expected resolved result");
  return result.recommendation.id;
}

async function seedUserAndEntities(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values([
      {
        id: USER_ID,
        name: "Follow-up User",
        email: "followups@example.com",
        email_verified_at: NOW,
        password_hash: null,
        slack_user_id: "U-followups",
        whatsapp_number: "+15550001111",
        description: null,
        role: null,
        reports_to: null,
        tool_progress: null,
        allowed_tools: null,
        timezone: "UTC",
      },
      {
        id: OTHER_USER_ID,
        name: "Other User",
        email: "other-followups@example.com",
        email_verified_at: NOW,
        password_hash: null,
        slack_user_id: "U-other-followups",
        whatsapp_number: "+15550002222",
        description: null,
        role: null,
        reports_to: null,
        tool_progress: null,
        allowed_tools: null,
        timezone: "UTC",
      },
    ])
    .execute();
  await db
    .insertInto("entities")
    .values([
      entityRow(ASSIGNEE_ID, "Follow-up User", "person"),
      entityRow(OTHER_ASSIGNEE_ID, "Other Teammate", "person"),
      entityRow(PROJECT_ID, "Goosebumps", "project"),
      entityRow(OTHER_PROJECT_ID, "Other Project", "project"),
    ])
    .execute();
}

function entityRow(id: string, name: string, sourceType: string) {
  return {
    id,
    name,
    source_type: sourceType,
    subtype: null,
    aliases: null,
    metadata: null,
    source_ref_id: null,
    status: "active",
    hotness: 0,
    created_at: NOW,
    updated_at: NOW,
    ai_brief: null,
    deleted_at: null,
    merged_into_entity_id: null,
  };
}

async function seedConversation(
  db: Kysely<DB>,
  platform: "slack" | "whatsapp",
  kind: "channel" | "group" | "dm",
  providerConversationId: string,
): Promise<number> {
  return (
    await db
      .insertInto("conversations")
      .values({
        platform,
        kind,
        provider_conversation_id: providerConversationId,
        display_name: providerConversationId,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

async function seedMessage(
  db: Kysely<DB>,
  conversationId: number,
  input: {
    providerMessageId: string;
    providerThreadId?: string | null;
    isThreadReply?: boolean;
  },
): Promise<number> {
  return (
    await db
      .insertInto("conversation_messages")
      .values({
        conversation_id: conversationId,
        provider_message_id: input.providerMessageId,
        sender_name: "Ashish",
        sender_user_id: USER_ID,
        attachments: null,
        provider_thread_id: input.providerThreadId ?? null,
        provider_parent_message_id: null,
        is_thread_reply: input.isThreadReply ? 1 : 0,
        provider_timestamp: NOW,
        received_at: NOW,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

async function assignTask(db: Kysely<DB>, taskId: string): Promise<void> {
  await db
    .updateTable("tasks")
    .set({
      assignee_entity_id: ASSIGNEE_ID,
      assignee_name: "Follow-up User",
      proposed_assignee_name: null,
    })
    .where("id", "=", taskId)
    .execute();
}

function summaryTaskRow(input: {
  id: string;
  title: string;
  status: "open" | "done";
  conversationId: number;
  originOutputId: string | null;
}) {
  return {
    id: input.id,
    parent_entity_id: null,
    parent_source_ref: null,
    parent_name: null,
    source: "summary",
    external_ref: null,
    title: input.title,
    normalized_title: input.title.toLowerCase(),
    status: input.status,
    status_raw: input.status,
    status_authority: "local",
    assignee_entity_id: ASSIGNEE_ID,
    assignee_name: "Follow-up User",
    proposed_assignee_name: null,
    priority: "medium",
    due_at: null,
    provenance: "summary",
    source_task_id: input.id,
    created_by_user_id: USER_ID,
    status_changed_at: NOW,
    completed_at: input.status === "done" ? NOW : null,
    valid_from: NOW,
    valid_to: null,
    milestone_series_key: null,
    source_platform: "slack",
    source_conversation_id: input.conversationId,
    source_provider_thread_id: null,
    source_anchor_key: `slack:${input.conversationId}:root`,
    origin_agent_output_id: input.originOutputId,
  };
}

async function seedDeliveries(db: Kysely<DB>, count: number): Promise<string[]> {
  const outputId = `output-${crypto.randomUUID()}`;
  await db
    .insertInto("agent_outputs")
    .values({
      id: outputId,
      agent_key: "daily-brief",
      user_id: USER_ID,
      output_date: "2026-07-16",
      source_label: null,
      timezone: "UTC",
      status: "completed",
      trigger_type: "scheduled",
      agent_version: "test",
      agent_run_id: null,
      masthead_json: null,
      raw_payload_json: null,
      error_message: null,
      generated_at: NOW,
    })
    .execute();
  const ids = Array.from({ length: count }, (_, index) => `delivery-${crypto.randomUUID()}-${index}`);
  await db
    .insertInto("agent_output_deliveries")
    .values(
      ids.map((id) => ({
        id,
        agent_output_id: outputId,
        platform: "slack",
        target_type: "dm",
        target_id: "U-followups",
        status: "sent",
        message_refs_json: null,
        error_message: null,
        sent_at: NOW,
      })),
    )
    .execute();
  return ids;
}

type AppliedResult = Awaited<
  ReturnType<ReturnType<typeof createConversationFollowupsRepository>["applyTaskChanges"]>
>[number];

void (null as TaskMemoryItem | null);
void (null as AppliedResult | null);
