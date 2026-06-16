import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAILY_BRIEF_AGENT_KEY,
  DAILY_BRIEF_AGENT_VERSION,
  type DailyBriefItemInput,
  createDailyBriefRepository,
} from "../db/repositories/daily-briefs";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { DailyBriefService, type DailyBriefServiceDeps } from "./service";

const NOW = new Date("2026-06-15T08:05:00.000Z");
const BRIEF_DATE = "2026-06-15";

function createPausedQueueManager(tasks: Array<() => Promise<void>>): QueueManager {
  return {
    getQueue: () => ({
      enqueue: (task: () => Promise<void>) => {
        tasks.push(task);
      },
    }),
  } as unknown as QueueManager;
}

function createService(db: Kysely<DB>, tasks: Array<() => Promise<void>>): DailyBriefService {
  const runAgent = vi.fn(async () => {
    throw new Error("runAgent should not be called by these tests");
  }) as unknown as DailyBriefServiceDeps["runAgent"];
  return new DailyBriefService({
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
  item: DailyBriefItemInput,
): DailyBriefService {
  const runAgent = vi.fn(async (params) => {
    if (!params.dailyBriefWriter) throw new Error("dailyBriefWriter missing");
    await params.dailyBriefWriter.write({
      briefDate: BRIEF_DATE,
      timezone: "UTC",
      masthead: { title: "Daily Brief", summary: "Summary" },
      rawPayload: {},
      items: [item],
    });
    return {
      messageSent: true,
      sessionId: "daily-brief-session",
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
  }) as unknown as DailyBriefServiceDeps["runAgent"];
  return new DailyBriefService({
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
    .values({ id: "daily-brief-owner", name: "Daily Brief Owner" })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "daily-brief-connector",
      connector_type: "google-drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "daily-brief-owner",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: params.id,
      connector_config_id: "daily-brief-connector",
      provider_file_id: `provider-${params.id}`,
      file_name: `${params.id}.md`,
      file_type: "document",
      content_category: "document",
      source: "google-drive",
      source_path: null,
      provider_url: params.providerUrl,
      content: "Daily brief source content",
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

function dailyBriefItem(overrides: Partial<DailyBriefItemInput> = {}): DailyBriefItemInput {
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

describe("DailyBriefService", () => {
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

  it("supersedes stale running briefs instead of returning them forever", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Daily Brief User", email: "user@example.com" });
    const staleAt = new Date(NOW.getTime() - 31 * 60 * 1000).toISOString();
    await db
      .insertInto("daily_briefs")
      .values({
        id: "stale-brief",
        user_id: user.id,
        brief_date: BRIEF_DATE,
        timezone: "UTC",
        status: "running",
        trigger_type: "manual",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        created_at: staleAt,
        updated_at: staleAt,
      })
      .execute();

    const service = createService(db, tasks);
    const replacement = await service.requestGenerationForUser({
      userId: user.id,
      briefDate: BRIEF_DATE,
      triggerType: "manual",
    });

    const stale = await db.selectFrom("daily_briefs").selectAll().where("id", "=", "stale-brief").executeTakeFirst();
    const running = await db
      .selectFrom("daily_briefs")
      .selectAll()
      .where("user_id", "=", user.id)
      .where("brief_date", "=", BRIEF_DATE)
      .where("status", "=", "running")
      .execute();

    expect(stale?.status).toBe("failed");
    expect(stale?.error_message).toBe("Brief generation expired after being left running.");
    expect(replacement?.id).not.toBe("stale-brief");
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe(replacement?.id);
    expect(tasks).toHaveLength(1);
  });

  it("does not report stale running briefs as active on latest reads", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Daily Brief User", email: "user@example.com" });
    const staleAt = new Date(NOW.getTime() - 31 * 60 * 1000).toISOString();
    await db
      .insertInto("daily_briefs")
      .values({
        id: "stale-brief",
        user_id: user.id,
        brief_date: BRIEF_DATE,
        timezone: "UTC",
        status: "running",
        trigger_type: "manual",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        created_at: staleAt,
        updated_at: staleAt,
      })
      .execute();

    const service = createService(db, tasks);
    const latest = await service.getLatestForUser(user.id, BRIEF_DATE);

    expect(latest.running).toBe(false);
    expect(latest.brief).toBeNull();
  });

  it("coalesces duplicate running brief creation for the same user and date", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Daily Brief User", email: "user@example.com" });
    const repo = createDailyBriefRepository(db);

    const first = await repo.createRunning({
      userId: user.id,
      briefDate: BRIEF_DATE,
      timezone: "UTC",
      triggerType: "manual",
    });
    const second = await repo.createRunning({
      userId: user.id,
      briefDate: BRIEF_DATE,
      timezone: "UTC",
      triggerType: "manual",
    });
    const running = await db
      .selectFrom("daily_briefs")
      .selectAll()
      .where("user_id", "=", user.id)
      .where("brief_date", "=", BRIEF_DATE)
      .where("status", "=", "running")
      .execute();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(running).toHaveLength(1);
  });

  it("rejects stale writer completion after a running brief has been superseded", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Daily Brief User", email: "user@example.com" });
    const repo = createDailyBriefRepository(db);
    await db
      .insertInto("daily_briefs")
      .values({
        id: "superseded-brief",
        user_id: user.id,
        brief_date: BRIEF_DATE,
        timezone: "UTC",
        status: "failed",
        trigger_type: "manual",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        error_message: "Brief generation expired after being left running.",
        created_at: new Date(NOW.getTime() - 31 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    await db
      .insertInto("daily_brief_items")
      .values({
        id: "existing-item",
        daily_brief_id: "superseded-brief",
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
      repo.completeBrief({
        briefId: "superseded-brief",
        masthead: { title: "Daily Brief", summary: "Summary" },
        rawPayload: {},
        items: [dailyBriefItem({ title: "Late stale item" })],
      }),
    ).rejects.toThrow("Daily Brief generation is no longer running.");

    const brief = await db
      .selectFrom("daily_briefs")
      .select(["status", "generated_at"])
      .where("id", "=", "superseded-brief")
      .executeTakeFirstOrThrow();
    const items = await db
      .selectFrom("daily_brief_items")
      .select(["id", "title"])
      .where("daily_brief_id", "=", "superseded-brief")
      .execute();

    expect(brief.status).toBe("failed");
    expect(brief.generated_at).toBeNull();
    expect(items).toEqual([{ id: "existing-item", title: "Existing item" }]);
  });

  it("uses referenced file provider URLs instead of agent-provided source URLs", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Daily Brief User", email: "user@example.com" });
    await seedIndexedFile(db, { id: "safe-source-file", providerUrl: "https://docs.example.com/source" });
    const service = createWritingService(
      db,
      tasks,
      dailyBriefItem({
        sourceUrl: "javascript:alert(1)",
        knowledgeRefs: { entityIds: [], fileIds: ["safe-source-file"] },
      }),
    );

    const row = await service.requestGenerationForUser({
      userId: user.id,
      briefDate: BRIEF_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated daily brief row");
    await tasks[0]();
    const brief = await service.getByIdForUser(row.id, user.id);

    expect(brief?.sections.todos[0].sourceUrl).toBe("https://docs.example.com/source");
  });

  it("drops agent-provided source URLs when referenced files have no provider URL", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Daily Brief User", email: "user@example.com" });
    await seedIndexedFile(db, { id: "source-file-without-url", providerUrl: null });
    const service = createWritingService(
      db,
      tasks,
      dailyBriefItem({
        sourceUrl: "https://phishing.example.com/source",
        knowledgeRefs: { entityIds: [], fileIds: ["source-file-without-url"] },
      }),
    );

    const row = await service.requestGenerationForUser({
      userId: user.id,
      briefDate: BRIEF_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated daily brief row");
    await tasks[0]();
    const brief = await service.getByIdForUser(row.id, user.id);

    expect(brief?.sections.todos[0].sourceUrl).toBeNull();
  });

  it("suppresses recent failed scheduled attempts during the schedule window", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Daily Brief User", email: "user@example.com" });
    await db
      .insertInto("daily_briefs")
      .values({
        id: "failed-scheduled-brief",
        user_id: user.id,
        brief_date: BRIEF_DATE,
        timezone: "UTC",
        status: "failed",
        trigger_type: "scheduled",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        error_message: "Agent failed",
        created_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        updated_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
      })
      .execute();

    const service = createService(db, tasks);
    const userRow = await users.findById(user.id);
    const shouldGenerate = await service.shouldGenerateForUser(userRow ?? user, NOW);
    const request = await service.requestGenerationForUser({
      userId: user.id,
      briefDate: BRIEF_DATE,
      triggerType: "scheduled",
      skipIfCompleted: true,
    });

    const rows = await db
      .selectFrom("daily_briefs")
      .select(["id", "status"])
      .where("user_id", "=", user.id)
      .where("brief_date", "=", BRIEF_DATE)
      .execute();

    expect(shouldGenerate).toBeNull();
    expect(request?.id).toBe("failed-scheduled-brief");
    expect(rows).toEqual([{ id: "failed-scheduled-brief", status: "failed" }]);
    expect(tasks).toHaveLength(0);
  });
});
