import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAgentParams, RunAgentResult } from "../agent/runner";
import {
  type AgentOutputItemInput,
  type AgentOutputWithItems,
  createAgentOutputRepository,
} from "../db/repositories/agent-outputs";
import { createSettingsRepository } from "../db/repositories/settings";
import { createTaskRepository } from "../db/repositories/tasks";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
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

  it("passes only reader-owned structural and local tasks into the runtime context", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Daily Brief User",
      email: "brief-owner@example.com",
      emailVerified: true,
    });
    await seedAssignablePerson(db, "person-brief-owner", "Daily Brief User", "brief-owner@example.com");
    await seedAssignablePerson(db, "person-other", "Other Person", "other@example.com");
    await seedIndexedFile(db, "visible-file", user.id);
    await seedIndexedFile(db, "invisible-file", user.id, "other@example.com");

    await seedDurableTask(db, {
      sourceTaskId: "reader-structural",
      title: "Reader structural",
      provenance: "structural",
      assigneeEntityId: "person-brief-owner",
      fileIds: ["visible-file"],
    });
    await seedDurableTask(db, {
      sourceTaskId: "other-structural",
      title: "Other structural",
      provenance: "structural",
      assigneeEntityId: "person-other",
      fileIds: ["visible-file"],
    });
    await seedDurableTask(db, {
      sourceTaskId: "unassigned-structural",
      title: "Unassigned structural",
      provenance: "structural",
      fileIds: ["visible-file"],
    });
    await seedDurableTask(db, {
      sourceTaskId: "invisible-structural",
      title: "Invisible structural",
      provenance: "structural",
      assigneeEntityId: "person-brief-owner",
      fileIds: ["invisible-file"],
    });
    await seedDurableTask(db, {
      sourceTaskId: "reader-created-local",
      title: "Reader-created local",
      provenance: "summary",
      createdByUserId: user.id,
      fileIds: ["visible-file"],
    });
    await seedDurableTask(db, {
      sourceTaskId: "reader-assigned-local",
      title: "Reader-assigned local",
      provenance: "summary",
      assigneeEntityId: "person-brief-owner",
      fileIds: ["visible-file"],
    });
    await seedDurableTask(db, {
      sourceTaskId: "unrelated-local",
      title: "Unrelated local",
      provenance: "summary",
      fileIds: ["visible-file"],
    });

    const run = await runAndCapture(db, user.id, OUTPUT_DATE, []);
    const tasks = run.context.openDurableTasks as Array<{ title: string }>;

    expect(tasks.map((task) => task.title)).toEqual(
      expect.arrayContaining(["Reader structural", "Reader-created local", "Reader-assigned local"]),
    );
    expect(tasks).toHaveLength(3);
    expect(run.instructions).toContain("openDurableTasks");
  });

  it("does not admit structural tasks by matching the reader name without verified email linkage", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Name Match",
      email: "reader@example.com",
      emailVerified: true,
    });
    await seedAssignablePerson(db, "person-name-match", "Name Match");
    await seedIndexedFile(db, "visible-file", user.id);
    await seedDurableTask(db, {
      sourceTaskId: "name-only-structural",
      title: "Name-only structural",
      provenance: "structural",
      assigneeEntityId: "person-name-match",
      fileIds: ["visible-file"],
    });
    await seedDurableTask(db, {
      sourceTaskId: "reader-local",
      title: "Reader local",
      provenance: "summary",
      createdByUserId: user.id,
      fileIds: ["visible-file"],
    });

    const run = await runAndCapture(db, user.id, OUTPUT_DATE, []);

    expect((run.context.openDurableTasks as Array<{ title: string }>).map((task) => task.title)).toEqual([
      "Reader local",
    ]);
    expect(run.context.identityUnresolvedTaskCount).toBe(1);
  });

  it("scrubs completed prior todos and excludes done durable tasks from runtime context", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Daily Brief User",
      email: "brief-owner@example.com",
      emailVerified: true,
    });
    await seedCompletedOutput(db, user.id, OUTPUT_DATE);
    await seedCompletedOutput(db, user.id, PREVIOUS_DATE);
    await seedDurableTask(db, {
      sourceTaskId: "reader-open-local",
      title: "Open reader-owned durable task",
      provenance: "summary",
      createdByUserId: user.id,
    });
    await seedDurableTask(db, {
      sourceTaskId: "reader-done-local",
      title: "Done reader-owned durable task",
      provenance: "summary",
      status: "done",
      createdByUserId: user.id,
    });

    const run = await runAndCapture(db, user.id, OUTPUT_DATE, []);

    expect(priorTitles(run.context.sameDayPreviousOutput)).toEqual(["Open prior todo"]);
    expect(priorTitles(run.context.previousDayOutput)).toEqual(["Open prior todo"]);
    expect((run.context.openDurableTasks as Array<{ title: string }>).map((task) => task.title)).toEqual([
      "Open reader-owned durable task",
    ]);
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

  it("drops broad-search todos without an allowlisted durable id from persisted output", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Daily Brief User",
      email: "brief-owner@example.com",
      emailVerified: true,
    });
    await seedIndexedFile(db, "brief-file-1", user.id);

    const run = await runAndCapture(db, user.id, OUTPUT_DATE, [
      briefItem({
        title: "Inferred from broad search",
        structuredPayload: {},
        knowledgeRefs: { entityIds: [], fileIds: ["brief-file-1"] },
      }),
      briefItem({
        title: "Unknown durable task",
        structuredPayload: { durableTaskId: "unknown-task-id" },
        knowledgeRefs: { entityIds: [], fileIds: ["brief-file-1"] },
        sortOrder: 1,
      }),
    ]);

    expect(run.output.items).toEqual([]);
  });

  it("persists canonical data for an allowlisted durable id without increasing task count when creation is enabled", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Daily Brief User",
      email: "brief-owner@example.com",
      emailVerified: true,
    });
    await seedAssignablePerson(db, "person-brief-owner", "Daily Brief User", "brief-owner@example.com");
    await seedProject(db, "project-x", "Project X");
    await seedIndexedFile(db, "brief-file-1", user.id);
    const taskId = await seedDurableTask(db, {
      sourceTaskId: "canonical-structural",
      title: "Canonical durable title",
      provenance: "structural",
      status: "in_progress",
      priority: "urgent",
      externalRef: "SKE-321",
      assigneeEntityId: "person-brief-owner",
      parentEntityId: "project-x",
      fileIds: ["brief-file-1"],
    });
    const before = await countTasks(db);

    const run = await runAndCapture(
      db,
      user.id,
      OUTPUT_DATE,
      [
        briefItem({
          title: "Invented model title",
          summary: "Model-authored context survives.",
          priority: "low",
          label: "blocked",
          structuredPayload: { durableTaskId: taskId, unrelated: "discard me" },
          knowledgeRefs: { entityIds: ["unknown-model-entity"], fileIds: ["unknown-model-file"] },
        }),
      ],
      { createTasks: true },
    );
    const after = await countTasks(db);

    expect(run.output.items).toEqual([
      expect.objectContaining({
        section_key: "todos",
        title: "Canonical durable title",
        summary: "Model-authored context survives.",
        priority: "high",
        label: "in_progress",
        display_ref: "SKE-321",
        structuredPayload: { durableTaskId: taskId },
        knowledgeRefs: {
          entityIds: ["person-brief-owner", "project-x"],
          fileIds: ["brief-file-1"],
        },
      }),
    ]);
    expect(after).toBe(before);
    expect(run.context.createTasks).toBe(true);
  });

  it("preserves admin-visible non-todo sections and emits aggregate-only reconciliation metrics", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Admin User",
      email: "admin@example.com",
      emailVerified: true,
      authRole: "admin",
    });
    await seedProject(db, "admin-project", "Admin-visible project");
    await seedIndexedFile(db, "restricted-file", user.id, "someone-else@example.com");
    await db
      .updateTable("indexed_files")
      .set({ source_updated_at: "2026-06-15T08:00:00.000Z" })
      .where("id", "=", "restricted-file")
      .execute();
    await seedMention(db, "admin-project-mention", "admin-project", "restricted-file");
    const settings = createSettingsRepository(db);
    await settings.ensure();
    await settings.update({ adminCanReadAllFiles: true });
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const customer = briefItem({
      sectionKey: "customer_updates",
      title: "Customer remains visible",
      summary: "Customer model summary",
      label: "warm",
      knowledgeRefs: { entityIds: ["admin-project"], fileIds: ["restricted-file"] },
    });
    const project = briefItem({
      sectionKey: "active_projects",
      title: "Project remains visible",
      summary: "Project model summary",
      label: "active",
      knowledgeRefs: { entityIds: ["admin-project"], fileIds: ["restricted-file"] },
      sortOrder: 1,
    });

    const run = await runAndCapture(
      db,
      user.id,
      OUTPUT_DATE,
      [
        briefItem({
          title: "Sensitive inferred todo title",
          summary: "Sensitive inferred todo content",
          structuredPayload: {},
          knowledgeRefs: { entityIds: ["admin-project"], fileIds: ["restricted-file"] },
        }),
        customer,
        project,
      ],
      {},
      logger,
    );

    expect(JSON.stringify(run.context.dailyBriefCandidateContext)).toContain("Admin-visible project");
    expect(run.output.items.map((item) => item.title)).toEqual(["Project remains visible", "Customer remains visible"]);
    const reconciliationCall = info.mock.calls.find((call) => call[1] === "Daily Brief: todo reconciliation");
    expect(reconciliationCall?.[0]).toEqual({
      outputId: run.output.output.id,
      userId: user.id,
      allowedTaskCount: 0,
      rejectedTaskCount: 1,
      backfilledTaskCount: 0,
      identityUnresolvedTaskCount: 0,
    });
    expect(JSON.stringify(reconciliationCall)).not.toMatch(
      /Sensitive inferred todo title|Sensitive inferred todo content|Customer model summary|Project model summary/,
    );
  });
});

async function runAndCapture(
  db: Kysely<DB>,
  userId: string,
  outputDate: string,
  items: AgentOutputItemInput[],
  configPatch: { createTasks?: boolean } = {},
  logger: Logger = createTestLogger(),
): Promise<{ context: Record<string, unknown>; instructions: string; output: AgentOutputWithItems }> {
  const queued: Array<() => Promise<void>> = [];
  const capturedParams: RunAgentParams[] = [];
  const service = new AgentRunService({
    db,
    config: createTestConfig(),
    logger,
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

  const [row] = await service.requestGenerationForUser({
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
  const output = await createAgentOutputRepository(db).getByIdForUser(DAILY_BRIEF_AGENT_KEY, row.id, userId);
  if (!output) throw new Error("Expected a persisted output");
  return {
    context: parseRuntimeContext(params.userMessage),
    instructions: params.agentInstructions ?? "",
    output,
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

async function seedIndexedFile(db: Kysely<DB>, id: string, userId: string, restrictedTo?: string): Promise<void> {
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
  if (restrictedTo) {
    await db.insertInto("file_access").values({ indexed_file_id: id, email: restrictedTo }).execute();
  }
}

async function seedAssignablePerson(db: Kysely<DB>, id: string, name: string, email?: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "person",
      subtype: null,
      aliases: email ? JSON.stringify([email]) : null,
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ai_brief: null,
    })
    .execute();
  if (email) {
    await db
      .insertInto("entity_contact_points")
      .values({
        id: `${id}-email`,
        entity_id: id,
        kind: "email",
        value: email.toLowerCase(),
        display_value: email,
        label: null,
        source: "test",
        connector_config_id: null,
        created_by_user_id: null,
        verified_at: new Date().toISOString(),
        last_contacted_at: null,
      })
      .execute();
  }
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

async function seedMention(db: Kysely<DB>, id: string, entityId: string, fileId: string): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id,
      entity_id: entityId,
      indexed_file_id: fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
      mentioned_at: "2026-06-15T08:00:00.000Z",
    })
    .execute();
}

async function seedDurableTask(
  db: Kysely<DB>,
  params: {
    sourceTaskId: string;
    title: string;
    provenance: "structural" | "brief" | "summary";
    status?: "open" | "in_progress" | "done";
    priority?: string | null;
    externalRef?: string | null;
    assigneeEntityId?: string | null;
    parentEntityId?: string | null;
    createdByUserId?: string | null;
    fileIds?: string[];
  },
): Promise<string> {
  const repo = createTaskRepository(db);
  const result = await repo.upsertTask({
    parentEntityId: params.parentEntityId ?? null,
    parentSourceRef: null,
    parentName: null,
    source: params.provenance === "structural" ? "linear" : params.provenance,
    externalRef: params.externalRef ?? null,
    title: params.title,
    status: params.status ?? "open",
    statusRaw: params.status ?? "open",
    statusAuthority: params.provenance === "structural" ? "external" : "local",
    assigneeEntityId: params.assigneeEntityId ?? null,
    priority: params.priority ?? null,
    dueAt: null,
    provenance: params.provenance,
    sourceTaskId: params.sourceTaskId,
    createdByUserId: params.createdByUserId ?? null,
  });
  for (const fileId of params.fileIds ?? []) await repo.upsertEvidence(result.taskId, "file", fileId);
  return result.taskId;
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
