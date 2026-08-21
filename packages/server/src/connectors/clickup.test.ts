/**
 * Tests for the ClickUp connector's retry logic.
 *
 * Verifies that 429 (rate limit) responses are bounded by MAX_RETRIES and
 * do not produce an infinite loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ClickUpList,
  type ClickUpSpace,
  createClickUpConnector,
  detectSprintCycle,
  resolveListCycle,
} from "./clickup";
import type { SyncedItem } from "./types";

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

describe("resolveListCycle", () => {
  it("uses heuristic sprint detection only when no valid hierarchy mapping is stored", () => {
    expect(
      resolveListCycle({
        list: sprintList,
        space: sprintsEnabledSpace,
        workspaceName: "Workspace",
        workspaceId: "workspace",
        storedMapping: { space: "project", list: "ignore" },
      }),
    ).toBeNull();

    for (const storedMapping of [undefined, {}, { nope: "project" }, { list: "bogus" }]) {
      expect(
        resolveListCycle({
          list: sprintList,
          space: sprintsEnabledSpace,
          workspaceName: "Workspace",
          workspaceId: "workspace",
          storedMapping,
        }),
      ).toMatchObject({ externalRef: sprintList.id });
    }
  });

  it("lets a stored list mapping suppress the heuristic or create dates-only sprint cycles", () => {
    expect(
      resolveListCycle({
        list: sprintList,
        space: sprintsEnabledSpace,
        workspaceName: "Workspace",
        workspaceId: "workspace",
        storedMapping: { space: "project", list: "project" },
      }),
    ).toBeNull();

    expect(
      resolveListCycle({
        list: { ...sprintList, name: "Iteration 5" },
        space: { ...sprintsEnabledSpace, features: { sprints: { enabled: false } } },
        workspaceName: "Workspace",
        workspaceId: "workspace",
        storedMapping: { space: "project", list: "sprint" },
      }),
    ).toMatchObject({
      externalRef: sprintList.id,
      name: "Iteration 5",
      scopeRef: { source: "clickup", sourceId: sprintsEnabledSpace.id },
      isSprint: true,
    });
  });

  it("requires dates and a nearest mapped project ancestor for stored sprint lists", () => {
    expect(
      resolveListCycle({
        list: { ...sprintList, start_date: null },
        space: sprintsEnabledSpace,
        workspaceName: "Workspace",
        workspaceId: "workspace",
        storedMapping: { space: "project", list: "sprint" },
      }),
    ).toBeNull();

    expect(
      resolveListCycle({
        list: sprintList,
        space: sprintsEnabledSpace,
        workspaceName: "Workspace",
        workspaceId: "workspace",
        storedMapping: { workspace: "team", space: "ignore", list: "sprint" },
        logger: { warn: vi.fn() },
      }),
    ).toBeNull();

    expect(
      resolveListCycle({
        list: sprintList,
        space: sprintsEnabledSpace,
        folder: { id: "folder-design", name: "Design" },
        workspaceName: "Workspace",
        workspaceId: "workspace",
        storedMapping: { space: "project", folder: "ignore", list: "sprint" },
      }),
    ).toMatchObject({ scopeRef: { source: "clickup", sourceId: sprintsEnabledSpace.id } });

    expect(
      resolveListCycle({
        list: sprintList,
        space: sprintsEnabledSpace,
        folder: { id: "folder-design", name: "Design" },
        workspaceName: "Workspace",
        workspaceId: "workspace",
        storedMapping: { folder: "project", list: "sprint" },
      }),
    ).toMatchObject({ scopeRef: { source: "clickup", sourceId: "folder-design" } });
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

function clickupTask(id: string) {
  return {
    id,
    name: `Task ${id}`,
    description: "",
    status: { status: "Open", type: "open" },
    priority: null,
    assignees: [],
    tags: [],
    date_created: "1785603600000",
    date_updated: "1785603600000",
    due_date: null,
    url: `https://app.clickup.com/t/${id}`,
    list: { id: "list-folderless", name: "Delivery" },
    space: { id: "space-alpha" },
  };
}

describe("ClickUp task pagination", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits all task pages with container source metadata for folderless lists", async () => {
    const page0 = Array.from({ length: 100 }, (_, index) => clickupTask(`task-${index}`));
    const page1 = Array.from({ length: 5 }, (_, index) => clickupTask(`task-extra-${index}`));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/team")) {
        return new Response(JSON.stringify({ teams: [{ id: "workspace-alpha", name: "Workspace", members: [] }] }));
      }
      if (url.endsWith("/team/workspace-alpha/space")) {
        return new Response(JSON.stringify({ spaces: [{ id: "space-alpha", name: "Space", private: false }] }));
      }
      if (url.endsWith("/space/space-alpha/folder")) {
        return new Response(JSON.stringify({ folders: [] }));
      }
      if (url.endsWith("/space/space-alpha/list")) {
        return new Response(JSON.stringify({ lists: [{ id: "list-folderless", name: "Delivery" }] }));
      }
      if (url.includes("/list/list-folderless/task") && url.includes("page=0")) {
        return new Response(JSON.stringify({ tasks: page0, last_page: false }));
      }
      if (url.includes("/list/list-folderless/task") && url.includes("page=1")) {
        return new Response(JSON.stringify({ tasks: page1, last_page: true }));
      }
      if (url.endsWith("/workspaces/workspace-alpha/docs")) {
        return new Response(JSON.stringify({ docs: [] }));
      }
      return new Response("unexpected", { status: 404 });
    });

    const connector = createClickUpConnector();
    const items: SyncedItem[] = [];
    for await (const item of connector.sync({
      credentials: { type: "api_key", api_key: "token" },
      scopeConfig: { spaces: ["space-alpha"] },
      cursor: null,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    })) {
      items.push(item);
    }

    expect(items).toHaveLength(105);
    expect(items.every((item) => item.sourceMeta?.spaceId === "space-alpha")).toBe(true);
    expect(items.every((item) => item.sourceMeta?.listId === "list-folderless")).toBe(true);
    expect(items.every((item) => !Object.hasOwn(item.sourceMeta ?? {}, "folderId"))).toBe(true);
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes("page=0"))).toBe(true);
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes("page=1"))).toBe(true);
  });
});
