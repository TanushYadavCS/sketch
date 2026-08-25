import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { microsoftGraphRequest, parseVttToTranscript } from "./microsoft-graph";
import { runConnectorSync } from "./sync";
import { createTeamsConnector } from "./teams";
import { type OAuthCredentials, type SyncedItem, toEmailPrincipals } from "./types";

const logger = createTestLogger();
const TEAMS_EVENT_START = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const TEAMS_EVENT_END = new Date(TEAMS_EVENT_START.getTime() + 60 * 60 * 1000);
const TEAMS_EVENT_MODIFIED = new Date(TEAMS_EVENT_END.getTime() + 5 * 60 * 1000);
const TEAMS_TRANSCRIPT_CREATED = new Date(TEAMS_EVENT_START.getTime() + 45 * 60 * 1000);
const CHAT_CREATED = new Date(Date.now() - 24 * 60 * 60 * 1000);

const sortedEmailPrincipals = (emails: string[]) =>
  toEmailPrincipals(emails).sort((left, right) => left.value.localeCompare(right.value));

describe("Teams connector", () => {
  let db: Kysely<DB> | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (db) {
      await db.destroy();
      db = null;
    }
  });

  it("parses VTT into speaker-labeled transcript text", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:00.000 --> 00:00:02.000",
      "<v Jane Doe>Hello &amp; welcome</v>",
      "",
      "2",
      "00:00:02.000 --> 00:00:04.000",
      "<v Bob Smith>We agreed to ship it.</v>",
    ].join("\n");

    expect(parseVttToTranscript(vtt)).toBe("Jane Doe: Hello & welcome\nBob Smith: We agreed to ship it.");
  });

  it("discovers Teams meetings, skips inaccessible meetings, and emits meeting transcript items", async () => {
    const connector = createTeamsConnector({ maxInflight: 2, processingLagMs: 0, retryBaseMs: 0 });
    mockTeamsGraph();

    const items: SyncedItem[] = [];
    for await (const item of connector.sync({
      credentials: validCredentials(),
      scopeConfig: { initialDays: 7 },
      cursor: null,
      logger,
      ownerEmail: "owner@canvasx.ai",
    })) {
      items.push(item);
    }

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      providerFileId: "transcript-good",
      providerUrl: "https://teams.microsoft.com/recording/good",
      fileName: "Acme kickoff",
      fileType: "meeting_transcript",
      contentCategory: "document",
      sourceCreatedAt: TEAMS_EVENT_START.toISOString(),
    });
    expect(items[0].content).toContain("Jane Doe: Confirmed the launch plan.");
    expect(items[0].attendees).toEqual([
      { name: "Jane Doe", email: "jane@example.com" },
      { name: "Owner User", email: "owner@canvasx.ai" },
    ]);
    expect(items[0].accessPrincipals).toEqual(sortedEmailPrincipals(["jane@example.com", "owner@canvasx.ai"]));
  });

  it("ingests a chat-started meeting that has no calendar event", async () => {
    const connector = createTeamsConnector({ maxInflight: 2, processingLagMs: 0, retryBaseMs: 0 });
    mockTeamsChatGraph();

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { initialDays: 7 },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );

    expect(items.map((item) => item.providerFileId).sort()).toEqual(["transcript-chat", "transcript-good"]);
    const chatItem = items.find((item) => item.providerFileId === "transcript-chat");
    expect(chatItem).toMatchObject({
      fileName: "Meeting with Ranjith",
      fileType: "meeting_transcript",
      sourceCreatedAt: CHAT_CREATED.toISOString(),
    });
    expect(chatItem?.content).toContain("Ihab: Started this from the chat.");
  });

  it("does not ingest a meeting twice when its chat and calendar event share a join URL", async () => {
    const connector = createTeamsConnector({ maxInflight: 2, processingLagMs: 0, retryBaseMs: 0 });
    mockTeamsChatGraph({ chatMirrorsCalendarEvent: true });

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { initialDays: 7 },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );

    expect(items.map((item) => item.providerFileId)).toEqual(["transcript-good"]);
  });

  it("revisits a chat meeting whose transcript only appears on a later run", async () => {
    const connector = createTeamsConnector({ maxInflight: 2, processingLagMs: 0, retryBaseMs: 0 });
    mockTeamsChatGraph({ chatTranscriptPending: true });

    const first = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { initialDays: 7 },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );
    expect(first.map((item) => item.providerFileId)).toEqual(["transcript-good"]);

    const cursor = await connector.getCursor({
      credentials: validCredentials(),
      scopeConfig: {},
      currentCursor: null,
      logger,
    });

    vi.restoreAllMocks();
    mockTeamsChatGraph();
    const removals: Array<{ providerFileId?: string; reason: string }> = [];
    const second = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { initialDays: 7 },
        cursor,
        logger,
        ownerEmail: "owner@canvasx.ai",
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(second.map((item) => item.providerFileId).sort()).toEqual(["transcript-chat", "transcript-good"]);
    expect(removals.map((record) => record.providerFileId)).not.toContain("transcript-chat");
  });

  it("keeps chat-discovered transcripts when chat discovery later becomes unauthorized", async () => {
    const connector = createTeamsConnector({
      maxInflight: 2,
      processingLagMs: 2 * 24 * 60 * 60 * 1000,
      retryBaseMs: 0,
    });
    mockTeamsChatGraph();
    await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { initialDays: 7 },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );
    const cursor = await connector.getCursor({
      credentials: validCredentials(),
      scopeConfig: {},
      currentCursor: null,
      logger,
    });

    vi.restoreAllMocks();
    mockTeamsChatGraph({ chatsStatus: 403 });
    const removals: Array<{ providerFileId?: string; reason: string }> = [];
    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { initialDays: 7 },
        cursor,
        logger,
        ownerEmail: "owner@canvasx.ai",
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(items.map((item) => item.providerFileId)).toEqual(["transcript-good"]);
    expect(removals.map((record) => record.providerFileId)).not.toContain("transcript-chat");
  });

  it("honors Retry-After while retrying Microsoft Graph throttles", async () => {
    const sleeps: number[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(jsonResponse({ id: "me" }));

    const result = await microsoftGraphRequest(validCredentials(), "/me", {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
    expect(result.data).toEqual({ id: "me" });
  });

  it("refreshes Microsoft tokens with env client credentials during sync", async () => {
    db = await createTestDb();
    await seedUser(db);
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "teams",
      authType: "oauth",
      credentials: JSON.stringify({
        ...validCredentials(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        client_id: "old-client",
        client_secret: "old-secret",
      }),
      scopeConfig: JSON.stringify({ initialDays: 7 }),
      createdBy: "owner",
    });
    const tokenRequests: URLSearchParams[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.hostname === "login.microsoftonline.com") {
        tokenRequests.push(init?.body as URLSearchParams);
        return jsonResponse({
          access_token: "env-access",
          refresh_token: "env-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (url.pathname === "/v1.0/me/calendarView") {
        return jsonResponse({ value: [] });
      }
      return jsonResponse({ value: [] });
    });

    await runConnectorSync(db, config.id, logger, {
      MICROSOFT_CLIENT_ID: "env-client",
      MICROSOFT_CLIENT_SECRET: "env-secret",
      MICROSOFT_TENANT: "env-tenant",
    });

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.get("client_id")).toBe("env-client");
    expect(tokenRequests[0]?.get("client_secret")).toBe("env-secret");
    const stored = await repo.findConfigById(config.id);
    const storedCredentials = JSON.parse(stored?.credentials ?? "{}") as OAuthCredentials;
    expect(storedCredentials.client_id).toBe("env-client");
    expect(storedCredentials.client_secret).toBe("env-secret");
    expect(storedCredentials.tenant).toBe("env-tenant");
    expect(storedCredentials.access_token).toBe("env-access");
  });

  it("caps Teams meeting discovery concurrency", async () => {
    const connector = createTeamsConnector({ maxInflight: 1, processingLagMs: 0, retryBaseMs: 0 });
    let activeResolutions = 0;
    let maxActiveResolutions = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/v1.0/me/calendarView") {
        return jsonResponse({
          value: [
            teamsEvent("event-one", "One", "https://teams.microsoft.com/l/meetup-join/one"),
            teamsEvent("event-two", "Two", "https://teams.microsoft.com/l/meetup-join/two"),
            teamsEvent("event-three", "Three", "https://teams.microsoft.com/l/meetup-join/three"),
          ],
        });
      }

      if (url.pathname === "/v1.0/me/onlineMeetings") {
        activeResolutions++;
        maxActiveResolutions = Math.max(maxActiveResolutions, activeResolutions);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeResolutions--;
        const filter = url.searchParams.get("$filter") ?? "";
        const id = filter.includes("one") ? "one" : filter.includes("two") ? "two" : "three";
        return jsonResponse({ value: [{ id: `meeting-${id}`, subject: id }] });
      }

      if (url.pathname.endsWith("/transcripts")) {
        return jsonResponse({ value: [] });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items: SyncedItem[] = [];
    for await (const item of connector.sync({
      credentials: validCredentials(),
      scopeConfig: { initialDays: 7 },
      cursor: null,
      logger,
      ownerEmail: "owner@canvasx.ai",
    })) {
      items.push(item);
    }

    expect(items).toHaveLength(0);
    expect(maxActiveResolutions).toBe(1);
  });

  it("keeps meetings without transcripts pending in the cursor", async () => {
    const connector = createTeamsConnector({ maxInflight: 1, processingLagMs: 0, retryBaseMs: 0 });
    const eventStart = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const event = {
      ...teamsEvent("event-pending", "Pending transcript", "https://teams.microsoft.com/l/meetup-join/pending"),
      start: { dateTime: eventStart, timeZone: "UTC" },
      end: { dateTime: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), timeZone: "UTC" },
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/v1.0/me/calendarView") {
        return jsonResponse({ value: [event] });
      }

      if (url.pathname === "/v1.0/me/onlineMeetings") {
        return jsonResponse({ value: [{ id: "meeting-pending", subject: "Pending transcript" }] });
      }

      if (url.pathname === "/v1.0/me/onlineMeetings/meeting-pending/transcripts") {
        return jsonResponse({ value: [] });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { initialDays: 3650 },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );

    const cursor = JSON.parse(
      (await connector.getCursor({
        credentials: validCredentials(),
        scopeConfig: {},
        currentCursor: null,
        logger,
      })) ?? "{}",
    ) as { lastSyncedAt?: string; observedMeetings?: Record<string, { transcriptIds: string[] }> };

    expect(cursor.lastSyncedAt).toBe(eventStart);
    expect(cursor.observedMeetings?.["event-pending"]?.transcriptIds).toEqual([]);
  });

  it("revisits cursor-observed meetings whose transcripts arrive after the processing lag", async () => {
    const connector = createTeamsConnector({ maxInflight: 1, processingLagMs: 0, retryBaseMs: 0 });
    const eventStart = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const cursorLastSyncedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    let calendarViewStart: string | null = null;
    const event = {
      ...teamsEvent("event-late", "Late transcript", "https://teams.microsoft.com/l/meetup-join/late"),
      start: { dateTime: eventStart, timeZone: "UTC" },
      end: { dateTime: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), timeZone: "UTC" },
    };
    const cursor = JSON.stringify({
      lastSyncedAt: cursorLastSyncedAt,
      syncWindowStart: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
      observedMeetings: {
        "event-late": {
          transcriptIds: [],
          sourceCreatedAt: eventStart,
          observedAt: cursorLastSyncedAt,
        },
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/v1.0/me/calendarView") {
        calendarViewStart = url.searchParams.get("startDateTime");
        return jsonResponse({ value: [event] });
      }

      if (url.pathname === "/v1.0/me/onlineMeetings") {
        return jsonResponse({ value: [{ id: "meeting-late", subject: "Late transcript" }] });
      }

      if (url.pathname === "/v1.0/me/onlineMeetings/meeting-late/transcripts") {
        return jsonResponse({ value: [{ id: "transcript-late", createdDateTime: new Date().toISOString() }] });
      }

      if (url.pathname === "/v1.0/me/onlineMeetings/meeting-late/recordings") {
        return jsonResponse({ value: [] });
      }

      if (url.pathname === "/v1.0/me/onlineMeetings/meeting-late/transcripts/transcript-late/content") {
        return new Response(["WEBVTT", "", "00:00:00.000 --> 00:00:02.000", "<v Jane Doe>Late recap.</v>"].join("\n"));
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { initialDays: 3650 },
        cursor,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );

    expect(calendarViewStart).toBe(eventStart);
    expect(items.map((item) => item.providerFileId)).toEqual(["transcript-late"]);
  });

  it("emits a removal when a previously observed transcript disappears", async () => {
    const connector = createTeamsConnector({ maxInflight: 2, processingLagMs: 0, retryBaseMs: 0 });
    mockTeamsGraph();

    await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { initialDays: 3650 },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );
    const cursor = await connector.getCursor({
      credentials: validCredentials(),
      scopeConfig: {},
      currentCursor: null,
      logger,
    });

    vi.restoreAllMocks();
    mockTeamsGraphWithoutTranscripts();
    const removals: Array<{ providerFileId?: string; sourceCreatedBefore?: string; reason: string }> = [];
    await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { initialDays: 3650 },
        cursor,
        logger,
        ownerEmail: "owner@canvasx.ai",
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(removals).toContainEqual({ providerFileId: "transcript-good", reason: "teams_transcript_removed" });
  });

  it("does not duplicate a transcript when the same transcript id is seen on consecutive syncs", async () => {
    db = await createTestDb();
    await seedUser(db);
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "teams",
      authType: "oauth",
      credentials: JSON.stringify(validCredentials()),
      scopeConfig: JSON.stringify({ initialDays: 3650 }),
      createdBy: "owner",
    });
    mockTeamsGraph();

    await runConnectorSync(db, config.id, logger, {
      SYNC_ALLOW_LARGE_RECONCILE: true,
      SYNC_MAX_RECONCILE_RATIO: 1,
    });
    await runConnectorSync(db, config.id, logger, {
      SYNC_ALLOW_LARGE_RECONCILE: true,
      SYNC_MAX_RECONCILE_RATIO: 1,
    });

    const rows = await db
      .selectFrom("indexed_files")
      .select(["id", "connector_config_id", "provider_file_id", "provider_url", "file_type"])
      .where("connector_config_id", "=", config.id)
      .where("source", "=", "teams")
      .execute();

    expect(rows).toEqual([
      {
        id: rows[0]?.id,
        connector_config_id: config.id,
        provider_file_id: "transcript-good",
        provider_url: "https://teams.microsoft.com/recording/good",
        file_type: "meeting_transcript",
      },
    ]);

    const facts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "relation", "subject_name", "subject_email", "source"])
      .where("connector_config_id", "=", config.id)
      .where("deleted_at", "is", null)
      .orderBy("subject_email")
      .execute();

    expect(facts).toEqual([
      {
        fact_type: "attendee",
        relation: "attended",
        subject_name: "Jane Doe",
        subject_email: "jane@example.com",
        source: "teams",
      },
      {
        fact_type: "attendee",
        relation: "attended",
        subject_name: "Owner User",
        subject_email: "owner@canvasx.ai",
        source: "teams",
      },
    ]);
  });

  it("removes disappeared Teams transcript rows and tombstones attendee facts", async () => {
    db = await createTestDb();
    await seedUser(db);
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "teams",
      authType: "oauth",
      credentials: JSON.stringify(validCredentials()),
      scopeConfig: JSON.stringify({ initialDays: 3650 }),
      createdBy: "owner",
    });
    mockTeamsGraph();

    await runConnectorSync(db, config.id, logger, {
      SYNC_ALLOW_LARGE_RECONCILE: true,
      SYNC_MAX_RECONCILE_RATIO: 1,
    });

    vi.restoreAllMocks();
    mockTeamsGraphWithoutTranscripts();
    const result = await runConnectorSync(db, config.id, logger, {
      SYNC_ALLOW_LARGE_RECONCILE: true,
      SYNC_MAX_RECONCILE_RATIO: 1,
    });

    const rows = await db
      .selectFrom("indexed_files")
      .select(["id"])
      .where("connector_config_id", "=", config.id)
      .where("source", "=", "teams")
      .execute();
    const facts = await db
      .selectFrom("indexed_file_facts")
      .select(["indexed_file_id", "deleted_at", "source", "fact_type", "relation"])
      .where("connector_config_id", "=", config.id)
      .where("source", "=", "teams")
      .orderBy("subject_email")
      .execute();

    expect(result.itemsArchived).toBe(1);
    expect(rows).toEqual([]);
    expect(facts).toEqual([
      {
        indexed_file_id: null,
        deleted_at: expect.any(String),
        source: "teams",
        fact_type: "attendee",
        relation: "attended",
      },
      {
        indexed_file_id: null,
        deleted_at: expect.any(String),
        source: "teams",
        fact_type: "attendee",
        relation: "attended",
      },
    ]);
  });

  it("streams meeting items instead of fetching the whole corpus before the first yield", async () => {
    const connector = createTeamsConnector({ maxInflight: 1, processingLagMs: 0, retryBaseMs: 0 });
    const sequence: string[] = [];
    mockGoodMeetings(sequence, ["recent", "middle", "old"]);

    const received: string[] = [];
    for await (const item of connector.sync({
      credentials: validCredentials(),
      scopeConfig: { initialDays: 7 },
      cursor: null,
      logger,
      ownerEmail: "owner@canvasx.ai",
    })) {
      if (received.length === 0) sequence.push("yield:first");
      received.push(item.providerFileId);
    }

    expect([...received].sort()).toEqual(["transcript-middle", "transcript-old", "transcript-recent"]);
    // The old buffered path fetched every meeting before yielding anything, so
    // the oldest meeting's lookup preceded the first yield. Streaming (with a
    // single in-flight worker) yields the first item before the last meeting is
    // ever fetched.
    expect(sequence.indexOf("yield:first")).toBeLessThan(sequence.indexOf("onlineMeetings:old"));
  });

  it("caps meetings per run to the most recent maxMeetings and never fetches older ones", async () => {
    const connector = createTeamsConnector({ maxInflight: 2, processingLagMs: 0, retryBaseMs: 0 });
    const sequence: string[] = [];
    mockGoodMeetings(sequence, ["recent", "old"]);

    const received: string[] = [];
    for await (const item of connector.sync({
      credentials: validCredentials(),
      scopeConfig: { initialDays: 7, maxMeetings: 1 },
      cursor: null,
      logger,
      ownerEmail: "owner@canvasx.ai",
    })) {
      received.push(item.providerFileId);
    }
    const advancedCursor = await connector.getCursor({
      credentials: validCredentials(),
      scopeConfig: {},
      currentCursor: null,
      logger,
    });

    expect(received).toEqual(["transcript-recent"]);
    expect(sequence).not.toContain("onlineMeetings:old");
    expect(JSON.parse(advancedCursor ?? "{}").lastSyncedAt).toEqual(expect.any(String));
  });

  it("aborts the run when a meeting fails with a non-skippable Graph error", async () => {
    const connector = createTeamsConnector({ maxInflight: 1, processingLagMs: 0, retryBaseMs: 0 });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/v1.0/me/calendarView") {
        return jsonResponse({
          value: [teamsEvent("event-fail", "Boom", "https://teams.microsoft.com/l/meetup-join/fail")],
        });
      }
      if (url.pathname === "/v1.0/me/onlineMeetings") {
        return jsonResponse({ value: [{ id: "meeting-fail", subject: "Boom" }] });
      }
      if (url.pathname === "/v1.0/me/onlineMeetings/meeting-fail/transcripts") {
        return new Response("server error", { status: 500 });
      }
      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    await expect(
      drain(
        connector.sync({
          credentials: validCredentials(),
          scopeConfig: { initialDays: 7 },
          cursor: null,
          logger,
          ownerEmail: "owner@canvasx.ai",
        }),
      ),
    ).rejects.toThrow();
  });
});

function validCredentials(): OAuthCredentials {
  return {
    type: "oauth",
    access_token: "access",
    refresh_token: "refresh",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    client_id: "client",
    client_secret: "secret",
  };
}

async function seedUser(db: Kysely<DB>) {
  await db
    .insertInto("users")
    .values({
      id: "owner",
      name: "Owner User",
      email: "owner@canvasx.ai",
    })
    .execute();
}

function mockTeamsGraph() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = new URL(input.toString());

    if (url.pathname === "/v1.0/me/calendarView") {
      return jsonResponse({
        value: [
          teamsEvent("event-good", "Acme kickoff", "https://teams.microsoft.com/l/meetup-join/good"),
          {
            ...teamsEvent("event-non-teams", "Zoom sync", "https://example.com/zoom"),
            onlineMeetingProvider: "unknown",
          },
          teamsEvent("event-unresolved", "Channel meeting", "https://teams.microsoft.com/l/meetup-join/unresolved"),
          teamsEvent(
            "event-forbidden",
            "Private leadership sync",
            "https://teams.microsoft.com/l/meetup-join/forbidden",
          ),
        ],
      });
    }

    if (url.pathname === "/v1.0/me/onlineMeetings") {
      const filter = url.searchParams.get("$filter") ?? "";
      if (filter.includes("forbidden")) {
        return jsonResponse({ value: [{ id: "meeting-forbidden", subject: "Private leadership sync" }] });
      }
      if (filter.includes("unresolved")) {
        return jsonResponse({ value: [] });
      }
      return jsonResponse({
        value: [
          {
            id: "meeting-good",
            subject: "Acme kickoff",
            joinWebUrl: "https://teams.microsoft.com/l/meetup-join/good",
          },
        ],
      });
    }

    if (url.pathname === "/v1.0/me/onlineMeetings/meeting-forbidden/transcripts") {
      return new Response("forbidden", { status: 403 });
    }

    if (url.pathname === "/v1.0/me/onlineMeetings/meeting-good/transcripts") {
      return jsonResponse({
        value: [{ id: "transcript-good", createdDateTime: TEAMS_TRANSCRIPT_CREATED.toISOString() }],
      });
    }

    if (url.pathname === "/v1.0/me/onlineMeetings/meeting-good/recordings") {
      return jsonResponse({
        value: [{ id: "recording-good", playbackUrl: "https://teams.microsoft.com/recording/good" }],
      });
    }

    if (url.pathname === "/v1.0/me/onlineMeetings/meeting-good/transcripts/transcript-good/content") {
      return new Response(
        [
          "WEBVTT",
          "",
          "00:00:00.000 --> 00:00:02.000",
          "<v Jane Doe>Confirmed the launch plan.</v>",
          "",
          "00:00:02.000 --> 00:00:04.000",
          "<v Owner User>We will send the recap.</v>",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/vtt" } },
      );
    }

    throw new Error(`unexpected fetch ${url.toString()}`);
  });
}

/**
 * Mock one calendar meeting ("Acme kickoff") alongside one chat-started meeting
 * ("Meeting with Ranjith") that has no calendar event, mirroring a tenant where
 * a call was launched straight from a Teams chat.
 */
function mockTeamsChatGraph(
  opts: { chatsStatus?: number; chatMirrorsCalendarEvent?: boolean; chatTranscriptPending?: boolean } = {},
): void {
  const calendarJoinUrl = "https://teams.microsoft.com/l/meetup-join/good";
  const chatJoinUrl = opts.chatMirrorsCalendarEvent
    ? calendarJoinUrl
    : "https://teams.microsoft.com/l/meetup-join/chat";

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = new URL(input.toString());

    if (url.pathname === "/v1.0/me/calendarView") {
      return jsonResponse({ value: [teamsEvent("event-good", "Acme kickoff", calendarJoinUrl)] });
    }

    if (url.pathname === "/v1.0/me/chats") {
      if (opts.chatsStatus) return new Response("forbidden", { status: opts.chatsStatus });
      /**
       * Honour the `lastUpdatedDateTime gt {from}` filter the connector sends.
       * The chat's only timestamp is its creation time, so a connector that
       * queried straight from the cursor watermark would filter this chat out
       * on the retry run and never revisit it.
       */
      const from = (url.searchParams.get("$filter") ?? "").match(/lastUpdatedDateTime gt (\S+)/)?.[1];
      if (from && CHAT_CREATED.toISOString() <= from) return jsonResponse({ value: [] });
      return jsonResponse({
        value: [
          {
            id: "19:meeting_chat@thread.v2",
            topic: "Meeting with Ranjith",
            createdDateTime: CHAT_CREATED.toISOString(),
            lastUpdatedDateTime: CHAT_CREATED.toISOString(),
            onlineMeetingInfo: { joinWebUrl: chatJoinUrl, calendarEventId: null },
          },
        ],
      });
    }

    if (url.pathname === "/v1.0/me/onlineMeetings") {
      const filter = url.searchParams.get("$filter") ?? "";
      const isChat = filter.includes("meetup-join/chat");
      return jsonResponse({
        value: [
          {
            id: isChat ? "meeting-chat" : "meeting-good",
            subject: isChat ? "Meeting with Ranjith" : "Acme kickoff",
            joinWebUrl: isChat ? chatJoinUrl : calendarJoinUrl,
          },
        ],
      });
    }

    const transcriptList = url.pathname.match(
      /^\/v1\.0\/me\/onlineMeetings\/(meeting-good|meeting-chat)\/transcripts$/,
    );
    if (transcriptList) {
      if (transcriptList[1] === "meeting-chat" && opts.chatTranscriptPending) return jsonResponse({ value: [] });
      const id = transcriptList[1] === "meeting-chat" ? "transcript-chat" : "transcript-good";
      return jsonResponse({ value: [{ id, createdDateTime: TEAMS_TRANSCRIPT_CREATED.toISOString() }] });
    }

    if (/^\/v1\.0\/me\/onlineMeetings\/(meeting-good|meeting-chat)\/recordings$/.test(url.pathname)) {
      return jsonResponse({ value: [] });
    }

    if (url.pathname === "/v1.0/me/onlineMeetings/meeting-chat/transcripts/transcript-chat/content") {
      return new Response(
        ["WEBVTT", "", "00:00:00.000 --> 00:00:02.000", "<v Ihab>Started this from the chat.</v>"].join("\n"),
        { status: 200, headers: { "Content-Type": "text/vtt" } },
      );
    }

    if (url.pathname === "/v1.0/me/onlineMeetings/meeting-good/transcripts/transcript-good/content") {
      return new Response(
        ["WEBVTT", "", "00:00:00.000 --> 00:00:02.000", "<v Jane Doe>Confirmed the launch plan.</v>"].join("\n"),
        { status: 200, headers: { "Content-Type": "text/vtt" } },
      );
    }

    throw new Error(`unexpected fetch ${url.toString()}`);
  });
}

function mockTeamsGraphWithoutTranscripts() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = new URL(input.toString());

    if (url.pathname === "/v1.0/me/calendarView") {
      return jsonResponse({
        value: [teamsEvent("event-good", "Acme kickoff", "https://teams.microsoft.com/l/meetup-join/good")],
      });
    }

    if (url.pathname === "/v1.0/me/onlineMeetings") {
      return jsonResponse({
        value: [
          {
            id: "meeting-good",
            subject: "Acme kickoff",
            joinWebUrl: "https://teams.microsoft.com/l/meetup-join/good",
          },
        ],
      });
    }

    if (url.pathname === "/v1.0/me/onlineMeetings/meeting-good/transcripts") {
      return jsonResponse({ value: [] });
    }

    throw new Error(`unexpected fetch ${url.toString()}`);
  });
}

/**
 * Mock a set of resolvable Teams meetings, each with its own transcript. `keys`
 * are ordered oldest-last (index 0 is the most recent); each key's start time is
 * spaced one hour apart so the per-run cap and processing order are
 * deterministic. Every `/onlineMeetings` lookup is appended to `sequence` as
 * `onlineMeetings:<key>` so tests can observe fetch order relative to yields.
 */
function mockGoodMeetings(sequence: string[], keys: string[]) {
  const events = keys.map((key, index) => ({
    ...teamsEvent(`event-${key}`, `${key} sync`, `https://teams.microsoft.com/l/meetup-join/${key}`),
    start: { dateTime: new Date(Date.now() - (index + 1) * 60 * 60_000).toISOString(), timeZone: "UTC" },
    end: { dateTime: new Date(Date.now() - (index + 1) * 60 * 60_000 + 30 * 60_000).toISOString(), timeZone: "UTC" },
  }));
  const keyForJoin = (value: string): string | undefined => keys.find((key) => value.includes(key));

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = new URL(input.toString());

    if (url.pathname === "/v1.0/me/calendarView") {
      return jsonResponse({ value: events });
    }

    if (url.pathname === "/v1.0/me/onlineMeetings") {
      const key = keyForJoin(url.searchParams.get("$filter") ?? "") ?? "unknown";
      sequence.push(`onlineMeetings:${key}`);
      return jsonResponse({
        value: [{ id: `meeting-${key}`, subject: key, joinWebUrl: `https://teams.microsoft.com/l/meetup-join/${key}` }],
      });
    }

    const listMatch = url.pathname.match(/\/onlineMeetings\/meeting-([^/]+)\/(transcripts|recordings)$/);
    if (listMatch) {
      const key = listMatch[1];
      if (listMatch[2] === "recordings") return jsonResponse({ value: [] });
      return jsonResponse({ value: [{ id: `transcript-${key}`, createdDateTime: new Date().toISOString() }] });
    }

    const contentMatch = url.pathname.match(/\/transcripts\/transcript-([^/]+)\/content$/);
    if (contentMatch) {
      return new Response(
        ["WEBVTT", "", "00:00:00.000 --> 00:00:02.000", `<v Jane Doe>Recap ${contentMatch[1]}.</v>`].join("\n"),
      );
    }

    throw new Error(`unexpected fetch ${url.toString()}`);
  });

  return events;
}

function teamsEvent(id: string, subject: string, joinUrl: string) {
  return {
    id,
    subject,
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
    onlineMeeting: { joinUrl },
    organizer: { emailAddress: { name: "Owner User", address: "owner@canvasx.ai" } },
    attendees: [{ emailAddress: { name: "Jane Doe", address: "jane@example.com" } }],
    start: { dateTime: TEAMS_EVENT_START.toISOString(), timeZone: "UTC" },
    end: { dateTime: TEAMS_EVENT_END.toISOString(), timeZone: "UTC" },
    lastModifiedDateTime: TEAMS_EVENT_MODIFIED.toISOString(),
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
