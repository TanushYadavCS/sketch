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

  it("does not seed reachable workspace members or entities when only another workspace's space is selected", async () => {
    const fetchSpy = mockClickUpFetch();
    const { entitySeeds, personSeeds, items } = await collectClickUpSync({
      workspaces: [],
      spaces: ["space-a"],
    });

    expect(items).toEqual([]);
    expect(personSeeds).toEqual([
      expect.objectContaining({
        sourceId: "user:1",
        name: "Alice A",
        email: "alice@workspace-a.example",
      }),
    ]);
    expect(entitySeeds.filter((seed) => seed.sourceType === "clickup_workspace").map((seed) => seed.sourceId)).toEqual([
      "workspace-a",
    ]);
    expect(entitySeeds.filter((seed) => seed.sourceType === "clickup_space").map((seed) => seed.sourceId)).toEqual([
      "space-a",
    ]);

    const paths = pathsFrom(fetchSpy);
    expect(paths).not.toEqual(expect.arrayContaining(["/api/v2/space/space-b/folder"]));
    expect(paths).not.toEqual(expect.arrayContaining(["/api/v3/workspaces/workspace-b/docs"]));
  });

  it("keeps unscoped sync seeding every reachable workspace", async () => {
    const fetchSpy = mockClickUpFetch();
    const { entitySeeds, personSeeds, items } = await collectClickUpSync({
      workspaces: [],
      spaces: [],
    });

    expect(items).toEqual([]);
    expect(personSeeds.map((seed) => seed.sourceId).sort()).toEqual(["user:1", "user:2"]);
    expect(
      entitySeeds
        .filter((seed) => seed.sourceType === "clickup_workspace")
        .map((seed) => seed.sourceId)
        .sort(),
    ).toEqual(["workspace-a", "workspace-b"]);
    expect(
      entitySeeds
        .filter((seed) => seed.sourceType === "clickup_space")
        .map((seed) => seed.sourceId)
        .sort(),
    ).toEqual(["space-a", "space-b"]);

    expect(pathsFrom(fetchSpy)).toEqual(
      expect.arrayContaining([
        "/api/v2/space/space-a/folder",
        "/api/v2/space/space-b/folder",
        "/api/v3/workspaces/workspace-a/docs",
        "/api/v3/workspaces/workspace-b/docs",
      ]),
    );
  });
});
