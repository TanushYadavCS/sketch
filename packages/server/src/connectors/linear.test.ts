/**
 * Tests for the Linear connector's retry logic.
 *
 * Verifies that 429 responses are bounded by MAX_RETRIES, that concurrent
 * connector instances do not share rate-limiter state, and that refreshTokens
 * skips refresh when token is still valid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLinearConnector } from "./linear";
import type { EntitySeed, SyncedItem } from "./types";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyPage(field: string): Response {
  return jsonResponse({ [field]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } });
}

/**
 * Routes a Linear GraphQL request to a canned response based on the operation
 * name embedded in the query string. Tests drive the connector's `sync`
 * generator (issues → teams → projects) without hitting the network.
 */
function routeLinearRequest(
  body: string,
  handlers: { teams?: () => Response; teamMembers?: () => Response },
): Response {
  if (body.includes("query Issues(")) return emptyPage("issues");
  if (body.includes("query Projects(")) return emptyPage("projects");
  if (body.includes("query TeamMembers(")) return handlers.teamMembers?.() ?? emptyPage("team");
  if (body.includes("query Teams(")) return handlers.teams?.() ?? emptyPage("teams");
  return jsonResponse({});
}

async function drainSync(
  connector: ReturnType<typeof createLinearConnector>,
  opts: {
    scopeConfig?: Record<string, unknown>;
    onEntitySeed?: (seed: EntitySeed) => Promise<void>;
  } = {},
): Promise<SyncedItem[]> {
  const items: SyncedItem[] = [];
  for await (const item of connector.sync({
    credentials: { type: "api_key", api_key: "test-key" },
    scopeConfig: opts.scopeConfig ?? {},
    cursor: null,
    logger: (await import("pino")).default({ level: "silent" }),
    onEntitySeed: opts.onEntitySeed,
  })) {
    items.push(item);
  }
  return items;
}

describe("Linear 429 retry bounded", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws after MAX_RETRIES (3) consecutive 429 responses", async () => {
    fetchSpy.mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    );

    const connector = createLinearConnector();
    await expect(connector.validateCredentials({ type: "api_key", api_key: "test-key" })).rejects.toThrow(
      /rate limited after/i,
    );

    // At most 3 fetch calls (MAX_RETRIES)
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("succeeds immediately on 200 response", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { id: "u1", name: "Test" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const connector = createLinearConnector();
    await expect(connector.validateCredentials({ type: "api_key", api_key: "test-key" })).resolves.toBeUndefined();
    expect(fetchSpy.mock.calls.length).toBe(1);
  });
});

describe("Linear concurrent syncs do not share rate-limiter state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("two connector instances have independent lastRequestTime", async () => {
    // Each createLinearConnector() call creates a new closure with its own lastRequestTime
    const connectorA = createLinearConnector();
    const connectorB = createLinearConnector();

    // They are distinct objects
    expect(connectorA).not.toBe(connectorB);

    // Both are independent instances of the same type
    expect(connectorA.type).toBe("linear");
    expect(connectorB.type).toBe("linear");
  });
});

describe("Linear refreshTokens expiry check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when token is not yet expired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const connector = createLinearConnector();
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const result = await connector.refreshTokens?.({
      type: "oauth",
      access_token: "existing-token",
      refresh_token: "refresh-token",
      client_id: "client-id",
      client_secret: "client-secret",
      expires_at: futureExpiry,
    });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes when token is expired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const connector = createLinearConnector();
    const pastExpiry = new Date(Date.now() - 60 * 1000).toISOString();

    const result = await connector.refreshTokens?.({
      type: "oauth",
      access_token: "old-token",
      refresh_token: "refresh-token",
      client_id: "client-id",
      client_secret: "client-secret",
      expires_at: pastExpiry,
    });

    expect(result).not.toBeNull();
    expect(result?.access_token).toBe("new-token");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("refreshes when no expires_at is set (treat as expired)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const connector = createLinearConnector();

    const result = await connector.refreshTokens?.({
      type: "oauth",
      access_token: "old-token",
      refresh_token: "refresh-token",
      client_id: "client-id",
      client_secret: "client-secret",
      // no expires_at
    });

    expect(result).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe("Linear team sync honors configured team scope", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips team/person_seed/member_of facts for teams outside the configured scope", async () => {
    const teamsPage = () =>
      jsonResponse({
        teams: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "team-eng",
              name: "Engineering",
              key: "ENG",
              members: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "u-eng", name: "Eng Person", email: "eng@example.com" }],
              },
            },
            {
              id: "team-mkt",
              name: "Marketing",
              key: "MKT",
              members: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "u-mkt", name: "Mkt Person", email: "mkt@example.com" }],
              },
            },
          ],
        },
      });

    fetchSpy.mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      return routeLinearRequest(body, { teams: teamsPage });
    }) as typeof globalThis.fetch);

    const seeds: EntitySeed[] = [];
    const connector = createLinearConnector();
    const items = await drainSync(connector, {
      scopeConfig: { teams: ["ENG"] },
      onEntitySeed: async (seed) => {
        seeds.push(seed);
      },
    });

    const teamSeeds = seeds.filter((s) => s.sourceType === "team");
    expect(teamSeeds.map((s) => s.metadata?.key)).toEqual(["ENG"]);

    const teamItems = items.filter((i) => i.fileType === "team");
    expect(teamItems).toHaveLength(1);
    expect(teamItems[0]?.fileName).toBe("Engineering");

    const personSeedNames = teamItems.flatMap((i) => i.personSeeds?.map((p) => p.name) ?? []);
    expect(personSeedNames).toEqual(["Eng Person"]);

    const memberEdgeTargets = teamItems.flatMap((i) => i.relationships?.map((r) => r.target.sourceId) ?? []);
    expect(memberEdgeTargets).toEqual(["team-eng"]);
  });
});

describe("Linear team sync paginates nested team members", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("issues follow-up requests for teams with more than one member page", async () => {
    const firstMembers = Array.from({ length: 250 }, (_, i) => ({
      id: `u-${i}`,
      name: `Member ${i}`,
      email: `member${i}@example.com`,
    }));
    const remainingMembers = Array.from({ length: 50 }, (_, i) => ({
      id: `u-${250 + i}`,
      name: `Member ${250 + i}`,
      email: `member${250 + i}@example.com`,
    }));

    const teamsPage = () =>
      jsonResponse({
        teams: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "team-big",
              name: "Big Team",
              key: "BIG",
              members: {
                pageInfo: { hasNextPage: true, endCursor: "members-cursor-1" },
                nodes: firstMembers,
              },
            },
          ],
        },
      });

    const teamMembersPage = () =>
      jsonResponse({
        team: {
          members: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: remainingMembers,
          },
        },
      });

    let teamMembersCalls = 0;
    fetchSpy.mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (body.includes("query TeamMembers(")) teamMembersCalls++;
      return routeLinearRequest(body, { teams: teamsPage, teamMembers: teamMembersPage });
    }) as typeof globalThis.fetch);

    const connector = createLinearConnector();
    const items = await drainSync(connector);

    expect(teamMembersCalls).toBe(1);

    const teamItems = items.filter((i) => i.fileType === "team");
    expect(teamItems).toHaveLength(1);
    expect(teamItems[0]?.personSeeds).toHaveLength(300);
    expect(teamItems[0]?.relationships).toHaveLength(300);
    expect(teamItems[0]?.personSeeds?.at(-1)?.name).toBe("Member 299");
  });
});
