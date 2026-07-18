import { createHash } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentOutputItemInput,
  type AgentRoute,
  createAgentOutputRepository,
} from "../../db/repositories/agent-outputs";
import { createTaskRepository } from "../../db/repositories/tasks";
import { createUserRepository } from "../../db/repositories/users";
import type { DB, UsersTable } from "../../db/schema";
import { createTestConfig, createTestDb } from "../../test-utils";
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
    expect(instructions).toContain("evidenceSince");
    expect(instructions).toContain("windowEnd");

    expect(instructions).toContain("todos:");
    expect(instructions).toContain("customer_updates:");
    expect(instructions).toContain("active_projects:");

    expect(instructions).not.toMatch(/at most \d+ items/);
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

  it("scopes conversation generation context to active Summarizer routes while retaining general tasks", async () => {
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
      expect.arrayContaining([activeSummaryTask.taskId, briefTask.taskId, structuralTask.taskId]),
    );
    expect(openTaskIds).not.toContain(disabledSummaryTask.taskId);
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

  it("filters inactive summary tasks in SQL before applying brief task limits", async () => {
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
      maxItemsPerSection: 1,
      baseContext: {
        outputDate: "2026-06-25",
        timezone: "UTC",
        sameDayPreviousOutput: null,
        previousDayOutput: null,
      },
    });

    expect((context?.summaryTasks as Array<{ id: string }>).map((task) => task.id)).toContain(activeTask.taskId);
    expect((context?.openDurableTasks as Array<{ id: string }>).map((task) => task.id)).toContain(activeTask.taskId);
    expect(JSON.stringify(context)).not.toContain("Inactive task");
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
          candidateId: "SEED1234",
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
