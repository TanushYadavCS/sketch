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

const silentLogger = pino({ level: "silent" });

describe("Fireflies getCursor lag", () => {
  it("returns a timestamp exactly 2h behind the current time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T12:00:00.000Z"));

    const connector = createFirefliesConnector();

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

    const connector = createFirefliesConnector();
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
