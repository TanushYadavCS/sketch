import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createTestDb, createTestLogger } from "../test-utils";
import {
  type GoogleCalendarEvent,
  createGoogleCalendarConnector,
  eventToSyncedItem,
  providerFileIdForEvent,
} from "./google-calendar";
import type { OAuthCredentials, SourceItemRemovalRecord, SyncedItem } from "./types";

const logger = createTestLogger();

const primaryCalendar = { id: "primary", summary: "Work", accessRole: "owner" as const };

function calendarEvent(id: string, overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    id,
    status: "confirmed",
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
    created: "2026-02-01T09:00:00Z",
    updated: "2026-02-02T10:00:00Z",
    summary: "Planning review",
    description: "Discuss <b>launch</b> readiness",
    location: "Room 4A",
    iCalUID: `${id}@google.com`,
    start: { dateTime: "2026-02-04T10:00:00Z" },
    end: { dateTime: "2026-02-04T10:30:00Z" },
    organizer: { email: "owner@canvasx.ai", displayName: "Owner" },
    creator: { email: "owner@canvasx.ai", displayName: "Owner" },
    attendees: [
      { email: "owner@canvasx.ai", displayName: "Owner", self: true },
      { email: "jane@example.com", displayName: "Jane Doe", responseStatus: "accepted" },
    ],
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    ...overrides,
  };
}

describe("Google Calendar connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps calendar events to structured synced items with owner and attendee access", () => {
    const item = eventToSyncedItem(calendarEvent("event-1"), primaryCalendar, "owner@canvasx.ai");

    expect(item).toMatchObject({
      providerFileId: "primary:event-1",
      threadId: "event-1@google.com",
      providerUrl: "https://calendar.google.com/event?eid=event-1",
      fileName: "Planning review",
      fileType: "calendar_event",
      contentCategory: "structured",
      sourcePath: "Google Calendar / Work",
      sourceCreatedAt: "2026-02-04T10:00:00.000Z",
      sourceUpdatedAt: "2026-02-02T10:00:00.000Z",
      mimeType: "text/calendar",
      authorEmail: "owner@canvasx.ai",
      authorName: "Owner",
    });
    expect(item?.content).toContain("Calendar: Work");
    expect(item?.content).toContain("Discuss launch readiness");
    expect(item?.accessEmails?.sort()).toEqual(["jane@example.com", "owner@canvasx.ai"]);
    expect(item?.attendees).toEqual([
      { name: "Owner", email: "owner@canvasx.ai" },
      { name: "Jane Doe", email: "jane@example.com" },
    ]);
  });

  it("syncs readable calendars and stores per-calendar sync tokens", async () => {
    const connector = createGoogleCalendarConnector();
    const requests: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      requests.push(url);

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({
          items: [primaryCalendar, { id: "busy-only", summary: "Busy only", accessRole: "freeBusyReader" }],
        });
      }

      if (url.pathname === "/calendar/v3/calendars/primary/events") {
        expect(url.searchParams.get("timeMin")).toBeTruthy();
        expect(url.searchParams.get("syncToken")).toBeNull();
        return jsonResponse({ items: [calendarEvent("event-1")], nextSyncToken: "sync-primary-1" });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: {},
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
    );

    expect(items).toHaveLength(1);
    expect(items[0].providerFileId).toBe("primary:event-1");
    expect(cursor.calendars).toEqual({ primary: "sync-primary-1" });
    expect(requests.some((url) => url.pathname.includes("busy-only"))).toBe(false);
  });

  it("browses readable calendars for scope selection", async () => {
    const connector = createGoogleCalendarConnector();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({
          items: [
            primaryCalendar,
            { id: "team", summary: "Team", accessRole: "reader" },
            { id: "busy-only", summary: "Busy only", accessRole: "freeBusyReader" },
          ],
        });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const result = await connector.browseExisting?.({ credentials: validCredentials(), logger });

    expect(result).toEqual({
      type: "flat",
      items: [
        { id: "primary", name: "Work" },
        { id: "team", name: "Team" },
      ],
    });
  });

  it("syncs no calendars when calendarIds is present and empty", async () => {
    const connector = createGoogleCalendarConnector();
    const requests: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      requests.push(url);

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ items: [primaryCalendar, { id: "team", summary: "Team", accessRole: "reader" }] });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { calendarIds: [] },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );
    const cursor = JSON.parse(
      (await connector.getCursor({
        credentials: validCredentials(),
        scopeConfig: { calendarIds: [] },
        currentCursor: null,
        logger,
      })) ?? "{}",
    );

    expect(items).toEqual([]);
    expect(cursor.calendars).toEqual({});
    expect(requests.every((url) => !url.pathname.endsWith("/events"))).toBe(true);
  });

  it("syncs only selected calendarIds when a calendar scope is saved", async () => {
    const connector = createGoogleCalendarConnector();
    const requests: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      requests.push(url);

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ items: [primaryCalendar, { id: "team", summary: "Team", accessRole: "reader" }] });
      }

      if (url.pathname === "/calendar/v3/calendars/team/events") {
        return jsonResponse({ items: [calendarEvent("team-event")], nextSyncToken: "sync-team-1" });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { calendarIds: ["team"] },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );

    expect(items.map((item) => item.providerFileId)).toEqual(["team:team-event"]);
    expect(requests.some((url) => url.pathname === "/calendar/v3/calendars/primary/events")).toBe(false);
  });

  it("uses syncToken for incremental sync and removes cancelled events", async () => {
    const connector = createGoogleCalendarConnector();
    const removals: SourceItemRemovalRecord[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ items: [primaryCalendar] });
      }

      if (url.pathname === "/calendar/v3/calendars/primary/events") {
        expect(url.searchParams.get("syncToken")).toBe("sync-primary-old");
        expect(url.searchParams.get("showDeleted")).toBe("true");
        expect(url.searchParams.get("timeMin")).toBeNull();
        return jsonResponse({
          items: [calendarEvent("deleted", { status: "cancelled" }), calendarEvent("updated")],
          nextSyncToken: "sync-primary-new",
        });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: {},
        cursor: JSON.stringify({ calendars: { primary: "sync-primary-old" } }),
        logger,
        ownerEmail: "owner@canvasx.ai",
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    const cursor = JSON.parse(
      (await connector.getCursor({
        credentials: validCredentials(),
        scopeConfig: {},
        currentCursor: null,
        logger,
      })) ?? "{}",
    );

    expect(items.map((item) => item.providerFileId)).toEqual(["primary:updated"]);
    expect(removals).toEqual([
      {
        providerFileId: providerFileIdForEvent("primary", "deleted"),
        reason: "google_calendar_event_cancelled",
      },
    ]);
    expect(cursor.calendars).toEqual({ primary: "sync-primary-new" });
  });

  it("prunes unreadable calendars and drops their stale sync token", async () => {
    const connector = createGoogleCalendarConnector();
    const removals: SourceItemRemovalRecord[] = [];
    const teamCalendar = { id: "team", summary: "Team", accessRole: "reader" as const };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ items: [primaryCalendar, teamCalendar] });
      }

      if (url.pathname === "/calendar/v3/calendars/primary/events") {
        expect(url.searchParams.get("syncToken")).toBe("sync-primary-old");
        return jsonResponse({ items: [calendarEvent("updated")], nextSyncToken: "sync-primary-new" });
      }

      if (url.pathname === "/calendar/v3/calendars/team/events") {
        expect(url.searchParams.get("syncToken")).toBe("sync-team-old");
        return jsonResponse({ error: { message: "Forbidden" } }, 403);
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: {},
        cursor: JSON.stringify({ calendars: { primary: "sync-primary-old", team: "sync-team-old" } }),
        logger,
        ownerEmail: "owner@canvasx.ai",
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    const cursor = JSON.parse(
      (await connector.getCursor({
        credentials: validCredentials(),
        scopeConfig: {},
        currentCursor: null,
        logger,
      })) ?? "{}",
    );

    expect(items.map((item) => item.providerFileId)).toEqual(["primary:updated"]);
    expect(removals).toEqual([
      {
        providerFileIdPrefix: "team:",
        reason: "google_calendar_calendar_unreadable",
      },
    ]);
    expect(cursor.calendars).toEqual({ primary: "sync-primary-new" });
  });

  it("falls back to a full sync and wipes old rows when a sync token expires", async () => {
    const connector = createGoogleCalendarConnector();
    const removals: SourceItemRemovalRecord[] = [];
    let eventRequests = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ items: [primaryCalendar] });
      }

      if (url.pathname === "/calendar/v3/calendars/primary/events") {
        eventRequests++;
        if (url.searchParams.get("syncToken") === "expired-token") {
          return jsonResponse({ error: { message: "Gone" } }, 410);
        }
        expect(url.searchParams.get("syncToken")).toBeNull();
        return jsonResponse({ items: [calendarEvent("fresh")], nextSyncToken: "fresh-token" });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: {},
        cursor: JSON.stringify({ calendars: { primary: "expired-token" } }),
        logger,
        ownerEmail: "owner@canvasx.ai",
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(eventRequests).toBe(2);
    expect(removals[0]).toMatchObject({
      sourceCreatedBefore: "9999-12-31T23:59:59.999Z",
      reason: "google_calendar_sync_token_expired",
    });
    expect(items.map((item) => item.providerFileId)).toEqual(["primary:fresh"]);
  });

  it("retries rate-limited validation requests", async () => {
    const connector = createGoogleCalendarConnector();
    let calls = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return jsonResponse({ items: [] });
    });

    await connector.validateCredentials(validCredentials());

    expect(calls).toBe(2);
  });

  it("does not merge event rows with the same Google IDs across connector owners", async () => {
    const db = await createTestDb();
    try {
      const repo = createConnectorRepository(db);
      const configA = await repo.createConfig({
        connectorType: "google_calendar",
        authType: "oauth",
        credentials: JSON.stringify(validCredentials()),
        createdBy: "owner-a",
      });
      const configB = await repo.createConfig({
        connectorType: "google_calendar",
        authType: "oauth",
        credentials: JSON.stringify(validCredentials()),
        createdBy: "owner-b",
      });

      const first = await repo.upsertFile({
        source: "google_calendar",
        providerFileId: "primary:event-1",
        providerUrl: null,
        fileName: "Owner A event",
        fileType: "calendar_event",
        contentCategory: "structured",
        content: "Owner A event",
        sourcePath: null,
        contentHash: "hash-a",
        sourceCreatedAt: "2026-02-04T10:00:00.000Z",
        sourceUpdatedAt: "2026-02-04T10:00:00.000Z",
        connectorConfigId: configA.id,
      });
      const second = await repo.upsertFile({
        source: "google_calendar",
        providerFileId: "primary:event-1",
        providerUrl: null,
        fileName: "Owner B event",
        fileType: "calendar_event",
        contentCategory: "structured",
        content: "Owner B event",
        sourcePath: null,
        contentHash: "hash-b",
        sourceCreatedAt: "2026-02-04T10:00:00.000Z",
        sourceUpdatedAt: "2026-02-04T10:00:00.000Z",
        connectorConfigId: configB.id,
      });

      expect(first.id).not.toBe(second.id);
      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
    } finally {
      await db.destroy();
    }
  });
});

async function drain(generator: AsyncGenerator<SyncedItem>): Promise<SyncedItem[]> {
  const items: SyncedItem[] = [];
  for await (const item of generator) {
    items.push(item);
  }
  return items;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function validCredentials(): OAuthCredentials {
  return {
    type: "oauth",
    access_token: "token",
    refresh_token: "refresh",
    client_id: "client",
    client_secret: "secret",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}
