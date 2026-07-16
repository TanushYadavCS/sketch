import type { Kysely, Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOutputItemInput } from "../../db/repositories/agent-outputs";
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
  params: {
    id?: string;
    name?: string;
    email?: string;
    emailVerified?: boolean;
    authRole?: "member" | "admin";
  } = {},
): Promise<Selectable<UsersTable>> {
  const id = params.id ?? "user-1";
  await db
    .insertInto("users")
    .values({
      id,
      name: params.name ?? "Agent User",
      email: params.email ?? "agent@example.com",
      email_verified_at: params.emailVerified ? NOW.toISOString() : null,
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

async function seedPersonEntity(
  db: Kysely<DB>,
  params: { id: string; name: string; emails?: string[] },
): Promise<void> {
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
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      ai_brief: null,
    })
    .execute();
  for (const [index, email] of (params.emails ?? []).entries()) {
    await db
      .insertInto("entity_contact_points")
      .values({
        id: `${params.id}-email-${index}`,
        entity_id: params.id,
        kind: "email",
        value: email.toLowerCase(),
        display_value: email,
        label: null,
        source: "test",
        connector_config_id: null,
        created_by_user_id: null,
        verified_at: NOW.toISOString(),
        last_contacted_at: null,
      })
      .execute();
  }
}

async function seedTask(
  db: Kysely<DB>,
  params: {
    id: string;
    title: string;
    status?: "open" | "in_progress" | "done" | "dropped";
    statusRaw?: string;
    priority?: string | null;
    provenance?: "structural" | "brief" | "summary";
    assigneeEntityId?: string | null;
    parentEntityId?: string | null;
    createdByUserId?: string | null;
    updatedAt?: string;
    fileIds?: string[];
    entityIds?: string[];
  },
): Promise<void> {
  const repo = createTaskRepository(db);
  await repo.upsertTask({
    parentEntityId: params.parentEntityId ?? null,
    parentSourceRef: null,
    parentName: null,
    source: params.provenance === "structural" ? "linear" : (params.provenance ?? "summary"),
    externalRef: `EXT-${params.id}`,
    title: params.title,
    status: params.status ?? "open",
    statusRaw: params.statusRaw ?? params.status ?? "open",
    statusAuthority: params.provenance === "structural" ? "external" : "local",
    assigneeEntityId: params.assigneeEntityId ?? null,
    priority: params.priority ?? null,
    dueAt: null,
    provenance: params.provenance ?? "summary",
    sourceTaskId: params.id,
    createdByUserId: params.createdByUserId ?? null,
  });
  const task = await db
    .selectFrom("tasks")
    .select("id")
    .where("source_task_id", "=", params.id)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("tasks")
    .set({ id: params.id, updated_at: params.updatedAt ?? NOW.toISOString() })
    .where("id", "=", task.id)
    .execute();
  for (const fileId of params.fileIds ?? []) await repo.upsertEvidence(params.id, "file", fileId);
  for (const entityId of params.entityIds ?? []) await repo.upsertEvidence(params.id, "entity", entityId);
}

describe("dailyBriefDefinition.buildInstructions", () => {
  it("is static and defers per-user values to the runtime context (prompt-cache safe)", () => {
    const instructions = dailyBriefDefinition.buildInstructions();

    expect(instructions).toContain("runtime context `sections`");
    expect(instructions).toContain("runtime context `maxItemsPerSection`");
    expect(instructions).toContain("`focus` field");
    expect(instructions).toContain("dailyBriefCandidateContext");
    expect(instructions).toContain("evidenceSince");
    expect(instructions).toContain("windowEnd");

    expect(instructions).toContain("todos:");
    expect(instructions).toContain("customer_updates:");
    expect(instructions).toContain("active_projects:");

    expect(instructions).not.toMatch(/at most \d+ items/);
  });

  it("requires todos to project only allowlisted durable task ids", () => {
    const instructions = dailyBriefDefinition.buildInstructions();

    expect(instructions).toContain("structuredPayload.durableTaskId");
    expect(instructions).toContain("openDurableTasks");
    expect(instructions).toMatch(/only IDs present in `openDurableTasks`/);
    expect(instructions).toMatch(/Do not derive new todos from recentSummaries or broad search/);
  });
});

describe("dailyBriefDefinition.augmentRuntimeContext", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedConnectorConfig(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("resolves verified primary and provider emails into an unambiguous reader-owned task runtime", async () => {
    const user = await seedUser(db, {
      id: "reader-1",
      email: "primary@example.com",
      emailVerified: true,
    });
    await db
      .insertInto("user_provider_identities")
      .values({
        id: "provider-reader-1",
        user_id: user.id,
        provider: "google",
        provider_user_id: "google-reader-1",
        provider_email: "provider@example.com",
      })
      .execute();
    await seedPersonEntity(db, {
      id: "person-reader",
      name: "Reader Person",
      emails: ["primary@example.com", "provider@example.com"],
    });
    await seedEntity(db, { id: "project-runtime", name: "Runtime Project" });
    await seedIndexedFile(db, { id: "file-runtime", sourceUpdatedAt: NOW.toISOString() });
    await seedTask(db, {
      id: "task-runtime",
      title: "Canonical task title",
      status: "in_progress",
      statusRaw: "Started",
      priority: "Urgent",
      provenance: "structural",
      assigneeEntityId: "person-reader",
      parentEntityId: "project-runtime",
      updatedAt: "2026-06-25T07:00:00.000Z",
      fileIds: ["file-runtime"],
    });
    await seedTask(db, {
      id: "summary-assigned",
      title: "Assigned summary task",
      provenance: "summary",
      assigneeEntityId: "person-reader",
      updatedAt: "2026-06-25T06:00:00.000Z",
      fileIds: ["file-runtime"],
    });

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: user.id,
      maxItemsPerSection: 4,
      baseContext: { outputDate: "2026-06-25", timezone: "UTC" },
    });

    expect(context?.openDurableTasks).toEqual([
      {
        id: "task-runtime",
        title: "Canonical task title",
        status: "in_progress",
        statusRaw: "Started",
        priority: "Urgent",
        provenance: "structural",
        externalRef: "EXT-task-runtime",
        updatedAt: "2026-06-25T07:00:00.000Z",
        createdByReader: false,
        assignedToReader: true,
        parentEntity: { id: "project-runtime", name: "Runtime Project", sourceType: "project" },
        assigneeEntity: { id: "person-reader", name: "Reader Person", sourceType: "person" },
        knowledgeRefs: {
          entityIds: ["person-reader", "project-runtime"],
          fileIds: ["file-runtime"],
        },
      },
      {
        id: "summary-assigned",
        title: "Assigned summary task",
        status: "open",
        statusRaw: "open",
        priority: null,
        provenance: "summary",
        externalRef: "EXT-summary-assigned",
        updatedAt: "2026-06-25T06:00:00.000Z",
        createdByReader: false,
        assignedToReader: true,
        parentEntity: null,
        assigneeEntity: { id: "person-reader", name: "Reader Person", sourceType: "person" },
        knowledgeRefs: {
          entityIds: ["person-reader"],
          fileIds: ["file-runtime"],
        },
      },
    ]);
    expect(context?.summaryTasks).toEqual([
      expect.objectContaining({ id: "summary-assigned", title: "Assigned summary task" }),
    ]);
    expect(context?.identityUnresolvedTaskCount).toBe(0);
  });

  it("does not fall back to matching the user name and fails structural tasks closed when identity is unresolved", async () => {
    const user = await seedUser(db, {
      id: "reader-unresolved",
      name: "Matching Person Name",
      email: "verified-but-unmapped@example.com",
      emailVerified: true,
    });
    await seedPersonEntity(db, { id: "person-name-only", name: "Matching Person Name" });
    await seedIndexedFile(db, { id: "file-unresolved", sourceUpdatedAt: NOW.toISOString() });
    await seedTask(db, {
      id: "structural-withheld",
      title: "Withheld structural task",
      provenance: "structural",
      assigneeEntityId: "person-name-only",
      fileIds: ["file-unresolved"],
    });
    await seedTask(db, {
      id: "reader-created-local",
      title: "Reader-created local task",
      provenance: "summary",
      createdByUserId: user.id,
      fileIds: ["file-unresolved"],
    });

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: user.id,
      maxItemsPerSection: 4,
      baseContext: { outputDate: "2026-06-25", timezone: "UTC" },
    });

    expect(context?.openDurableTasks).toEqual([
      expect.objectContaining({ id: "reader-created-local", createdByReader: true, assignedToReader: false }),
    ]);
    expect(context?.identityUnresolvedTaskCount).toBe(1);
  });

  it("loads the complete reader-owned allowlist while reconciliation caps displayed todos", async () => {
    const user = await seedUser(db, {
      id: "reader-many-tasks",
      email: "many-tasks@example.com",
      emailVerified: true,
    });
    await seedEntity(db, { id: "project-many-tasks", name: "Many Tasks Project" });
    const taskIds = Array.from({ length: 55 }, (_, index) => `task-many-${String(index).padStart(2, "0")}`);
    for (const taskId of taskIds) {
      await seedTask(db, {
        id: taskId,
        title: `Canonical ${taskId}`,
        provenance: "summary",
        createdByUserId: user.id,
        parentEntityId: "project-many-tasks",
      });
    }

    const context = await dailyBriefDefinition.augmentRuntimeContext?.({
      db,
      config: createTestConfig(),
      users: createUserRepository(db),
      userId: user.id,
      maxItemsPerSection: 4,
      baseContext: { outputDate: "2026-06-25", timezone: "UTC" },
    });

    const openDurableTasks = context?.openDurableTasks as Array<{ id: string }>;
    expect(openDurableTasks.map((task) => task.id).sort()).toEqual(taskIds);

    const reconciled =
      (await dailyBriefDefinition.reconcileItems?.({
        db,
        items: [],
        runtimeContext: {
          ...context,
          sections: ["todos"],
          maxItemsPerSection: 4,
        },
        logger: { info: vi.fn() } as never,
        outputId: "output-many-tasks",
        userId: user.id,
      })) ?? [];

    expect(reconciled.filter((item) => item.sectionKey === "todos")).toHaveLength(4);
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

  function todoItem(durableTaskId: unknown, overrides: Partial<AgentOutputItemInput> = {}): AgentOutputItemInput {
    return {
      sectionKey: "todos",
      title: "Model todo title",
      summary: "Model todo summary",
      priority: "low",
      label: "blocked",
      actionLabel: "Unblock with Sketch",
      actionPrompt: "Model prompt",
      structuredPayload: { durableTaskId, unrelated: "model data" },
      knowledgeRefs: { entityIds: ["model-entity"], fileIds: ["model-file"] },
      sortOrder: 99,
      ...overrides,
    };
  }

  function durableTask(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      title: `Canonical ${id}`,
      status: "open",
      statusRaw: "Open",
      priority: "medium",
      provenance: "structural",
      externalRef: `EXT-${id}`,
      updatedAt: "2026-06-25T06:00:00.000Z",
      createdByReader: false,
      assignedToReader: true,
      parentEntity: null,
      assigneeEntity: { id: "person-reader", name: "Reader", sourceType: "person" },
      knowledgeRefs: { entityIds: ["person-reader"], fileIds: [`file-${id}`] },
      ...overrides,
    };
  }

  function reconcileLogger() {
    return { info: vi.fn() };
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
        title: "Model todo title",
        summary: "do it",
        priority: "high",
        label: "todo",
        structuredPayload: { durableTaskId: "task-1" },
        knowledgeRefs: { entityIds: ["model-entity"], fileIds: ["model-file"] },
        sortOrder: 0,
      },
    ];

    const result =
      (await dailyBriefDefinition.reconcileItems?.({
        db,
        items,
        runtimeContext: {
          sections: ["meetings", "todos"],
          maxItemsPerSection: 4,
          todaysMeetings: skeleton,
          openDurableTasks: [durableTask("task-1")],
          identityUnresolvedTaskCount: 0,
        },
        logger: reconcileLogger() as never,
        outputId: "output-meetings",
        userId: "user-meetings",
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
        logger: reconcileLogger() as never,
        outputId: "output-empty-meetings",
        userId: "user-meetings",
      })) ?? [];

    expect(result).toEqual([]);
  });

  it("leaves items untouched when the meetings section is disabled", async () => {
    const items = [meetingItem("evt-1", null)];
    const result = await dailyBriefDefinition.reconcileItems?.({
      db,
      items,
      runtimeContext: { sections: ["todos"], todaysMeetings: skeleton },
      logger: reconcileLogger() as never,
      outputId: "output-meetings-disabled",
      userId: "user-meetings",
    });

    expect(result).toBe(items);
  });

  it("accepts only unique allowlisted durable task ids and canonicalizes task-owned fields", async () => {
    const logger = reconcileLogger();
    const customer = {
      sectionKey: "customer_updates",
      title: "Customer unchanged",
      summary: "Keep this model content",
      priority: "high",
      label: "warm",
      knowledgeRefs: { entityIds: ["customer-1"], fileIds: ["customer-file"] },
      sortOrder: 0,
    } satisfies AgentOutputItemInput;
    const items = [
      todoItem("task-valid"),
      todoItem(undefined, { structuredPayload: {} }),
      todoItem(42),
      todoItem("task-invented"),
      todoItem("task-valid"),
      customer,
    ];

    const result =
      (await dailyBriefDefinition.reconcileItems?.({
        db,
        items,
        runtimeContext: {
          sections: ["todos", "customer_updates"],
          maxItemsPerSection: 4,
          openDurableTasks: [
            durableTask("task-valid", {
              title: "Canonical urgent task",
              status: "in_progress",
              statusRaw: "Started",
              priority: "urgent",
              knowledgeRefs: { entityIds: ["project-1"], fileIds: ["canonical-file"] },
            }),
            durableTask("task-no-refs", {
              knowledgeRefs: { entityIds: [], fileIds: [] },
            }),
          ],
          identityUnresolvedTaskCount: 3,
        },
        logger: logger as never,
        outputId: "output-reconcile",
        userId: "user-reconcile",
      })) ?? [];

    expect(result.filter((item) => item.sectionKey === "todos")).toEqual([
      expect.objectContaining({
        title: "Canonical urgent task",
        label: "in_progress",
        priority: "high",
        structuredPayload: { durableTaskId: "task-valid" },
        knowledgeRefs: { entityIds: ["project-1"], fileIds: ["canonical-file"] },
        sortOrder: 0,
      }),
    ]);
    expect(result.find((item) => item.sectionKey === "customer_updates")).toBe(customer);
    expect(JSON.stringify(result)).not.toContain("model-entity");
    expect(JSON.stringify(result)).not.toContain("model-file");
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]?.[0]).toEqual({
      outputId: "output-reconcile",
      userId: "user-reconcile",
      allowedTaskCount: 1,
      rejectedTaskCount: 4,
      backfilledTaskCount: 0,
      identityUnresolvedTaskCount: 3,
    });
    expect(Object.keys(logger.info.mock.calls[0]?.[0] ?? {}).sort()).toEqual(
      [
        "allowedTaskCount",
        "backfilledTaskCount",
        "identityUnresolvedTaskCount",
        "outputId",
        "rejectedTaskCount",
        "userId",
      ].sort(),
    );
  });

  it("backfills unused tasks in updatedAt DESC then id ASC order and enforces the todo cap", async () => {
    const logger = reconcileLogger();
    const result =
      (await dailyBriefDefinition.reconcileItems?.({
        db,
        items: [todoItem("task-b")],
        runtimeContext: {
          sections: ["todos"],
          maxItemsPerSection: 3,
          openDurableTasks: [
            durableTask("task-a", {
              priority: null,
              updatedAt: "2026-06-25T06:00:00.000Z",
            }),
            durableTask("task-b", {
              priority: "low",
              updatedAt: "2026-06-25T06:00:00.000Z",
            }),
            durableTask("task-latest", {
              status: "in_progress",
              priority: "1",
              updatedAt: "2026-06-25T07:00:00.000Z",
            }),
            durableTask("task-over-cap", {
              updatedAt: "2026-06-25T05:00:00.000Z",
            }),
          ],
          identityUnresolvedTaskCount: 0,
        },
        logger: logger as never,
        outputId: "output-backfill",
        userId: "user-backfill",
      })) ?? [];

    const todos = result.filter((item) => item.sectionKey === "todos");
    expect(todos.map((item) => item.structuredPayload?.durableTaskId)).toEqual(["task-b", "task-latest", "task-a"]);
    expect(todos.map((item) => item.priority)).toEqual(["low", "high", "medium"]);
    expect(todos.map((item) => item.label)).toEqual(["todo", "in_progress", "todo"]);
    expect(todos.slice(1)).toEqual([
      expect.objectContaining({
        summary: expect.any(String),
        actionLabel: "Plan with Sketch",
        actionPrompt: expect.any(String),
        sortOrder: 1,
      }),
      expect.objectContaining({
        summary: expect.any(String),
        actionLabel: "Plan with Sketch",
        actionPrompt: expect.any(String),
        sortOrder: 2,
      }),
    ]);
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
      allowedTaskCount: 4,
      rejectedTaskCount: 0,
      backfilledTaskCount: 2,
    });
  });

  it("composes todo projection with meeting reconciliation while leaving customer and project items unchanged", async () => {
    const logger = reconcileLogger();
    const customer = {
      sectionKey: "customer_updates",
      title: "Customer update",
      summary: "Customer model summary",
      priority: "high",
      label: "at_risk",
      knowledgeRefs: { entityIds: ["customer-1"], fileIds: ["customer-file"] },
      sortOrder: 0,
    } satisfies AgentOutputItemInput;
    const project = {
      sectionKey: "active_projects",
      title: "Project update",
      summary: "Project model summary",
      priority: "medium",
      label: "active",
      knowledgeRefs: { entityIds: ["project-1"], fileIds: ["project-file"] },
      sortOrder: 0,
    } satisfies AgentOutputItemInput;

    const result =
      (await dailyBriefDefinition.reconcileItems?.({
        db,
        items: [meetingItem("evt-1", { context: "Meeting context" }), todoItem("task-compose"), customer, project],
        runtimeContext: {
          sections: ["meetings", "todos", "customer_updates", "active_projects"],
          maxItemsPerSection: 2,
          todaysMeetings: [skeleton[0]],
          openDurableTasks: [durableTask("task-compose")],
          identityUnresolvedTaskCount: 0,
        },
        logger: logger as never,
        outputId: "output-compose",
        userId: "user-compose",
      })) ?? [];

    expect(result.map((item) => item.sectionKey)).toEqual(["meetings", "todos", "customer_updates", "active_projects"]);
    expect(result[0]).toMatchObject({ title: "Standup", summary: "Meeting context" });
    expect(result[1]).toMatchObject({
      title: "Canonical task-compose",
      structuredPayload: { durableTaskId: "task-compose" },
    });
    expect(result[2]).toBe(customer);
    expect(result[3]).toBe(project);
  });
});

describe("dailyBriefDefinition.onOutputSaved", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db, { id: "user-1", name: "Agent User", email: "agent@example.com", emailVerified: true });
    await seedConnectorConfig(db);
    await seedPersonEntity(db, {
      id: "person-agent",
      name: "Agent User",
      emails: ["agent@example.com"],
    });
    await seedIndexedFile(db, { id: "task-source", sourceUpdatedAt: NOW.toISOString() });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("skips promotion for every todo carrying a valid durable task id even when task creation is enabled", async () => {
    await dailyBriefDefinition.onOutputSaved?.({
      db,
      config: createTestConfig(),
      logger: createTestLogger(),
      userId: "user-1",
      outputId: "output-task-backed",
      createTasks: true,
      items: [
        {
          sectionKey: "todos",
          title: "Task-backed todo",
          summary: "Already represents a durable task.",
          priority: "high",
          label: "todo",
          structuredPayload: {
            durableTaskId: "durable-task-1",
            assigneeName: "Agent User",
          },
          knowledgeRefs: { entityIds: [], fileIds: ["task-source"] },
          sortOrder: 0,
        },
      ],
    });

    const row = await db
      .selectFrom("tasks")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(row.count)).toBe(0);
  });
});
