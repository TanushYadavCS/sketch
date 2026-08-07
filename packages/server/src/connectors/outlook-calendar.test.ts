import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import {
  type OutlookCalendarEvent,
  type OutlookCalendarListEntry,
  createOutlookCalendarConnector,
  eventToSyncedItem,
} from "./outlook-calendar";
import type { OAuthCredentials, SyncedItem } from "./types";

const logger = createTestLogger();
const workCalendar: OutlookCalendarListEntry = {
  id: "calendar-1",
  name: "Work",
  isDefaultCalendar: true,
  owner: { emailAddress: { address: "owner@canvasx.ai", name: "Owner" } },
};

function calendarEvent(id: string, overrides: Partial<OutlookCalendarEvent> = {}): OutlookCalendarEvent {
  return {
    id,
    iCalUId: `${id}@example.com`,
    subject: "Planning review",
    body: { contentType: "text", content: "Discuss launch readiness" },
    bodyPreview: "Discuss launch readiness",
    start: { dateTime: "2026-08-07T10:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-08-07T10:30:00.0000000", timeZone: "UTC" },
    location: { displayName: "Room 4A" },
    organizer: { emailAddress: { address: "owner@canvasx.ai", name: "Owner" } },
    attendees: [{ emailAddress: { address: "jane@example.com", name: "Jane Doe" } }],
    webLink: `https://outlook.office.com/calendar/item/${id}`,
    createdDateTime: "2026-08-01T09:00:00.0000000Z",
    lastModifiedDateTime: "2026-08-02T10:00:00.0000000Z",
    isAllDay: false,
    onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/example" },
    ...overrides,
  };
}

describe("Outlook Calendar connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps events to calendar documents with meeting metadata and ACL emails", () => {
    const item = eventToSyncedItem(calendarEvent("event-1"), workCalendar, "owner@canvasx.ai");

    expect(item).toMatchObject({
      providerFileId: "calendar-1:event-1",
      threadId: "event-1@example.com",
      providerUrl: "https://outlook.office.com/calendar/item/event-1",
      fileName: "Planning review",
      fileType: "calendar_event",
      contentCategory: "document",
      sourcePath: "Outlook Calendar / Work",
      sourceCreatedAt: "2026-08-07T10:00:00.000Z",
      sourceUpdatedAt: "2026-08-02T10:00:00.000Z",
      isAllDay: false,
      mimeType: "text/calendar",
      authorEmail: "owner@canvasx.ai",
      authorName: "Owner",
    });
    expect(item?.content).toContain("Calendar: Work");
    expect(item?.content).toContain("Conference: https://teams.microsoft.com/l/meetup-join/example");
    expect(item?.accessEmails?.sort()).toEqual(["jane@example.com", "owner@canvasx.ai"]);
    expect(item?.attendees).toEqual([
      { name: "Owner", email: "owner@canvasx.ai" },
      { name: "Jane Doe", email: "jane@example.com" },
    ]);
  });

  it("preserves all-day events and treats dateTime values without offsets as UTC", () => {
    const item = eventToSyncedItem(
      calendarEvent("offsite-1", {
        start: { dateTime: "2026-08-07T00:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-08-08T00:00:00.0000000", timeZone: "UTC" },
        isAllDay: true,
      }),
      workCalendar,
      "owner@canvasx.ai",
    );

    expect(item?.isAllDay).toBe(true);
    expect(item?.sourceCreatedAt).toBe("2026-08-07T00:00:00.000Z");
  });

  it("streams paginated calendar delta results and persists opaque per-calendar delta links", async () => {
    const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
    mockGraphFetch((url, init) => {
      requests.push({ url, init });
      if (url.pathname === "/v1.0/me/calendars") {
        return jsonResponse({ value: [workCalendar] });
      }
      if (url.pathname.endsWith("/calendarView/delta") && !url.searchParams.has("$skiptoken")) {
        return jsonResponse({
          value: [calendarEvent("event-1")],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/me/calendars/calendar-1/calendarView/delta?$skiptoken=events-page-2",
        });
      }
      if (url.searchParams.get("$skiptoken") === "events-page-2") {
        return jsonResponse({
          value: [calendarEvent("event-2", { subject: "Follow-up" })],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/calendars/calendar-1/calendarView/delta?$deltatoken=opaque-1",
        });
      }
      throw new Error(`Unexpected Microsoft Graph request: ${url.toString()}`);
    });

    const connector = createOutlookCalendarConnector();
    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { calendarIds: ["calendar-1"] },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );

    expect(items.map((item) => item.providerFileId)).toEqual(["calendar-1:event-1", "calendar-1:event-2"]);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.url.searchParams.get("$select")).toBe(
      "id,name,isDefaultCalendar,owner,canViewPrivateItems,canEdit",
    );
    expect(requests[1]?.url.searchParams.get("$select")).toBeNull();
    expect(requests[1]?.init?.headers).toMatchObject({
      Prefer: expect.stringContaining('IdType="ImmutableId"'),
    });

    const cursor = await connector.getCursor({
      credentials: validCredentials(),
      scopeConfig: { calendarIds: ["calendar-1"] },
      currentCursor: null,
      logger,
    });
    expect(JSON.parse(cursor ?? "")).toMatchObject({
      version: 1,
      calendars: {
        "calendar-1":
          "https://graph.microsoft.com/v1.0/me/calendars/calendar-1/calendarView/delta?$deltatoken=opaque-1",
      },
    });
  });

  it("refreshes a stale delta cursor with a fresh calendar window", async () => {
    const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const removals: Array<{ sourceCreatedBefore?: string; reason: string }> = [];
    mockGraphFetch((url, init) => {
      requests.push({ url, init });
      if (url.pathname === "/v1.0/me/calendars") return jsonResponse({ value: [workCalendar] });
      if (url.pathname.endsWith("/calendarView/delta")) {
        if (url.searchParams.has("$deltatoken")) throw new Error("stale delta link should not be reused");
        return jsonResponse({
          value: [calendarEvent("fresh-event")],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/calendar-delta-fresh",
        });
      }
      throw new Error(`Unexpected Microsoft Graph request: ${url.toString()}`);
    });

    const connector = createOutlookCalendarConnector();
    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { calendarIds: ["calendar-1"], initialFutureDays: 30 },
        cursor: JSON.stringify({
          version: 1,
          calendars: { "calendar-1": "https://graph.microsoft.com/v1.0/calendar-delta-stale" },
          lastSyncedAt: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        logger,
        onSourceItemRemoved: async (record) => {
          removals.push(record as { sourceCreatedBefore?: string; reason: string });
        },
      }),
    );

    expect(items.map((item) => item.providerFileId)).toEqual(["calendar-1:fresh-event"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url.searchParams.has("$deltatoken")).toBe(false);
    expect(requests[1]?.url.searchParams.get("startDateTime")).toBeTruthy();
    expect(requests[1]?.url.searchParams.get("endDateTime")).toBeTruthy();
    expect(removals).toEqual([
      { sourceCreatedBefore: "9999-12-31T23:59:59.999Z", reason: "outlook_calendar_delta_window_refresh" },
    ]);

    const nextCursor = await connector.getCursor({
      credentials: validCredentials(),
      scopeConfig: { calendarIds: ["calendar-1"], initialFutureDays: 30 },
      currentCursor: null,
      logger,
    });
    expect(JSON.parse(nextCursor ?? "")).toMatchObject({
      calendars: { "calendar-1": "https://graph.microsoft.com/v1.0/calendar-delta-fresh" },
      lastSyncedAt: expect.any(String),
    });
  });

  it("preserves the delta window timestamp during incremental syncs", async () => {
    const windowStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    mockGraphFetch((url) => {
      if (url.pathname === "/v1.0/me/calendars") return jsonResponse({ value: [workCalendar] });
      if (url.pathname.endsWith("/calendarView/delta")) {
        expect(url.searchParams.get("$deltatoken")).toBe("existing");
        return jsonResponse({
          value: [calendarEvent("incremental-event")],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/calendar-delta-incremental",
        });
      }
      throw new Error(`Unexpected Microsoft Graph request: ${url.toString()}`);
    });

    const connector = createOutlookCalendarConnector();
    await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: { calendarIds: ["calendar-1"], initialFutureDays: 30 },
        cursor: JSON.stringify({
          version: 1,
          calendars: {
            "calendar-1":
              "https://graph.microsoft.com/v1.0/me/calendars/calendar-1/calendarView/delta?$deltatoken=existing",
          },
          lastSyncedAt: windowStartedAt,
        }),
        logger,
      }),
    );

    const nextCursor = await connector.getCursor({
      credentials: validCredentials(),
      scopeConfig: { calendarIds: ["calendar-1"], initialFutureDays: 30 },
      currentCursor: null,
      logger,
    });
    expect(JSON.parse(nextCursor ?? "")).toMatchObject({
      calendars: { "calendar-1": "https://graph.microsoft.com/v1.0/calendar-delta-incremental" },
      lastSyncedAt: windowStartedAt,
    });
  });

  it("emits removals for deleted, cancelled, and declined events", async () => {
    const removals: Array<{ providerFileId?: string; sourceCreatedBefore?: string; reason: string }> = [];
    mockGraphFetch((url) => {
      if (url.pathname === "/v1.0/me/calendars") return jsonResponse({ value: [workCalendar] });
      if (url.pathname.endsWith("/calendarView/delta")) {
        return jsonResponse({
          value: [
            { id: "deleted", "@removed": { reason: "deleted" } },
            calendarEvent("cancelled", { isCancelled: true }),
            calendarEvent("declined", { responseStatus: { response: "declined" } }),
          ],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/calendar-delta-1",
        });
      }
      throw new Error(`Unexpected Microsoft Graph request: ${url.toString()}`);
    });

    const items = await drain(
      createOutlookCalendarConnector().sync({
        credentials: validCredentials(),
        scopeConfig: { calendarIds: ["calendar-1"] },
        cursor: null,
        logger,
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(items).toEqual([]);
    expect(removals).toEqual([
      { providerFileId: "calendar-1:deleted", reason: "outlook_calendar_event_deleted" },
      { providerFileId: "calendar-1:cancelled", reason: "outlook_calendar_event_cancelled" },
      { providerFileId: "calendar-1:declined", reason: "outlook_calendar_event_declined" },
      { providerFileIdPrefix: "calendar-1:", reason: "outlook_calendar_empty_full_sync" },
    ]);
  });

  it("removes a calendar prefix when a full snapshot is empty", async () => {
    const removals: Array<{ providerFileId?: string; providerFileIdPrefix?: string; reason: string }> = [];
    mockGraphFetch((url) => {
      if (url.pathname === "/v1.0/me/calendars") return jsonResponse({ value: [workCalendar] });
      if (url.pathname.endsWith("/calendarView/delta")) {
        return jsonResponse({ "@odata.deltaLink": "https://graph.microsoft.com/v1.0/calendar-delta-empty", value: [] });
      }
      throw new Error(`Unexpected Microsoft Graph request: ${url.toString()}`);
    });

    await drain(
      createOutlookCalendarConnector().sync({
        credentials: validCredentials(),
        scopeConfig: { calendarIds: ["calendar-1"] },
        cursor: null,
        logger,
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(removals).toEqual([{ providerFileIdPrefix: "calendar-1:", reason: "outlook_calendar_empty_full_sync" }]);
  });

  it("wipes and rebuilds the calendar set when a saved delta link expires", async () => {
    const removals: Array<{ providerFileId?: string; sourceCreatedBefore?: string; reason: string }> = [];
    let deltaRequests = 0;
    mockGraphFetch((url) => {
      if (url.pathname === "/v1.0/me/calendars") return jsonResponse({ value: [workCalendar] });
      if (url.searchParams.get("$deltatoken") === "expired") return jsonResponse("expired", 410);
      if (url.pathname.endsWith("/calendarView/delta")) {
        deltaRequests++;
        return jsonResponse({
          value: [calendarEvent("rebuilt")],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/calendar-delta-rebuilt",
        });
      }
      throw new Error(`Unexpected Microsoft Graph request: ${url.toString()}`);
    });

    const items = await drain(
      createOutlookCalendarConnector().sync({
        credentials: validCredentials(),
        scopeConfig: { calendarIds: ["calendar-1"] },
        cursor: JSON.stringify({
          version: 1,
          calendars: { "calendar-1": "https://graph.microsoft.com/v1.0/calendar-delta?$deltatoken=expired" },
          lastSyncedAt: new Date().toISOString(),
        }),
        logger,
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(items.map((item) => item.providerFileId)).toEqual(["calendar-1:rebuilt"]);
    expect(deltaRequests).toBe(1);
    expect(removals).toEqual([
      { sourceCreatedBefore: "9999-12-31T23:59:59.999Z", reason: "outlook_calendar_delta_expired" },
    ]);
  });
});

function validCredentials(): OAuthCredentials {
  return {
    type: "oauth",
    access_token: "access",
    refresh_token: "refresh",
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    client_id: "client",
    client_secret: "secret",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockGraphFetch(handler: (url: URL, init: RequestInit | undefined) => Response): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return handler(url, init);
  });
}

async function drain(iterable: AsyncIterable<SyncedItem>): Promise<SyncedItem[]> {
  const items: SyncedItem[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
