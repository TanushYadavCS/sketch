import { createHash } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentOutputItemInput,
  type AgentRoute,
  createAgentOutputRepository,
} from "../../db/repositories/agent-outputs";
import { createTaskRepository } from "../../db/repositories/tasks";
import { createUserRepository } from "../../db/repositories/users";
import type { DB, UsersTable } from "../../db/schema";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";
import {
  DAILY_BRIEF_ENTITY_WINDOW_DAYS,
  DAILY_BRIEF_EVIDENCE_WINDOW_DAYS,
  DAILY_BRIEF_MEETINGS_SECTION_KEY,
  type TodaysMeeting,
  buildDailyBriefCandidateContext,
  buildTodaysMeetings,
  dailyBriefDefinition,
} from "./daily-brief";

const NOW = new Date("2026-06-25T08:00:00.000Z");

async function seedUser(
  db: Kysely<DB>,
  params: { id?: string; email?: string; authRole?: "member" | "admin" } = {},
): Promise<Selectable<UsersTable>> {
  const id = params.id ?? "user-1";
  await db
    .insertInto("users")
    .values({
      id,
      name: "Agent User",
      email: params.email ?? "agent@example.com",
      auth_role: params.authRole ?? "member",
    })
    .execute();
  return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

async function seedConnectorConfig(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "config-1",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      created_by: "user-1",
      scope_config: "{}",
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, params: { id: string; name: string; hotness?: number }): Promise<void> {
  const now = NOW.toISOString();
  await db
    .insertInto("entities")
    .values({
      id: params.id,
      name: params.name,
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: params.hotness ?? 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
}

async function seedIndexedFile(
  db: Kysely<DB>,
  params: { id: string; sourceUpdatedAt: string; restrictedTo?: string },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: params.id,
      connector_config_id: "config-1",
      provider_file_id: `provider-${params.id}`,
      file_name: `${params.id}.md`,
      file_type: "meeting_transcript",
      content_category: "document",
      source: "fireflies",
      source_path: null,
      provider_url: null,
      content: "brief evidence",
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      source_updated_at: params.sourceUpdatedAt,
      source_created_at: null,
      synced_at: NOW.toISOString(),
      embedding_status: "pending",
    })
    .execute();

  if (params.restrictedTo) {
    await db.insertInto("file_access").values({ indexed_file_id: params.id, email: params.restrictedTo }).execute();
  }
}

async function seedMention(
  db: Kysely<DB>,
  params: { id: string; entityId: string; fileId: string; mentionedAt?: string },
): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id: params.id,
      entity_id: params.entityId,
      indexed_file_id: params.fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
      mentioned_at: params.mentionedAt ?? NOW.toISOString(),
    })
    .execute();
}

describe("dailyBriefDefinition.buildInstructions", () => {
  it("is static and defers per-user values to the runtime context (prompt-cache safe)", () => {
    const instructions = dailyBriefDefinition.buildInstructions();

    expect(instructions).toContain("runtime context `sections`");
    expect(instructions).toContain("runtime context `maxItemsPerSection`");
    expect(instructions).toContain("`focus` field");
    expect(instructions).toContain("dailyBriefCandidateContext");
    expect(instructions).toContain("taskAttention");
    expect(instructions).toContain("Known Task Memory");
    expect(instructions).toContain("pending_completion_review");
    expect(instructions).toContain("Do not claim that a task changed");
    expect(instructions).toContain("produce fewer todos");
    expect(instructions).toContain("evidenceSince");
    expect(instructions).toContain("windowEnd");

    expect(instructions).toContain("todos:");
    expect(instructions).toContain("customer_updates:");
    expect(instructions).toContain("active_projects:");

    expect(instructions).not.toMatch(/at most \d+ items/);
  });
});

describe("dailyBriefDefinition.onOutputSaved task linking", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
    await db.updateTable("users").set({ email_verified_at: NOW.toISOString() }).where("id", "=", "user-1").execute();
    await db
      .insertInto("entities")
      .values({
        id: "person-1",
        name: "Agent User",
        source_type: "person",
        subtype: null,
        aliases: null,
        metadata: JSON.stringify({ email: "agent@example.com" }),
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
        ai_brief: null,
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function persistItems(items: AgentOutputItemInput[]) {
    const repo = createAgentOutputRepository(db);
    const running = await repo.createRunning({
      agentKey: "daily_brief",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-07-17",
      timezone: "UTC",
      triggerType: "manual",
    });
    const refs = await repo.completeOutput({
      outputId: running.row.id,
      masthead: { title: "Daily Brief", summary: "Summary" },
      rawPayload: {},
      items,
    });
    return {
      outputId: running.row.id,
      persistedItems: refs.map((ref, index) => ({ id: ref.id, item: items[index] })),
    };
  }

  function todo(
    title: string,
    options: {
      projectId?: string;
      fileIds?: string[];
      canonicalTaskId?: string;
      sortOrder?: number;
      priority?: "high" | "medium" | "low";
    } = {},
  ): AgentOutputItemInput {
    return {
      sectionKey: "todos",
      title,
      summary: `${title} snapshot`,
      priority: options.priority ?? "medium",
      label: "todo",
      canonicalTaskId: options.canonicalTaskId,
      structuredPayload: {
        assigneeEntityId: "person-1",
        assigneeName: "Agent User",
      },
      knowledgeRefs: {
        entityIds: options.projectId ? [options.projectId] : [],
        fileIds: options.fileIds ?? ["file-1"],
      },
      sortOrder: options.sortOrder ?? 0,
    };
  }

  async function runHook(params: {
    outputId: string;
    persistedItems: Array<{ id: string; item: AgentOutputItemInput }>;
    items?: AgentOutputItemInput[];
    logger?: ReturnType<typeof createTestLogger>;
  }) {
    await dailyBriefDefinition.onOutputSaved?.({
      db,
      config: createTestConfig(),
      logger: params.logger ?? createTestLogger(),
      userId: "user-1",
      outputId: params.outputId,
      items: params.items ?? params.persistedItems.map((entry) => entry.item),
      persistedItems: params.persistedItems,
      createTasks: true,
      runtimeContext: {},
    });
  }

  it("links an upserted task to the exact persisted item", async () => {
    await seedEntity(db, { id: "project-a", name: "Project A" });
    const item = todo("Prepare launch plan", { projectId: "project-a" });
    const persisted = await persistItems([item]);

    await runHook(persisted);

    const row = await db
      .selectFrom("agent_output_items")
      .innerJoin("tasks", "tasks.id", "agent_output_items.task_id")
      .select(["agent_output_items.id", "tasks.parent_entity_id"])
      .where("agent_output_items.id", "=", persisted.persistedItems[0].id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ id: persisted.persistedItems[0].id, parent_entity_id: "project-a" });
    const activity = await db
      .selectFrom("task_activity_events")
      .innerJoin("tasks", "tasks.id", "task_activity_events.task_id")
      .select([
        "task_activity_events.event_kind",
        "task_activity_events.actor_type",
        "task_activity_events.actor_key",
        "task_activity_events.surface",
        "task_activity_events.source_agent_output_id",
      ])
      .where("tasks.parent_entity_id", "=", "project-a")
      .execute();
    expect(activity).toHaveLength(2);
    expect(activity).toEqual(
      expect.arrayContaining([
        {
          event_kind: "created",
          actor_type: "agent",
          actor_key: "daily_brief",
          surface: "daily_brief",
          source_agent_output_id: persisted.outputId,
        },
        {
          event_kind: "evidence_added",
          actor_type: "agent",
          actor_key: "daily_brief",
          surface: "daily_brief",
          source_agent_output_id: persisted.outputId,
        },
      ]),
    );
  });

  it("records a meaningful Brief task field change once across re-emission", async () => {
    await seedEntity(db, { id: "project-a", name: "Project A" });
    const initial = await persistItems([todo("Prepare launch plan", { projectId: "project-a" })]);
    await runHook(initial);
    const changed = await persistItems([todo("Prepare launch plan", { projectId: "project-a", priority: "high" })]);

    await runHook(changed);
    await runHook(changed);

    const task = await db
      .selectFrom("tasks")
      .select(["id", "priority"])
      .where("parent_entity_id", "=", "project-a")
      .executeTakeFirstOrThrow();
    expect(task.priority).toBe("high");
    await expect(
      db
        .selectFrom("task_activity_events")
        .select(["event_kind", "changes_json", "source_agent_output_id"])
        .where("task_id", "=", task.id)
        .orderBy("event_kind")
        .execute(),
    ).resolves.toEqual([
      {
        event_kind: "created",
        changes_json: null,
        source_agent_output_id: initial.outputId,
      },
      {
        event_kind: "evidence_added",
        changes_json: null,
        source_agent_output_id: initial.outputId,
      },
      {
        event_kind: "fields_changed",
        changes_json: JSON.stringify({ priority: { before: "medium", after: "high" } }),
        source_agent_output_id: changed.outputId,
      },
    ]);
  });

  it("links a collated structural task", async () => {
    await seedEntity(db, { id: "project-a", name: "Project A" });
    await db
      .insertInto("tasks")
      .values({
        id: "structural-task",
        parent_entity_id: "project-a",
        source: "linear",
        title: "Prepare launch plan",
        normalized_title: "prepare launch plan",
        status: "open",
        status_authority: "external",
        provenance: "structural",
        source_task_id: "LIN-1",
      })
      .execute();
    const persisted = await persistItems([todo("Prepare launch plan", { projectId: "project-a" })]);

    await runHook(persisted);

    await expect(
      db
        .selectFrom("agent_output_items")
        .select("task_id")
        .where("id", "=", persisted.persistedItems[0].id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ task_id: "structural-task" });
    await expect(
      db
        .selectFrom("task_activity_events")
        .select(["task_id", "event_kind"])
        .where("task_id", "=", "structural-task")
        .execute(),
    ).resolves.toEqual([{ task_id: "structural-task", event_kind: "evidence_added" }]);
  });

  it("leaves skipped promotion unlinked", async () => {
    const persisted = await persistItems([todo("No evidence task", { fileIds: [] })]);

    await runHook(persisted);

    await expect(
      db
        .selectFrom("agent_output_items")
        .select("task_id")
        .where("id", "=", persisted.persistedItems[0].id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ task_id: null });
  });

  it("rolls back task creation and leaves the item unlinked when promotion fails", async () => {
    await seedEntity(db, { id: "project-a", name: "Project A" });
    const persisted = await persistItems([todo("Fail promotion", { projectId: "project-a" })]);
    await db.schema.dropTable("task_evidence").execute();
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");

    await runHook({ ...persisted, logger });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ outputId: persisted.outputId, userId: "user-1" }),
      "Daily Brief: task promotion failed",
    );
    await expect(db.selectFrom("tasks").select("id").execute()).resolves.toEqual([]);
    await expect(
      db
        .selectFrom("agent_output_items")
        .select("task_id")
        .where("id", "=", persisted.persistedItems[0].id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ task_id: null });
  });

  it("skips promotion for a server-linked durable item", async () => {
    await db
      .insertInto("tasks")
      .values({
        id: "durable-task",
        source: "summary",
        title: "Durable task",
        normalized_title: "durable task",
        status: "open",
        status_authority: "local",
        provenance: "summary",
        source_task_id: "durable-task",
        created_by_user_id: "user-1",
      })
      .execute();
    const persisted = await persistItems([todo("Durable task", { canonicalTaskId: "durable-task" })]);
    await db.schema.dropTable("task_evidence").execute();
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");

    await runHook({ ...persisted, logger });

    expect(warn).not.toHaveBeenCalled();
    await expect(
      db
        .selectFrom("agent_output_items")
        .select("task_id")
        .where("id", "=", persisted.persistedItems[0].id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ task_id: "durable-task" });
  });

  it("attaches same-title todos to their exact persisted ids without title matching", async () => {
    await seedEntity(db, { id: "project-a", name: "Project A" });
    await seedEntity(db, { id: "project-b", name: "Project B" });
    const items = [
      todo("Send revised proposal", { projectId: "project-a", sortOrder: 0 }),
      todo("Send revised proposal", { projectId: "project-b", sortOrder: 1 }),
    ];
    const persisted = await persistItems(items);

    await runHook(persisted);

    const rows = await db
      .selectFrom("agent_output_items")
      .innerJoin("tasks", "tasks.id", "agent_output_items.task_id")
      .select(["agent_output_items.id", "tasks.parent_entity_id"])
      .where("agent_output_items.agent_output_id", "=", persisted.outputId)
      .orderBy("agent_output_items.sort_order", "asc")
      .execute();
    expect(rows).toEqual([
      { id: persisted.persistedItems[0].id, parent_entity_id: "project-a" },
      { id: persisted.persistedItems[1].id, parent_entity_id: "project-b" },
    ]);
  });
});

describe("buildDailyBriefCandidateContext", () => {
  let db: Kysely<DB>;
  let user: Selectable<UsersTable>;

  beforeEach(async () => {
    db = await createTestDb();
    user = await seedUser(db);
    await seedConnectorConfig(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("selects 7-day active entities, hot fallback entities inside 30 days, and excludes stale or invisible entities", async () => {
    await seedEntity(db, { id: "entity-recent", name: "Recent Project", hotness: 1 });
    await seedEntity(db, { id: "entity-hot", name: "Hot Eighth Day Project", hotness: 9 });
    await seedEntity(db, { id: "entity-stale", name: "Stale Hot Project", hotness: 100 });
    await seedEntity(db, { id: "entity-private", name: "Private Project", hotness: 50 });

    await seedIndexedFile(db, { id: "file-recent", sourceUpdatedAt: "2026-06-24T10:00:00.000Z" });
    await seedIndexedFile(db, { id: "file-hot", sourceUpdatedAt: "2026-06-17T10:00:00.000Z" });
    await seedIndexedFile(db, { id: "file-stale", sourceUpdatedAt: "2026-05-20T10:00:00.000Z" });
    await seedIndexedFile(db, {
      id: "file-private",
      sourceUpdatedAt: "2026-06-24T12:00:00.000Z",
      restrictedTo: "someone-else@example.com",
    });

    await seedMention(db, { id: "mention-recent", entityId: "entity-recent", fileId: "file-recent" });
    await seedMention(db, { id: "mention-hot", entityId: "entity-hot", fileId: "file-hot" });
    await seedMention(db, { id: "mention-stale", entityId: "entity-stale", fileId: "file-stale" });
    await seedMention(db, { id: "mention-private", entityId: "entity-private", fileId: "file-private" });

    const context = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["agent@example.com"],
    });

    expect(context.entityWindowDays).toBe(DAILY_BRIEF_ENTITY_WINDOW_DAYS);
    expect(context.evidenceWindowDays).toBe(DAILY_BRIEF_EVIDENCE_WINDOW_DAYS);
    expect(context.windowEnd).toBe("2026-06-25T23:59:59.999Z");
    expect(context.entitySince).toBe("2026-06-18T23:59:59.999Z");
    expect(context.evidenceSince).toBe("2026-05-26T23:59:59.999Z");
    expect(context.recentEntities.map((entity) => entity.id)).toEqual(["entity-recent"]);
    expect(context.hotFallbackEntities.map((entity) => entity.id)).toEqual(["entity-hot"]);
    expect(context.recentEntities[0]).toMatchObject({
      reason: "recent_activity",
      evidenceCountLast30Days: 1,
      evidenceCountLast7Days: 1,
      sampleFileIds: ["file-recent"],
      sampleMentionIds: ["mention-recent"],
    });
    expect(context.hotFallbackEntities[0]).toMatchObject({
      reason: "hotness_fallback",
      evidenceCountLast30Days: 1,
      evidenceCountLast7Days: 0,
      sampleFileIds: ["file-hot"],
      sampleMentionIds: ["mention-hot"],
    });
  });

  it("does not put recent entities overflow into the hotness fallback list", async () => {
    for (let i = 0; i < 31; i += 1) {
      await seedEntity(db, { id: `entity-recent-${i}`, name: `Recent Project ${i}`, hotness: 100 + i });
      await seedIndexedFile(db, { id: `file-recent-${i}`, sourceUpdatedAt: "2026-06-24T10:00:00.000Z" });
      await seedMention(db, {
        id: `mention-recent-${i}`,
        entityId: `entity-recent-${i}`,
        fileId: `file-recent-${i}`,
      });
    }
    await seedEntity(db, { id: "entity-fallback", name: "Fallback Project", hotness: 1 });
    await seedIndexedFile(db, { id: "file-fallback", sourceUpdatedAt: "2026-06-17T10:00:00.000Z" });
    await seedMention(db, {
      id: "mention-fallback",
      entityId: "entity-fallback",
      fileId: "file-fallback",
    });

    const context = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["agent@example.com"],
    });

    expect(context.recentEntities).toHaveLength(30);
    expect(context.hotFallbackEntities.map((entity) => entity.id)).toEqual(["entity-fallback"]);
    expect(context.hotFallbackEntities[0].evidenceCountLast7Days).toBe(0);
  });

  it("honors the admin content-read setting when building candidate context", async () => {
    user = await seedUser(db, { id: "admin-user", email: "admin@example.com", authRole: "admin" });
    await seedEntity(db, { id: "entity-private", name: "Private Project", hotness: 50 });
    await seedIndexedFile(db, {
      id: "file-private",
      sourceUpdatedAt: "2026-06-24T12:00:00.000Z",
      restrictedTo: "someone-else@example.com",
    });
    await seedMention(db, { id: "mention-private", entityId: "entity-private", fileId: "file-private" });

    const defaultContext = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["admin@example.com"],
    });

    const bypassContext = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: true,
      contentUserEmails: undefined,
    });

    expect(defaultContext.recentEntities).toEqual([]);
    expect(defaultContext.hotFallbackEntities).toEqual([]);
    expect(bypassContext.recentEntities.map((entity) => entity.id)).toEqual(["entity-private"]);
  });

  it("uses linked provider emails when filtering candidate visibility", async () => {
    await seedEntity(db, { id: "entity-provider-email", name: "Provider Email Project", hotness: 1 });
    await seedIndexedFile(db, {
      id: "file-provider-email",
      sourceUpdatedAt: "2026-06-24T12:00:00.000Z",
      restrictedTo: "provider@example.com",
    });
    await seedMention(db, {
      id: "mention-provider-email",
      entityId: "entity-provider-email",
      fileId: "file-provider-email",
    });

    const primaryOnlyContext = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["agent@example.com"],
    });

    const linkedEmailContext = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["agent@example.com", "provider@example.com"],
    });

    expect(primaryOnlyContext.recentEntities).toEqual([]);
    expect(linkedEmailContext.recentEntities.map((entity) => entity.id)).toEqual(["entity-provider-email"]);
  });

  it("anchors candidate windows to the requested output date instead of the current wall clock", async () => {
    await seedEntity(db, { id: "entity-historical", name: "Historical Project", hotness: 1 });
    await seedEntity(db, { id: "entity-future", name: "Future Project", hotness: 100 });
    await seedIndexedFile(db, { id: "file-historical", sourceUpdatedAt: "2026-06-15T12:00:00.000Z" });
    await seedIndexedFile(db, { id: "file-future", sourceUpdatedAt: "2026-06-24T12:00:00.000Z" });
    await seedMention(db, { id: "mention-historical", entityId: "entity-historical", fileId: "file-historical" });
    await seedMention(db, { id: "mention-future", entityId: "entity-future", fileId: "file-future" });

    const context = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-15",
      timezone: "Asia/Kolkata",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["agent@example.com"],
    });

    expect(context.windowEnd).toBe("2026-06-15T18:29:59.999Z");
    expect(context.entitySince).toBe("2026-06-08T18:29:59.999Z");
    expect(context.evidenceSince).toBe("2026-05-16T18:29:59.999Z");
    expect(context.recentEntities.map((entity) => entity.id)).toEqual(["entity-historical"]);
    expect(context.hotFallbackEntities).toEqual([]);
  });
});

async function seedCalendarEvent(
  db: Kysely<DB>,
  params: {
    id: string;
    startTime: string;
    title?: string;
    sourcePath?: string | null;
    providerUrl?: string | null;
    archived?: boolean;
    restrictedTo?: string;
    connectorConfigId?: string;
    threadId?: string;
    allDay?: boolean;
  },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: params.id,
      connector_config_id: params.connectorConfigId ?? "cal-reader",
      provider_file_id: `cal-${params.id}`,
      thread_id: params.threadId ?? null,
      file_name: params.title ?? params.id,
      file_type: "calendar_event",
      content_category: "document",
      source: "google_calendar",
      source_path: params.sourcePath ?? "Google Calendar / Work",
      provider_url: params.providerUrl ?? `https://calendar.google.com/${params.id}`,
      content: "calendar event",
      is_archived: params.archived ? 1 : 0,
      is_all_day: params.allDay ? 1 : 0,
      source_updated_at: params.startTime,
      source_created_at: params.startTime,
      synced_at: NOW.toISOString(),
      embedding_status: "pending",
    })
    .execute();

  if (params.restrictedTo) {
    await db.insertInto("file_access").values({ indexed_file_id: params.id, email: params.restrictedTo }).execute();
  }
}

async function seedCalendarConnector(db: Kysely<DB>, params: { id: string; createdBy: string }): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: params.id,
      connector_type: "google_calendar",
      auth_type: "oauth",
      credentials: "{}",
      created_by: params.createdBy,
      scope_config: "{}",
    })
    .execute();
}

async function seedAttendeeFact(
  db: Kysely<DB>,
  params: { id: string; fileId: string; name: string; email?: string | null },
): Promise<void> {
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: params.id,
      indexed_file_id: params.fileId,
      source: "google_calendar",
      fact_type: "attendee",
      relation: "attendee",
      subject_name: params.name,
      subject_email: params.email ?? null,
      fact_key: `${params.fileId}:${params.email ?? params.name}`,
    })
    .execute();
}

async function seedPerson(db: Kysely<DB>, params: { id: string; name: string; email: string }): Promise<void> {
  const now = NOW.toISOString();
  await db
    .insertInto("entities")
    .values({
      id: params.id,
      name: params.name,
      source_type: "person",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
  await db
    .insertInto("entity_contact_points")
    .values({ id: `cp-${params.id}`, entity_id: params.id, kind: "email", value: params.email, source: "test" })
    .execute();
}

const MEETINGS_RUNTIME_PARAMS = {
  outputDate: "2026-06-25",
  timezone: "UTC",
  now: NOW,
  adminCanReadAllFiles: false,
  contentUserEmails: ["agent@example.com"],
};

describe("buildTodaysMeetings", () => {
  let db: Kysely<DB>;
  let user: Selectable<UsersTable>;

  beforeEach(async () => {
    db = await createTestDb();
    user = await seedUser(db);
    await seedConnectorConfig(db);
    await seedCalendarConnector(db, { id: "cal-reader", createdBy: "user-1" });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("builds today's meetings sorted by start, resolving attendees to person entities", async () => {
    await seedPerson(db, { id: "person-jane", name: "Jane Doe", email: "jane@example.com" });
    await seedCalendarEvent(db, { id: "evt-late", startTime: "2026-06-25T14:00:00.000Z", title: "Late sync" });
    await seedCalendarEvent(db, { id: "evt-early", startTime: "2026-06-25T09:00:00.000Z", title: "Early standup" });
    await seedAttendeeFact(db, { id: "f1", fileId: "evt-early", name: "Jane Doe", email: "JANE@example.com" });
    await seedAttendeeFact(db, { id: "f2", fileId: "evt-early", name: "Bob Stone", email: "bob@example.com" });

    const meetings = await buildTodaysMeetings({ db, user, ...MEETINGS_RUNTIME_PARAMS });

    expect(meetings.map((meeting) => meeting.fileId)).toEqual(["evt-early", "evt-late"]);
    expect(meetings[0]).toMatchObject({
      title: "Early standup",
      startTime: "2026-06-25T09:00:00.000Z",
      via: "Work",
      sourceUrl: "https://calendar.google.com/evt-early",
    });
    expect(meetings[0].attendees).toEqual([
      { name: "Jane Doe", email: "jane@example.com", entityId: "person-jane" },
      { name: "Bob Stone", email: "bob@example.com", entityId: null },
    ]);
    expect(meetings[1].attendees).toEqual([]);
  });

  it("excludes all-day events by flag but keeps timed meetings that start at UTC midnight", async () => {
    await seedCalendarEvent(db, {
      id: "evt-all-day",
      startTime: "2026-06-25T00:00:00.000Z",
      title: "Team offsite",
      allDay: true,
    });
    await seedCalendarEvent(db, {
      id: "evt-midnight-utc",
      startTime: "2026-06-25T00:00:00.000Z",
      title: "5:30 AM IST standup",
    });
    await seedCalendarEvent(db, { id: "evt-timed", startTime: "2026-06-25T09:00:00.000Z", title: "Standup" });

    const utcMeetings = await buildTodaysMeetings({ db, user, ...MEETINGS_RUNTIME_PARAMS });
    expect(utcMeetings.map((meeting) => meeting.fileId)).toEqual(["evt-midnight-utc", "evt-timed"]);

    const istMeetings = await buildTodaysMeetings({
      db,
      user,
      ...MEETINGS_RUNTIME_PARAMS,
      timezone: "Asia/Kolkata",
    });
    expect(istMeetings.map((meeting) => meeting.fileId)).toEqual(["evt-midnight-utc", "evt-timed"]);
  });

  it("excludes archived events, events outside the day, and files the reader cannot see", async () => {
    await seedCalendarEvent(db, { id: "evt-today", startTime: "2026-06-25T10:00:00.000Z" });
    await seedCalendarEvent(db, { id: "evt-archived", startTime: "2026-06-25T11:00:00.000Z", archived: true });
    await seedCalendarEvent(db, { id: "evt-tomorrow", startTime: "2026-06-26T10:00:00.000Z" });
    await seedCalendarEvent(db, {
      id: "evt-restricted",
      startTime: "2026-06-25T12:00:00.000Z",
      restrictedTo: "someone-else@example.com",
    });

    const meetings = await buildTodaysMeetings({ db, user, ...MEETINGS_RUNTIME_PARAMS });

    expect(meetings.map((meeting) => meeting.fileId)).toEqual(["evt-today"]);
  });

  it("collapses duplicate calendar copies of one event, keeping the reader-owned copy", async () => {
    await seedUser(db, { id: "coworker", email: "coworker@example.com" });
    await seedCalendarConnector(db, { id: "cal-coworker", createdBy: "coworker" });

    await seedCalendarEvent(db, {
      id: "evt-coworker-copy",
      startTime: "2026-06-25T09:00:00.000Z",
      title: "Shared sync",
      threadId: "shared-invite@google.com",
      connectorConfigId: "cal-coworker",
      restrictedTo: "agent@example.com",
    });
    await seedCalendarEvent(db, {
      id: "evt-reader-copy",
      startTime: "2026-06-25T09:00:00.000Z",
      title: "Shared sync",
      threadId: "shared-invite@google.com",
      connectorConfigId: "cal-reader",
      restrictedTo: "agent@example.com",
    });

    const meetings = await buildTodaysMeetings({ db, user, ...MEETINGS_RUNTIME_PARAMS });

    expect(meetings).toHaveLength(1);
    expect(meetings[0].fileId).toBe("evt-reader-copy");
  });

  it("drops a meeting visible only through a coworker's calendar copy (declined / not on my calendar)", async () => {
    await seedUser(db, { id: "coworker", email: "coworker@example.com" });
    await seedCalendarConnector(db, { id: "cal-coworker", createdBy: "coworker" });

    await seedCalendarEvent(db, {
      id: "evt-declined-coworker-copy",
      startTime: "2026-06-25T09:00:00.000Z",
      title: "Invite the reader declined",
      threadId: "declined-invite@google.com",
      connectorConfigId: "cal-coworker",
      restrictedTo: "agent@example.com",
    });

    const meetings = await buildTodaysMeetings({ db, user, ...MEETINGS_RUNTIME_PARAMS });

    expect(meetings).toEqual([]);
  });

  it("scopes an admin's meetings to their own calendar even with the read-all bypass", async () => {
    const admin = await seedUser(db, { id: "admin-1", email: "admin@example.com", authRole: "admin" });
    await seedCalendarConnector(db, { id: "cal-admin", createdBy: "admin-1" });
    await seedCalendarEvent(db, {
      id: "evt-mine",
      startTime: "2026-06-25T09:00:00.000Z",
      connectorConfigId: "cal-admin",
      restrictedTo: "admin@example.com",
    });
    await seedCalendarEvent(db, {
      id: "evt-someone-else",
      startTime: "2026-06-25T10:00:00.000Z",
      restrictedTo: "other-person@example.com",
    });

    const meetings = await buildTodaysMeetings({
      db,
      user: admin,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: true,
      contentUserEmails: undefined,
    });

    expect(meetings.map((meeting) => meeting.fileId)).toEqual(["evt-mine"]);
  });
});

describe("dailyBriefDefinition.reconcileItems", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  const skeleton: TodaysMeeting[] = [
    {
      fileId: "evt-1",
      startTime: "2026-06-25T09:00:00.000Z",
      title: "Standup",
      via: "Work",
      sourceUrl: "https://calendar.google.com/evt-1",
      attendees: [{ name: "Jane Doe", email: "jane@example.com", entityId: "person-jane" }],
    },
    {
      fileId: "evt-2",
      startTime: "2026-06-25T14:00:00.000Z",
      title: "Customer call",
      via: null,
      sourceUrl: null,
      attendees: [],
    },
  ];

  function meetingItem(fileId: string, payload: AgentOutputItemInput["structuredPayload"]): AgentOutputItemInput {
    return {
      sectionKey: DAILY_BRIEF_MEETINGS_SECTION_KEY,
      title: "Model title",
      summary: "model summary",
      priority: "medium",
      label: "meeting",
      structuredPayload: payload,
      knowledgeRefs: { entityIds: [], fileIds: [fileId] },
      sortOrder: 0,
    };
  }

  it("uses the skeleton as truth: enriches matches, backfills skipped, drops invented meetings", async () => {
    const items: AgentOutputItemInput[] = [
      meetingItem("evt-1", {
        context: "Kickoff for the new sprint.",
        attendees: [{ entityId: "person-jane", role: "EM", note: "Owns delivery", emphasis: true }],
      }),
      meetingItem("ghost", { context: "Invented meeting." }),
      {
        sectionKey: "todos",
        title: "Ship the thing",
        summary: "do it",
        priority: "high",
        label: "todo",
        knowledgeRefs: { entityIds: [], fileIds: [] },
        sortOrder: 0,
      },
    ];

    const result =
      (await dailyBriefDefinition.reconcileItems?.({
        db,
        items,
        runtimeContext: { sections: ["meetings", "todos"], todaysMeetings: skeleton },
      })) ?? [];

    const meetings = result.filter((item) => item.sectionKey === DAILY_BRIEF_MEETINGS_SECTION_KEY);
    expect(meetings.map((item) => item.title)).toEqual(["Standup", "Customer call"]);
    expect(meetings.map((item) => item.knowledgeRefs.fileIds)).toEqual([["evt-1"], ["evt-2"]]);

    expect(meetings[0].summary).toBe("Kickoff for the new sprint.");
    expect(meetings[0].sourceUrl).toBe("https://calendar.google.com/evt-1");
    expect(meetings[0].structuredPayload).toMatchObject({
      startTime: "2026-06-25T09:00:00.000Z",
      via: "Work",
      attendees: [{ name: "Jane Doe", entityId: "person-jane", role: "EM", note: "Owns delivery", emphasis: true }],
    });
    expect(meetings[0].knowledgeRefs.entityIds).toEqual(["person-jane"]);

    expect(meetings[1].structuredPayload).toMatchObject({ startTime: "2026-06-25T14:00:00.000Z", attendees: [] });
    expect(meetings[1].summary).toBe("On your calendar today.");

    expect(result.some((item) => item.knowledgeRefs.fileIds.includes("ghost"))).toBe(false);
    expect(result.some((item) => item.sectionKey === "todos")).toBe(true);
  });

  it("drops all meeting items when the skeleton is empty", async () => {
    const result =
      (await dailyBriefDefinition.reconcileItems?.({
        db,
        items: [meetingItem("evt-1", null)],
        runtimeContext: { sections: ["meetings"], todaysMeetings: [] },
      })) ?? [];

    expect(result).toEqual([]);
  });

  it("leaves items untouched when the meetings section is disabled", async () => {
    const items = [meetingItem("evt-1", null)];
    const result = await dailyBriefDefinition.reconcileItems?.({
      db,
      items,
      runtimeContext: { sections: ["todos"], todaysMeetings: skeleton },
    });

    expect(result).toEqual(items);
  });

  it("restores canonical Task Attention identity and drops pending-review or quiet task todos", async () => {
    const todo = (title: string, taskId?: string): AgentOutputItemInput => ({
      sectionKey: "todos",
      title,
      summary: title,
      priority: "medium",
      label: "todo",
      structuredPayload: taskId ? { taskId } : {},
      knowledgeRefs: { entityIds: [], fileIds: [] },
      sortOrder: 0,
    });
    const result =
      (await dailyBriefDefinition.reconcileItems?.({
        db,
        items: [
          todo("Active attention task", "task-active"),
          todo("Pending review task", "task-pending"),
          todo("Quiet memory task", "task-quiet"),
          todo("Genuinely new work"),
        ],
        runtimeContext: {
          sections: ["todos"],
          openDurableTasks: [{ id: "task-active" }, { id: "task-pending" }, { id: "task-quiet" }],
          taskAttention: {
            items: [
              {
                taskId: "task-active",
                parentEntityId: "project-1",
                assigneeEntityId: "person-1",
                sourcePlatform: "slack",
                sourceAnchorKey: "slack:42:root",
                attentionReasons: ["meaningfully_changed"],
                changedFields: ["priority", "status"],
              },
              {
                taskId: "task-pending",
                parentEntityId: null,
                assigneeEntityId: null,
                sourcePlatform: "whatsapp",
                sourceAnchorKey: "whatsapp:43:root",
                attentionReasons: ["pending_completion_review"],
              },
            ],
          },
        },
      })) ?? [];

    expect(result.map((item) => item.title)).toEqual(["Active attention task", "Genuinely new work"]);
    expect(result[0]).toMatchObject({
      canonicalTaskId: "task-active",
      structuredPayload: {
        taskId: "task-active",
        parentEntityId: "project-1",
        assigneeEntityId: "person-1",
        sourcePlatform: "slack",
        sourceAnchorKey: "slack:42:root",
        attentionReasons: ["meaningfully_changed"],
        changedFields: ["priority", "status"],
      },
    });
  });

  it("reconciles exact conversation identities without suppressing unrelated same-title todos", async () => {
    const result =
      (await dailyBriefDefinition.reconcileItems?.({
        db,
        items: [
          {
            sectionKey: "todos",
            title: "Send revised proposal",
            summary: "Reconstructed by the model.",
            priority: "medium",
            label: "todo",
            structuredPayload: {
              sourceKey: "slack:channel:C_MATCH",
              sourceAnchorKey: "slack:42:root",
            },
            knowledgeRefs: { entityIds: ["project-1"], fileIds: [] },
            sortOrder: 0,
          },
          {
            sectionKey: "todos",
            title: "Send revised proposal",
            summary: "Jira work with the same title.",
            priority: "medium",
            label: "todo",
            structuredPayload: { sourceKey: "jira:project:OPS" },
            knowledgeRefs: { entityIds: ["project-1"], fileIds: [] },
            sortOrder: 1,
          },
          {
            sectionKey: "todos",
            title: "Send revised proposal",
            summary: "Email work with the same title.",
            priority: "medium",
            label: "todo",
            structuredPayload: { sourceKey: "gmail:thread:abc" },
            knowledgeRefs: { entityIds: ["project-1"], fileIds: [] },
            sortOrder: 2,
          },
        ],
        runtimeContext: {
          sections: ["todos", "looks_resolved", "untracked_followups"],
          todaysMeetings: [],
          followupReminder: {
            status: "ok",
            mode: "durable_only",
            pending: [],
            looksResolved: [
              {
                recommendationId: "recommendation-1",
                taskId: "task-1",
                title: "Send revised proposal",
                rationale: "Completion was reported.",
                reviewCode: "R7K2",
                parentEntityId: "project-1",
                assigneeEntityId: "person-1",
                sourceKey: "slack:channel:C_MATCH",
                sourceAnchorKey: "slack:42:root",
              },
            ],
            untracked: [],
          },
        },
      })) ?? [];

    expect(result.map((item) => [item.sectionKey, item.structuredPayload?.sourceKey ?? null])).toEqual([
      ["todos", "jira:project:OPS"],
      ["todos", "gmail:thread:abc"],
      ["looks_resolved", "slack:channel:C_MATCH"],
    ]);
  });
});

describe("dailyBriefDefinition.augmentRuntimeContext", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedSummarizerConfig(routes: AgentRoute[], createTasks = true): Promise<void> {
    await db
      .insertInto("agent_user_configs")
      .values({
        agent_key: "conversation_summary",
        user_id: "user-1",
        enabled: 1,
        schedule_hour: 8,
        schedule_minute: 0,
        timezone: "UTC",
        max_items_per_section: 5,
        prefs_json: JSON.stringify({ routes, createTasks }),
      })
      .execute();
  }

  async function seedSummaryOutput(
    sourceKey: string,
    items: Array<{ title: string; messageIds: number[] }>,
    generatedAt = "2026-06-25T07:00:00.000Z",
  ): Promise<string> {
    const repo = createAgentOutputRepository(db);
    const running = await repo.createRunning({
      agentKey: "conversation_summary",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-06-25",
      timezone: "UTC",
      triggerType: "manual",
      sourceKey,
      sourceLabel: sourceKey,
    });
    await repo.completeOutput({
      outputId: running.row.id,
      masthead: { title: "Summary", summary: "Summary" },
      rawPayload: { items: [] },
      items: items.map((item, index) => ({
        sectionKey: "action_items",
        title: item.title,
        summary: `${item.title} summary`,
        priority: "medium",
        label: "action_item",
        knowledgeRefs: { entityIds: [], fileIds: [] },
        structuredPayload: { messageIds: item.messageIds, sourceLabels: [sourceKey] },
        sortOrder: index,
      })),
    });
    await db
      .updateTable("agent_outputs")
      .set({ generated_at: generatedAt, updated_at: generatedAt })
      .where("id", "=", running.row.id)
      .execute();
    return running.row.id;
  }

  async function seedConversationMessage(
    providerConversationId: string,
    providerMessageId: string,
    options: { platform?: "slack" | "whatsapp"; kind?: "channel" | "group" | "dm" } = {},
  ): Promise<{
    conversationId: number;
    messageId: number;
  }> {
    const conversation = await db
      .insertInto("conversations")
      .values({
        platform: options.platform ?? "slack",
        kind: options.kind ?? "channel",
        provider_conversation_id: providerConversationId,
        display_name: providerConversationId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const message = await db
      .insertInto("conversation_messages")
      .values({
        conversation_id: conversation.id,
        provider_message_id: providerMessageId,
        sender_jid: "sender",
        sender_name: "Sender",
        sender_user_id: "user-1",
        addressed_to_sketch: 0,
        text: providerMessageId,
        provider_thread_id: null,
        is_thread_reply: 0,
        received_at: NOW.toISOString(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { conversationId: conversation.id, messageId: message.id };
  }

  function summaryRoute(id: string, sources: AgentRoute["sources"], enabled = true): AgentRoute {
    return {
      id,
      sources,
      focus: null,
      sections: null,
      maxItemsPerSection: null,
      schedule: null,
      destination: { kind: "off" },
      enabled,
    };
  }

  async function seedTopologyTaskOwner(): Promise<string> {
    await seedUser(db);
    await db.updateTable("users").set({ email_verified_at: NOW.toISOString() }).where("id", "=", "user-1").execute();
    await db
      .insertInto("entities")
      .values({
        id: "person-topology-owner",
        name: "Agent User",
        source_type: "person",
        subtype: null,
        aliases: JSON.stringify(["agent@example.com"]),
        metadata: JSON.stringify({ email: "agent@example.com" }),
        source_ref_id: null,
        status: "active",
        hotness: 0,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
        ai_brief: null,
      })
      .execute();
    return "person-topology-owner";
  }

  it("separates recent ownerless Task Attention from quiet Known Task Memory", async () => {
    await seedUser(db);
    const repo = createTaskRepository(db);
    const recent = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Prepare the launch brief",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "attention-recent",
      createdByUserId: "user-1",
    });
    const quiet = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Quiet backlog task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "attention-quiet",
      createdByUserId: "user-1",
    });
    await db
      .insertInto("task_activity_events")
      .values({
        id: "activity-recent-created",
        task_id: recent.taskId,
        event_kind: "created",
        actor_type: "agent",
        actor_user_id: null,
        actor_key: "conversation_summary",
        surface: "summarizer",
        source_agent_output_id: null,
        changes_json: null,
        evidence_json: null,
        dedupe_key: "activity-recent-created",
        occurred_at: "2026-06-25T07:30:00.000Z",
      })
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect((context?.openDurableTasks as Array<{ id: string }>).map((task) => task.id)).toEqual(
      expect.arrayContaining([recent.taskId, quiet.taskId]),
    );
    expect(context?.taskAttention).toMatchObject({
      windowStart: "2026-06-24T23:59:59.999Z",
      windowEnd: "2026-06-25T23:59:59.999Z",
      partial: false,
      items: [
        {
          taskId: recent.taskId,
          title: "Prepare the launch brief",
          status: "open",
          lastMeaningfulActivityAt: "2026-06-25T07:30:00.000Z",
          lastEventKind: "created",
          changedFields: [],
          attentionReasons: ["new_since_last_brief", "meaningfully_changed"],
        },
      ],
    });
  });

  it("ranks an older overdue task before truncating a large relevant candidate set", async () => {
    await seedUser(db);
    const repo = createTaskRepository(db);
    const overdue = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Older overdue task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: "2026-06-20",
      provenance: "summary",
      sourceTaskId: "older-overdue",
      createdByUserId: "user-1",
    });
    await db
      .updateTable("tasks")
      .set({ updated_at: "2026-01-01T00:00:00.000Z" })
      .where("id", "=", overdue.taskId)
      .execute();
    for (let index = 0; index < 101; index += 1) {
      const quiet = await repo.upsertTask({
        parentEntityId: null,
        parentSourceRef: null,
        parentName: null,
        source: "summary",
        externalRef: null,
        title: `Newer quiet task ${index}`,
        status: "open",
        statusRaw: "open",
        statusAuthority: "local",
        assigneeEntityId: null,
        assigneeName: null,
        priority: "medium",
        dueAt: null,
        provenance: "summary",
        sourceTaskId: `newer-quiet-${index}`,
        createdByUserId: "user-1",
      });
      await db
        .updateTable("tasks")
        .set({ updated_at: `2026-06-24T${String(index % 24).padStart(2, "0")}:00:00.000Z` })
        .where("id", "=", quiet.taskId)
        .execute();
    }

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.taskAttention).toMatchObject({
      partial: true,
      items: [
        {
          taskId: overdue.taskId,
          attentionReasons: ["overdue"],
        },
      ],
    });
  });

  it("normalizes timestamp due dates before ranking the inclusive due-soon boundary", async () => {
    await seedUser(db);
    const repo = createTaskRepository(db);
    const dueSoon = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Older boundary due-soon task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: "2026-07-02T00:00:00.000Z",
      provenance: "summary",
      sourceTaskId: "older-boundary-due-soon",
      createdByUserId: "user-1",
    });
    await db
      .updateTable("tasks")
      .set({ updated_at: "2026-01-01T00:00:00.000Z" })
      .where("id", "=", dueSoon.taskId)
      .execute();
    for (let index = 0; index < 101; index += 1) {
      const quiet = await repo.upsertTask({
        parentEntityId: null,
        parentSourceRef: null,
        parentName: null,
        source: "summary",
        externalRef: null,
        title: `Boundary newer quiet task ${index}`,
        status: "open",
        statusRaw: "open",
        statusAuthority: "local",
        assigneeEntityId: null,
        assigneeName: null,
        priority: "medium",
        dueAt: null,
        provenance: "summary",
        sourceTaskId: `boundary-newer-quiet-${index}`,
        createdByUserId: "user-1",
      });
      await db
        .updateTable("tasks")
        .set({ updated_at: `2026-06-24T${String(index % 24).padStart(2, "0")}:00:00.000Z` })
        .where("id", "=", quiet.taskId)
        .execute();
    }

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.taskAttention).toMatchObject({
      partial: true,
      items: [
        {
          taskId: dueSoon.taskId,
          dueAt: "2026-07-02T00:00:00.000Z",
          attentionReasons: ["due_soon"],
        },
      ],
    });
  });

  it("reports a status change when a later in-window event is more recent", async () => {
    await seedUser(db);
    const repo = createTaskRepository(db);
    const changed = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Changed task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "status-then-evidence",
      createdByUserId: "user-1",
    });
    await db
      .insertInto("task_activity_events")
      .values([
        {
          id: "status-then-evidence-status",
          task_id: changed.taskId,
          event_kind: "status_changed",
          actor_type: "user",
          actor_user_id: "user-1",
          actor_key: null,
          surface: "web",
          source_agent_output_id: null,
          changes_json: JSON.stringify({ status: { before: "in_progress", after: "open" } }),
          evidence_json: null,
          dedupe_key: "status-then-evidence-status",
          occurred_at: "2026-06-25T06:30:00.000Z",
        },
        {
          id: "status-then-evidence-later",
          task_id: changed.taskId,
          event_kind: "evidence_added",
          actor_type: "agent",
          actor_user_id: null,
          actor_key: "daily_brief",
          surface: "daily_brief",
          source_agent_output_id: null,
          changes_json: null,
          evidence_json: JSON.stringify({ messageIds: [42] }),
          dedupe_key: "status-then-evidence-later",
          occurred_at: "2026-06-25T07:00:00.000Z",
        },
      ])
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.taskAttention).toMatchObject({
      items: [
        {
          taskId: changed.taskId,
          changedFields: ["status"],
          attentionReasons: ["meaningfully_changed", "status_changed"],
        },
      ],
    });
  });

  it("uses meaningful activity to order new and changed tasks within one attention tier", async () => {
    await seedUser(db);
    const repo = createTaskRepository(db);
    const created = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "New task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "new-tier-task",
      createdByUserId: "user-1",
    });
    const changed = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Changed task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "changed-tier-task",
      createdByUserId: "user-1",
    });
    await db
      .insertInto("task_activity_events")
      .values([
        {
          id: "combined-tier-created",
          task_id: created.taskId,
          event_kind: "created",
          actor_type: "agent",
          actor_user_id: null,
          actor_key: "daily_brief",
          surface: "daily_brief",
          source_agent_output_id: null,
          changes_json: null,
          evidence_json: null,
          dedupe_key: "combined-tier-created",
          occurred_at: "2026-06-25T06:30:00.000Z",
        },
        {
          id: "combined-tier-changed",
          task_id: changed.taskId,
          event_kind: "fields_changed",
          actor_type: "agent",
          actor_user_id: null,
          actor_key: "daily_brief",
          surface: "daily_brief",
          source_agent_output_id: null,
          changes_json: JSON.stringify({ priority: { before: "low", after: "medium" } }),
          evidence_json: null,
          dedupe_key: "combined-tier-changed",
          occurred_at: "2026-06-25T07:00:00.000Z",
        },
      ])
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });
    const attention = context?.taskAttention as {
      items: Array<{ taskId: string; attentionReasons: string[] }>;
    };

    expect(attention.items.map((item) => item.taskId)).toEqual([changed.taskId, created.taskId]);
    expect(attention.items[0]?.attentionReasons).toEqual(["meaningfully_changed"]);
    expect(attention.items[1]?.attentionReasons).toEqual(["new_since_last_brief", "meaningfully_changed"]);
  });

  it("ranks reader-relevant Task Attention without broadening relevance for admins", async () => {
    await seedUser(db, { authRole: "admin" });
    await seedUser(db, { id: "user-other", email: "other@example.com" });
    await db.updateTable("users").set({ email_verified_at: NOW.toISOString() }).where("id", "=", "user-1").execute();
    await db
      .insertInto("entities")
      .values({
        id: "person-attention-reader",
        name: "Agent User",
        source_type: "person",
        subtype: null,
        aliases: JSON.stringify(["agent@example.com"]),
        metadata: JSON.stringify({ email: "agent@example.com" }),
        source_ref_id: null,
        status: "active",
        hotness: 0,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
        ai_brief: null,
      })
      .execute();
    const repo = createTaskRepository(db);
    const createTask = (sourceTaskId: string, options: { dueAt?: string; priority?: string; owner?: string }) =>
      repo.upsertTask({
        parentEntityId: null,
        parentSourceRef: null,
        parentName: null,
        source: "summary",
        externalRef: null,
        title: sourceTaskId,
        status: "open",
        statusRaw: "open",
        statusAuthority: "local",
        assigneeEntityId: options.owner === "assigned" ? "person-attention-reader" : null,
        assigneeName: options.owner === "assigned" ? "Agent User" : null,
        priority: options.priority ?? "medium",
        dueAt: options.dueAt ?? null,
        provenance: "summary",
        sourceTaskId,
        createdByUserId: options.owner === "other" || options.owner === "assigned" ? "user-other" : "user-1",
      });
    const overdue = await createTask("01-overdue", { dueAt: "2026-06-24" });
    const pending = await createTask("02-pending", {});
    const changed = await createTask("03-changed", { owner: "assigned" });
    const dueSoon = await createTask("04-due-soon", { dueAt: "2026-06-28" });
    const high = await createTask("05-high", { priority: "high" });
    const carried = await createTask("06-carried", {});
    const reassignedCarried = await createTask("07-reassigned-carried", { owner: "other" });
    await createTask("07-quiet", {});
    await createTask("08-unrelated-admin-visible", {
      owner: "other",
      dueAt: "2026-06-20",
      priority: "high",
    });
    await db
      .insertInto("task_activity_events")
      .values([
        {
          id: "attention-status-event",
          task_id: changed.taskId,
          event_kind: "status_changed",
          actor_type: "user",
          actor_user_id: "user-1",
          actor_key: null,
          surface: "web",
          source_agent_output_id: null,
          changes_json: JSON.stringify({ status: { before: "in_progress", after: "open" } }),
          evidence_json: null,
          dedupe_key: "attention-status-event",
          occurred_at: "2026-06-25T06:30:00.000Z",
        },
        {
          id: "attention-changed-event",
          task_id: changed.taskId,
          event_kind: "fields_changed",
          actor_type: "agent",
          actor_user_id: null,
          actor_key: "conversation_summary",
          surface: "summarizer",
          source_agent_output_id: null,
          changes_json: JSON.stringify({ priority: { before: "low", after: "medium" } }),
          evidence_json: null,
          dedupe_key: "attention-changed-event",
          occurred_at: "2026-06-25T07:00:00.000Z",
        },
      ])
      .execute();
    await db
      .insertInto("task_activity_events")
      .values({
        id: "attention-historical-event",
        task_id: high.taskId,
        event_kind: "fields_changed",
        actor_type: "agent",
        actor_user_id: null,
        actor_key: "conversation_summary",
        surface: "summarizer",
        source_agent_output_id: null,
        changes_json: JSON.stringify({ priority: { before: "medium", after: "high" } }),
        evidence_json: null,
        dedupe_key: "attention-historical-event",
        occurred_at: "2026-06-24T07:00:00.000Z",
      })
      .execute();
    await db
      .insertInto("task_completion_recommendations")
      .values({
        id: "attention-pending-review",
        task_id: pending.taskId,
        proposed_status: "done",
        review_state: "pending",
        review_code: "ATTN1234",
        evidence_fingerprint: "attention-pending-review",
        origin_agent_output_id: null,
        rationale: "Reported complete.",
        delivery_count: 0,
        expires_at: "2026-06-25T12:00:00.000Z",
      })
      .execute();
    const outputRepo = createAgentOutputRepository(db);
    const previous = await outputRepo.createRunning({
      agentKey: "daily_brief",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-06-24",
      timezone: "UTC",
      triggerType: "manual",
    });
    await outputRepo.completeOutput({
      outputId: previous.row.id,
      masthead: { title: "Previous", summary: "Previous" },
      rawPayload: {},
      items: [
        {
          sectionKey: "todos",
          title: "06-carried",
          summary: "Still active",
          priority: "medium",
          label: "todo",
          canonicalTaskId: carried.taskId,
          structuredPayload: {},
          knowledgeRefs: { entityIds: [], fileIds: [] },
          sortOrder: 0,
        },
        {
          sectionKey: "todos",
          title: "07-reassigned-carried",
          summary: "No longer assigned to the reader",
          priority: "medium",
          label: "todo",
          canonicalTaskId: reassignedCarried.taskId,
          structuredPayload: {},
          knowledgeRefs: { entityIds: [], fileIds: [] },
          sortOrder: 1,
        },
      ],
    });
    await db
      .updateTable("agent_outputs")
      .set({ generated_at: "2026-06-25T06:00:00.000Z", updated_at: "2026-06-25T06:00:00.000Z" })
      .where("id", "=", previous.row.id)
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        generationStartedAt: "2026-06-25T08:00:00.000Z",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });
    const attention = context?.taskAttention as {
      windowStart: string;
      partial: boolean;
      items: Array<{ taskId: string; changedFields: string[]; attentionReasons: string[] }>;
    };

    expect((context?.openDurableTasks as Array<{ id: string }>).map((task) => task.id)).toContain(changed.taskId);
    expect(attention.windowStart).toBe("2026-06-25T06:00:00.000Z");
    expect(attention.partial).toBe(false);
    expect(attention.items.map((item) => item.taskId)).toEqual([
      overdue.taskId,
      pending.taskId,
      changed.taskId,
      dueSoon.taskId,
      high.taskId,
      carried.taskId,
    ]);
    expect(attention.items.find((item) => item.taskId === changed.taskId)).toMatchObject({
      changedFields: ["priority", "status"],
      attentionReasons: ["meaningfully_changed", "status_changed"],
    });
    expect(attention.items.find((item) => item.taskId === pending.taskId)?.attentionReasons).toContain(
      "pending_completion_review",
    );
    expect(attention.items.find((item) => item.taskId === high.taskId)).toMatchObject({
      lastMeaningfulActivityAt: "2026-06-24T07:00:00.000Z",
      lastEventKind: "fields_changed",
      changedFields: [],
      attentionReasons: ["high_priority"],
    });
    expect(attention.items.find((item) => item.taskId === carried.taskId)?.attentionReasons).toEqual([
      "carried_from_previous_brief",
    ]);
    expect(attention.items.map((item) => item.taskId)).not.toContain(reassignedCarried.taskId);
  });

  it("keeps structural attention reader-relevant and returns only visible file evidence", async () => {
    const assigneeEntityId = await seedTopologyTaskOwner();
    await seedConnectorConfig(db);
    await seedIndexedFile(db, { id: "attention-visible-file", sourceUpdatedAt: NOW.toISOString() });
    await seedIndexedFile(db, {
      id: "attention-restricted-file",
      sourceUpdatedAt: NOW.toISOString(),
      restrictedTo: "other@example.com",
    });
    const repo = createTaskRepository(db);
    const createStructuralTask = (sourceTaskId: string, assigneeId: string | null) =>
      repo.upsertTask({
        parentEntityId: null,
        parentSourceRef: null,
        parentName: null,
        source: "linear",
        externalRef: sourceTaskId,
        title: sourceTaskId,
        status: "open",
        statusRaw: "Todo",
        statusAuthority: "external",
        assigneeEntityId: assigneeId,
        assigneeName: assigneeId ? "Agent User" : null,
        priority: assigneeId ? "high" : "medium",
        dueAt: null,
        provenance: "structural",
        sourceTaskId,
      });
    const assigned = await createStructuralTask("structural-assigned", assigneeEntityId);
    const carried = await createStructuralTask("structural-carried", null);
    const unrelated = await createStructuralTask("structural-unrelated", null);
    const inaccessible = await createStructuralTask("structural-inaccessible", assigneeEntityId);
    await repo.upsertEvidence(assigned.taskId, "file", "attention-visible-file");
    await repo.upsertEvidence(assigned.taskId, "file", "attention-restricted-file");
    await repo.upsertEvidence(carried.taskId, "file", "attention-visible-file");
    await repo.upsertEvidence(unrelated.taskId, "file", "attention-visible-file");
    await repo.upsertEvidence(inaccessible.taskId, "file", "attention-restricted-file");

    const outputRepo = createAgentOutputRepository(db);
    const previous = await outputRepo.createRunning({
      agentKey: "daily_brief",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-06-24",
      timezone: "UTC",
      triggerType: "manual",
    });
    await outputRepo.completeOutput({
      outputId: previous.row.id,
      masthead: { title: "Previous", summary: "Previous" },
      rawPayload: {},
      items: [
        {
          sectionKey: "todos",
          title: "structural-carried",
          summary: "Still active",
          priority: "medium",
          label: "todo",
          canonicalTaskId: carried.taskId,
          structuredPayload: {},
          knowledgeRefs: { entityIds: [], fileIds: [] },
          sortOrder: 0,
        },
      ],
    });
    await db
      .updateTable("agent_outputs")
      .set({ generated_at: "2026-06-25T06:00:00.000Z", updated_at: "2026-06-25T06:00:00.000Z" })
      .where("id", "=", previous.row.id)
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });
    const attention = context?.taskAttention as {
      items: Array<{ taskId: string; attentionReasons: string[]; evidence: { fileIds: string[] } }>;
    };

    expect(attention.items.map((item) => item.taskId)).toEqual([assigned.taskId, carried.taskId]);
    expect(attention.items[0]).toMatchObject({
      taskId: assigned.taskId,
      attentionReasons: ["high_priority"],
      evidence: { fileIds: ["attention-visible-file"] },
    });
    expect(attention.items[1]).toMatchObject({
      taskId: carried.taskId,
      attentionReasons: ["carried_from_previous_brief"],
    });
    expect(attention.items.map((item) => item.taskId)).not.toEqual(
      expect.arrayContaining([unrelated.taskId, inaccessible.taskId]),
    );
  });

  it("bounds Task Attention evidence and marks the context partial when evidence is truncated", async () => {
    await seedUser(db);
    await seedConnectorConfig(db);
    const task = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Evidence-heavy attention task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "high",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "attention-evidence-heavy",
      createdByUserId: "user-1",
    });
    const messageIds: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const message = await seedConversationMessage(`C-EVIDENCE-${index}`, `evidence-${index}`);
      messageIds.push(message.messageId);
      await seedIndexedFile(db, { id: `file-${index}`, sourceUpdatedAt: NOW.toISOString() });
      await db
        .insertInto("task_message_evidence")
        .values({
          task_id: task.taskId,
          conversation_message_id: message.messageId,
          source_platform: "slack",
          source_conversation_id: message.conversationId,
          source_provider_thread_id: null,
          source_anchor_key: `slack:${message.conversationId}:root`,
        })
        .execute();
      await db
        .insertInto("task_evidence")
        .values({ task_id: task.taskId, kind: "file", ref_id: `file-${index}` })
        .execute();
    }

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.taskAttention).toMatchObject({
      partial: true,
      items: [
        {
          taskId: task.taskId,
          attentionReasons: ["high_priority"],
          evidence: {
            messageIds: messageIds.slice(0, 5),
            fileIds: ["file-0", "file-1", "file-2", "file-3", "file-4"],
            truncated: true,
          },
        },
      ],
    });
  });

  it("falls back conservatively when Task Activity cannot be loaded", async () => {
    await seedUser(db);
    const task = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "High priority fallback task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "high",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "attention-activity-fallback",
      createdByUserId: "user-1",
    });
    await db.schema.dropTable("task_activity_events").execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.taskAttention).toMatchObject({
      partial: true,
      items: [
        {
          taskId: task.taskId,
          lastEventKind: null,
          changedFields: [],
          attentionReasons: ["high_priority"],
        },
      ],
    });
  });

  it("marks Task Attention partial when reader assignee identity lookup fails", async () => {
    await seedUser(db);
    await db.updateTable("users").set({ email_verified_at: NOW.toISOString() }).where("id", "=", "user-1").execute();
    const task = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Reader-owned fallback task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "high",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "attention-assignee-lookup-fallback",
      createdByUserId: "user-1",
    });
    await db.schema.dropTable("entity_contact_points").execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.taskAttention).toMatchObject({
      partial: true,
      items: [{ taskId: task.taskId, attentionReasons: ["high_priority"] }],
    });
  });

  it("exposes the shared looks-resolved reminder state and transition mode", async () => {
    await seedUser(db);
    await db.updateTable("users").set({ email_verified_at: NOW.toISOString() }).where("id", "=", "user-1").execute();
    await seedSummarizerConfig([
      {
        id: "route-1",
        sources: ["whatsapp:group:goosebumps"],
        focus: null,
        sections: null,
        maxItemsPerSection: null,
        schedule: null,
        destination: { kind: "off" },
        enabled: true,
      },
    ]);
    const conversation = await db
      .insertInto("conversations")
      .values({
        platform: "whatsapp",
        kind: "group",
        provider_conversation_id: "goosebumps",
        display_name: "Goosebumps",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("entities")
      .values({
        id: "person-followup",
        name: "Agent User",
        source_type: "person",
        subtype: null,
        aliases: JSON.stringify(["agent@example.com"]),
        metadata: JSON.stringify({ email: "agent@example.com" }),
        source_ref_id: null,
        status: "active",
        hotness: 0,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
        ai_brief: null,
      })
      .execute();
    const task = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Send revised proposal",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: "person-followup",
      assigneeName: "Agent User",
      priority: "high",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "followup-task",
      createdByUserId: "user-1",
    });
    await db
      .updateTable("tasks")
      .set({
        source_platform: "whatsapp",
        source_conversation_id: conversation.id,
        source_anchor_key: `whatsapp:${conversation.id}:root`,
      })
      .where("id", "=", task.taskId)
      .execute();
    await db
      .insertInto("task_completion_recommendations")
      .values({
        id: "recommendation-followup",
        task_id: task.taskId,
        proposed_status: "done",
        review_state: "pending",
        review_code: "R7K2",
        evidence_fingerprint: "fingerprint-followup",
        origin_agent_output_id: null,
        rationale: "Ashish reported that this is fixed.",
        delivery_count: 0,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .execute();
    await db
      .insertInto("task_durability_route_state")
      .values({
        agent_key: "conversation_summary",
        user_id: "user-1",
        route_id: "route-1",
        source_key: "whatsapp:group:goosebumps",
        mode: "hybrid",
        seed_state: "reviewed",
        seed_started_at: NOW.toISOString(),
        seed_reviewed_at: NOW.toISOString(),
        incremental_success_at: null,
        last_error: null,
      })
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "ok",
      mode: "hybrid",
      pending: [],
      looksResolved: [
        {
          recommendationId: "recommendation-followup",
          taskId: task.taskId,
          title: "Send revised proposal",
          reviewCode: "R7K2",
        },
      ],
    });
  });

  it("keeps the brief runnable with an explicit fallback when transition state cannot be read", async () => {
    await seedUser(db);
    await seedSummarizerConfig([]);
    await db.schema.dropTable("task_durability_route_state").execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toEqual({
      status: "error",
      code: "durable_transition_failed",
      retryable: true,
      fallback: [],
    });
  });

  it("retains explicit legacy untracked fallback before an active route has transition state", async () => {
    await seedUser(db);
    const sourceKey = "slack:channel:C_ACTIVE";
    await seedSummarizerConfig([
      {
        id: "route-active",
        sources: [sourceKey],
        focus: null,
        sections: null,
        maxItemsPerSection: null,
        schedule: null,
        destination: { kind: "off" },
        enabled: true,
      },
    ]);
    const evidence = await seedConversationMessage("C_ACTIVE", "active-message");
    await seedSummaryOutput(sourceKey, [{ title: "Follow up with Acme", messageIds: [evidence.messageId] }]);

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "ok",
      mode: "hybrid",
      untracked: [
        {
          title: "Follow up with Acme",
          reviewCode: null,
        },
      ],
    });
  });

  it("does not read transition state when Summarizer task creation is disabled", async () => {
    await seedUser(db);
    const sourceKey = "slack:channel:C_DISABLED";
    await seedSummarizerConfig(
      [
        {
          id: "route-disabled",
          sources: [sourceKey],
          focus: null,
          sections: null,
          maxItemsPerSection: null,
          schedule: null,
          destination: { kind: "off" },
          enabled: true,
        },
      ],
      false,
    );
    const evidence = await seedConversationMessage("C_DISABLED", "disabled-message");
    await seedSummaryOutput(sourceKey, [{ title: "Follow up without durability", messageIds: [evidence.messageId] }]);
    await db.schema.dropTable("task_durability_route_state").execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toBeUndefined();
    expect(context?.recentSummaries).toEqual([
      expect.objectContaining({
        actionItems: [expect.objectContaining({ title: "Follow up without durability" })],
      }),
    ]);
  });

  it("scopes generation context to active Summarizer routes while retaining broad Known Task Memory", async () => {
    await seedUser(db);
    await seedConnectorConfig(db);
    await seedIndexedFile(db, { id: "structural-task-file", sourceUpdatedAt: NOW.toISOString() });
    await db
      .insertInto("entities")
      .values({
        id: "person-owner",
        name: "Agent User",
        source_type: "person",
        subtype: null,
        aliases: JSON.stringify(["agent@example.com"]),
        metadata: JSON.stringify({ email: "agent@example.com" }),
        source_ref_id: null,
        status: "active",
        hotness: 0,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
        ai_brief: null,
      })
      .execute();

    const firstActiveSource = "slack:channel:C_ACTIVE_ONE";
    const secondActiveSource = "slack:channel:C_ACTIVE_TWO";
    const activeRouteSourceKey = `route:${createHash("sha256")
      .update([firstActiveSource, secondActiveSource].sort().join("|"))
      .digest("hex")
      .slice(0, 12)}`;
    const disabledRouteSourceKey = "slack:channel:C_DISABLED";
    await seedSummarizerConfig([
      {
        id: "route-active-combined",
        sources: [firstActiveSource, secondActiveSource],
        focus: null,
        sections: null,
        maxItemsPerSection: null,
        schedule: null,
        destination: { kind: "off" },
        enabled: true,
      },
      {
        id: "route-disabled",
        sources: [disabledRouteSourceKey],
        focus: null,
        sections: null,
        maxItemsPerSection: null,
        schedule: null,
        destination: { kind: "off" },
        enabled: false,
      },
    ]);

    const activeOutputId = await seedSummaryOutput(activeRouteSourceKey, [
      { title: "Active route follow-up", messageIds: [] },
    ]);
    const disabledOutputId = await seedSummaryOutput(disabledRouteSourceKey, [
      { title: "Disabled route follow-up", messageIds: [] },
    ]);
    const tasks = createTaskRepository(db);
    const activeSummaryTask = await tasks.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Active route durable task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: "person-owner",
      assigneeName: "Agent User",
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "active-route-task",
      createdByUserId: "user-1",
    });
    const disabledSummaryTask = await tasks.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Disabled route durable task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: "person-owner",
      assigneeName: "Agent User",
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "disabled-route-task",
      createdByUserId: "user-1",
    });
    const briefTask = await tasks.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "brief",
      externalRef: null,
      title: "General brief task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: "person-owner",
      assigneeName: "Agent User",
      priority: "medium",
      dueAt: null,
      provenance: "brief",
      sourceTaskId: "general-brief-task",
      createdByUserId: "user-1",
    });
    const structuralTask = await tasks.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "linear",
      externalRef: "SKE-STRUCTURAL",
      title: "General structural task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: "medium",
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "general-structural-task",
    });
    await tasks.upsertEvidence(structuralTask.taskId, "file", "structural-task-file");
    await db
      .updateTable("tasks")
      .set({
        origin_agent_output_id: activeOutputId,
        updated_at: "2026-06-25T07:30:00.000Z",
      })
      .where("id", "=", activeSummaryTask.taskId)
      .execute();
    await db
      .updateTable("tasks")
      .set({
        origin_agent_output_id: disabledOutputId,
        updated_at: "2026-06-25T07:30:00.000Z",
      })
      .where("id", "=", disabledSummaryTask.taskId)
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect((context?.recentSummaries as Array<{ outputId: string }>).map((summary) => summary.outputId)).toEqual([
      activeOutputId,
    ]);
    expect((context?.summaryTasks as Array<{ id: string }>).map((task) => task.id)).toEqual([activeSummaryTask.taskId]);
    const openTaskIds = (context?.openDurableTasks as Array<{ id: string }>).map((task) => task.id);
    expect(openTaskIds).toEqual(
      expect.arrayContaining([
        activeSummaryTask.taskId,
        disabledSummaryTask.taskId,
        briefTask.taskId,
        structuralTask.taskId,
      ]),
    );
  });

  it.each([
    {
      name: "single to combined",
      activeRoutes: [summaryRoute("route-combined", ["slack:channel:C_TOPOLOGY", "slack:channel:C_SECONDARY"])],
      historicalSourceKey: "slack:channel:C_TOPOLOGY",
      currentSourceKey: `route:${createHash("sha256")
        .update(["slack:channel:C_TOPOLOGY", "slack:channel:C_SECONDARY"].sort().join("|"))
        .digest("hex")
        .slice(0, 12)}`,
    },
    {
      name: "combined to single",
      activeRoutes: [summaryRoute("route-single", ["slack:channel:C_TOPOLOGY"])],
      historicalSourceKey: `route:${createHash("sha256")
        .update(["slack:channel:C_TOPOLOGY", "slack:channel:C_SECONDARY"].sort().join("|"))
        .digest("hex")
        .slice(0, 12)}`,
      currentSourceKey: "slack:channel:C_TOPOLOGY",
    },
  ])(
    "keeps summary tasks active across $name topology changes while limiting recent summaries to current outputs",
    async ({ activeRoutes, historicalSourceKey, currentSourceKey }) => {
      const assigneeEntityId = await seedTopologyTaskOwner();
      await seedSummarizerConfig(activeRoutes);
      const evidence = await seedConversationMessage("C_TOPOLOGY", `topology-${historicalSourceKey}`);
      const historicalOutputId = await seedSummaryOutput(historicalSourceKey, [
        { title: "Durable topology follow-up", messageIds: [evidence.messageId] },
      ]);
      const currentOutputId = await seedSummaryOutput(currentSourceKey, [
        { title: "Current topology summary", messageIds: [] },
      ]);
      const task = await createTaskRepository(db).upsertTask({
        parentEntityId: null,
        parentSourceRef: null,
        parentName: null,
        source: "summary",
        externalRef: null,
        title: "Durable topology follow-up",
        status: "open",
        statusRaw: "open",
        statusAuthority: "local",
        assigneeEntityId,
        assigneeName: "Agent User",
        priority: "medium",
        dueAt: null,
        provenance: "summary",
        sourceTaskId: `topology-task-${historicalSourceKey}`,
        createdByUserId: "user-1",
      });
      await db
        .updateTable("tasks")
        .set({
          source_platform: "slack",
          source_conversation_id: evidence.conversationId,
          source_anchor_key: `slack:${evidence.conversationId}:root`,
          origin_agent_output_id: historicalOutputId,
          updated_at: "2026-06-25T07:30:00.000Z",
        })
        .where("id", "=", task.taskId)
        .execute();

      const context = await dailyBriefDefinition.augmentRuntimeContext?.({
        db,
        config: createTestConfig(),
        users: createUserRepository(db),
        userId: "user-1",
        maxItemsPerSection: 5,
        baseContext: {
          outputDate: "2026-06-25",
          timezone: "UTC",
          sameDayPreviousOutput: null,
          previousDayOutput: null,
        },
      });

      expect((context?.recentSummaries as Array<{ outputId: string }>).map((summary) => summary.outputId)).toEqual([
        currentOutputId,
      ]);
      expect((context?.summaryTasks as Array<{ id: string }>).map((item) => item.id)).toContain(task.taskId);
      expect((context?.openDurableTasks as Array<{ id: string }>).map((item) => item.id)).toContain(task.taskId);
      expect(context?.followupReminder).toMatchObject({
        status: "ok",
        pending: [expect.objectContaining({ taskId: task.taskId, title: "Durable topology follow-up" })],
      });
    },
  );

  it("keeps a DM summary task active when its route changes from single to combined", async () => {
    const assigneeEntityId = await seedTopologyTaskOwner();
    const evidence = await seedConversationMessage("opaque-slack-dm", "dm-topology", { kind: "dm" });
    const dmSource = `slack:dm:${evidence.conversationId}` as const;
    const currentSourceKey = `route:${createHash("sha256")
      .update([dmSource, "slack:channel:C_SECONDARY"].sort().join("|"))
      .digest("hex")
      .slice(0, 12)}`;
    await seedSummarizerConfig([summaryRoute("route-dm-combined", [dmSource, "slack:channel:C_SECONDARY"])]);
    const historicalOutputId = await seedSummaryOutput(dmSource, [
      { title: "DM topology follow-up", messageIds: [evidence.messageId] },
    ]);
    await seedSummaryOutput(currentSourceKey, [{ title: "Current DM topology summary", messageIds: [] }]);
    const task = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "DM topology follow-up",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId,
      assigneeName: "Agent User",
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "dm-topology-task",
      createdByUserId: "user-1",
    });
    await db
      .updateTable("tasks")
      .set({
        source_platform: "slack",
        source_conversation_id: evidence.conversationId,
        source_anchor_key: `slack:${evidence.conversationId}:root`,
        origin_agent_output_id: historicalOutputId,
        updated_at: "2026-06-25T07:30:00.000Z",
      })
      .where("id", "=", task.taskId)
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect((context?.summaryTasks as Array<{ id: string }>).map((item) => item.id)).toContain(task.taskId);
    expect((context?.openDurableTasks as Array<{ id: string }>).map((item) => item.id)).toContain(task.taskId);
    expect(context?.followupReminder).toMatchObject({
      status: "ok",
      pending: [expect.objectContaining({ taskId: task.taskId, title: "DM topology follow-up" })],
    });
  });

  it("keeps a task assigned to the user when it originated outside the user's own Summarizer routes", async () => {
    const assigneeEntityId = await seedTopologyTaskOwner();
    await seedUser(db, { id: "user-other", email: "other@example.com" });
    await seedSummarizerConfig([summaryRoute("route-own", ["slack:channel:C_OWN"])]);
    const evidence = await seedConversationMessage("C_OTHER_OWNER", "assigned-from-other-route");
    const task = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Assigned from another route",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId,
      assigneeName: "Agent User",
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "assigned-from-other-route",
      createdByUserId: "user-other",
    });
    await db
      .updateTable("tasks")
      .set({
        source_platform: "slack",
        source_conversation_id: evidence.conversationId,
        source_anchor_key: `slack:${evidence.conversationId}:root`,
      })
      .where("id", "=", task.taskId)
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "ok",
      pending: [expect.objectContaining({ taskId: task.taskId, title: "Assigned from another route" })],
    });
  });

  it("keeps historical fallback visible immediately after a single route becomes combined", async () => {
    await seedUser(db);
    const memberSource = "slack:channel:C_TOPOLOGY_FALLBACK";
    await seedSummarizerConfig([summaryRoute("route-combined-fallback", [memberSource, "slack:channel:C_SECONDARY"])]);
    const evidence = await seedConversationMessage("C_TOPOLOGY_FALLBACK", "historical-topology-fallback");
    await seedSummaryOutput(memberSource, [
      { title: "Historical topology fallback", messageIds: [evidence.messageId] },
    ]);

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "ok",
      mode: "hybrid",
      untracked: [expect.objectContaining({ title: "Historical topology fallback" })],
    });
  });

  it("keeps up to ten hybrid fallback outputs per active route", async () => {
    await seedUser(db);
    const firstSource = "slack:channel:C_ROUTE_FIRST";
    const secondSource = "slack:channel:C_ROUTE_SECOND";
    await seedSummarizerConfig([
      summaryRoute("route-first", [firstSource]),
      summaryRoute("route-second", [secondSource]),
    ]);
    const firstEvidence = await seedConversationMessage("C_ROUTE_FIRST", "route-first-message");
    const secondEvidence = await seedConversationMessage("C_ROUTE_SECOND", "route-second-message");
    await seedSummaryOutput(
      firstSource,
      [{ title: "First route fallback", messageIds: [firstEvidence.messageId] }],
      "2026-06-25T06:00:00.000Z",
    );
    for (let index = 0; index < 10; index += 1) {
      await seedSummaryOutput(
        secondSource,
        [{ title: `Second route fallback ${index}`, messageIds: [secondEvidence.messageId] }],
        `2026-06-25T07:${String(index).padStart(2, "0")}:00.000Z`,
      );
    }

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 20,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({ status: "ok", mode: "hybrid" });
    const untracked = (context?.followupReminder as { untracked: Array<{ title: string }> }).untracked;
    expect(untracked).toContainEqual(expect.objectContaining({ title: "First route fallback" }));
    expect(untracked.filter((item) => item.title.startsWith("Second route fallback"))).toHaveLength(10);
  });

  it("marks reminder context non-authoritative when a bounded historical summary page may be incomplete", async () => {
    await seedUser(db);
    const sourceKey = "slack:channel:C_HISTORY_OVERFLOW";
    await seedSummarizerConfig([summaryRoute("route-history-overflow", [sourceKey])]);
    const evidence = await seedConversationMessage("C_HISTORY_OVERFLOW", "history-overflow-message");
    for (let index = 0; index < 50; index += 1) {
      await seedSummaryOutput(
        sourceKey,
        [{ title: `History overflow ${index}`, messageIds: [evidence.messageId] }],
        `2026-06-25T06:${String(index).padStart(2, "0")}:00.000Z`,
      );
    }

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "error",
      code: "reminder_history_overflow",
      retryable: true,
    });
  });

  it("does not let inactive summary history consume the active-route scan cap", async () => {
    await seedUser(db);
    const activeSource = "slack:channel:C_ACTIVE_HISTORY";
    const inactiveSource = "slack:channel:C_INACTIVE_HISTORY";
    await seedSummarizerConfig([summaryRoute("route-active-history", [activeSource])]);
    const activeEvidence = await seedConversationMessage("C_ACTIVE_HISTORY", "active-history");
    const inactiveEvidence = await seedConversationMessage("C_INACTIVE_HISTORY", "inactive-history");
    await seedSummaryOutput(
      activeSource,
      [{ title: "Active historical follow-up", messageIds: [activeEvidence.messageId] }],
      "2026-06-25T06:00:00.000Z",
    );
    for (let index = 0; index < 50; index += 1) {
      await seedSummaryOutput(
        inactiveSource,
        [{ title: `Inactive historical follow-up ${index}`, messageIds: [inactiveEvidence.messageId] }],
        `2026-06-25T07:${String(index).padStart(2, "0")}:00.000Z`,
      );
    }

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "ok",
      mode: "hybrid",
      untracked: [expect.objectContaining({ title: "Active historical follow-up" })],
    });
    expect(JSON.stringify(context)).not.toContain("Inactive historical follow-up");
  });

  it("keeps route-scoped Summary context separate from bounded Known Task Memory", async () => {
    const assigneeEntityId = await seedTopologyTaskOwner();
    const activeSource = "slack:channel:C_ACTIVE_TASK_CAP";
    const inactiveSource = "slack:channel:C_INACTIVE_TASK_CAP";
    await seedSummarizerConfig([summaryRoute("route-active-task-cap", [activeSource])]);
    const activeOutputId = await seedSummaryOutput(activeSource, []);
    const inactiveOutputId = await seedSummaryOutput(inactiveSource, []);
    const tasks = createTaskRepository(db);
    const activeTask = await tasks.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Active task behind inactive cap",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId,
      assigneeName: "Agent User",
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "active-task-behind-inactive-cap",
      createdByUserId: "user-1",
    });
    await db
      .updateTable("tasks")
      .set({
        origin_agent_output_id: activeOutputId,
        updated_at: "2026-06-25T06:00:00.000Z",
      })
      .where("id", "=", activeTask.taskId)
      .execute();
    for (let index = 0; index < 50; index += 1) {
      const inactiveTask = await tasks.upsertTask({
        parentEntityId: null,
        parentSourceRef: null,
        parentName: null,
        source: "summary",
        externalRef: null,
        title: `Inactive task ${index}`,
        status: "open",
        statusRaw: "open",
        statusAuthority: "local",
        assigneeEntityId,
        assigneeName: "Agent User",
        priority: "medium",
        dueAt: null,
        provenance: "summary",
        sourceTaskId: `inactive-task-${index}`,
        createdByUserId: "user-1",
      });
      await db
        .updateTable("tasks")
        .set({
          origin_agent_output_id: inactiveOutputId,
          updated_at: `2026-06-25T07:${String(index).padStart(2, "0")}:00.000Z`,
        })
        .where("id", "=", inactiveTask.taskId)
        .execute();
    }

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        maxItemsPerSection: 1,
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect((context?.summaryTasks as Array<{ id: string }>).map((task) => task.id)).toContain(activeTask.taskId);
    expect(context?.openDurableTasks).toHaveLength(4);
    expect((context?.taskAttention as { items: unknown[] }).items).toEqual([]);
  });

  it("caps fallback reminder items when transition reads fail", async () => {
    await seedUser(db);
    const sourceKey = "slack:channel:C_TRANSITION_FALLBACK_CAP";
    await seedSummarizerConfig([summaryRoute("route-transition-fallback-cap", [sourceKey])]);
    const evidence = await seedConversationMessage("C_TRANSITION_FALLBACK_CAP", "transition-fallback-cap");
    await seedSummaryOutput(
      sourceKey,
      Array.from({ length: 30 }, (_, index) => ({
        title: `Transition fallback ${index}`,
        messageIds: [evidence.messageId],
      })),
    );
    await db.schema.dropTable("task_durability_route_state").execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "error",
      code: "durable_transition_failed",
      fallback: expect.any(Array),
    });
    expect((context?.followupReminder as { fallback: unknown[] }).fallback).toHaveLength(25);
  });

  it("keeps exact suppression identities when completed tasks are the only reminder state", async () => {
    await seedUser(db);
    const task = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Send revised proposal",
      status: "done",
      statusRaw: "done",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "completed-only-task",
      createdByUserId: "user-1",
    });
    await db
      .updateTable("tasks")
      .set({ source_anchor_key: "slack:42:root", updated_at: "2026-06-20T08:00:00.000Z" })
      .where("id", "=", task.taskId)
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "ok",
      suppressed: [
        {
          taskId: task.taskId,
          title: "Send revised proposal",
          sourceAnchorKey: "slack:42:root",
        },
      ],
    });
  });

  it("does not duplicate a pending seed proposal as a legacy untracked item", async () => {
    await seedUser(db);
    const sourceKey = "slack:channel:C_SEED";
    await seedSummarizerConfig([
      {
        id: "route-seed",
        sources: [sourceKey],
        focus: null,
        sections: null,
        maxItemsPerSection: null,
        schedule: null,
        destination: { kind: "off" },
        enabled: true,
      },
    ]);
    const evidence = await seedConversationMessage("C_SEED", "seed-message");
    const outputId = await seedSummaryOutput(sourceKey, [
      { title: "Follow up with Acme", messageIds: [evidence.messageId] },
    ]);
    const sourceAnchorKey = `slack:${evidence.conversationId}:root`;
    const evidenceFingerprint = createHash("sha256")
      .update(JSON.stringify(["follow up with acme", sourceAnchorKey, [evidence.messageId]]))
      .digest("hex");
    await db
      .insertInto("task_durability_route_state")
      .values({
        agent_key: "conversation_summary",
        user_id: "user-1",
        route_id: "route-seed",
        source_key: sourceKey,
        mode: "hybrid",
        seed_state: "pending",
        seed_started_at: NOW.toISOString(),
        seed_reviewed_at: null,
        incremental_success_at: null,
        last_error: null,
      })
      .execute();
    await db
      .insertInto("task_seed_candidates")
      .values({
        id: "pending-seed",
        agent_key: "conversation_summary",
        user_id: "user-1",
        route_id: "route-seed",
        source_key: sourceKey,
        origin_agent_output_id: outputId,
        origin_agent_output_item_id: null,
        title: "Follow up with Acme",
        normalized_title: "follow up with acme",
        proposed_assignee_name: null,
        source_platform: "slack",
        source_conversation_id: evidence.conversationId,
        source_provider_thread_id: null,
        source_anchor_key: sourceAnchorKey,
        evidence_fingerprint: evidenceFingerprint,
        review_code: "SEED1234",
        review_state: "pending",
        accepted_task_id: null,
        reviewed_at: null,
        reviewed_by_user_id: null,
      })
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "ok",
      mode: "hybrid",
      untracked: [
        {
          candidateId: "pending-seed",
          title: "Follow up with Acme",
          reviewCode: "SEED1234",
          sourceKey,
          sourceAnchorKey,
        },
      ],
    });
    expect((context?.followupReminder as { untracked: unknown[] }).untracked).toHaveLength(1);
  });

  it("uses recent-summary candidates as explicit fallback when a durable-only reminder query fails", async () => {
    await seedUser(db);
    const sourceKey = "slack:channel:C_FALLBACK";
    await seedSummarizerConfig([
      {
        id: "route-fallback",
        sources: [sourceKey],
        focus: null,
        sections: null,
        maxItemsPerSection: null,
        schedule: null,
        destination: { kind: "off" },
        enabled: true,
      },
    ]);
    const evidence = await seedConversationMessage("C_FALLBACK", "fallback-message");
    const outputId = await seedSummaryOutput(sourceKey, [
      { title: "Recover this follow-up", messageIds: [evidence.messageId] },
    ]);
    await db
      .insertInto("task_durability_route_state")
      .values({
        agent_key: "conversation_summary",
        user_id: "user-1",
        route_id: "route-fallback",
        source_key: sourceKey,
        mode: "durable_only",
        seed_state: "reviewed",
        seed_started_at: NOW.toISOString(),
        seed_reviewed_at: NOW.toISOString(),
        incremental_success_at: NOW.toISOString(),
        last_error: null,
      })
      .execute();
    const task = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Existing durable task",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "fallback-task",
      createdByUserId: "user-1",
    });
    await db
      .updateTable("tasks")
      .set({
        source_platform: "slack",
        source_conversation_id: evidence.conversationId,
        source_anchor_key: `slack:${evidence.conversationId}:root`,
        origin_agent_output_id: outputId,
      })
      .where("id", "=", task.taskId)
      .execute();
    await db.schema.dropTable("task_completion_recommendations").execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "error",
      code: "durable_query_failed",
      fallback: [
        {
          title: "Recover this follow-up",
          sourceKey,
          sourceAnchorKey: `slack:${evidence.conversationId}:root`,
        },
      ],
    });
  });

  it("suppresses only the dismissed member anchor for same-title combined-route summaries", async () => {
    await seedUser(db);
    const firstSource = "slack:channel:C_FIRST";
    const secondSource = "slack:channel:C_SECOND";
    const routeSourceKey = `route:${createHash("sha256")
      .update([firstSource, secondSource].sort().join("|"))
      .digest("hex")
      .slice(0, 12)}`;
    await seedSummarizerConfig([
      {
        id: "combined-route",
        sources: [firstSource, secondSource],
        focus: null,
        sections: null,
        maxItemsPerSection: null,
        schedule: null,
        destination: { kind: "off" },
        enabled: true,
      },
    ]);
    const first = await seedConversationMessage("C_FIRST", "first-message");
    const second = await seedConversationMessage("C_SECOND", "second-message");
    const outputId = await seedSummaryOutput(routeSourceKey, [
      { title: "Send revised proposal", messageIds: [first.messageId] },
      { title: "Send revised proposal", messageIds: [second.messageId] },
    ]);
    await db
      .insertInto("task_durability_route_state")
      .values({
        agent_key: "conversation_summary",
        user_id: "user-1",
        route_id: "combined-route",
        source_key: routeSourceKey,
        mode: "hybrid",
        seed_state: "reviewed",
        seed_started_at: NOW.toISOString(),
        seed_reviewed_at: NOW.toISOString(),
        incremental_success_at: null,
        last_error: null,
      })
      .execute();
    await db
      .insertInto("task_seed_candidates")
      .values({
        id: "dismissed-first-anchor",
        agent_key: "conversation_summary",
        user_id: "user-1",
        route_id: "combined-route",
        source_key: routeSourceKey,
        origin_agent_output_id: outputId,
        origin_agent_output_item_id: null,
        title: "Send revised proposal",
        normalized_title: "send revised proposal",
        proposed_assignee_name: null,
        source_platform: "slack",
        source_conversation_id: first.conversationId,
        source_provider_thread_id: null,
        source_anchor_key: `slack:${first.conversationId}:root`,
        evidence_fingerprint: "dismissed-first-fingerprint",
        review_code: "DISM1234",
        review_state: "dismissed",
        accepted_task_id: null,
        reviewed_at: NOW.toISOString(),
        reviewed_by_user_id: "user-1",
      })
      .execute();

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: "user-1",
      maxItemsPerSection: 5,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect(context?.followupReminder).toMatchObject({
      status: "ok",
      mode: "hybrid",
      untracked: [
        {
          title: "Send revised proposal",
          reviewCode: null,
        },
      ],
    });
  });
});
