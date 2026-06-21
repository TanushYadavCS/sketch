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

  it("with the flag on, surfaces open durable tasks, scrubs completed prior todos, and promotes emitted todos", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Daily Brief User", email: "brief-owner@example.com" });
    await seedIndexedFile(db, "brief-file-1", user.id);
    await seedCompletedOutput(db, user.id, OUTPUT_DATE);
    await seedCompletedOutput(db, user.id, PREVIOUS_DATE);

    const taskRepo = createTaskRepository(db);
    await taskRepo.promoteBriefTask({
      userId: user.id,
      todo: briefItem({ title: "Open durable task", label: "todo" }),
      knowledgeRefs: { entityIds: [], fileIds: ["brief-file-1"] },
    });
    await taskRepo.promoteBriefTask({
      userId: user.id,
      todo: briefItem({ title: "Done durable task", label: "done" }),
      knowledgeRefs: { entityIds: [], fileIds: ["brief-file-1"] },
    });

    const before = await countTasks(db);
    const run = await runAndCapture(db, user.id, true, OUTPUT_DATE, [
      briefItem({ title: "Brand new follow-up", knowledgeRefs: { entityIds: [], fileIds: ["brief-file-1"] } }),
    ]);
    const after = await countTasks(db);

    expect((run.context.openDurableTasks as Array<{ title: string }>).map((task) => task.title)).toEqual([
      "Open durable task",
    ]);
    expect(priorTitles(run.context.sameDayPreviousOutput)).toEqual(["Open prior todo"]);
    expect(priorTitles(run.context.previousDayOutput)).toEqual(["Open prior todo"]);
    expect(run.instructions).toContain("openDurableTasks");
    expect(after).toBeGreaterThan(before);
  });

  it("with the flag off, omits durable tasks, leaves prior todos intact, and promotes nothing", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Daily Brief User", email: "brief-owner-2@example.com" });
    await seedIndexedFile(db, "brief-file-2", user.id);
    await seedCompletedOutput(db, user.id, OUTPUT_DATE);

    const before = await countTasks(db);
    const run = await runAndCapture(db, user.id, false, OUTPUT_DATE, [
      briefItem({ title: "Flag-off emitted todo", knowledgeRefs: { entityIds: [], fileIds: ["brief-file-2"] } }),
    ]);
    const after = await countTasks(db);

    expect(run.context).not.toHaveProperty("openDurableTasks");
    expect(priorTitles(run.context.sameDayPreviousOutput)).toEqual(["Completed prior todo", "Open prior todo"]);
    expect(run.instructions).not.toContain("openDurableTasks");
    expect(after).toBe(before);
  });
});

async function runAndCapture(
  db: Kysely<DB>,
  userId: string,
  experimentalFlag: boolean,
  outputDate: string,
  items: AgentOutputItemInput[],
): Promise<{ context: Record<string, unknown>; instructions: string }> {
  const queued: Array<() => Promise<void>> = [];
  const capturedParams: RunAgentParams[] = [];
  const service = new AgentRunService({
    db,
    config: createTestConfig({ EXPERIMENTAL_FLAG: experimentalFlag }),
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
    queueManager: createPausedQueueManager(queued),
  });

  const row = await service.requestGenerationForUser({
    agentKey: DAILY_BRIEF_AGENT_KEY,
    userId,
    outputDate,
    triggerType: "manual",
  });
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
      },
    }),
  } as unknown as QueueManager;
}

async function seedCompletedOutput(db: Kysely<DB>, userId: string, outputDate: string): Promise<void> {
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
    trace: { progressEvents: [], finalText: "Done" },
  };
}
