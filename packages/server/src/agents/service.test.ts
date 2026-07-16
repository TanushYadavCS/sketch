import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunAgentParams, RunAgentResult } from "../agent/runner";
import { type AgentOutputItemInput, createAgentOutputRepository } from "../db/repositories/agent-outputs";
import { createSettingsRepository } from "../db/repositories/settings";
import { createTaskRepository } from "../db/repositories/tasks";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { CONVERSATION_SUMMARY_AGENT_KEY, CONVERSATION_SUMMARY_AGENT_VERSION } from "./definitions/conversation-summary";
import { DAILY_BRIEF_AGENT_KEY, DAILY_BRIEF_AGENT_VERSION } from "./definitions/daily-brief";
import { AgentRunService } from "./service";

const OUTPUT_DATE = "2026-06-15";
const PREVIOUS_DATE = "2026-06-14";

describe("Daily Brief durable-task hooks", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("surfaces open durable tasks, scrubs completed prior todos, and promotes emitted todos", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Daily Brief User",
      email: "brief-owner@example.com",
      emailVerified: true,
    });
    await seedAssignablePerson(db, "person-brief-owner", "Daily Brief User", "brief-owner@example.com");
    await seedIndexedFile(db, "brief-file-1", user.id);
    await seedCompletedOutput(db, user.id, OUTPUT_DATE);
    await seedCompletedOutput(db, user.id, PREVIOUS_DATE);
    const tasksWithToggle = await runAndCapture(db, user.id, "2026-06-16", [], { createTasks: true });

    const taskRepo = createTaskRepository(db);
    await taskRepo.promoteBriefTask({
      userId: user.id,
      todo: briefItem({
        title: "Open durable task",
        label: "todo",
        structuredPayload: { assigneeName: "Daily Brief User" },
      }),
      knowledgeRefs: { entityIds: [], fileIds: ["brief-file-1"] },
    });
    await taskRepo.promoteBriefTask({
      userId: user.id,
      todo: briefItem({
        title: "Done durable task",
        label: "done",
        structuredPayload: { assigneeName: "Daily Brief User" },
      }),
      knowledgeRefs: { entityIds: [], fileIds: ["brief-file-1"] },
    });

    const before = await countTasks(db);
    const run = await runAndCapture(
      db,
      user.id,
      OUTPUT_DATE,
      [
        briefItem({
          title: "Brand new follow-up",
          structuredPayload: { assigneeName: "Daily Brief User" },
          knowledgeRefs: { entityIds: [], fileIds: ["brief-file-1"] },
        }),
      ],
      { createTasks: true },
    );
    const after = await countTasks(db);

    expect((run.context.openDurableTasks as Array<{ title: string }>).map((task) => task.title)).toEqual([
      "Open durable task",
    ]);
    expect(priorTitles(run.context.sameDayPreviousOutput)).toEqual(["Open prior todo"]);
    expect(priorTitles(run.context.previousDayOutput)).toEqual(["Open prior todo"]);
    expect(run.instructions).toContain("openDurableTasks");
    expect(tasksWithToggle.context.createTasks).toBe(true);
    expect(after).toBeGreaterThan(before);
  });

  it("adds recent Summarizer outputs and user-owned summary tasks to Daily Brief context without replaying old summaries", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Daily Brief User",
      email: "brief-owner@example.com",
      emailVerified: true,
    });
    await seedAssignablePerson(db, "person-brief-owner", "Daily Brief User", "brief-owner@example.com");
    await seedIndexedFile(db, "brief-file-1", user.id);
    await seedCompletedOutput(db, user.id, OUTPUT_DATE, { generatedAt: "2026-06-15T08:00:00.000Z" });
    const oldSummaryId = await seedSummaryOutput(db, user.id, {
      generatedAt: "2026-06-15T07:00:00.000Z",
      title: "Old chat action",
    });
    const recentSummaryId = await seedSummaryOutput(db, user.id, {
      generatedAt: "2026-06-15T09:00:00.000Z",
      title: "Recent chat action",
    });
    const taskRepo = createTaskRepository(db);
    const summaryTask = await taskRepo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Recent chat action",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "summary-recent-chat-action",
      createdByUserId: user.id,
    });

    const run = await runAndCapture(db, user.id, OUTPUT_DATE, [], { createTasks: false });

    expect(run.context.recentSummaries as Array<{ outputId: string; actionItems: Array<{ title: string }> }>).toEqual([
      {
        outputId: recentSummaryId,
        generatedAt: "2026-06-15T09:00:00.000Z",
        summaryWindow: { start: "2026-06-15T08:00:00.000Z", end: "2026-06-15T09:00:00.000Z" },
        actionItems: [
          {
            id: expect.any(String),
            title: "Recent chat action",
            summary: "Recent chat action summary",
            priority: "high",
            sourceLabels: ["#launch"],
            messageIds: ["message-recent-chat-action"],
          },
        ],
      },
    ]);
    expect(JSON.stringify(run.context.recentSummaries)).not.toContain(oldSummaryId);
    expect(run.context.summaryTasks).toEqual([
      {
        id: summaryTask.taskId,
        title: "Recent chat action",
        status: "open",
        statusRaw: "action_item",
        provenance: "summary",
        parentEntityId: null,
        updatedAt: expect.any(String),
      },
    ]);
    expect(run.instructions).toContain("summaryTasks");
    expect(run.instructions).toContain("recentSummaries");
  });

  it("keeps create-tasks disabled for Brief writes while allowing genuinely new Brief tasks when enabled", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Daily Brief User",
      email: "brief-owner@example.com",
      emailVerified: true,
    });
    await seedAssignablePerson(db, "person-brief-owner", "Daily Brief User", "brief-owner@example.com");
    await seedProject(db, "project-x", "Project X");
    await seedIndexedFile(db, "brief-file-1", user.id);
    const todo = briefItem({
      title: "New Brief-only follow-up",
      structuredPayload: { assigneeName: "Daily Brief User" },
      knowledgeRefs: { entityIds: ["project-x"], fileIds: ["brief-file-1"] },
    });

    await runAndCapture(db, user.id, OUTPUT_DATE, [todo], { createTasks: false });
    const afterDisabled = await countTasks(db);
    await runAndCapture(db, user.id, "2026-06-16", [todo], { createTasks: true });
    const afterEnabled = await countTasks(db);

    expect(afterDisabled).toBe(0);
    expect(afterEnabled).toBe(1);
  });
});

async function runAndCapture(
  db: Kysely<DB>,
  userId: string,
  outputDate: string,
  items: AgentOutputItemInput[],
  configPatch: { createTasks?: boolean } = {},
): Promise<{ context: Record<string, unknown>; instructions: string }> {
  const queued: Array<() => Promise<void>> = [];
  const capturedParams: RunAgentParams[] = [];
  const service = new AgentRunService({
    db,
    config: createTestConfig(),
    logger: createTestLogger(),
    users: createUserRepository(db),
    settings: createSettingsRepository(db),
    runAgent: async (params) => {
      capturedParams.push(params);
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      await params.agentOutputWriter.write({
        outputDate,
        timezone: "UTC",
        masthead: { title: "Daily Brief", summary: "Summary" },
        rawPayload: { outputDate, timezone: "UTC", masthead: { title: "Daily Brief", summary: "Summary" }, items: [] },
        items,
      });
      return runResult();
    },
    runScheduledAgent: async () => {
      throw new Error("runScheduledAgent should not be called");
    },
    queueManager: createPausedQueueManager(queued),
  });

  const row = await service.requestGenerationForUser({
    agentKey: DAILY_BRIEF_AGENT_KEY,
    userId,
    outputDate,
    triggerType: "manual",
  });
  if (Object.keys(configPatch).length > 0) {
    await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, userId, configPatch);
  }
  if (!row) throw new Error("Expected a running output");
  await queued.at(-1)?.();
  const params = capturedParams[0];
  if (!params) throw new Error("runAgent was not called");
  return {
    context: parseRuntimeContext(params.userMessage),
    instructions: params.agentInstructions ?? "",
  };
}

function priorTitles(output: unknown): string[] {
  const items = (output as { items?: Array<{ title: string }> } | null)?.items ?? [];
  return items.map((item) => item.title);
}

async function countTasks(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("tasks")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

function createPausedQueueManager(tasks: Array<() => Promise<void>>): QueueManager {
  return {
    getQueue: () => ({
      enqueue: (task: () => Promise<void>) => {
        tasks.push(task);
        return true;
      },
    }),
  } as unknown as QueueManager;
}

async function seedCompletedOutput(
  db: Kysely<DB>,
  userId: string,
  outputDate: string,
  opts: { generatedAt?: string } = {},
): Promise<void> {
  const repo = createAgentOutputRepository(db);
  const running = await repo.createRunning({
    agentKey: DAILY_BRIEF_AGENT_KEY,
    agentVersion: DAILY_BRIEF_AGENT_VERSION,
    userId,
    outputDate,
    timezone: "UTC",
    triggerType: "manual",
  });
  await repo.completeOutput({
    outputId: running.row.id,
    masthead: { title: "Daily Brief", summary: "Summary" },
    rawPayload: {},
    items: [
      briefItem({ title: "Completed prior todo", label: "done", sortOrder: 0 }),
      briefItem({ title: "Open prior todo", label: "todo", sortOrder: 1 }),
    ],
  });
  if (opts.generatedAt) {
    await db
      .updateTable("agent_outputs")
      .set({ generated_at: opts.generatedAt, updated_at: opts.generatedAt })
      .where("id", "=", running.row.id)
      .execute();
  }
}

async function seedSummaryOutput(
  db: Kysely<DB>,
  userId: string,
  params: { generatedAt: string; title: string },
): Promise<string> {
  const repo = createAgentOutputRepository(db);
  const outputDate = params.generatedAt.slice(0, 10);
  const running = await repo.createRunning({
    agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
    agentVersion: CONVERSATION_SUMMARY_AGENT_VERSION,
    userId,
    outputDate,
    periodKey: outputDate,
    sourceKey: "slack:channel:C_LAUNCH",
    sourceLabel: "#launch",
    timezone: "UTC",
    triggerType: "manual",
  });
  await repo.completeOutput({
    outputId: running.row.id,
    masthead: { title: "Conversation Summary", summary: "Summary" },
    rawPayload: {
      outputDate,
      timezone: "UTC",
      summaryWindow: { start: "2026-06-15T08:00:00.000Z", end: params.generatedAt },
      items: [],
    },
    items: [
      {
        sectionKey: "action_items",
        title: params.title,
        summary: `${params.title} summary`,
        priority: "high",
        label: "action_item",
        knowledgeRefs: { entityIds: [], fileIds: [] },
        structuredPayload: {
          sourceLabels: ["#launch"],
          messageIds: [`message-${params.title.toLowerCase().replaceAll(" ", "-")}`],
        },
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

async function seedIndexedFile(db: Kysely<DB>, id: string, userId: string): Promise<void> {
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

async function seedAssignablePerson(db: Kysely<DB>, id: string, name: string, email: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "person",
      subtype: null,
      aliases: JSON.stringify([email]),
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ai_brief: null,
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
    })
    .execute();
}

function briefItem(overrides: Partial<AgentOutputItemInput> = {}): AgentOutputItemInput {
  return {
    sectionKey: "todos",
    title: "Brief todo",
    summary: "Summary",
    priority: "high",
    label: "todo",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
    ...overrides,
  };
}

function parseRuntimeContext(userMessage: string): Record<string, unknown> {
  const marker = "Runtime context:\n";
  const index = userMessage.lastIndexOf(marker);
  if (index === -1) throw new Error("Runtime context marker not found");
  return JSON.parse(userMessage.slice(index + marker.length));
}

function runResult(): RunAgentResult {
  return {
    messageSent: true,
    sessionId: "daily-brief-session",
    costUsd: 0,
    auxCostUsd: 0,
    pendingUploads: [],
    rawUsage: {
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      durationApiMs: 0,
      numTurns: 0,
      stopReason: null,
      errorSubtype: null,
      isResumedSession: false,
      totalAttachments: 0,
      imageCount: 0,
      nonImageCount: 0,
      mimeTypes: [],
      fileSizes: [],
      promptMode: "text",
      toolCalls: [],
      auxLlmCalls: [],
      sdkCostUsd: 0,
    },
    trace: { progressEvents: [], finalText: "Done", automationArtifacts: [] },
  };
}
