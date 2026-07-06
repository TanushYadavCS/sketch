/**
 * Tests for the ClickUp connector's retry logic.
 *
 * Verifies that 429 (rate limit) responses are bounded by MAX_RETRIES and
 * do not produce an infinite loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClickUpList, type ClickUpSpace, createClickUpConnector, detectSprintCycle } from "./clickup";

const sprintsEnabledSpace: ClickUpSpace = {
  id: "space-design",
  name: "Design",
  features: { sprints: { enabled: true } },
};

const sprintList: ClickUpList = {
  id: "901205383311",
  name: "[Design] Sprint 5 (5/13 - 5/26)",
  start_date: "1747094400000",
  due_date: "1748217600000",
};

describe("detectSprintCycle", () => {
  it("detects a dated sprint list in a sprint-enabled space", () => {
    const cycle = detectSprintCycle(sprintList, sprintsEnabledSpace, { id: "folder-design", name: "Design" });

    expect(cycle).toEqual({
      source: "clickup",
      externalRef: sprintList.id,
      name: sprintList.name,
      scopeRef: { source: "clickup", sourceId: "folder-design" },
      startsAt: "2025-05-13T00:00:00.000Z",
      endsAt: "2025-05-26T00:00:00.000Z",
      sequence: 5,
      isSprint: true,
    });
  });

  it("rejects lists when the space sprint feature or sprint name gate fails", () => {
    expect(
      detectSprintCycle(sprintList, {
        ...sprintsEnabledSpace,
        features: { sprints: { enabled: false } },
      }),
    ).toBeNull();
    expect(
      detectSprintCycle(
        {
          ...sprintList,
          id: "901205383312",
          name: "QA EPIC",
        },
        sprintsEnabledSpace,
      ),
    ).toBeNull();
  });

  it("rejects excluded, undated, and malformed-date sprint-like lists", () => {
    for (const list of [
      { ...sprintList, id: "901205383313", name: "QA Sprint Backlog" },
      { ...sprintList, id: "901205383314", name: "Old Sprint Archive" },
      { id: "901205383315", name: "Delight Sprint", start_date: null, due_date: null },
      { ...sprintList, id: "901205383316", name: "Sprint 6", start_date: "0" },
      { ...sprintList, id: "901205383317", name: "Sprint 7", due_date: "123abc" },
    ]) {
      expect(detectSprintCycle(list, sprintsEnabledSpace)).toBeNull();
    }
  });
});

describe("ClickUp 429 retry bounded", () => {
  const token = "test-api-key";
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws after MAX_RETRIES (3) consecutive 429 responses — does not loop infinitely", async () => {
    // Return 429 every time
    fetchSpy.mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    );

    const connector = createClickUpConnector();

    // validateCredentials calls clickupRequest("/user", ...) which will hit 429
    await expect(connector.validateCredentials({ type: "api_key", api_key: token })).rejects.toThrow(
      /rate limited after/i,
    );

    // Should have been called exactly MAX_RETRIES (3) times — not more
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("succeeds on first call when fetch returns 200", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ user: { id: 1, username: "test" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const connector = createClickUpConnector();
    await expect(connector.validateCredentials({ type: "api_key", api_key: token })).resolves.toBeUndefined();
    expect(fetchSpy.mock.calls.length).toBe(1);
  });
});

describe("ClickUp refreshTokens expiry check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when token is not yet expired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const connector = createClickUpConnector();
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
      new Response(JSON.stringify({ access_token: "new-token", token_type: "Bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const connector = createClickUpConnector();
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
});
