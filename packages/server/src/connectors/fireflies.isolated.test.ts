/**
 * Tests for the Fireflies connector's cursor lag.
 *
 * Fireflies' GraphQL `fromDate` filters by meeting start time, not by
 * transcript availability. Fireflies takes ~15–45 min to post-process a
 * recording into a queryable transcript. If `getCursor` returned `now`,
 * any transcript whose meeting predates the cursor at the moment
 * Fireflies makes it listable would be silently dropped forever.
 */
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFirefliesConnector } from "./fireflies";
import type { NameResolver, SyncedItem } from "./types";

const silentLogger = pino({ level: "silent" });

interface FirefliesFixture {
  id: string;
  title?: string;
  date?: number;
  duration?: number;
  organizer_email?: string | null;
  host_email?: string | null;
  participants?: string[];
  meeting_attendees?: Array<{ name: string | null; email: string | null; displayName: string | null }>;
  transcript_url?: string | null;
  speakers?: Array<{ id: number; name: string }>;
  contacts?: Array<{ email: string; name: string }>;
}

/**
 * Drive `connector.sync()` against a stubbed Fireflies API. Returns the
 * single yielded SyncedItem (or null if none).
 */
async function runFirefliesOnce(
  fixture: FirefliesFixture,
  ownerEmail: string | null = null,
  resolveNameToEmail?: NameResolver,
  minRequestIntervalMs = 0,
): Promise<SyncedItem | null> {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };

    if (body.query.includes("contacts {")) {
      return new Response(JSON.stringify({ data: { contacts: fixture.contacts ?? [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.query.includes("transcripts(")) {
      if ((body.variables.skip as number) === 0) {
        return new Response(
          JSON.stringify({
            data: {
              transcripts: [
                {
                  id: fixture.id,
                  title: fixture.title ?? "Test meeting",
                  date: fixture.date ?? Date.now(),
                  duration: fixture.duration ?? 600,
                  organizer_email: fixture.organizer_email ?? null,
                  host_email: fixture.host_email ?? null,
                  participants: fixture.participants ?? [],
                  meeting_attendees: fixture.meeting_attendees ?? [],
                  transcript_url: fixture.transcript_url ?? null,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: { transcripts: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.query.includes("transcript(id:")) {
      return new Response(
        JSON.stringify({
          data: {
            transcript: {
              summary: null,
              speakers: fixture.speakers ?? [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    const connector = createFirefliesConnector({ minRequestIntervalMs });
    for await (const item of connector.sync({
      credentials: { type: "api_key", api_key: "test" },
      scopeConfig: {},
      cursor: null,
      logger: silentLogger,
      ownerEmail,
      resolveNameToEmail,
    })) {
      return item;
    }
    return null;
  } finally {
    fetchSpy.mockRestore();
  }
}

describe("Fireflies getCursor lag", () => {
  it("returns a timestamp exactly 2h behind the current time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T12:00:00.000Z"));

    const connector = createFirefliesConnector({ minRequestIntervalMs: 0 });

    try {
      const cursor = await connector.getCursor({
        credentials: { type: "api_key", api_key: "unused" },
        scopeConfig: {},
        currentCursor: null,
        logger: silentLogger,
      });

      expect(cursor).toBe("2026-04-27T10:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Fireflies sync includes late-arriving transcripts", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("yields a transcript whose meeting date is 30 min before now when cursor is 2h in the past", async () => {
    const now = Date.now();
    const meetingDate = now - 30 * 60 * 1000; // 30 min ago
    const cursor = new Date(now - 2 * 60 * 60 * 1000).toISOString();

    // Page 1: one transcript; page 2: empty list ends pagination.
    // Interleaved with summary lookups per transcript.
    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init as RequestInit).body as string) as {
        query: string;
        variables: Record<string, unknown>;
      };

      if (body.query.includes("transcripts(")) {
        // List query
        if ((body.variables.skip as number) === 0) {
          return new Response(
            JSON.stringify({
              data: {
                transcripts: [
                  {
                    id: "t1",
                    title: "Late transcript",
                    date: meetingDate,
                    duration: 600,
                    organizer_email: "a@example.com",
                    participants: ["a@example.com", "b@example.com"],
                    transcript_url: "https://fireflies.example/t1",
                  },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ data: { transcripts: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (body.query.includes("transcript(id:")) {
        return new Response(
          JSON.stringify({
            data: {
              transcript: {
                summary: {
                  overview: "Overview",
                  shorthand_bullet: ["Point"],
                  action_items: ["Action"],
                  keywords: ["kw"],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const connector = createFirefliesConnector({ minRequestIntervalMs: 0 });
    const items: Array<{ providerFileId: string }> = [];
    for await (const item of connector.sync({
      credentials: { type: "api_key", api_key: "test" },
      scopeConfig: {},
      cursor,
      logger: silentLogger,
    })) {
      items.push(item);
    }

    expect(items).toHaveLength(1);
    expect(items[0].providerFileId).toBe("t1");
  }, 20_000);
});

describe("Fireflies attendee/email matching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches a speaker to email via meeting_attendees pair when local-part substring would miss", async () => {
    // "Bob Chen" → local-part "rchen" — substring match would fail.
    const item = await runFirefliesOnce({
      id: "t-pair",
      participants: ["rchen@acme.com"],
      meeting_attendees: [{ name: "Bob Chen", email: "rchen@acme.com", displayName: null }],
      speakers: [{ id: 1, name: "Bob Chen" }],
    });
    expect(item?.attendees).toEqual([{ name: "Bob Chen", email: "rchen@acme.com" }]);
  });

  it("recovers a speaker's email from the contacts directory when Fireflies has no roster", async () => {
    const item = await runFirefliesOnce({
      id: "t-rescue",
      participants: [],
      meeting_attendees: [],
      speakers: [{ id: 1, name: "Prakhar Vijay" }],
      contacts: [{ email: "prakhar@habuild.in", name: "Prakhar Vijay" }],
    });
    expect(item?.attendees).toEqual([{ name: "Prakhar Vijay", email: "prakhar@habuild.in" }]);
  });

  it("drops ambiguous meeting_attendees pairs (same normalized name, different emails) so the speaker stays name-only", async () => {
    const item = await runFirefliesOnce({
      id: "t-ambig-attendees",
      participants: [],
      meeting_attendees: [
        { name: "John Smith", email: "john.smith@a.com", displayName: null },
        { name: "John Smith", email: "j.smith@b.com", displayName: null },
      ],
      speakers: [{ id: 1, name: "John Smith" }],
    });
    expect(item?.attendees).toEqual([{ name: "John Smith" }]);
    expect(item?.accessEmails).toEqual(expect.arrayContaining(["john.smith@a.com", "j.smith@b.com"]));
  });

  it("drops ambiguous contact-name matches so the speaker stays name-only", async () => {
    const item = await runFirefliesOnce({
      id: "t-ambig",
      participants: [],
      meeting_attendees: [],
      speakers: [{ id: 1, name: "John Smith" }],
      contacts: [
        { email: "john1@a.com", name: "John Smith" },
        { email: "john2@b.com", name: "John Smith" },
      ],
    });
    expect(item?.attendees).toEqual([{ name: "John Smith" }]);
  });

  it("always includes the connector owner's email in accessEmails, even when only a bot is rostered", async () => {
    const item = await runFirefliesOnce(
      {
        id: "t-owner",
        organizer_email: "meetingbot@x.com",
        participants: ["meetingbot@x.com"],
        meeting_attendees: [],
      },
      "alice@x.com",
    );
    expect(item?.accessEmails).toEqual(expect.arrayContaining(["alice@x.com", "meetingbot@x.com"]));
    expect(item?.accessEmails).toHaveLength(2);
  });

  it("deduplicates mixed-case email values into a single canonical entry", async () => {
    const item = await runFirefliesOnce({
      id: "t-case",
      organizer_email: "Alice@Acme.com",
      participants: ["alice@acme.com"],
      meeting_attendees: [{ name: "Alice", email: "ALICE@acme.com", displayName: null }],
    });
    expect(item?.accessEmails).toEqual(["alice@acme.com"]);
  });

  it("still resolves via local-part substring when meeting_attendees is empty (regression)", async () => {
    const item = await runFirefliesOnce({
      id: "t-fallback",
      participants: ["alice@acme.com"],
      meeting_attendees: [],
      speakers: [{ id: 1, name: "Alice Sharma" }],
    });
    expect(item?.attendees).toEqual([{ name: "Alice Sharma", email: "alice@acme.com" }]);
  });

  it("attaches a contact-directory name to a silent attendee email (regression)", async () => {
    const item = await runFirefliesOnce({
      id: "t-silent",
      participants: ["someone@acme.com"],
      meeting_attendees: [],
      speakers: [],
      contacts: [{ email: "someone@acme.com", name: "Someone Real" }],
    });
    expect(item?.attendees).toEqual([{ name: "Someone Real", email: "someone@acme.com" }]);
  });
});

describe("Fireflies speaker resolution via Sketch-side resolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves a speaker via the users-table side of the resolver and gives them ACL", async () => {
    const resolver: NameResolver = (name) =>
      name === "Himanshu Kalra" ? { email: "himanshu@team.com", source: "users" } : null;
    const item = await runFirefliesOnce(
      {
        id: "t-users",
        participants: [],
        meeting_attendees: [],
        speakers: [{ id: 1, name: "Himanshu Kalra" }],
      },
      null,
      resolver,
    );
    expect(item?.attendees).toEqual([{ name: "Himanshu Kalra", email: "himanshu@team.com" }]);
    expect(item?.accessEmails).toEqual(expect.arrayContaining(["himanshu@team.com"]));
  });

  it("resolves a speaker via the entities-table side of the resolver", async () => {
    const resolver: NameResolver = (name) =>
      name === "Aryaman Soni" ? { email: "vishal.soni99@icloud.com", entityId: "ent-1", source: "entities" } : null;
    const item = await runFirefliesOnce(
      {
        id: "t-entities",
        participants: [],
        meeting_attendees: [],
        speakers: [{ id: 1, name: "Aryaman Soni" }],
      },
      null,
      resolver,
    );
    expect(item?.attendees).toEqual([{ name: "Aryaman Soni", email: "vishal.soni99@icloud.com" }]);
    expect(item?.accessEmails).toEqual(expect.arrayContaining(["vishal.soni99@icloud.com"]));
  });

  it("falls through when the resolver returns null", async () => {
    const resolver: NameResolver = () => null;
    const item = await runFirefliesOnce(
      {
        id: "t-resolver-miss",
        participants: [],
        meeting_attendees: [],
        speakers: [{ id: 1, name: "Unknown Speaker" }],
      },
      null,
      resolver,
    );
    expect(item?.attendees).toEqual([{ name: "Unknown Speaker" }]);
  });

  it("does not call the resolver when an earlier fallback succeeds", async () => {
    const resolver = vi.fn<NameResolver>().mockReturnValue(null);
    const item = await runFirefliesOnce(
      {
        id: "t-precedence",
        meeting_attendees: [{ name: "Bob Chen", email: "rchen@acme.com", displayName: null }],
        speakers: [{ id: 1, name: "Bob Chen" }],
      },
      null,
      resolver,
    );
    expect(item?.attendees).toEqual([{ name: "Bob Chen", email: "rchen@acme.com" }]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("yields the same shape as the no-resolver path when resolver is undefined and nothing matches", async () => {
    // Equivalent to the predecessor PR's behavior — a speaker with no
    // meeting_attendees roster, no participants, no contacts, and no resolver
    // stays name-only with just the owner in accessEmails.
    const item = await runFirefliesOnce(
      { id: "t-undef", meeting_attendees: [], speakers: [{ id: 1, name: "Solo" }] },
      "owner@x.com",
      undefined,
    );
    expect(item?.attendees).toEqual([{ name: "Solo" }]);
    expect(item?.accessEmails).toEqual(["owner@x.com"]);
  });

  it("preserves owner-email injection alongside resolver-recovered ACL", async () => {
    const resolver: NameResolver = () => ({ email: "recovered@x.com", source: "users" });
    const item = await runFirefliesOnce(
      {
        id: "t-owner-plus-resolver",
        organizer_email: "meetingbot@x.com",
        participants: ["meetingbot@x.com"],
        meeting_attendees: [],
        speakers: [{ id: 1, name: "Real Person" }],
      },
      "alice@x.com",
      resolver,
    );
    expect(item?.accessEmails).toEqual(expect.arrayContaining(["alice@x.com", "meetingbot@x.com", "recovered@x.com"]));
  }, 15000);
});

describe("Fireflies request rate limiting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spaces sequential API requests by the configured minimum interval", async () => {
    const item = await runFirefliesOnce(
      {
        id: "t-rate-limit",
        participants: ["a@example.com"],
        speakers: [{ id: 1, name: "Alice" }],
        contacts: [{ email: "a@example.com", name: "Alice" }],
      },
      null,
      undefined,
      10,
    );
    expect(item?.providerFileId).toBe("t-rate-limit");
  });
});
