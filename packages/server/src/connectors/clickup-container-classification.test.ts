import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { createTestDb, createTestLogger } from "../test-utils";
import { readHierarchyMappingConfig, resolveHierarchyMapping } from "./hierarchy-mapping";
import { runConnectorSync } from "./sync";
import { serializeCredentials } from "./sync-utils";
import type { HierarchyLevelDeclaration } from "./types";

const USER_ID = "clickup-container-user";

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
  tasksByList: Record<string, unknown[]>;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function clickupTask(input: {
  id: string;
  name: string;
  list: { id: string; name: string };
  spaceId: string;
  folder?: { id: string; name: string };
  createdAt?: string;
}) {
  return {
    id: input.id,
    name: input.name,
    description: "",
    status: { status: "open", type: "open" },
    priority: null,
    creator: { id: "creator-1", username: "Owner", email: "owner@example.com" },
    assignees: [],
    tags: [],
    date_created: input.createdAt ?? "1780000000000",
    date_updated: input.createdAt ?? "1780000000000",
    url: `https://app.clickup.com/t/${input.id}`,
    parent: null,
    list: input.list,
    folder: input.folder,
    space: { id: input.spaceId },
    custom_fields: [],
  };
}

function mockClickUpFetch(fixture: ClickUpFixture): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;

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

    for (const [listId, tasks] of Object.entries(fixture.tasksByList)) {
      if (path === `/api/v2/list/${listId}/task`) return jsonResponse({ tasks, last_page: true });
    }

    return new Response(JSON.stringify({ error: `unexpected path ${path}` }), { status: 404 });
  });
}

async function seedConnector(db: Kysely<DB>, connectorId: string, scopeConfig: Record<string, unknown>) {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "ClickUp Container User",
      email: "clickup-container@example.com",
      email_verified_at: now,
      password_hash: "hash",
      auth_role: "admin",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  return createConnectorRepository(db).createConfig({
    connectorType: "clickup",
    authType: "api_key",
    credentials: serializeCredentials({ type: "api_key", api_key: "clickup-token" }),
    scopeConfig: JSON.stringify(scopeConfig),
    createdBy: USER_ID,
    syncStatus: "active",
  });
}

async function runClickUpSync(db: Kysely<DB>, connectorId: string) {
  return runConnectorSync(db, connectorId, createTestLogger(), undefined, { postSyncMode: "deferred" });
}

describe("ClickUp container classification sync effects", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("mints one standing project for a program and cycles for monthly cohort lists", async () => {
    const folder = { id: "folder-21-day", name: "21 Day Challenge" };
    const lists = [
      { id: "list-june", name: "21 Day - June", start_date: "1780272000000", due_date: "1782864000000" },
      { id: "list-july", name: "21 Day - July", start_date: "1782950400000", due_date: "1785542400000" },
      { id: "list-august", name: "21 Day - August", start_date: "1785628800000", due_date: "1788220800000" },
    ];
    const fixture: ClickUpFixture = {
      team: { id: "workspace-habuild", name: "Habuild", members: [] },
      spaces: [{ id: "space-ops", name: "Operations" }],
      foldersBySpace: { "space-ops": [folder] },
      listsByFolder: { "folder-21-day": lists },
      folderlessListsBySpace: { "space-ops": [] },
      tasksByList: Object.fromEntries(
        lists.map((list) => [
          list.id,
          [clickupTask({ id: `task-${list.id}`, name: `Coach ${list.name}`, list, spaceId: "space-ops", folder })],
        ]),
      ),
    };
    mockClickUpFetch(fixture);
    const connector = await seedConnector(db, "connector-program", {
      hierarchyMapping: {
        levels: { folder: "project", list: "ignore" },
        containers: {
          "folder-21-day": "program",
          "list-june": "cycle",
          "list-july": "cycle",
          "list-august": "cycle",
        },
      },
    });

    await runClickUpSync(db, connector.id);
    await materializeUnmaterializedFacts(db, createTestLogger());

    const projectRefs = await db
      .selectFrom("entity_source_refs")
      .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
      .select(["entity_source_refs.source_id", "entities.source_type", "entities.metadata"])
      .where("entity_source_refs.source", "=", "clickup")
      .where("entities.source_type", "=", "project")
      .orderBy("entity_source_refs.source_id", "asc")
      .execute();
    expect(projectRefs.map((row) => row.source_id)).toEqual(["folder-21-day"]);
    expect(JSON.parse(projectRefs[0]?.metadata ?? "{}")).toMatchObject({ containerTarget: "program" });

    const cycles = await db
      .selectFrom("work_cycles")
      .select(["external_ref", "scope_entity_id"])
      .orderBy("external_ref", "asc")
      .execute();
    expect(cycles.map((cycle) => cycle.external_ref)).toEqual(["list-august", "list-july", "list-june"]);
    expect(new Set(cycles.map((cycle) => cycle.scope_entity_id)).size).toBe(1);
    await expect(db.selectFrom("tasks").select("id").execute()).resolves.toHaveLength(3);
  });

  it("syncs register tickets as indexed files without structural task facts or task rows", async () => {
    const list = { id: "list-crm", name: "Client Register" };
    mockClickUpFetch({
      team: { id: "workspace-habuild", name: "Habuild", members: [] },
      spaces: [{ id: "space-sales", name: "Sales" }],
      foldersBySpace: { "space-sales": [] },
      listsByFolder: {},
      folderlessListsBySpace: { "space-sales": [list] },
      tasksByList: {
        "list-crm": [
          clickupTask({ id: "person-a", name: "Anita Shah", list, spaceId: "space-sales" }),
          clickupTask({ id: "company-b", name: "Bluebird Pvt Ltd", list, spaceId: "space-sales" }),
        ],
      },
    });
    const connector = await seedConnector(db, "connector-register", {
      hierarchyMapping: {
        levels: { space: "project", list: "ignore" },
        containers: { "list-crm": "register" },
      },
    });

    await runClickUpSync(db, connector.id);
    await materializeUnmaterializedFacts(db, createTestLogger());

    await expect(
      db.selectFrom("indexed_files").select("provider_file_id").orderBy("provider_file_id").execute(),
    ).resolves.toEqual([{ provider_file_id: "company-b" }, { provider_file_id: "person-a" }]);
    await expect(
      db.selectFrom("indexed_file_facts").select("id").where("fact_type", "=", "structural_task").execute(),
    ).resolves.toHaveLength(0);
    await expect(db.selectFrom("tasks").select("id").execute()).resolves.toHaveLength(0);
  });

  it("applies accepted container mappings on re-sync without a classifier call and keeps legacy levels compatible", async () => {
    const list = { id: "list-queue", name: "Riya Mehta" };
    mockClickUpFetch({
      team: { id: "workspace-habuild", name: "Habuild", members: [] },
      spaces: [{ id: "space-support", name: "Support" }],
      foldersBySpace: { "space-support": [] },
      listsByFolder: {},
      folderlessListsBySpace: { "space-support": [list] },
      tasksByList: {
        "list-queue": [clickupTask({ id: "queue-entry", name: "Follow up diary row", list, spaceId: "space-support" })],
      },
    });
    const acceptedMapping = {
      levels: { space: "project", list: "ignore" },
      containers: { "list-queue": "person_queue" },
    };
    const connector = await seedConnector(db, "connector-accepted", { hierarchyMapping: acceptedMapping });
    const classifier = vi.fn();

    const stored = await createConnectorRepository(db).findConfigById(connector.id);
    expect(JSON.parse(stored?.scope_config ?? "{}")).toMatchObject({ hierarchyMapping: acceptedMapping });

    await runClickUpSync(db, connector.id);
    expect(classifier).toHaveBeenCalledTimes(0);
    await expect(
      db.selectFrom("indexed_file_facts").select("id").where("fact_type", "=", "structural_task").execute(),
    ).resolves.toHaveLength(0);

    const levels: HierarchyLevelDeclaration[] = [
      { key: "workspace", label: "Workspace", allowedTargets: ["team", "ignore"], default: "ignore" },
      {
        key: "space",
        label: "Space",
        allowedTargets: ["team", "project", "ignore"],
        default: "ignore",
      },
      { key: "folder", label: "Folder", allowedTargets: ["project", "ignore"], default: "ignore" },
      {
        key: "list",
        label: "List",
        allowedTargets: ["project", "sprint", "ignore"],
        default: "ignore",
      },
    ];
    expect(resolveHierarchyMapping(levels, readHierarchyMappingConfig({ space: "project", list: "ignore" }))).toEqual(
      resolveHierarchyMapping(levels, readHierarchyMappingConfig({ levels: { space: "project", list: "ignore" } })),
    );
  });
});
