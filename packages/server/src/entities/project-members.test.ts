import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityProjectBindingsRepository } from "../db/repositories/entity-project-bindings";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { mergeEntities, unmergeEntities } from "./merge";
import { createProjectBindingsService } from "./project-bindings";
import { createProjectMembersService } from "./project-members";

const USER_ID = "project-members-user";
const NOW = "2026-06-14T00:00:00.000Z";

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Project Members User", email: "project-members@example.com" })
    .execute();
}

async function seedConnector(db: Kysely<DB>, id = "connector-1", source = "linear"): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: source,
      auth_type: "api_key",
      credentials: "{}",
      scope_config: "{}",
      created_by: USER_ID,
    })
    .execute();
}

async function seedProject(db: Kysely<DB>, id: string, name: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
}

async function seedOrigin(db: Kysely<DB>, entityId: string, source: string, sourceId: string): Promise<void> {
  await db
    .insertInto("entity_source_refs")
    .values({
      id: `ref-${entityId}-${sourceId}`,
      entity_id: entityId,
      source,
      source_id: sourceId,
      source_url: null,
      last_seen_at: NOW,
    })
    .execute();
}

async function seedFile(
  db: Kysely<DB>,
  params: { id: string; source: string; connectorConfigId?: string; archived?: boolean },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: params.id,
      connector_config_id: params.connectorConfigId ?? "connector-1",
      provider_file_id: `provider-${params.id}`,
      file_name: `${params.id}.md`,
      file_type: "document",
      content_category: "document",
      source: params.source,
      provider_url: `https://example.com/${params.id}`,
      synced_at: NOW,
      is_archived: params.archived ? 1 : 0,
    })
    .execute();
}

async function seedParentFact(
  db: Kysely<DB>,
  params: { fileId: string; source: string; containerId: string; factId?: string; connectorConfigId?: string },
): Promise<void> {
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: params.factId ?? `fact-${params.fileId}-${params.containerId}`,
      indexed_file_id: params.fileId,
      connector_config_id: params.connectorConfigId ?? "connector-1",
      source: params.source,
      fact_type: "parent_entity",
      relation: "mentioned",
      subject_source: params.source,
      subject_source_id: params.containerId,
      fact_key: `parent-${params.fileId}-${params.containerId}`,
    })
    .execute();
}

describe("project members", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("nominates live files from a project's origin-bound container", async () => {
    await seedConnector(db);
    await seedProject(db, "project", "Project");
    await seedOrigin(db, "project", "linear", "LP1");
    await seedFile(db, { id: "file-a", source: "linear" });
    await seedFile(db, { id: "file-b", source: "linear" });
    await seedFile(db, { id: "file-other", source: "linear" });
    await seedFile(db, { id: "file-archived", source: "linear", archived: true });
    await seedParentFact(db, { fileId: "file-a", source: "linear", containerId: "LP1" });
    await seedParentFact(db, { fileId: "file-b", source: "linear", containerId: "LP1" });
    await seedParentFact(db, { fileId: "file-other", source: "linear", containerId: "OTHER" });
    await seedParentFact(db, { fileId: "file-archived", source: "linear", containerId: "LP1" });

    const result = await createProjectMembersService(db).resolveProjectMembers("project");

    expect(result.truncated).toBe(false);
    expect(result.members.map((m) => m.indexedFileId).sort()).toEqual(["file-a", "file-b"]);
  });

  it("resolves spine-nominated members and applies sticky overrides", async () => {
    await seedConnector(db, "clickup-config", "clickup");
    await seedProject(db, "parent", "Parent");
    await seedProject(db, "child", "Child");
    await seedFile(db, { id: "file-child", source: "clickup", connectorConfigId: "clickup-config" });
    await seedFile(db, { id: "file-manual", source: "clickup", connectorConfigId: "clickup-config" });
    await seedParentFact(db, {
      fileId: "file-child",
      source: "clickup",
      containerId: "C1",
      connectorConfigId: "clickup-config",
    });
    await createEntityProjectBindingsRepository(db).create({
      entityId: "child",
      source: "clickup",
      containerId: "C1",
      containerKind: "space",
      createdBy: USER_ID,
    });
    await createProjectBindingsService(db).groupProject("parent", "child");
    const members = createProjectMembersService(db);

    await expect(members.resolveProjectMembers("parent")).resolves.toMatchObject({
      members: [expect.objectContaining({ indexedFileId: "file-child", viaProjectId: "child", manual: false })],
    });

    await members.setMembership("parent", "file-child", "exclude", USER_ID);
    await expect(members.resolveProjectMembers("parent")).resolves.toMatchObject({ members: [] });

    await members.setMembership("parent", "file-manual", "include", USER_ID);
    await expect(members.resolveProjectMembers("parent")).resolves.toMatchObject({
      members: [
        expect.objectContaining({
          indexedFileId: "file-manual",
          viaProjectId: null,
          containerId: null,
          manual: true,
        }),
      ],
    });
  });

  it("keeps connector-config-scoped bindings from matching overlapping containers", async () => {
    await seedConnector(db, "clickup-a", "clickup");
    await seedConnector(db, "clickup-b", "clickup");
    await seedProject(db, "project", "Project");
    await seedFile(db, { id: "file-a", source: "clickup", connectorConfigId: "clickup-a" });
    await seedFile(db, { id: "file-b", source: "clickup", connectorConfigId: "clickup-b" });
    await seedParentFact(db, {
      fileId: "file-a",
      source: "clickup",
      containerId: "C1",
      connectorConfigId: "clickup-a",
    });
    await seedParentFact(db, {
      fileId: "file-b",
      source: "clickup",
      containerId: "C1",
      connectorConfigId: "clickup-b",
    });
    await createEntityProjectBindingsRepository(db).create({
      entityId: "project",
      source: "clickup",
      containerId: "C1",
      containerKind: "space",
      connectorConfigId: "clickup-a",
      createdBy: USER_ID,
    });

    await expect(createProjectMembersService(db).resolveProjectMembers("project")).resolves.toMatchObject({
      members: [expect.objectContaining({ indexedFileId: "file-a" })],
    });
  });

  it("re-points member overrides during merge and restores them on unmerge", async () => {
    await seedConnector(db);
    await seedProject(db, "parent", "Parent");
    await seedProject(db, "duplicate", "Duplicate");
    await seedFile(db, { id: "file-x", source: "linear" });
    const members = createProjectMembersService(db);
    await members.setMembership("duplicate", "file-x", "exclude", USER_ID);

    const merge = await mergeEntities(db, { survivorId: "parent", loserId: "duplicate", userId: USER_ID });

    await expect(
      db
        .selectFrom("entity_project_member_overrides")
        .select(["entity_id", "indexed_file_id", "mode"])
        .where("entity_id", "=", "parent")
        .execute(),
    ).resolves.toEqual([{ entity_id: "parent", indexed_file_id: "file-x", mode: "exclude" }]);

    await unmergeEntities(db, { mergeId: merge.mergeId, userId: USER_ID });

    await expect(
      db
        .selectFrom("entity_project_member_overrides")
        .select(["entity_id", "indexed_file_id", "mode"])
        .where("entity_id", "=", "duplicate")
        .execute(),
    ).resolves.toEqual([{ entity_id: "duplicate", indexed_file_id: "file-x", mode: "exclude" }]);
  });
});
