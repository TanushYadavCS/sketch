/**
 * Tests for the Fireflies connector's incremental overlap window.
 *
 * Fireflies' GraphQL `fromDate` filters by meeting start time, not by
 * transcript availability. A transcript can be finalized days after its
 * meeting (delayed processing or a manual upload of an old recording); it
 * then carries an OLD meeting `date`. If incremental sync started exactly at
 * the stored cursor, such a transcript would sit below the high-watermark and
 * be filtered out forever. `sync` instead looks back an overlap window before
 * the cursor and relies on content-hash dedup to make the re-scan cheap.
 */
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFirefliesConnector } from "./fireflies";
import { type NameResolver, type SyncedItem, toEmailPrincipals } from "./types";

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

describe("Fireflies getCursor", () => {
  it("stores the true high-watermark (now), leaving the recent-window re-scan to sync's overlap", async () => {
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

      expect(cursor).toBe("2026-04-27T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Fireflies sync includes late-arriving transcripts", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  /** Captures the `fromDate` the connector asked the API to filter on. */
  let requestedFromDate: string | undefined;

  beforeEach(() => {
    requestedFromDate = undefined;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Mock that mimics Fireflies' SERVER-SIDE `fromDate` filtering: a transcript
   * is only listable when its meeting `date` is at or after the requested
   * `fromDate`. This is what makes the test meaningful — a connector that
   * started exactly at the cursor would never see the late transcript.
   */
  function mockFirefliesFilteringByFromDate(transcripts: Array<{ id: string; date: number }>): void {
    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init as RequestInit).body as string) as {
        query: string;
        variables: Record<string, unknown>;
      };

      if (body.query.includes("transcripts(")) {
        if ((body.variables.skip as number) === 0) {
          requestedFromDate = body.variables.fromDate as string | undefined;
          const fromMs = requestedFromDate ? Date.parse(requestedFromDate) : Number.NEGATIVE_INFINITY;
          const visible = transcripts
            .filter((t) => t.date >= fromMs)
            .map((t) => ({
              id: t.id,
              title: `Meeting ${t.id}`,
              date: t.date,
              duration: 600,
              organizer_email: "a@example.com",
              participants: ["a@example.com"],
              transcript_url: `https://fireflies.example/${t.id}`,
            }));
          return new Response(JSON.stringify({ data: { transcripts: visible } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ data: { transcripts: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (body.query.includes("transcript(id:")) {
        return new Response(JSON.stringify({ data: { transcript: { summary: { overview: "o" }, speakers: [] } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  async function collectSync(cursor: string, scopeConfig: Record<string, unknown> = {}): Promise<string[]> {
    const connector = createFirefliesConnector({ minRequestIntervalMs: 0 });
    const ids: string[] = [];
    for await (const item of connector.sync({
      credentials: { type: "api_key", api_key: "test" },
      scopeConfig,
      cursor,
      logger: silentLogger,
    })) {
      ids.push(item.providerFileId);
    }
    return ids;
  }

  it("recovers a transcript finalized days after its meeting date (below the cursor high-watermark)", async () => {
    const cursor = "2026-06-23T00:00:00.000Z";
    // Meeting was 5 days before the cursor — a tight `fromDate=cursor` filter
    // would skip it. The 7-day overlap pulls it back in.
    const meetingDate = Date.parse("2026-06-18T00:00:00.000Z");
    mockFirefliesFilteringByFromDate([{ id: "t-late", date: meetingDate }]);

    const ids = await collectSync(cursor);

    expect(ids).toEqual(["t-late"]);
    expect(requestedFromDate).toBe("2026-06-16T00:00:00.000Z");
  }, 20_000);

  it("respects a per-connector scopeConfig.incrementalOverlapDays override", async () => {
    const cursor = "2026-06-23T00:00:00.000Z";
    // 10 days back: missed by the default 7-day window, caught by a 14-day override.
    const meetingDate = Date.parse("2026-06-13T00:00:00.000Z");
    mockFirefliesFilteringByFromDate([{ id: "t-old", date: meetingDate }]);

    const missed = await collectSync(cursor);
    expect(missed).toEqual([]);

    const recovered = await collectSync(cursor, { incrementalOverlapDays: 14 });
    expect(recovered).toEqual(["t-old"]);
    expect(requestedFromDate).toBe("2026-06-09T00:00:00.000Z");
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
    expect(item?.accessPrincipals).toEqual(
      expect.arrayContaining(toEmailPrincipals(["john.smith@a.com", "j.smith@b.com"])),
    );
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

  it("always includes the connector owner's email in accessPrincipals, even when only a bot is rostered", async () => {
    const item = await runFirefliesOnce(
      {
        id: "t-owner",
        organizer_email: "meetingbot@x.com",
        participants: ["meetingbot@x.com"],
        meeting_attendees: [],
      },
      "alice@x.com",
    );
    expect(item?.accessPrincipals).toEqual(
      expect.arrayContaining(toEmailPrincipals(["alice@x.com", "meetingbot@x.com"])),
    );
    expect(item?.accessPrincipals).toHaveLength(2);
  });

  it("deduplicates mixed-case email values into a single canonical entry", async () => {
    const item = await runFirefliesOnce({
      id: "t-case",
      organizer_email: "Alice@Acme.com",
      participants: ["alice@acme.com"],
      meeting_attendees: [{ name: "Alice", email: "ALICE@acme.com", displayName: null }],
    });
    expect(item?.accessPrincipals).toEqual(toEmailPrincipals(["alice@acme.com"]));
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
    expect(item?.accessPrincipals).toEqual(expect.arrayContaining(toEmailPrincipals(["himanshu@team.com"])));
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
    expect(item?.accessPrincipals).toEqual(expect.arrayContaining(toEmailPrincipals(["vishal.soni99@icloud.com"])));
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
    // stays name-only with just the owner in accessPrincipals.
    const item = await runFirefliesOnce(
      { id: "t-undef", meeting_attendees: [], speakers: [{ id: 1, name: "Solo" }] },
      "owner@x.com",
      undefined,
    );
    expect(item?.attendees).toEqual([{ name: "Solo" }]);
    expect(item?.accessPrincipals).toEqual(toEmailPrincipals(["owner@x.com"]));
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
    expect(item?.accessPrincipals).toEqual(
      expect.arrayContaining(toEmailPrincipals(["alice@x.com", "meetingbot@x.com", "recovered@x.com"])),
    );
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
