import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../auth/password";
import { createSettingsRepository } from "../../db/repositories/settings";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createApp } from "../../http";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const NOW = "2026-06-14T00:00:00.000Z";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const passwordHash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash,
    authRole: "admin",
  });
  await users.create({
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash,
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function userIdByEmail(db: Kysely<DB>, email: string): Promise<string> {
  const user = await db.selectFrom("users").select("id").where("email", "=", email).executeTakeFirstOrThrow();
  return user.id;
}

async function seedEntity(db: Kysely<DB>, id: string, name: string, sourceType = "project") {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: sourceType,
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

async function seedProjectMemberNomination(
  db: Kysely<DB>,
  params: { projectId: string; fileId: string; userId: string },
) {
  await db
    .insertInto("connector_configs")
    .values({
      id: "connector-1",
      connector_type: "linear",
      auth_type: "api_key",
      credentials: "{}",
      scope_config: "{}",
      created_by: params.userId,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: params.fileId,
      connector_config_id: "connector-1",
      provider_file_id: `provider-${params.fileId}`,
      file_name: `${params.fileId}.md`,
      file_type: "document",
      content_category: "document",
      source: "linear",
      provider_url: `https://example.com/${params.fileId}`,
      synced_at: NOW,
      is_archived: 0,
    })
    .execute();
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: `fact-${params.fileId}`,
      indexed_file_id: params.fileId,
      connector_config_id: "connector-1",
      source: "linear",
      fact_type: "parent_entity",
      relation: "mentioned",
      subject_source: "linear",
      subject_source_id: "LP1",
      fact_key: `parent-${params.fileId}-LP1`,
    })
    .execute();
  await db
    .insertInto("entity_source_refs")
    .values({
      id: `ref-${params.projectId}-LP1`,
      entity_id: params.projectId,
      source: "linear",
      source_id: "LP1",
      source_url: null,
      last_seen_at: NOW,
    })
    .execute();
}

describe("entity binding routes", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;
  let adminId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
    adminId = await userIdByEmail(db, ADMIN_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("denies binding creation for members", async () => {
    await seedEntity(db, "project", "Project");

    const res = await app.request("/api/entities/project/bindings", {
      method: "POST",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "linear", containerId: "team-1", containerKind: "team" }),
    });

    expect(res.status).toBe(403);
  });

  it("allows members to read project scope data", async () => {
    await seedEntity(db, "project", "Project");

    const res = await app.request("/api/entities/project/bindings?effective=true", {
      headers: { Cookie: memberCookie },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ bindings: [], children: [] });
  });

  it("creates a project binding and lists effective bindings", async () => {
    await seedEntity(db, "company", "Company", "company");
    await seedEntity(db, "project", "Project");

    const nonProjectRes = await app.request("/api/entities/company/bindings", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "linear", containerId: "company-team", containerKind: "team" }),
    });
    expect(nonProjectRes.status).toBe(422);
    expect((await nonProjectRes.json()).error.code).toBe("NOT_A_PROJECT");

    const createRes = await app.request("/api/entities/project/bindings", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "linear", containerId: "project-team", containerKind: "team" }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created.binding).toEqual(
      expect.objectContaining({
        entityId: "project",
        source: "linear",
        containerId: "project-team",
        containerKind: "team",
      }),
    );
    await expect(
      db
        .selectFrom("entity_project_bindings")
        .select("created_by")
        .where("id", "=", created.binding.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ created_by: adminId });

    const listRes = await app.request("/api/entities/project/bindings?effective=true", {
      headers: { Cookie: adminCookie },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ containerId: "project-team" })]));
  });

  it("groups projects and rejects grouping an already grouped child", async () => {
    await seedEntity(db, "parent", "Parent");
    await seedEntity(db, "parent-2", "Parent 2");
    await seedEntity(db, "child", "Child");

    const groupRes = await app.request("/api/entities/parent/group", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ childId: "child" }),
    });
    expect(groupRes.status).toBe(200);

    const conflictRes = await app.request("/api/entities/parent-2/group", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ childId: "child" }),
    });
    expect(conflictRes.status).toBe(409);
    expect((await conflictRes.json()).error.code).toBe("ALREADY_GROUPED");

    const ungroupRes = await app.request("/api/entities/parent/group/child", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(ungroupRes.status).toBe(200);
  });

  it("ungroups only the selected user grouping relationship", async () => {
    await seedEntity(db, "parent", "Parent");
    await seedEntity(db, "other-parent", "Other Parent");
    await seedEntity(db, "child", "Child");
    await db
      .insertInto("entity_relationships")
      .values({
        id: "learned",
        source_entity_id: "child",
        target_entity_id: "other-parent",
        relationship_type: "part_of",
        confidence: "INFERRED",
        confidence_score: 0.8,
        source: "llm_extraction",
        valid_from: "",
      })
      .execute();
    await app.request("/api/entities/parent/group", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ childId: "child" }),
    });

    const listRes = await app.request("/api/entities/parent/bindings?effective=true", {
      headers: { Cookie: adminCookie },
    });
    expect((await listRes.json()).children).toEqual([{ id: "child", name: "Child" }]);

    const ungroupRes = await app.request("/api/entities/parent/group/child", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(ungroupRes.status).toBe(200);
    await expect(db.selectFrom("entity_relationships").select("source").execute()).resolves.toEqual([
      { source: "llm_extraction" },
    ]);
  });
});

describe("entity member routes", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;
  let adminId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
    adminId = await userIdByEmail(db, ADMIN_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("denies non-admins", async () => {
    await seedEntity(db, "project", "Project");
    await seedProjectMemberNomination(db, { projectId: "project", fileId: "file-a", userId: adminId });

    const res = await app.request("/api/entities/project/members/file-a", {
      method: "PUT",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "exclude" }),
    });

    expect(res.status).toBe(403);
  });

  it("hides an excluded nominated member and restores it when cleared", async () => {
    await seedEntity(db, "project", "Project");
    await seedProjectMemberNomination(db, { projectId: "project", fileId: "file-a", userId: adminId });

    const beforeRes = await app.request("/api/entities/project/members", {
      headers: { Cookie: adminCookie },
    });
    expect(beforeRes.status).toBe(200);
    expect((await beforeRes.json()).members).toEqual([expect.objectContaining({ indexedFileId: "file-a" })]);

    const excludeRes = await app.request("/api/entities/project/members/file-a", {
      method: "PUT",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "exclude" }),
    });
    expect(excludeRes.status).toBe(200);

    const excludedRes = await app.request("/api/entities/project/members", {
      headers: { Cookie: adminCookie },
    });
    expect(excludedRes.status).toBe(200);
    expect((await excludedRes.json()).members).toEqual([]);

    const clearRes = await app.request("/api/entities/project/members/file-a", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(clearRes.status).toBe(200);

    const restoredRes = await app.request("/api/entities/project/members", {
      headers: { Cookie: adminCookie },
    });
    expect(restoredRes.status).toBe(200);
    expect((await restoredRes.json()).members).toEqual([expect.objectContaining({ indexedFileId: "file-a" })]);
  });

  it("rejects setting a member on a non-project", async () => {
    await seedEntity(db, "project", "Project");
    await seedEntity(db, "company", "Company", "company");
    await seedProjectMemberNomination(db, { projectId: "project", fileId: "file-a", userId: adminId });

    const res = await app.request("/api/entities/company/members/file-a", {
      method: "PUT",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "include" }),
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("NOT_A_PROJECT");
  });
});
