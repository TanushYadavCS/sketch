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
      contentCategory: "document",
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

  it("extracts Calendly invitees and guests from the event description when Google attendees are missing", () => {
    const item = eventToSyncedItem(
      calendarEvent("calendly-1", {
        attendees: [],
        description: [
          "Invitee:",
          "Alice Buyer",
          "Invitee Email:",
          "alice@example.com",
          "Additional Guests:",
          "Bob Guest <bob@example.com>",
          "carol@example.com",
          "Cancel:",
          "https://calendly.com/cancellations/abc",
        ].join("\n"),
      }),
      primaryCalendar,
      "owner@canvasx.ai",
    );

    expect(item?.accessEmails?.sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
      "owner@canvasx.ai",
    ]);
    expect(item?.attendees).toEqual([
      { name: "Owner", email: "owner@canvasx.ai" },
      { name: "Alice Buyer", email: "alice@example.com" },
      { name: "Bob Guest", email: "bob@example.com" },
      { name: "Carol", email: "carol@example.com" },
    ]);
  });

  it("derives participant and author names when Calendar only returns email addresses", () => {
    const item = eventToSyncedItem(
      calendarEvent("email-only", {
        creator: undefined,
        organizer: { email: "owner@canvasx.ai" },
        attendees: [{ email: "jane.doe@example.com" }, { email: "sam+demo@example.com" }],
      }),
      primaryCalendar,
      "owner@canvasx.ai",
    );

    expect(item).toMatchObject({
      authorEmail: "owner@canvasx.ai",
      authorName: "Owner",
    });
    expect(item?.attendees).toEqual([
      { name: "Owner", email: "owner@canvasx.ai" },
      { name: "Jane Doe", email: "jane.doe@example.com" },
      { name: "Sam Demo", email: "sam+demo@example.com" },
    ]);
  });

  it("pairs generic Calendly name and email labels for attendee extraction", () => {
    const item = eventToSyncedItem(
      calendarEvent("calendly-generic", {
        attendees: [],
        description: [
          "Name:",
          "Morgan Lead",
          "Email:",
          "morgan@example.com",
          "Reschedule:",
          "https://calendly.com/reschedulings/abc",
        ].join("\n"),
      }),
      primaryCalendar,
      "owner@canvasx.ai",
    );

    expect(item?.accessEmails?.sort()).toEqual(["morgan@example.com", "owner@canvasx.ai"]);
    expect(item?.attendees).toEqual([
      { name: "Owner", email: "owner@canvasx.ai" },
      { name: "Morgan Lead", email: "morgan@example.com" },
    ]);
  });

  it("does not duplicate Calendly invitees that are already Google attendees", () => {
    const item = eventToSyncedItem(
      calendarEvent("calendly-duplicate", {
        description: [
          "Invitee:",
          "Jane Doe",
          "Invitee Email:",
          "jane@example.com",
          "Cancel:",
          "https://calendly.com/cancellations/abc",
        ].join("\n"),
      }),
      primaryCalendar,
      "owner@canvasx.ai",
    );

    expect(item?.attendees).toEqual([
      { name: "Owner", email: "owner@canvasx.ai" },
      { name: "Jane Doe", email: "jane@example.com" },
    ]);
    expect(item?.accessEmails?.sort()).toEqual(["jane@example.com", "owner@canvasx.ai"]);
  });

  it("extracts attendees and description contacts from private calendar events", () => {
    const item = eventToSyncedItem(
      calendarEvent("calendly-private", {
        visibility: "private",
        description: [
          "Invitee:",
          "Alice Buyer",
          "Invitee Email:",
          "alice@example.com",
          "Cancel:",
          "https://calendly.com/cancellations/abc",
        ].join("\n"),
      }),
      primaryCalendar,
      "owner@canvasx.ai",
    );

    expect(item?.content).toContain("Attendees: Owner <owner@canvasx.ai>, Jane Doe <jane@example.com>");
    expect(item?.accessEmails?.sort()).toEqual(["alice@example.com", "jane@example.com", "owner@canvasx.ai"]);
    expect(item?.attendees).toEqual([
      { name: "Owner", email: "owner@canvasx.ai" },
      { name: "Jane Doe", email: "jane@example.com" },
      { name: "Alice Buyer", email: "alice@example.com" },
    ]);
  });

  it("filters Google Calendar managed participants before extracting entities or access emails", () => {
    const item = eventToSyncedItem(
      calendarEvent("managed-participant", {
        attendees: [
          { email: "owner@canvasx.ai", displayName: "Owner", self: true },
          { email: "c_room@group.calendar.google.com" },
          { email: "c_room@group.v.calendar.google.com" },
          { email: "jane@example.com", displayName: "Jane Doe", responseStatus: "accepted" },
        ],
      }),
      primaryCalendar,
      "owner@canvasx.ai",
    );

    expect(item?.content).not.toContain("calendar.google.com");
    expect(item?.content).not.toContain("c_room");
    expect(item?.accessEmails?.sort()).toEqual(["jane@example.com", "owner@canvasx.ai"]);
    expect(item?.attendees).toEqual([
      { name: "Owner", email: "owner@canvasx.ai" },
      { name: "Jane Doe", email: "jane@example.com" },
    ]);
  });

  it("does not use Google Calendar managed identities as event authors", () => {
    const item = eventToSyncedItem(
      calendarEvent("managed-author", {
        creator: { email: "c_room@group.calendar.google.com" },
        organizer: { email: "c_room@group.v.calendar.google.com" },
        attendees: [{ email: "jane@example.com", displayName: "Jane Doe" }],
      }),
      primaryCalendar,
      "owner@canvasx.ai",
    );

    expect(item?.content).not.toContain("Organizer:");
    expect(item?.authorEmail).toBeUndefined();
    expect(item?.authorName).toBeUndefined();
    expect(item?.attendees).toEqual([{ name: "Jane Doe", email: "jane@example.com" }]);
  });

  it("ignores labeled emails in non-Calendly descriptions", () => {
    const item = eventToSyncedItem(
      calendarEvent("not-calendly", {
        attendees: [],
        description: ["Name:", "Alice Buyer", "Email:", "alice@example.com"].join("\n"),
      }),
      primaryCalendar,
      "owner@canvasx.ai",
    );

    expect(item?.accessEmails).toEqual(["owner@canvasx.ai"]);
    expect(item?.attendees).toEqual([{ name: "Owner", email: "owner@canvasx.ai" }]);
  });

  it("drops events the owner declined", () => {
    const item = eventToSyncedItem(
      calendarEvent("declined", {
        attendees: [
          { email: "owner@canvasx.ai", displayName: "Owner", self: true, responseStatus: "declined" },
          { email: "jane@example.com", displayName: "Jane Doe", responseStatus: "accepted" },
        ],
      }),
      primaryCalendar,
      "owner@canvasx.ai",
    );

    expect(item).toBeNull();
  });

  it("keeps events the owner has not declined", () => {
    for (const responseStatus of ["accepted", "tentative", "needsAction"]) {
      const item = eventToSyncedItem(
        calendarEvent(`rsvp-${responseStatus}`, {
          attendees: [{ email: "owner@canvasx.ai", displayName: "Owner", self: true, responseStatus }],
        }),
        primaryCalendar,
        "owner@canvasx.ai",
      );

      expect(item).not.toBeNull();
    }
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
        expect(url.searchParams.get("timeMax")).toBeTruthy();
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
    expect(cursor.version).toBe(2);
    expect(cursor.calendars).toEqual({ primary: "sync-primary-1" });
    expect(requests.some((url) => url.pathname.includes("busy-only"))).toBe(false);
  });

  it("collapses expanded recurring event instances into one series item", async () => {
    const connector = createGoogleCalendarConnector();
    const pastStart = isoRelativeDays(-7);
    const nextStart = isoRelativeDays(7);
    const laterStart = isoRelativeDays(30);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ items: [primaryCalendar] });
      }

      if (url.pathname === "/calendar/v3/calendars/primary/events") {
        expect(url.searchParams.get("timeMin")).toBeTruthy();
        expect(url.searchParams.get("timeMax")).toBeTruthy();
        return jsonResponse({
          items: [
            calendarEvent("series_1", recurringEvent({ start: pastStart })),
            calendarEvent("series_3", recurringEvent({ start: laterStart })),
            calendarEvent("series_2", recurringEvent({ start: nextStart })),
          ],
          nextSyncToken: "sync-primary-1",
        });
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

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      providerFileId: "primary:recurring:series@google.com",
      threadId: "series@google.com",
      sourceCreatedAt: nextStart,
    });
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
        cursor: currentCursor({ primary: "sync-primary-old" }),
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

  it("removes a previously synced event the owner has now declined", async () => {
    const connector = createGoogleCalendarConnector();
    const removals: SourceItemRemovalRecord[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ items: [primaryCalendar] });
      }

      if (url.pathname === "/calendar/v3/calendars/primary/events") {
        return jsonResponse({
          items: [
            calendarEvent("declined", {
              attendees: [{ email: "owner@canvasx.ai", displayName: "Owner", self: true, responseStatus: "declined" }],
            }),
            calendarEvent("kept"),
          ],
          nextSyncToken: "sync-primary-new",
        });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: {},
        cursor: currentCursor({ primary: "sync-primary-old" }),
        logger,
        ownerEmail: "owner@canvasx.ai",
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(items.map((item) => item.providerFileId)).toEqual(["primary:kept"]);
    expect(removals).toEqual([
      {
        providerFileId: providerFileIdForEvent("primary", "declined"),
        reason: "google_calendar_event_declined",
      },
    ]);
  });

  it("keeps the recurring series when a single instance is declined", async () => {
    const connector = createGoogleCalendarConnector();
    const removals: SourceItemRemovalRecord[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ items: [primaryCalendar] });
      }

      if (url.pathname === "/calendar/v3/calendars/primary/events") {
        return jsonResponse({
          items: [
            calendarEvent("recur-declined", {
              recurringEventId: "recur-declined-series",
              attendees: [{ email: "owner@canvasx.ai", displayName: "Owner", self: true, responseStatus: "declined" }],
            }),
          ],
          nextSyncToken: "sync-primary-new",
        });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: {},
        cursor: currentCursor({ primary: "sync-primary-old" }),
        logger,
        ownerEmail: "owner@canvasx.ai",
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(removals).toEqual([]);
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
        cursor: currentCursor({ primary: "sync-primary-old", team: "sync-team-old" }),
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
        cursor: currentCursor({ primary: "expired-token" }),
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

  it("full-syncs and wipes old rows when upgrading a legacy recurring cursor", async () => {
    const connector = createGoogleCalendarConnector();
    const removals: SourceItemRemovalRecord[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return jsonResponse({ items: [primaryCalendar] });
      }

      if (url.pathname === "/calendar/v3/calendars/primary/events") {
        expect(url.searchParams.get("syncToken")).toBeNull();
        expect(url.searchParams.get("timeMin")).toBeTruthy();
        expect(url.searchParams.get("timeMax")).toBeTruthy();
        return jsonResponse({ items: [calendarEvent("fresh")], nextSyncToken: "fresh-token" });
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items = await drain(
      connector.sync({
        credentials: validCredentials(),
        scopeConfig: {},
        cursor: JSON.stringify({ calendars: { primary: "legacy-token" } }),
        logger,
        ownerEmail: "owner@canvasx.ai",
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(removals).toEqual([
      {
        sourceCreatedBefore: "9999-12-31T23:59:59.999Z",
        reason: "google_calendar_recurring_dedup_upgrade",
      },
    ]);
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
        contentCategory: "document",
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
        contentCategory: "document",
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

function currentCursor(calendars: Record<string, string>): string {
  return JSON.stringify({ version: 2, calendars });
}

function isoRelativeDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function recurringEvent(overrides: { start: string }): Partial<GoogleCalendarEvent> {
  const end = new Date(Date.parse(overrides.start) + 30 * 60 * 1000).toISOString();
  return {
    iCalUID: "series@google.com",
    recurringEventId: "series",
    originalStartTime: { dateTime: overrides.start },
    start: { dateTime: overrides.start },
    end: { dateTime: end },
  };
}
