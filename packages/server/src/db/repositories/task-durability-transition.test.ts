import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import type { AgentOutputItemInput } from "./agent-outputs";
import { createAgentOutputRepository } from "./agent-outputs";
import { createTaskDurabilityTransitionRepository } from "./task-durability-transition";

const AGENT_KEY = "conversation_summary";
const USER_ID = "user-1";
const ROUTE_ID = "route-1";
const SOURCE_KEY = "slack:channel:C_SEED";
const NOW = "2026-07-16T12:00:00.000Z";

describe("createTaskDurabilityTransitionRepository", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db, USER_ID);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("loads only the newest ten outputs strictly newer than the seven-day boundary", async () => {
    const conversationId = await seedConversation(db, "slack", "C_SEED");
    const outputRepo = createAgentOutputRepository(db);
    const boundaryMessageId = await seedMessage(db, conversationId, {
      providerMessageId: "boundary",
      threadId: "thread-boundary",
    });
    await seedOutput(outputRepo, db, {
      generatedAt: "2026-07-09T12:00:00.000Z",
      title: "Boundary task",
      messageIds: [boundaryMessageId],
    });

    for (let index = 0; index < 12; index += 1) {
      const messageId = await seedMessage(db, conversationId, {
        providerMessageId: `message-${index}`,
        threadId: `thread-${index}`,
      });
      await seedOutput(outputRepo, db, {
        generatedAt: new Date(Date.parse("2026-07-10T00:00:00.000Z") + index * 60_000).toISOString(),
        title: `Task ${index}`,
        messageIds: [messageId],
      });
    }

    const result = await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });

    const rows = await db
      .selectFrom("task_seed_candidates")
      .select("title")
      .where("user_id", "=", USER_ID)
      .orderBy("title", "asc")
      .execute();
    expect(result).toMatchObject({
      initialized: true,
      mode: "hybrid",
      seedState: "pending",
      createdCount: 10,
      skippedCount: 0,
      pendingCount: 10,
      lastError: null,
    });
    expect(rows.map((row) => row.title)).toEqual([
      "Task 10",
      "Task 11",
      "Task 2",
      "Task 3",
      "Task 4",
      "Task 5",
      "Task 6",
      "Task 7",
      "Task 8",
      "Task 9",
    ]);
  });

  it("merges visible and raw candidates, deduplicates them, and initializes idempotently", async () => {
    const conversationId = await seedConversation(db, "slack", "C_SEED");
    const messageId = await seedMessage(db, conversationId, {
      providerMessageId: "message-dedupe",
      threadId: "thread-dedupe",
    });
    const outputRepo = createAgentOutputRepository(db);
    await seedOutput(outputRepo, db, {
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "Ship launch plan",
      messageIds: [messageId],
      rawItems: [taskCandidate(" ship launch plan ", [messageId])],
    });
    const repo = createTaskDurabilityTransitionRepository(db);

    const first = await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });
    const second = await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });

    expect(first).toMatchObject({ initialized: true, createdCount: 1, pendingCount: 1 });
    expect(second).toMatchObject({ initialized: false, createdCount: 0, pendingCount: 1 });
    expect(await countRows(db, "task_seed_candidates")).toBe(1);
  });

  it("skips missing, nonexistent, foreign, ambiguous, and unsupported evidence while exposing the count", async () => {
    const sourceConversationId = await seedConversation(db, "slack", "C_SEED");
    const foreignConversationId = await seedConversation(db, "slack", "C_FOREIGN");
    const unsupportedConversationId = await seedConversation(db, "teams", "T_UNSUPPORTED");
    const sourceMessageId = await seedMessage(db, sourceConversationId, {
      providerMessageId: "source",
      threadId: "thread-source",
    });
    const otherSourceMessageId = await seedMessage(db, sourceConversationId, {
      providerMessageId: "other-source",
      threadId: "thread-other",
    });
    const foreignMessageId = await seedMessage(db, foreignConversationId, {
      providerMessageId: "foreign",
      threadId: "thread-foreign",
    });
    const unsupportedMessageId = await seedMessage(db, unsupportedConversationId, {
      providerMessageId: "unsupported",
      threadId: null,
    });
    const outputRepo = createAgentOutputRepository(db);
    await seedOutput(outputRepo, db, {
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "Valid task",
      messageIds: [sourceMessageId],
      rawItems: [
        taskCandidate("Missing evidence", []),
        taskCandidate("Nonexistent evidence", [999_999]),
        taskCandidate("Foreign evidence", [foreignMessageId]),
        taskCandidate("Ambiguous evidence", [sourceMessageId, otherSourceMessageId]),
        taskCandidate("Unsupported evidence", [unsupportedMessageId]),
      ],
    });

    const result = await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });

    expect(result).toMatchObject({ createdCount: 1, skippedCount: 5, pendingCount: 1, seedState: "pending" });
    expect(await db.selectFrom("task_seed_candidates").select("title").execute()).toEqual([{ title: "Valid task" }]);
  });

  it("validates combined-route seed evidence against the loaded conversation set", async () => {
    const allowedConversationId = await seedConversation(db, "slack", "C_ALLOWED");
    const foreignConversationId = await seedConversation(db, "slack", "C_FOREIGN");
    const foreignMessageId = await seedMessage(db, foreignConversationId, {
      providerMessageId: "foreign-route-message",
      threadId: "foreign-route-thread",
    });
    const sourceKey = "route:combined";
    await seedOutput(createAgentOutputRepository(db), db, {
      sourceKey,
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "Foreign route task",
      messageIds: [foreignMessageId],
    });

    const result = await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey,
      allowedConversationIds: [allowedConversationId],
      now: NOW,
    });

    expect(result).toMatchObject({ createdCount: 0, skippedCount: 1, pendingCount: 0, seedState: "reviewed" });
  });

  it("seeds combined routes from recent member-source outputs", async () => {
    const conversationId = await seedConversation(db, "slack", "C_MEMBER");
    const messageId = await seedMessage(db, conversationId, {
      providerMessageId: "member-route-message",
      threadId: "member-route-thread",
    });
    const memberSourceKey = "slack:channel:C_MEMBER";
    await seedOutput(createAgentOutputRepository(db), db, {
      sourceKey: memberSourceKey,
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "Member source task",
      messageIds: [messageId],
    });

    const result = await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: "route:combined",
      sourceKeys: [memberSourceKey],
      allowedConversationIds: [conversationId],
      now: NOW,
    });

    expect(result).toMatchObject({ createdCount: 1, skippedCount: 0, pendingCount: 1, seedState: "pending" });
    const seed = await db
      .selectFrom("task_seed_candidates")
      .select(["review_code", "source_key", "title"])
      .executeTakeFirstOrThrow();
    expect(seed).toMatchObject({ source_key: "route:combined", title: "Member source task" });

    await expect(
      createTaskDurabilityTransitionRepository(db).reviewSeedCandidate({
        userId: USER_ID,
        code: seed.review_code,
        decision: "track",
        surface: "slack",
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("automatically reviews a successful seed with no valid candidates", async () => {
    const result = await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });

    expect(result).toMatchObject({
      mode: "hybrid",
      seedState: "reviewed",
      createdCount: 0,
      pendingCount: 0,
      lastError: null,
    });
    expect(await routeState(db)).toMatchObject({
      mode: "hybrid",
      seed_state: "reviewed",
      seed_reviewed_at: NOW,
    });
  });

  it("reconciles a pending route after its last reviewable seed candidate is deleted", async () => {
    const conversationId = await seedConversation(db, "slack", "C_SEED");
    const messageId = await seedMessage(db, conversationId, {
      providerMessageId: "deleted-seed-evidence",
      threadId: "deleted-seed-thread",
    });
    await seedOutput(createAgentOutputRepository(db), db, {
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "Deleted seed task",
      messageIds: [messageId],
    });
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });
    await db.deleteFrom("conversations").where("id", "=", conversationId).execute();

    const reconciled = await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: "2026-07-16T13:00:00.000Z",
    });

    expect(reconciled).toMatchObject({
      mode: "hybrid",
      seedState: "reviewed",
      pendingCount: 0,
      createdCount: 0,
      skippedCount: 1,
      lastError: null,
    });
  });

  it("resets a durable route when its configured source key changes", async () => {
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });
    await repo.recordIncrementalSuccess({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      expectedSourceKey: SOURCE_KEY,
      now: "2026-07-16T12:05:00.000Z",
    });

    const changed = await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: "slack:channel:C_CHANGED",
      now: "2026-07-16T13:00:00.000Z",
    });

    expect(changed).toMatchObject({ mode: "hybrid", seedState: "reviewed", pendingCount: 0 });
    await expect(routeState(db)).resolves.toMatchObject({
      source_key: "slack:channel:C_CHANGED",
      mode: "hybrid",
      incremental_success_at: null,
    });
  });

  it("accepts a seed into a durable task with dedicated evidence and retains an ownerless proposed name", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "120363-seed@g.us", "group");
    const messageId = await seedMessage(db, conversationId, {
      providerMessageId: "wa-message",
      threadId: null,
    });
    const sourceKey = "whatsapp:group:120363-seed@g.us";
    const outputRepo = createAgentOutputRepository(db);
    await seedOutput(outputRepo, db, {
      sourceKey,
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "Send revised proposal",
      messageIds: [messageId],
      owner: "External Ashish",
    });
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey,
      now: NOW,
    });
    const candidate = await db.selectFrom("task_seed_candidates").selectAll().executeTakeFirstOrThrow();

    const reviewed = await repo.reviewSeedCandidate({
      userId: USER_ID,
      code: candidate.review_code.toLowerCase(),
      decision: "track",
      surface: "whatsapp",
      now: "2026-07-16T12:05:00.000Z",
    });

    expect(reviewed).toMatchObject({ status: "accepted", mode: "hybrid" });
    const task = await db.selectFrom("tasks").selectAll().executeTakeFirstOrThrow();
    expect(task).toMatchObject({
      id: reviewed.status === "accepted" ? reviewed.taskId : "",
      title: "Send revised proposal",
      proposed_assignee_name: "External Ashish",
      assignee_entity_id: null,
      source_platform: "whatsapp",
      source_conversation_id: conversationId,
      source_provider_thread_id: null,
      origin_agent_output_id: candidate.origin_agent_output_id,
    });
    expect(await db.selectFrom("task_message_evidence").selectAll().execute()).toEqual([
      expect.objectContaining({
        task_id: task.id,
        conversation_message_id: messageId,
        source_platform: "whatsapp",
        source_conversation_id: conversationId,
      }),
    ]);
    expect(await db.selectFrom("task_seed_candidates").selectAll().executeTakeFirstOrThrow()).toMatchObject({
      review_state: "accepted",
      accepted_task_id: task.id,
      reviewed_by_user_id: USER_ID,
      reviewed_at: "2026-07-16T12:05:00.000Z",
    });
  });

  it("does not promote a seed after its route source changes during review", async () => {
    const code = await seedOneCandidate(db);
    await sql`
      CREATE TRIGGER reset_route_during_seed_review
      AFTER UPDATE OF review_state ON task_seed_candidates
      WHEN NEW.review_state = 'processing'
      BEGIN
        UPDATE task_durability_route_state
        SET source_key = 'slack:channel:C_CHANGED',
            mode = 'hybrid',
            seed_state = 'pending'
        WHERE agent_key = 'conversation_summary'
          AND user_id = 'user-1'
          AND route_id = 'route-1';
      END
    `.execute(db);

    await expect(
      createTaskDurabilityTransitionRepository(db).reviewSeedCandidate({
        userId: USER_ID,
        code,
        decision: "track",
        surface: "slack",
        now: "2026-07-16T12:05:00.000Z",
      }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(countRows(db, "tasks")).resolves.toBe(0);
  });

  it("normalizes a top-level Slack seed to the shared root anchor", async () => {
    const conversationId = await seedConversation(db, "slack", "C_SEED");
    const messageId = await seedMessage(db, conversationId, {
      providerMessageId: "top-level-message",
      threadId: null,
    });
    await db
      .updateTable("conversation_messages")
      .set({ provider_thread_id: "top-level-message", is_thread_reply: 0 })
      .where("id", "=", messageId)
      .execute();
    await seedOutput(createAgentOutputRepository(db), db, {
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "Top-level task",
      messageIds: [messageId],
    });
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });
    const candidate = await db.selectFrom("task_seed_candidates").selectAll().executeTakeFirstOrThrow();

    await repo.reviewSeedCandidate({
      userId: USER_ID,
      code: candidate.review_code,
      decision: "track",
      surface: "slack",
      now: NOW,
    });

    await expect(db.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()).resolves.toMatchObject({
      source_provider_thread_id: null,
      source_anchor_key: `slack:${conversationId}:root`,
    });
  });

  it("dismisses without creating a task and keeps reviews idempotent", async () => {
    const code = await seedOneCandidate(db);
    const repo = createTaskDurabilityTransitionRepository(db);

    const first = await repo.reviewSeedCandidate({
      userId: USER_ID,
      code,
      decision: "dismiss",
      surface: "slack",
      now: "2026-07-16T12:05:00.000Z",
    });
    const second = await repo.reviewSeedCandidate({
      userId: USER_ID,
      code,
      decision: "dismiss",
      surface: "slack",
      now: "2026-07-16T12:06:00.000Z",
    });

    expect(first).toMatchObject({ status: "dismissed", mode: "hybrid" });
    expect(second).toMatchObject({ status: "already_reviewed", decision: "dismiss", mode: "hybrid" });
    expect(await countRows(db, "tasks")).toBe(0);
    await expect(
      repo.getUserTransition({
        agentKey: AGENT_KEY,
        userId: USER_ID,
        activeRoutes: [{ routeId: ROUTE_ID, sourceKey: SOURCE_KEY, sourceKeys: [SOURCE_KEY] }],
      }),
    ).resolves.toMatchObject({
      suppressedLegacy: [{ title: "Seed task", sourceKey: SOURCE_KEY }],
    });
  });

  it("keeps opaque DM source candidates valid during active-route reconciliation", async () => {
    const conversationId = await seedConversation(db, "whatsapp", "dm:+15551234567", "dm");
    const sourceKey = `whatsapp:dm:${conversationId}`;
    const messageId = await seedMessage(db, conversationId, {
      providerMessageId: "dm-seed-message",
      threadId: null,
    });
    await seedOutput(createAgentOutputRepository(db), db, {
      sourceKey,
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "DM seed task",
      messageIds: [messageId],
    });
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey,
      allowedConversationIds: [conversationId],
      now: NOW,
    });

    await expect(
      repo.getUserTransition({
        agentKey: AGENT_KEY,
        userId: USER_ID,
        activeRoutes: [{ routeId: ROUTE_ID, sourceKey, sourceKeys: [sourceKey] }],
      }),
    ).resolves.toMatchObject({
      untracked: [expect.objectContaining({ title: "DM seed task", sourcePlatform: "whatsapp" })],
    });
  });

  it("retains the member conversation anchor for combined-route legacy suppression", async () => {
    const firstConversationId = await seedConversation(db, "slack", "C_FIRST");
    const secondConversationId = await seedConversation(db, "slack", "C_SECOND");
    const firstMessageId = await seedMessage(db, firstConversationId, {
      providerMessageId: "first-combined",
      threadId: "first-thread",
    });
    const secondMessageId = await seedMessage(db, secondConversationId, {
      providerMessageId: "second-combined",
      threadId: "second-thread",
    });
    const sourceKey = "route:combined";
    const outputRepo = createAgentOutputRepository(db);
    await seedOutput(outputRepo, db, {
      sourceKey,
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "Send revised proposal",
      messageIds: [firstMessageId],
    });
    await seedOutput(outputRepo, db, {
      sourceKey,
      generatedAt: "2026-07-15T13:00:00.000Z",
      title: "Send revised proposal",
      messageIds: [secondMessageId],
    });
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey,
      allowedConversationIds: [firstConversationId, secondConversationId],
      now: NOW,
    });
    const dismissed = await db
      .selectFrom("task_seed_candidates")
      .select(["review_code", "source_anchor_key"])
      .where("source_conversation_id", "=", firstConversationId)
      .executeTakeFirstOrThrow();
    await repo.reviewSeedCandidate({
      userId: USER_ID,
      code: dismissed.review_code,
      decision: "dismiss",
      surface: "slack",
      now: "2026-07-16T12:05:00.000Z",
    });

    const transition = await repo.getUserTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      activeRoutes: [
        {
          routeId: ROUTE_ID,
          sourceKey,
          sourceKeys: ["slack:channel:C_FIRST", "slack:channel:C_SECOND"],
        },
      ],
      now: NOW,
    });

    expect(transition.suppressedLegacy).toEqual([
      {
        title: "Send revised proposal",
        sourceKey,
        sourceAnchorKey: dismissed.source_anchor_key,
      },
    ]);
    expect(transition.untracked).toHaveLength(1);
  });

  it("authorizes review codes to their owner and returns pending seeds as untracked items", async () => {
    const code = await seedOneCandidate(db);
    await seedUser(db, "user-2");
    const repo = createTaskDurabilityTransitionRepository(db);

    const transition = await repo.getUserTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      activeRoutes: [{ routeId: ROUTE_ID, sourceKey: SOURCE_KEY, sourceKeys: [SOURCE_KEY] }],
    });
    const foreign = await repo.reviewSeedCandidate({
      userId: "user-2",
      code,
      decision: "track",
      surface: "slack",
      now: NOW,
    });
    const missing = await repo.reviewSeedCandidate({
      userId: USER_ID,
      code: "ZZZZZZ",
      decision: "track",
      surface: "slack",
      now: NOW,
    });

    expect(transition).toMatchObject({
      mode: "hybrid",
      untracked: [
        {
          code,
          title: "Seed task",
          label: "Reconstructed from recent summaries; not yet tracked.",
          sourcePlatform: "slack",
        },
      ],
    });
    expect(foreign).toEqual({ status: "not_found" });
    expect(missing).toEqual({ status: "not_found" });
    expect(await countRows(db, "tasks")).toBe(0);
  });

  it("caps active pending and dismissed reminder state with an explicit overflow signal", async () => {
    const conversationId = await seedConversation(db, "slack", "C_SEED");
    const messageId = await seedMessage(db, conversationId, {
      providerMessageId: "transition-limit-message",
      threadId: "transition-limit-thread",
    });
    await seedOutput(createAgentOutputRepository(db), db, {
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "Transition limit visible",
      messageIds: [messageId],
      rawItems: Array.from({ length: 25 }, (_, index) => taskCandidate(`Transition limit raw ${index}`, [messageId])),
    });
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });
    const template = await db.selectFrom("task_seed_candidates").selectAll().executeTakeFirstOrThrow();
    await db
      .insertInto("task_seed_candidates")
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          ...template,
          id: `dismissed-limit-${index}`,
          title: `Dismissed limit ${index}`,
          normalized_title: `dismissed limit ${index}`,
          evidence_fingerprint: `dismissed-limit-${index}`,
          review_code: `D${String(index).padStart(7, "0")}`,
          review_state: "dismissed",
          reviewed_at: NOW,
          reviewed_by_user_id: USER_ID,
        })),
      )
      .execute();

    const transition = await repo.getUserTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      activeRoutes: [{ routeId: ROUTE_ID, sourceKey: SOURCE_KEY, sourceKeys: [SOURCE_KEY] }],
      now: NOW,
    });

    expect(transition.overflow).toBe(true);
    expect(transition.mode).toBe("hybrid");
    expect(transition.untracked).toHaveLength(25);
    expect(transition.suppressedLegacy).toHaveLength(100);
  });

  it("does not count lifetime candidates outside the active route SQL scope toward reminder overflow", async () => {
    await seedOneCandidate(db);
    const template = await db.selectFrom("task_seed_candidates").selectAll().executeTakeFirstOrThrow();
    await db
      .insertInto("task_seed_candidates")
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          ...template,
          id: `historical-dismissed-${index}`,
          route_id: "historical-route",
          source_key: "slack:channel:C_HISTORICAL",
          title: `Historical dismissed ${index}`,
          normalized_title: `historical dismissed ${index}`,
          evidence_fingerprint: `historical-dismissed-${index}`,
          review_code: `H${String(index).padStart(7, "0")}`,
          review_state: "dismissed",
          reviewed_at: NOW,
          reviewed_by_user_id: USER_ID,
        })),
      )
      .execute();

    const transition = await createTaskDurabilityTransitionRepository(db).getUserTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      activeRoutes: [{ routeId: ROUTE_ID, sourceKey: SOURCE_KEY, sourceKeys: [SOURCE_KEY] }],
      now: NOW,
    });

    expect(transition.overflow).toBe(false);
    expect(transition.untracked).toHaveLength(1);
    expect(transition.suppressedLegacy).toEqual([]);
  });

  it("retires pending candidates whose originating evidence is no longer valid", async () => {
    const conversationId = await seedConversation(db, "slack", "C_SEED");
    const messageId = await seedMessage(db, conversationId, {
      providerMessageId: "stale-evidence",
      threadId: "stale-thread",
    });
    await seedOutput(createAgentOutputRepository(db), db, {
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "Stale seed task",
      messageIds: [messageId],
    });
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });
    await db.deleteFrom("conversation_messages").where("id", "=", messageId).execute();

    const transition = await repo.getUserTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      activeRoutes: [{ routeId: ROUTE_ID, sourceKey: SOURCE_KEY, sourceKeys: [SOURCE_KEY] }],
      now: "2026-07-16T13:00:00.000Z",
    });

    expect(transition).toMatchObject({
      mode: "hybrid",
      routes: [{ routeId: ROUTE_ID, sourceKey: SOURCE_KEY, seedState: "reviewed" }],
      untracked: [],
    });
    expect(await countRows(db, "task_seed_candidates")).toBe(0);
  });

  it("filters transition state and candidates to currently enabled route identities", async () => {
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });
    await repo.recordIncrementalSuccess({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      expectedSourceKey: SOURCE_KEY,
      now: "2026-07-16T12:01:00.000Z",
    });
    await db
      .insertInto("task_durability_route_state")
      .values({
        agent_key: AGENT_KEY,
        user_id: USER_ID,
        route_id: "historical-route",
        source_key: "slack:channel:C_HISTORICAL",
        mode: "hybrid",
        seed_state: "pending",
        seed_started_at: NOW,
        seed_reviewed_at: null,
        incremental_success_at: null,
        last_error: null,
      })
      .execute();

    const transition = await repo.getUserTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      activeRoutes: [{ routeId: ROUTE_ID, sourceKey: SOURCE_KEY, sourceKeys: [SOURCE_KEY] }],
      now: NOW,
    });

    expect(transition.mode).toBe("durable_only");
    expect(transition.routes).toEqual([
      {
        routeId: ROUTE_ID,
        sourceKey: SOURCE_KEY,
        mode: "durable_only",
        seedState: "reviewed",
        lastError: null,
      },
    ]);
  });

  it("does not record incremental success when the route source changed", async () => {
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: "slack:channel:C_CHANGED",
      now: "2026-07-16T12:01:00.000Z",
    });

    const result = await repo.recordIncrementalSuccess({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      expectedSourceKey: SOURCE_KEY,
      now: "2026-07-16T12:02:00.000Z",
    });

    expect(result).toEqual({ mode: "hybrid" });
    await expect(routeState(db)).resolves.toMatchObject({
      source_key: "slack:channel:C_CHANGED",
      incremental_success_at: null,
      mode: "hybrid",
    });
  });

  it("switches to durable-only regardless of whether incremental success or final review happens first", async () => {
    const firstCode = await seedOneCandidate(db);
    const repo = createTaskDurabilityTransitionRepository(db);

    expect(
      await repo.recordIncrementalSuccess({
        agentKey: AGENT_KEY,
        userId: USER_ID,
        routeId: ROUTE_ID,
        expectedSourceKey: SOURCE_KEY,
        now: "2026-07-16T12:02:00.000Z",
      }),
    ).toEqual({ mode: "hybrid" });
    expect(
      await repo.reviewSeedCandidate({
        userId: USER_ID,
        code: firstCode,
        decision: "dismiss",
        surface: "slack",
        now: "2026-07-16T12:03:00.000Z",
      }),
    ).toMatchObject({ status: "dismissed", mode: "durable_only" });

    const secondRoute = "route-2";
    const secondSource = "slack:channel:C_SECOND";
    const secondConversation = await seedConversation(db, "slack", "C_SECOND");
    const secondMessage = await seedMessage(db, secondConversation, {
      providerMessageId: "second-message",
      threadId: "second-thread",
    });
    await seedOutput(createAgentOutputRepository(db), db, {
      sourceKey: secondSource,
      generatedAt: "2026-07-15T13:00:00.000Z",
      title: "Second route task",
      messageIds: [secondMessage],
    });
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: secondRoute,
      sourceKey: secondSource,
      now: NOW,
    });
    const secondCandidate = await db
      .selectFrom("task_seed_candidates")
      .select("review_code")
      .where("route_id", "=", secondRoute)
      .executeTakeFirstOrThrow();
    await repo.reviewSeedCandidate({
      userId: USER_ID,
      code: secondCandidate.review_code,
      decision: "dismiss",
      surface: "slack",
      now: "2026-07-16T12:04:00.000Z",
    });
    expect(
      await repo.recordIncrementalSuccess({
        agentKey: AGENT_KEY,
        userId: USER_ID,
        routeId: secondRoute,
        expectedSourceKey: secondSource,
        now: "2026-07-16T12:05:00.000Z",
      }),
    ).toEqual({ mode: "durable_only" });
    expect(
      await repo.getUserTransition({
        agentKey: AGENT_KEY,
        userId: USER_ID,
        activeRoutes: [
          { routeId: ROUTE_ID, sourceKey: SOURCE_KEY, sourceKeys: [SOURCE_KEY] },
          { routeId: secondRoute, sourceKey: secondSource, sourceKeys: [secondSource] },
        ],
      }),
    ).toMatchObject({
      mode: "durable_only",
      untracked: [],
    });
  });

  it("does not complete seed review until every pending candidate is reviewed", async () => {
    const conversationId = await seedConversation(db, "slack", "C_SEED");
    const firstMessageId = await seedMessage(db, conversationId, {
      providerMessageId: "first-review",
      threadId: "shared-thread",
    });
    const secondMessageId = await seedMessage(db, conversationId, {
      providerMessageId: "second-review",
      threadId: "shared-thread",
    });
    await seedOutput(createAgentOutputRepository(db), db, {
      generatedAt: "2026-07-15T12:00:00.000Z",
      title: "First review task",
      messageIds: [firstMessageId],
      rawItems: [taskCandidate("Second review task", [secondMessageId])],
    });
    const repo = createTaskDurabilityTransitionRepository(db);
    await repo.ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });
    await repo.recordIncrementalSuccess({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      expectedSourceKey: SOURCE_KEY,
      now: "2026-07-16T12:01:00.000Z",
    });
    const candidates = await db
      .selectFrom("task_seed_candidates")
      .select(["review_code", "title"])
      .orderBy("title", "asc")
      .execute();

    const first = await repo.reviewSeedCandidate({
      userId: USER_ID,
      code: candidates[0].review_code,
      decision: "dismiss",
      surface: "slack",
      now: "2026-07-16T12:02:00.000Z",
    });
    const second = await repo.reviewSeedCandidate({
      userId: USER_ID,
      code: candidates[1].review_code,
      decision: "dismiss",
      surface: "slack",
      now: "2026-07-16T12:03:00.000Z",
    });

    expect(first).toMatchObject({ status: "dismissed", mode: "hybrid" });
    expect(second).toMatchObject({ status: "dismissed", mode: "durable_only" });
    expect(await routeState(db)).toMatchObject({
      seed_state: "reviewed",
      seed_reviewed_at: "2026-07-16T12:03:00.000Z",
      mode: "durable_only",
    });
  });

  it("remains hybrid and records last_error when completed-output loading fails", async () => {
    await db.schema.alterTable("agent_outputs").renameTo("agent_outputs_unavailable").execute();

    const result = await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: AGENT_KEY,
      userId: USER_ID,
      routeId: ROUTE_ID,
      sourceKey: SOURCE_KEY,
      now: NOW,
    });

    expect(result).toMatchObject({
      initialized: true,
      mode: "hybrid",
      seedState: "pending",
      createdCount: 0,
      pendingCount: 0,
    });
    expect(result.skippedCount).toBe(0);
    expect(result.lastError).toContain("agent_outputs");
    expect(await routeState(db)).toMatchObject({
      mode: "hybrid",
      seed_state: "pending",
      seed_reviewed_at: null,
    });
    expect((await routeState(db))?.last_error).toContain("agent_outputs");
  });
});

async function seedUser(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("users")
    .values({ id, name: id, email: `${id}@example.com`, email_verified_at: NOW })
    .execute();
}

async function seedConversation(
  db: Kysely<DB>,
  platform: string,
  providerConversationId: string,
  kind = "channel",
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
      .where("provider_conversation_id", "=", providerConversationId)
      .executeTakeFirstOrThrow()
  ).id;
}

async function seedMessage(
  db: Kysely<DB>,
  conversationId: number,
  params: { providerMessageId: string; threadId: string | null },
): Promise<number> {
  await db
    .insertInto("conversation_messages")
    .values({
      conversation_id: conversationId,
      provider_message_id: params.providerMessageId,
      sender_jid: "sender",
      sender_name: "Sender",
      sender_user_id: USER_ID,
      addressed_to_sketch: 0,
      text: params.providerMessageId,
      provider_thread_id: params.threadId,
      is_thread_reply: params.threadId ? 1 : 0,
      received_at: NOW,
    })
    .execute();
  return (
    await db
      .selectFrom("conversation_messages")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .where("provider_message_id", "=", params.providerMessageId)
      .executeTakeFirstOrThrow()
  ).id;
}

async function seedOutput(
  repo: ReturnType<typeof createAgentOutputRepository>,
  db: Kysely<DB>,
  params: {
    generatedAt: string;
    title: string;
    messageIds: number[];
    sourceKey?: string;
    owner?: string;
    rawItems?: AgentOutputItemInput[];
  },
): Promise<string> {
  const sourceKey = params.sourceKey ?? SOURCE_KEY;
  const running = await repo.createRunning({
    agentKey: AGENT_KEY,
    agentVersion: "test",
    userId: USER_ID,
    outputDate: params.generatedAt.slice(0, 10),
    timezone: "UTC",
    triggerType: "manual",
    sourceKey,
    sourceLabel: sourceKey,
  });
  const structuredPayload: Record<string, unknown> = {
    messageIds: params.messageIds,
    sourceLabels: [sourceKey],
  };
  if (params.owner) structuredPayload.owner = params.owner;
  await repo.completeOutput({
    outputId: running.row.id,
    masthead: { title: "Summary", summary: "Summary" },
    rawPayload: { items: params.rawItems ?? [] },
    items: [
      {
        sectionKey: "action_items",
        title: params.title,
        summary: `${params.title} summary`,
        priority: "medium",
        label: "action_item",
        knowledgeRefs: { entityIds: [], fileIds: [] },
        structuredPayload,
        sortOrder: 0,
      },
    ],
  });
  await db
    .updateTable("agent_outputs")
    .set({ generated_at: params.generatedAt, updated_at: params.generatedAt })
    .where("id", "=", running.row.id)
    .execute();
  return running.row.id;
}

function taskCandidate(title: string, messageIds: number[]): AgentOutputItemInput {
  return {
    sectionKey: "task_candidates",
    title,
    summary: `${title.trim()} summary`,
    priority: "medium",
    label: "action_item",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    structuredPayload: { messageIds, sourceLabels: [SOURCE_KEY] },
    sortOrder: 0,
  };
}

async function seedOneCandidate(db: Kysely<DB>): Promise<string> {
  const conversationId = await seedConversation(db, "slack", "C_SEED");
  const messageId = await seedMessage(db, conversationId, {
    providerMessageId: "seed-message",
    threadId: "seed-thread",
  });
  await seedOutput(createAgentOutputRepository(db), db, {
    generatedAt: "2026-07-15T12:00:00.000Z",
    title: "Seed task",
    messageIds: [messageId],
  });
  await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
    agentKey: AGENT_KEY,
    userId: USER_ID,
    routeId: ROUTE_ID,
    sourceKey: SOURCE_KEY,
    now: NOW,
  });
  return (await db.selectFrom("task_seed_candidates").select("review_code").executeTakeFirstOrThrow()).review_code;
}

async function routeState(db: Kysely<DB>) {
  return db
    .selectFrom("task_durability_route_state")
    .selectAll()
    .where("agent_key", "=", AGENT_KEY)
    .where("user_id", "=", USER_ID)
    .where("route_id", "=", ROUTE_ID)
    .executeTakeFirst();
}

async function countRows(db: Kysely<DB>, table: "task_seed_candidates" | "tasks"): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
