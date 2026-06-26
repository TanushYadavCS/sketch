import type { Kysely, Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentOutputItemInput } from "../../db/repositories/agent-outputs";
import type { DB, UsersTable } from "../../db/schema";
import { createTestDb } from "../../test-utils";
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
  },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: params.id,
      connector_config_id: params.connectorConfigId ?? "config-1",
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

  it("excludes all-day events (UTC-midnight sentinel) regardless of timezone", async () => {
    await seedCalendarEvent(db, { id: "evt-all-day", startTime: "2026-06-25T00:00:00.000Z", title: "Team offsite" });
    await seedCalendarEvent(db, { id: "evt-timed", startTime: "2026-06-25T09:00:00.000Z", title: "Standup" });

    const utcMeetings = await buildTodaysMeetings({ db, user, ...MEETINGS_RUNTIME_PARAMS });
    expect(utcMeetings.map((meeting) => meeting.fileId)).toEqual(["evt-timed"]);

    const istMeetings = await buildTodaysMeetings({
      db,
      user,
      ...MEETINGS_RUNTIME_PARAMS,
      timezone: "Asia/Kolkata",
    });
    expect(istMeetings.map((meeting) => meeting.fileId)).toEqual(["evt-timed"]);
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

  it("collapses duplicate calendar copies of one event, preferring the reader-owned copy", async () => {
    await seedUser(db, { id: "coworker", email: "coworker@example.com" });
    await seedCalendarConnector(db, { id: "cal-reader", createdBy: "user-1" });
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

  it("scopes an admin's meetings to their own calendar even with the read-all bypass", async () => {
    const admin = await seedUser(db, { id: "admin-1", email: "admin@example.com", authRole: "admin" });
    await seedCalendarEvent(db, {
      id: "evt-mine",
      startTime: "2026-06-25T09:00:00.000Z",
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

    expect(result).toBe(items);
  });
});
