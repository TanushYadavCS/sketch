import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { microsoftGraphRequest, parseVttToTranscript } from "./microsoft-graph";
import { runConnectorSync } from "./sync";
import { createTeamsConnector } from "./teams";
import type { OAuthCredentials, SyncedItem } from "./types";

const logger = createTestLogger();

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
      sourceCreatedAt: "2026-06-01T10:00:00.000Z",
    });
    expect(items[0].content).toContain("Jane Doe: Confirmed the launch plan.");
    expect(items[0].attendees).toEqual([
      { name: "Jane Doe", email: "jane@example.com" },
      { name: "Owner User", email: "owner@canvasx.ai" },
    ]);
    expect(items[0].accessEmails?.sort()).toEqual(["jane@example.com", "owner@canvasx.ai"]);
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
        scopeConfig: { initialDays: 30 },
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
        scopeConfig: { initialDays: 30 },
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
        scopeConfig: { initialDays: 30 },
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
        scopeConfig: { initialDays: 30 },
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
      scopeConfig: JSON.stringify({ initialDays: 30 }),
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
      scopeConfig: JSON.stringify({ initialDays: 30 }),
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
      return jsonResponse({ value: [{ id: "transcript-good", createdDateTime: "2026-06-01T10:45:00Z" }] });
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

function teamsEvent(id: string, subject: string, joinUrl: string) {
  return {
    id,
    subject,
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
    onlineMeeting: { joinUrl },
    organizer: { emailAddress: { name: "Owner User", address: "owner@canvasx.ai" } },
    attendees: [{ emailAddress: { name: "Jane Doe", address: "jane@example.com" } }],
    start: { dateTime: "2026-06-01T10:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-06-01T11:00:00Z", timeZone: "UTC" },
    lastModifiedDateTime: "2026-06-01T11:05:00Z",
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
