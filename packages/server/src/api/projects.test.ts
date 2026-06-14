import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const NOW = "2026-06-14T00:00:00.000Z";

type ProjectPayload = {
  project: {
    id: string;
    name: string;
    origin: "derived" | "defined";
    status: string;
    sourceCount: number;
    subProjectCount: number;
  };
};

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
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
}

async function seedOrigin(db: Kysely<DB>, entityId: string, source: string, sourceId: string) {
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

async function seedBinding(db: Kysely<DB>, entityId: string, createdBy: string) {
  await db
    .insertInto("entity_project_bindings")
    .values({
      id: `binding-${entityId}`,
      entity_id: entityId,
      source: "linear",
      container_id: "team-1",
      container_kind: "team",
      label: "Team 1",
      connector_config_id: null,
      created_by: createdBy,
    })
    .execute();
}

async function seedConnector(db: Kysely<DB>, userId: string) {
  await db
    .insertInto("connector_configs")
    .values({
      id: "connector-1",
      connector_type: "linear",
      auth_type: "api_key",
      credentials: "{}",
      scope_config: "{}",
      created_by: userId,
    })
    .execute();
}

async function seedFileWithParentFact(db: Kysely<DB>, fileId: string, containerId: string) {
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: "connector-1",
      provider_file_id: `provider-${fileId}`,
      file_name: `${fileId}.md`,
      file_type: "document",
      content_category: "document",
      source: "linear",
      provider_url: `https://example.com/${fileId}`,
      synced_at: NOW,
      is_archived: 0,
    })
    .execute();
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: `fact-${fileId}`,
      indexed_file_id: fileId,
      connector_config_id: "connector-1",
      source: "linear",
      fact_type: "parent_entity",
      relation: "mentioned",
      subject_source: "linear",
      subject_source_id: containerId,
      fact_key: `parent-${fileId}-${containerId}`,
    })
    .execute();
}

async function seedStructuralSeed(
  db: Kysely<DB>,
  args: { source: string; sourceId: string; name: string; sourceType: string },
) {
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: `seed-${args.source}-${args.sourceId}`,
      indexed_file_id: null,
      connector_config_id: "connector-1",
      source: args.source,
      fact_type: "structural_seed",
      relation: "seeded",
      subject_name: args.name,
      subject_source: args.source,
      subject_source_id: args.sourceId,
      raw: JSON.stringify({ sourceType: args.sourceType }),
      fact_key: `seed:${args.source}:${args.sourceId}`,
    })
    .execute();
}

async function seedPartOf(db: Kysely<DB>, childId: string, parentId: string) {
  await db
    .insertInto("entity_relationships")
    .values({
      id: `rel-${childId}-${parentId}`,
      source_entity_id: childId,
      target_entity_id: parentId,
      relationship_type: "part_of",
      confidence: "CONFIRMED",
      confidence_score: 1,
      source: "user_grouping",
      valid_from: "",
      valid_to: null,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

describe("project routes", () => {
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

  it("lists confirmed projects with counts and origin", async () => {
    await seedEntity(db, "derived-project", "Alpha Project");
    await seedOrigin(db, "derived-project", "linear", "LP1");
    await seedBinding(db, "derived-project", adminId);
    await seedEntity(db, "defined-project", "Beta Project");
    await seedEntity(db, "company", "Company", "company");

    const res = await app.request("/api/projects", { headers: { Cookie: adminCookie } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: ProjectPayload["project"][] };
    expect(body.projects).toEqual([
      expect.objectContaining({
        id: "derived-project",
        name: "Alpha Project",
        origin: "derived",
        sourceCount: expect.any(Number),
        subProjectCount: 0,
      }),
      expect.objectContaining({
        id: "defined-project",
        name: "Beta Project",
        origin: "defined",
        sourceCount: 0,
        subProjectCount: 0,
      }),
    ]);
    expect(body.projects.find((p) => p.id === "derived-project")?.sourceCount).toBeGreaterThanOrEqual(1);
    expect(body.projects.map((p) => p.id)).not.toContain("company");
  });

  it("returns project detail with sources, members, and sub-projects", async () => {
    await seedConnector(db, adminId);
    await seedEntity(db, "parent-project", "Parent Project");
    await seedEntity(db, "child-project", "Child Project");
    await seedOrigin(db, "parent-project", "linear", "LP1");
    await seedFileWithParentFact(db, "file-a", "LP1");
    await seedPartOf(db, "child-project", "parent-project");

    const res = await app.request("/api/projects/parent-project", { headers: { Cookie: adminCookie } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectPayload & {
      sources: { source: string; containerId: string }[];
      members: { indexedFileId: string; fileName: string }[];
      truncated: boolean;
      subProjects: { id: string; name: string }[];
    };
    expect(body.project).toEqual(
      expect.objectContaining({
        id: "parent-project",
        origin: "derived",
        sourceCount: 1,
        subProjectCount: 1,
      }),
    );
    expect(body.sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "linear", containerId: "LP1" })]),
    );
    expect(body.members).toEqual(expect.arrayContaining([expect.objectContaining({ indexedFileId: "file-a" })]));
    expect(body.subProjects).toEqual([expect.objectContaining({ id: "child-project", name: "Child Project" })]);

    const missingRes = await app.request("/api/projects/unknown-project", { headers: { Cookie: adminCookie } });
    expect(missingRes.status).toBe(404);
    expect(((await missingRes.json()) as { error: { code: string } }).error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("denies members", async () => {
    const res = await app.request("/api/projects", { headers: { Cookie: memberCookie } });

    expect(res.status).toBe(403);
  });

  it("lists bindable containers, excludes already-bound and non-project seeds, and denies members", async () => {
    await seedConnector(db, adminId);
    await seedStructuralSeed(db, {
      source: "linear",
      sourceId: "team-1",
      name: "Platform",
      sourceType: "linear_project",
    });
    await seedStructuralSeed(db, {
      source: "clickup",
      sourceId: "space-9",
      name: "Roadmap",
      sourceType: "clickup_space",
    });
    await seedStructuralSeed(db, { source: "clickup", sourceId: "doc-7", name: "Notes", sourceType: "clickup_doc" });
    await seedEntity(db, "bound-project", "Bound Project");
    await seedBinding(db, "bound-project", adminId);

    const memberRes = await app.request("/api/projects/bindable-containers", { headers: { Cookie: memberCookie } });
    expect(memberRes.status).toBe(403);

    const res = await app.request("/api/projects/bindable-containers", { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { containers: { source: string; containerId: string; label: string }[] };

    expect(body.containers.map((c) => c.containerId)).toEqual(["space-9"]);
    expect(body.containers[0]).toEqual(
      expect.objectContaining({ source: "clickup", containerKind: "clickup_space", label: "Roadmap" }),
    );
  });

  it("soft-deletes an entity, hides it from the list, writes a suppression memo, and is idempotent", async () => {
    await seedEntity(db, "junk-project", "Sketch PR #192");

    const res = await app.request("/api/entities/junk-project", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);

    const row = await db
      .selectFrom("entities")
      .select(["deleted_at", "merged_into_entity_id"])
      .where("id", "=", "junk-project")
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
    expect(row.merged_into_entity_id).toBeNull();

    const list = (await (await app.request("/api/projects", { headers: { Cookie: adminCookie } })).json()) as {
      projects: { id: string }[];
    };
    expect(list.projects.map((p) => p.id)).not.toContain("junk-project");

    const memo = await db
      .selectFrom("entity_creation_suppressions")
      .selectAll()
      .where("entity_type", "=", "project")
      .execute();
    expect(memo).toHaveLength(1);
    expect(memo[0].original_entity_id).toBe("junk-project");

    const again = await app.request("/api/entities/junk-project", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(again.status).toBe(404);
  });

  it("excludes a soft-deleted child project from parent rollup counts", async () => {
    await seedConnector(db, adminId);
    await seedEntity(db, "parent-project", "Parent Project");
    await seedEntity(db, "child-project", "Child Project");
    await seedOrigin(db, "child-project", "linear", "LC1");
    await seedBinding(db, "child-project", adminId);
    await seedPartOf(db, "child-project", "parent-project");

    const before = (await (
      await app.request("/api/projects/parent-project", { headers: { Cookie: adminCookie } })
    ).json()) as ProjectPayload;
    expect(before.project.subProjectCount).toBe(1);
    expect(before.project.sourceCount).toBeGreaterThanOrEqual(1);

    const del = await app.request("/api/entities/child-project", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(del.status).toBe(200);

    const after = (await (
      await app.request("/api/projects/parent-project", { headers: { Cookie: adminCookie } })
    ).json()) as ProjectPayload;
    expect(after.project.subProjectCount).toBe(0);
    expect(after.project.sourceCount).toBe(0);
  });
});
