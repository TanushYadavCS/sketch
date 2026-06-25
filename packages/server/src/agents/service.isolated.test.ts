import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentOutputItemInput, createAgentOutputRepository } from "../db/repositories/agent-outputs";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { DAILY_BRIEF_AGENT_KEY, DAILY_BRIEF_AGENT_VERSION, dailyBriefDefinition } from "./definitions/daily-brief";
import { AgentRunService, type AgentRunServiceDeps } from "./service";

const NOW = new Date("2026-06-15T08:05:00.000Z");
const OUTPUT_DATE = "2026-06-15";

function createPausedQueueManager(tasks: Array<() => Promise<void>>): QueueManager {
  return {
    getQueue: () => ({
      enqueue: (task: () => Promise<void>) => {
        tasks.push(task);
      },
    }),
  } as unknown as QueueManager;
}

function createService(db: Kysely<DB>, tasks: Array<() => Promise<void>>): AgentRunService {
  const runAgent = vi.fn(async () => {
    throw new Error("runAgent should not be called by these tests");
  }) as unknown as AgentRunServiceDeps["runAgent"];
  return new AgentRunService({
    db,
    config: createTestConfig(),
    logger: createTestLogger(),
    users: createUserRepository(db),
    settings: createSettingsRepository(db),
    runAgent,
    queueManager: createPausedQueueManager(tasks),
  });
}

function createWritingService(
  db: Kysely<DB>,
  tasks: Array<() => Promise<void>>,
  item: AgentOutputItemInput,
): AgentRunService {
  const runAgent = vi.fn(async (params) => {
    if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
    await params.agentOutputWriter.write({
      outputDate: OUTPUT_DATE,
      timezone: "UTC",
      masthead: { title: "Daily Brief", summary: "Summary" },
      rawPayload: {},
      items: [item],
    });
    return {
      messageSent: true,
      sessionId: "agent-session",
      costUsd: 0,
      pendingUploads: [],
      durationMs: 0,
      durationApiMs: 0,
      numTurns: 0,
      stopReason: null,
      errorSubtype: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      model: null,
      isResumedSession: false,
      totalAttachments: 0,
      imageCount: 0,
      nonImageCount: 0,
      mimeTypes: [],
      fileSizes: [],
      promptMode: "text" as const,
      toolCalls: [],
      auxLlmCalls: [],
      sdkCostUsd: 0,
      rawUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      trace: { progressEvents: [], finalText: "Done" },
    };
  }) as unknown as AgentRunServiceDeps["runAgent"];
  return new AgentRunService({
    db,
    config: createTestConfig(),
    logger: createTestLogger(),
    users: createUserRepository(db),
    settings: createSettingsRepository(db),
    runAgent,
    queueManager: createPausedQueueManager(tasks),
  });
}

async function seedIndexedFile(db: Kysely<DB>, params: { id: string; providerUrl: string | null }): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: "agent-owner", name: "Agent Owner" })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "agent-connector",
      connector_type: "google-drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "agent-owner",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: params.id,
      connector_config_id: "agent-connector",
      provider_file_id: `provider-${params.id}`,
      file_name: `${params.id}.md`,
      file_type: "document",
      content_category: "document",
      source: "google-drive",
      source_path: null,
      provider_url: params.providerUrl,
      content: "Agent source content",
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
    title: "Follow up with customer",
    summary: "Customer asked for a status update.",
    priority: "high",
    label: "todo",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
    ...overrides,
  };
}

describe("AgentRunService", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.destroy();
  });

  it("supersedes stale running outputs instead of returning them forever", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const staleAt = new Date(NOW.getTime() - 31 * 60 * 1000).toISOString();
    await db
      .insertInto("agent_outputs")
      .values({
        id: "stale-output",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        user_id: user.id,
        output_date: OUTPUT_DATE,
        timezone: "UTC",
        status: "running",
        trigger_type: "manual",
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        created_at: staleAt,
        updated_at: staleAt,
      })
      .execute();

    const service = createService(db, tasks);
    const replacement = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });

    const stale = await db.selectFrom("agent_outputs").selectAll().where("id", "=", "stale-output").executeTakeFirst();
    const running = await db
      .selectFrom("agent_outputs")
      .selectAll()
      .where("user_id", "=", user.id)
      .where("output_date", "=", OUTPUT_DATE)
      .where("status", "=", "running")
      .execute();

    expect(stale?.status).toBe("failed");
    expect(stale?.error_message).toBe("Generation expired after being left running.");
    expect(replacement?.id).not.toBe("stale-output");
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe(replacement?.id);
    expect(tasks).toHaveLength(1);
  });

  it("does not report stale running outputs as active on latest reads", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const staleAt = new Date(NOW.getTime() - 31 * 60 * 1000).toISOString();
    await db
      .insertInto("agent_outputs")
      .values({
        id: "stale-output",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        user_id: user.id,
        output_date: OUTPUT_DATE,
        timezone: "UTC",
        status: "running",
        trigger_type: "manual",
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        created_at: staleAt,
        updated_at: staleAt,
      })
      .execute();

    const service = createService(db, tasks);
    const latest = await service.getLatestForUser(DAILY_BRIEF_AGENT_KEY, user.id, OUTPUT_DATE);

    expect(latest.running).toBe(false);
    expect(latest.output).toBeNull();
  });

  it("coalesces duplicate running output creation for the same agent, user, and date", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const repo = createAgentOutputRepository(db);

    const first = await repo.createRunning({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      agentVersion: DAILY_BRIEF_AGENT_VERSION,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      timezone: "UTC",
      triggerType: "manual",
    });
    const second = await repo.createRunning({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      agentVersion: DAILY_BRIEF_AGENT_VERSION,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      timezone: "UTC",
      triggerType: "manual",
    });
    const running = await db
      .selectFrom("agent_outputs")
      .selectAll()
      .where("user_id", "=", user.id)
      .where("output_date", "=", OUTPUT_DATE)
      .where("status", "=", "running")
      .execute();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(running).toHaveLength(1);
  });

  it("rejects stale writer completion after a running output has been superseded", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const repo = createAgentOutputRepository(db);
    await db
      .insertInto("agent_outputs")
      .values({
        id: "superseded-output",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        user_id: user.id,
        output_date: OUTPUT_DATE,
        timezone: "UTC",
        status: "failed",
        trigger_type: "manual",
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        error_message: "Generation expired after being left running.",
        created_at: new Date(NOW.getTime() - 31 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    await db
      .insertInto("agent_output_items")
      .values({
        id: "existing-item",
        agent_output_id: "superseded-output",
        section_key: "todos",
        title: "Existing item",
        summary: "Existing summary",
        priority: "high",
        label: "todo",
        display_ref: null,
        action_type: null,
        action_label: null,
        action_prompt: null,
        knowledge_refs_json: JSON.stringify({ entityIds: [], fileIds: [] }),
        source_url: null,
        sort_order: 0,
        created_at: new Date().toISOString(),
      })
      .execute();

    await expect(
      repo.completeOutput({
        outputId: "superseded-output",
        masthead: { title: "Daily Brief", summary: "Summary" },
        rawPayload: {},
        items: [briefItem({ title: "Late stale item" })],
      }),
    ).rejects.toThrow("Agent output generation is no longer running.");

    const output = await db
      .selectFrom("agent_outputs")
      .select(["status", "generated_at"])
      .where("id", "=", "superseded-output")
      .executeTakeFirstOrThrow();
    const items = await db
      .selectFrom("agent_output_items")
      .select(["id", "title"])
      .where("agent_output_id", "=", "superseded-output")
      .execute();

    expect(output.status).toBe("failed");
    expect(output.generated_at).toBeNull();
    expect(items).toEqual([{ id: "existing-item", title: "Existing item" }]);
  });

  it("uses referenced file provider URLs instead of agent-provided source URLs", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    await seedIndexedFile(db, { id: "safe-source-file", providerUrl: "https://docs.example.com/source" });
    const service = createWritingService(
      db,
      tasks,
      briefItem({
        sourceUrl: "javascript:alert(1)",
        knowledgeRefs: { entityIds: [], fileIds: ["safe-source-file"] },
      }),
    );

    const row = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();
    const output = await service.getByIdForUser(DAILY_BRIEF_AGENT_KEY, row.id, user.id);

    expect(output?.sections.todos[0].sourceUrl).toBe("https://docs.example.com/source");
  });

  it("drops agent-provided source URLs when referenced files have no provider URL", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    await seedIndexedFile(db, { id: "source-file-without-url", providerUrl: null });
    const service = createWritingService(
      db,
      tasks,
      briefItem({
        sourceUrl: "https://phishing.example.com/source",
        knowledgeRefs: { entityIds: [], fileIds: ["source-file-without-url"] },
      }),
    );

    const row = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();
    const output = await service.getByIdForUser(DAILY_BRIEF_AGENT_KEY, row.id, user.id);

    expect(output?.sections.todos[0].sourceUrl).toBeNull();
  });

  it("suppresses recent failed scheduled attempts during the schedule window", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    await db
      .insertInto("agent_outputs")
      .values({
        id: "failed-scheduled-output",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        user_id: user.id,
        output_date: OUTPUT_DATE,
        timezone: "UTC",
        status: "failed",
        trigger_type: "scheduled",
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        error_message: "Agent failed",
        created_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        updated_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
      })
      .execute();

    const service = createService(db, tasks);
    const userRow = await users.findById(user.id);
    const shouldGenerate = await service.shouldGenerateForUser(dailyBriefDefinition, userRow ?? user, NOW);
    const request = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
      skipIfCompleted: true,
    });

    const rows = await db
      .selectFrom("agent_outputs")
      .select(["id", "status"])
      .where("user_id", "=", user.id)
      .where("output_date", "=", OUTPUT_DATE)
      .execute();

    expect(shouldGenerate).toBeNull();
    expect(request?.id).toBe("failed-scheduled-output");
    expect(rows).toEqual([{ id: "failed-scheduled-output", status: "failed" }]);
    expect(tasks).toHaveLength(0);
  });

  it("persists section toggles and focus, and disables the agent when reconfigured", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const service = createService(db, []);

    const updated = await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
      enabled: false,
      scheduleHour: 9,
      sections: { customer_updates: false },
      focus: "  Prioritize enterprise accounts  ",
    });

    expect(updated?.enabled).toBe(false);
    expect(updated?.scheduleHour).toBe(9);
    expect(updated?.focus).toBe("Prioritize enterprise accounts");
    const customer = updated?.sections.find((s) => s.key === "customer_updates");
    const todos = updated?.sections.find((s) => s.key === "todos");
    expect(customer?.enabled).toBe(false);
    expect(todos?.enabled).toBe(true);

    const reread = await service.getConfigView(DAILY_BRIEF_AGENT_KEY, user.id);
    expect(reread?.enabled).toBe(false);
    expect(reread?.focus).toBe("Prioritize enterprise accounts");
    expect(reread?.sections.find((s) => s.key === "customer_updates")?.enabled).toBe(false);

    const latest = await service.getLatestForUser(DAILY_BRIEF_AGENT_KEY, user.id);
    expect(latest.enabledSections).toContain("todos");
    expect(latest.enabledSections).not.toContain("customer_updates");
  });
});
