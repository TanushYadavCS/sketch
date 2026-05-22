import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createEntityRepository } from "../db/repositories/entities";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { endRecreateLock, isRecreateActive } from "../entities/recreate-state";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const PASSWORD = "testpassword123";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({ name: "admin", email: ADMIN_EMAIL, emailVerified: true, passwordHash: hash, authRole: "admin" });
  await users.create({
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
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

async function seedGraph(db: Kysely<DB>) {
  const admin = await createUserRepository(db).findByEmail(ADMIN_EMAIL);
  if (!admin) throw new Error("admin missing");
  const now = new Date().toISOString();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      created_by: admin.id,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "file-1",
      connector_config_id: "cfg",
      provider_file_id: "meeting-1",
      file_name: "Meeting",
      file_type: "transcript",
      content_category: "document",
      content: "hello",
      source: "fireflies",
      content_hash: "hash",
      is_archived: 0,
      synced_at: now,
    })
    .execute();
  const entity = await createEntityRepository(db).upsertPersonEntity({
    name: "Saurabh",
    email: "saurabh@example.com",
    subtype: "external",
    source: "fireflies",
    sourceId: "meeting-1:saurabh@example.com",
  });
  await createEntityRepository(db).createMention({
    entityId: entity.id,
    indexedFileId: "file-1",
    confidence: "EXTRACTED",
    source: "fireflies_attendee",
    relation: "attended",
  });
}

async function waitForInactive(app: ReturnType<typeof createApp>, cookie: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const res = await app.request("/api/entities/recreate/status", { headers: { Cookie: cookie } });
    const body = (await res.json()) as { active: boolean };
    if (!body.active) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("entity recreate routes", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;

  beforeEach(async () => {
    if (isRecreateActive()) endRecreateLock();
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, createTestConfig({ EXPERIMENTAL_FLAG: true }), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
  });

  afterEach(async () => {
    if (isRecreateActive()) endRecreateLock();
    await db.destroy();
  });

  it("requires admin role", async () => {
    const res = await app.request("/api/entities/recreate/status", {
      headers: { Cookie: memberCookie },
    });

    expect(res.status).toBe(403);
  });

  it("combined dry-run reports reset counts without deleting graph data", async () => {
    await seedGraph(db);

    const res = await app.request("/api/entities/recreate", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET_AND_RECREATE", dryRun: true }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reset: { dryRun: boolean; deleted: Record<string, number>; warnings: string[] };
    };
    expect(body.reset.dryRun).toBe(true);
    expect(body.reset.deleted.entities).toBe(1);
    expect(body.reset.warnings.join(" ")).toContain("no persisted source facts");
    await expect(db.selectFrom("entities").selectAll().execute()).resolves.toHaveLength(1);
  });

  it("split reset holds the recreate lock until run consumes it", async () => {
    await seedGraph(db);

    const reset = await app.request("/api/entities/recreate/reset", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET_AND_RECREATE" }),
    });
    expect(reset.status).toBe(200);
    expect(isRecreateActive()).toBe(true);

    const status = await app.request("/api/entities/recreate/status", {
      headers: { Cookie: adminCookie },
    });
    const statusBody = (await status.json()) as { active: boolean; currentJob: { phase: string } | null };
    expect(statusBody.active).toBe(true);
    expect(statusBody.currentJob?.phase).toBe("reset_done");

    const run = await app.request("/api/entities/recreate/run", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ skipLlm: true }),
    });
    expect(run.status).toBe(202);
    await waitForInactive(app, adminCookie);
  });
});
