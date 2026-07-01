import { afterEach, describe, expect, it, vi } from "vitest";
import { createClickUpConnector } from "./clickup";
import { emitFactsForSyncedItem } from "./sync-facts";
import type { EntitySeed, SyncedItem } from "./types";

interface ClickUpFixture {
  team: { id: string; name: string; members: Array<{ user: { id: number; username: string; email?: string } }> };
  spaces: Array<{ id: string; name: string; private?: boolean; features?: { sprints?: { enabled?: boolean } } }>;
  foldersBySpace: Record<string, Array<{ id: string; name: string }>>;
  listsByFolder: Record<
    string,
    Array<{ id: string; name: string; task_count?: number; start_date?: string; due_date?: string }>
  >;
  folderlessListsBySpace: Record<
    string,
    Array<{ id: string; name: string; task_count?: number; start_date?: string; due_date?: string }>
  >;
  tasksByList?: Record<string, unknown[]>;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function clickupTask(input: {
  id: string;
  name: string;
  spaceId: string;
  list: { id: string; name: string };
  folder?: { id: string; name: string };
}) {
  return {
    id: input.id,
    name: input.name,
    description: "",
    status: { status: "open", type: "open" },
    priority: null,
    assignees: [],
    tags: [],
    date_created: "1780000000000",
    date_updated: "1780000001000",
    url: `https://app.clickup.com/t/${input.id}`,
    parent: null,
    list: input.list,
    folder: input.folder,
    space: { id: input.spaceId },
    custom_fields: [],
  };
}

function mockClickUpFetch(fixture: ClickUpFixture): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;

    if (path === "/api/v2/team") return jsonResponse({ teams: [fixture.team] });
    if (path === `/api/v2/team/${fixture.team.id}/space`) return jsonResponse({ spaces: fixture.spaces });
    if (path === `/api/v3/workspaces/${fixture.team.id}/docs`) return jsonResponse({ docs: [] });

    for (const space of fixture.spaces) {
      if (path === `/api/v2/space/${space.id}/folder`) {
        return jsonResponse({ folders: fixture.foldersBySpace[space.id] ?? [] });
      }
      if (path === `/api/v2/space/${space.id}/list`) {
        return jsonResponse({ lists: fixture.folderlessListsBySpace[space.id] ?? [] });
      }
    }

    for (const [folderId, lists] of Object.entries(fixture.listsByFolder)) {
      if (path === `/api/v2/folder/${folderId}/list`) return jsonResponse({ lists });
    }

    for (const [listId, tasks] of Object.entries(fixture.tasksByList ?? {})) {
      if (path === `/api/v2/list/${listId}/task`) return jsonResponse({ tasks });
    }

    return new Response(JSON.stringify({ error: `unexpected path ${path}` }), { status: 404 });
  });
}

async function collectClickUpSync(
  fixture: ClickUpFixture,
  hierarchyMapping?: Record<string, string>,
): Promise<{ seeds: EntitySeed[]; items: SyncedItem[] }> {
  mockClickUpFetch(fixture);
  const connector = createClickUpConnector();
  const seeds: EntitySeed[] = [];
  const items: SyncedItem[] = [];

  for await (const item of connector.sync({
    credentials: { type: "api_key", api_key: "clickup-token" },
    scopeConfig: hierarchyMapping ? { hierarchyMapping } : {},
    cursor: null,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    onEntitySeed: async (seed) => {
      seeds.push(seed);
    },
  })) {
    items.push(item);
  }

  return { seeds, items };
}

describe("ClickUp hierarchy mapping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the mapping to seed Canvas-X-style and getEpik-style hierarchies", async () => {
    const canvas = await collectClickUpSync(
      {
        team: { id: "workspace-canvas", name: "Canvas X", members: [] },
        spaces: [{ id: "space-marketing", name: "Marketing" }],
        foldersBySpace: { "space-marketing": [{ id: "folder-content", name: "Content Engine" }] },
        listsByFolder: {
          "folder-content": [
            { id: "list-blog", name: "Blog Calendar" },
            { id: "list-video", name: "Video | Autopilot" },
            { id: "list-web", name: "Website management" },
          ],
        },
        folderlessListsBySpace: { "space-marketing": [] },
        tasksByList: { "list-blog": [], "list-video": [], "list-web": [] },
      },
      { space: "team", folder: "project", list: "ignore" },
    );

    expect(canvas.seeds.filter((seed) => seed.sourceType === "team")).toEqual([
      expect.objectContaining({ sourceId: "space-marketing", name: "Marketing", aliases: undefined }),
    ]);
    expect(canvas.seeds.filter((seed) => seed.sourceType === "project")).toEqual([
      expect.objectContaining({
        sourceId: "folder-content",
        name: "Marketing Content Engine",
        aliases: ["Content Engine"],
      }),
    ]);
    expect(canvas.seeds.map((seed) => seed.sourceId)).not.toEqual(
      expect.arrayContaining(["list-blog", "list-video", "list-web"]),
    );

    const getEpik = await collectClickUpSync(
      {
        team: { id: "workspace-getepik", name: "getEpik", members: [] },
        spaces: [{ id: "space-eng", name: "Engineering" }],
        foldersBySpace: { "space-eng": [] },
        listsByFolder: {},
        folderlessListsBySpace: { "space-eng": [{ id: "list-default", name: "List" }] },
        tasksByList: { "list-default": [] },
      },
      { space: "project", list: "ignore" },
    );

    expect(getEpik.seeds.filter((seed) => seed.sourceType === "project")).toEqual([
      expect.objectContaining({ sourceId: "space-eng", name: "Engineering" }),
    ]);
    expect(getEpik.seeds.map((seed) => seed.sourceId)).not.toContain("list-default");
  });

  it("points task project and parent facts at the nearest mapped project instead of an ignored folder", async () => {
    const folder = { id: "folder-delivery", name: "Delivery Folder" };
    const list = { id: "list-build", name: "Build" };
    const { items } = await collectClickUpSync(
      {
        team: { id: "workspace-acme", name: "Acme", members: [] },
        spaces: [{ id: "space-product", name: "Product" }],
        foldersBySpace: { "space-product": [folder] },
        listsByFolder: { "folder-delivery": [list] },
        folderlessListsBySpace: { "space-product": [] },
        tasksByList: {
          "list-build": [
            clickupTask({
              id: "task-build",
              name: "Build mapped task",
              spaceId: "space-product",
              list,
              folder,
            }),
          ],
        },
      },
      { space: "project", folder: "ignore", list: "ignore" },
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.task?.project).toEqual({ name: "Product", source: "clickup", sourceId: "space-product" });
    expect(items[0]?.parentEntities).toEqual([
      { source: "clickup", sourceId: "space-product", contextSnippet: "In space: Product" },
    ]);

    const emittedFacts: Array<Record<string, unknown>> = [];
    await emitFactsForSyncedItem({
      factRepo: {
        upsertFact: async (fact: Record<string, unknown>) => {
          emittedFacts.push(fact);
        },
      } as never,
      connector: createClickUpConnector(),
      connectorType: "clickup",
      factContext: {
        connectorConfigId: "connector-clickup",
        createdByUserId: "user-clickup",
        lastSeenSyncRunId: "sync-run",
      },
      item: items[0] as SyncedItem,
      indexedFileId: "indexed-task",
    });

    expect(emittedFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factType: "parent_entity",
          subjectSourceId: "space-product",
          raw: expect.objectContaining({
            parent: { source: "clickup", sourceId: "space-product", contextSnippet: "In space: Product" },
          }),
        }),
        expect.objectContaining({
          factType: "structural_task",
          raw: expect.objectContaining({
            task: expect.objectContaining({
              project: { name: "Product", source: "clickup", sourceId: "space-product" },
            }),
          }),
        }),
      ]),
    );
    expect(emittedFacts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ subjectSourceId: "folder-delivery" })]),
    );
  });

  it("uses stored hierarchy mapping without emitting legacy flat seeds", async () => {
    const { seeds } = await collectClickUpSync(
      {
        team: { id: "workspace-mapped", name: "Mapped Workspace", members: [] },
        spaces: [{ id: "space-mapped", name: "Mapped Space" }],
        foldersBySpace: { "space-mapped": [] },
        listsByFolder: {},
        folderlessListsBySpace: { "space-mapped": [{ id: "list-mapped", name: "Mapped List" }] },
        tasksByList: { "list-mapped": [] },
      },
      { workspace: "team", space: "project", list: "ignore" },
    );

    expect(seeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: "team", sourceId: "workspace-mapped", name: "Mapped Workspace" }),
        expect.objectContaining({ sourceType: "project", sourceId: "space-mapped", name: "Mapped Space" }),
      ]),
    );
    expect(seeds.map((seed) => seed.sourceType)).not.toEqual(
      expect.arrayContaining(["clickup_workspace", "clickup_space"]),
    );
  });

  it("keeps default hierarchy seeding while preserving legacy sprint cycle detection when no mapping is stored", async () => {
    const list = {
      id: "list-sprint-default",
      name: "Sprint 8",
      start_date: "1747094400000",
      due_date: "1748217600000",
    };
    const { seeds, items } = await collectClickUpSync({
      team: { id: "workspace-default", name: "Default Workspace", members: [] },
      spaces: [{ id: "space-default", name: "Default Space", features: { sprints: { enabled: true } } }],
      foldersBySpace: { "space-default": [] },
      listsByFolder: {},
      folderlessListsBySpace: { "space-default": [list] },
      tasksByList: {
        "list-sprint-default": [
          clickupTask({
            id: "task-default-sprint",
            name: "Default sprint task",
            spaceId: "space-default",
            list,
          }),
        ],
      },
    });

    expect(seeds).toEqual([expect.objectContaining({ sourceType: "project", sourceId: "space-default" })]);
    expect(items[0]?.task?.project).toEqual({ name: "Default Space", source: "clickup", sourceId: "space-default" });
    expect(items[0]?.task?.cycle).toMatchObject({
      externalRef: "list-sprint-default",
      scopeRef: { source: "clickup", sourceId: "space-default" },
      isSprint: true,
    });
  });

  it("treats a stored list project mapping as authoritative over sprint-like names", async () => {
    const list = {
      id: "list-sprint-project",
      name: "Sprint 9",
      start_date: "1747094400000",
      due_date: "1748217600000",
    };
    const { seeds, items } = await collectClickUpSync(
      {
        team: { id: "workspace-project-list", name: "Project List Workspace", members: [] },
        spaces: [{ id: "space-project-list", name: "Project List Space", features: { sprints: { enabled: true } } }],
        foldersBySpace: { "space-project-list": [] },
        listsByFolder: {},
        folderlessListsBySpace: { "space-project-list": [list] },
        tasksByList: {
          "list-sprint-project": [
            clickupTask({
              id: "task-project-list",
              name: "Project list task",
              spaceId: "space-project-list",
              list,
            }),
          ],
        },
      },
      { space: "project", list: "project" },
    );

    expect(seeds.map((seed) => seed.sourceId)).toEqual(
      expect.arrayContaining(["space-project-list", "list-sprint-project"]),
    );
    expect(items[0]?.task?.cycle).toBeUndefined();
    expect(items[0]?.task?.project).toEqual({
      name: "Project List Space Sprint 9",
      source: "clickup",
      sourceId: "list-sprint-project",
    });
  });

  it("keeps sprint tasks parented to the nearest mapped project and drops sprint cycles with no project ancestor", async () => {
    const sprintList = {
      id: "list-dated-iteration",
      name: "Iteration 10",
      start_date: "1747094400000",
      due_date: "1748217600000",
    };
    const withProject = await collectClickUpSync(
      {
        team: { id: "workspace-sprint", name: "Sprint Workspace", members: [] },
        spaces: [{ id: "space-sprint", name: "Sprint Space", features: { sprints: { enabled: false } } }],
        foldersBySpace: { "space-sprint": [{ id: "folder-ignored", name: "Ignored Folder" }] },
        listsByFolder: { "folder-ignored": [sprintList] },
        folderlessListsBySpace: { "space-sprint": [] },
        tasksByList: {
          "list-dated-iteration": [
            clickupTask({
              id: "task-sprint-parent",
              name: "Sprint parent task",
              spaceId: "space-sprint",
              folder: { id: "folder-ignored", name: "Ignored Folder" },
              list: sprintList,
            }),
          ],
        },
      },
      { space: "project", folder: "ignore", list: "sprint" },
    );

    expect(withProject.items[0]?.task?.project).toEqual({
      name: "Sprint Space",
      source: "clickup",
      sourceId: "space-sprint",
    });
    expect(withProject.items[0]?.task?.cycle).toMatchObject({
      externalRef: "list-dated-iteration",
      scopeRef: { source: "clickup", sourceId: "space-sprint" },
      isSprint: true,
    });

    const withoutProject = await collectClickUpSync(
      {
        team: { id: "workspace-no-project", name: "No Project Workspace", members: [] },
        spaces: [{ id: "space-no-project", name: "No Project Space", features: { sprints: { enabled: false } } }],
        foldersBySpace: { "space-no-project": [] },
        listsByFolder: {},
        folderlessListsBySpace: { "space-no-project": [sprintList] },
        tasksByList: {
          "list-dated-iteration": [
            clickupTask({
              id: "task-no-project",
              name: "No project task",
              spaceId: "space-no-project",
              list: sprintList,
            }),
          ],
        },
      },
      { workspace: "team", space: "ignore", list: "sprint" },
    );

    expect(withoutProject.items[0]?.task?.project).toBeUndefined();
    expect(withoutProject.items[0]?.task?.cycle).toBeUndefined();
  });
});
