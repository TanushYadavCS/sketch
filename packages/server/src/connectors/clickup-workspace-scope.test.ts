import { afterEach, describe, expect, it, vi } from "vitest";
import { createClickUpConnector } from "./clickup";
import type { EntitySeed, PersonEntitySeed, SyncedItem } from "./types";

const teams = [
  {
    id: "workspace-a",
    name: "Workspace A",
    members: [{ user: { id: 1, username: "Alice A", email: "alice@workspace-a.example" } }],
  },
  {
    id: "workspace-b",
    name: "Workspace B",
    members: [{ user: { id: 2, username: "Bob B", email: "bob@workspace-b.example" } }],
  },
];

const spacesByWorkspace = {
  "workspace-a": [{ id: "space-a", name: "Space A" }],
  "workspace-b": [{ id: "space-b", name: "Space B" }],
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockClickUpFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;

    if (path === "/api/v2/team") {
      return jsonResponse({ teams });
    }

    const teamSpaceMatch = path.match(/^\/api\/v2\/team\/([^/]+)\/space$/);
    if (teamSpaceMatch) {
      return jsonResponse({
        spaces: spacesByWorkspace[teamSpaceMatch[1] as keyof typeof spacesByWorkspace] ?? [],
      });
    }

    const spaceFoldersMatch = path.match(/^\/api\/v2\/space\/([^/]+)\/folder$/);
    if (spaceFoldersMatch) {
      return jsonResponse({ folders: [] });
    }

    const spaceListsMatch = path.match(/^\/api\/v2\/space\/([^/]+)\/list$/);
    if (spaceListsMatch) {
      return jsonResponse({ lists: [] });
    }

    const docsMatch = path.match(/^\/api\/v3\/workspaces\/([^/]+)\/docs$/);
    if (docsMatch) {
      return jsonResponse({ docs: [] });
    }

    return new Response(JSON.stringify({ error: `unexpected path ${path}` }), { status: 404 });
  });
}

async function collectClickUpSync(scopeConfig: Record<string, unknown>) {
  const connector = createClickUpConnector();
  const entitySeeds: EntitySeed[] = [];
  const personSeeds: PersonEntitySeed[] = [];
  const items: SyncedItem[] = [];

  for await (const item of connector.sync({
    credentials: { type: "api_key", api_key: "clickup-token" },
    scopeConfig,
    cursor: null,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    onEntitySeed: async (seed) => {
      entitySeeds.push(seed);
    },
    onPersonSeed: async (seed) => {
      personSeeds.push(seed);
    },
  })) {
    items.push(item);
  }

  return { entitySeeds, personSeeds, items };
}

function pathsFrom(fetchSpy: ReturnType<typeof mockClickUpFetch>): string[] {
  const calls = fetchSpy.mock.calls as Parameters<typeof fetch>[];
  return calls.map((call) => new URL(String(call[0])).pathname);
}

describe("ClickUp workspace effective scope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not seed workspace members as people, and does not reach another workspace when only one space is selected", async () => {
    const fetchSpy = mockClickUpFetch();
    const { entitySeeds, personSeeds, items } = await collectClickUpSync({
      workspaces: [],
      spaces: ["space-a"],
    });

    expect(items).toEqual([]);
    // Bare workspace membership is not an engagement signal — no phantom people.
    expect(personSeeds).toEqual([]);
    expect(entitySeeds.filter((seed) => seed.sourceType === "clickup_workspace")).toEqual([]);
    expect(entitySeeds.filter((seed) => seed.sourceType === "clickup_space")).toEqual([]);

    const paths = pathsFrom(fetchSpy);
    expect(paths).not.toEqual(expect.arrayContaining(["/api/v2/space/space-b/folder"]));
    expect(paths).not.toEqual(expect.arrayContaining(["/api/v3/workspaces/workspace-b/docs"]));
  });

  it("processes every reachable workspace when unscoped, still without seeding members as people", async () => {
    const fetchSpy = mockClickUpFetch();
    const { entitySeeds, personSeeds, items } = await collectClickUpSync({
      workspaces: [],
      spaces: [],
    });

    expect(items).toEqual([]);
    // No tasks in these fixtures → no assignees → no people, even though both
    // workspaces are fully processed (proven by the fetch paths below).
    expect(personSeeds).toEqual([]);
    expect(entitySeeds.filter((seed) => seed.sourceType === "clickup_workspace")).toEqual([]);
    expect(entitySeeds.filter((seed) => seed.sourceType === "clickup_space")).toEqual([]);

    expect(pathsFrom(fetchSpy)).toEqual(
      expect.arrayContaining([
        "/api/v2/space/space-a/folder",
        "/api/v2/space/space-b/folder",
        "/api/v3/workspaces/workspace-a/docs",
        "/api/v3/workspaces/workspace-b/docs",
      ]),
    );
  });

  it("seeds task assignees as people (engagement signal), keyed by assignee username", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v2/team") {
        return jsonResponse({
          teams: [{ id: "workspace-a", name: "Workspace A", members: teams[0].members }],
        });
      }
      if (path === "/api/v2/team/workspace-a/space") {
        return jsonResponse({ spaces: [{ id: "space-a", name: "Space A" }] });
      }
      if (path === "/api/v2/space/space-a/folder") return jsonResponse({ folders: [] });
      if (path === "/api/v2/space/space-a/list") {
        return jsonResponse({ lists: [{ id: "list-a", name: "List A" }] });
      }
      if (path === "/api/v2/list/list-a/task") {
        return jsonResponse({
          tasks: [
            {
              id: "task-1",
              name: "Do the thing",
              status: { status: "open", type: "open" },
              assignees: [{ id: 1, username: "Alice A", email: "alice@workspace-a.example" }],
              tags: [],
              url: "https://app.clickup.com/t/task-1",
              list: { id: "list-a", name: "List A" },
              space: { id: "space-a" },
              date_updated: "1700000000000",
            },
          ],
        });
      }
      if (path === "/api/v3/workspaces/workspace-a/docs") return jsonResponse({ docs: [] });
      return new Response(JSON.stringify({ error: `unexpected path ${path}` }), { status: 404 });
    });

    const { personSeeds } = await collectClickUpSync({ workspaces: [], spaces: [] });

    // The assignee is seeded (engagement), keyed by username — not by user:<id>.
    expect(personSeeds).toEqual([expect.objectContaining({ sourceId: "assignee:Alice A", name: "Alice A" })]);
    expect(personSeeds.every((seed) => !seed.sourceId.startsWith("user:"))).toBe(true);
  });
});
