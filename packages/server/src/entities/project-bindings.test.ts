import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityProjectBindingsRepository } from "../db/repositories/entity-project-bindings";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { mergeEntities, unmergeEntities } from "./merge";
import { createProjectBindingsService } from "./project-bindings";

const USER_ID = "project-bindings-user";

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Project Bindings User", email: "project-bindings@example.com" })
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
      last_seen_at: "2026-06-14T00:00:00.000Z",
    })
    .execute();
}

async function partOfCount(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("entity_relationships")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("relationship_type", "=", "part_of")
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe("project bindings", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("resolves effective scope up the spine", async () => {
    await seedProject(db, "parent", "Parent");
    await seedProject(db, "child", "Child");
    await seedOrigin(db, "parent", "linear", "parent-origin");
    const repo = createEntityProjectBindingsRepository(db);
    await repo.create({
      entityId: "child",
      source: "clickup",
      containerId: "child-space",
      containerKind: "space",
      label: "Child Space",
      createdBy: USER_ID,
    });
    const service = createProjectBindingsService(db);

    await service.groupProject("parent", "child");

    const parentBindings = await service.resolveEffectiveBindings("parent");
    expect(parentBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "linear", containerId: "parent-origin", origin: true }),
        expect.objectContaining({
          source: "clickup",
          containerId: "child-space",
          viaProjectId: "child",
          origin: false,
        }),
      ]),
    );
    const childBindings = await service.resolveEffectiveBindings("child");
    expect(childBindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "clickup", containerId: "child-space" })]),
    );
    expect(childBindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "linear", containerId: "parent-origin" })]),
    );
  });

  it("guards single-parent grouping and cycles", async () => {
    await seedProject(db, "parent", "Parent");
    await seedProject(db, "parent-2", "Parent 2");
    await seedProject(db, "child", "Child");
    const service = createProjectBindingsService(db);

    await service.groupProject("parent", "child");
    await expect(service.groupProject("parent-2", "child")).rejects.toMatchObject({
      code: "ALREADY_GROUPED",
    });
    await expect(service.groupProject("child", "parent")).rejects.toMatchObject({
      code: "WOULD_CYCLE",
    });

    await expect(partOfCount(db)).resolves.toBe(1);
  });

  it("ungroups inheritance and merge re-points project bindings with unmerge restore", async () => {
    await seedProject(db, "parent", "Parent");
    await seedProject(db, "child", "Child");
    await seedProject(db, "duplicate", "Parent Duplicate");
    await seedOrigin(db, "parent", "linear", "parent-origin");
    const repo = createEntityProjectBindingsRepository(db);
    await repo.create({
      entityId: "child",
      source: "clickup",
      containerId: "child-space",
      containerKind: "space",
      createdBy: USER_ID,
    });
    await repo.create({
      entityId: "duplicate",
      source: "linear",
      containerId: "duplicate-team",
      containerKind: "team",
      createdBy: USER_ID,
    });
    const service = createProjectBindingsService(db);
    await service.groupProject("parent", "child");

    await service.ungroupProject("child");

    await expect(service.resolveEffectiveBindings("parent")).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "clickup", containerId: "child-space" })]),
    );

    const merge = await mergeEntities(db, { survivorId: "parent", loserId: "duplicate", userId: USER_ID });
    await expect(service.resolveEffectiveBindings("parent")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "linear", containerId: "duplicate-team" })]),
    );

    await unmergeEntities(db, { mergeId: merge.mergeId, userId: USER_ID });

    await expect(service.resolveEffectiveBindings("parent")).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "linear", containerId: "duplicate-team" })]),
    );
    await expect(service.resolveEffectiveBindings("duplicate")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "linear", containerId: "duplicate-team" })]),
    );
  });
});
