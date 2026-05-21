/**
 * Route-level tests for /api/entity-review.
 *
 * Resolve-logic coverage lives in resolve.test.ts; this file focuses on
 * what only the HTTP layer can express: owner-scope enforcement,
 * auth-before-mutation on GET /:id, multi-user-evidence admin escalation,
 * and the EXPERIMENTAL_FLAG gate on the mount point.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSWORD = "testpassword123";
const OWNER_EMAIL = "owner@test.com";
const ADMIN_EMAIL = "admin@test.com";
const OTHER_EMAIL = "other@test.com";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db, ENCRYPTION_KEY);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await users.create({
    name: "owner",
    email: OWNER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "member",
  });
  await users.create({
    name: "other",
    email: OTHER_EMAIL,
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

async function userIdByEmail(db: Kysely<DB>, email: string): Promise<string> {
  const row = await db.selectFrom("users").select(["id"]).where("email", "=", email).executeTakeFirstOrThrow();
  return row.id;
}

async function seedConnectorConfig(db: Kysely<DB>, id: string, createdBy: string) {
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: JSON.stringify({ type: "api_key", apiKey: "x" }),
      created_by: createdBy,
      scope_config: JSON.stringify({}),
    })
    .execute();
}

async function seedIndexedFile(db: Kysely<DB>, id: string, configId: string) {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: configId,
      provider_file_id: `p-${id}`,
      file_name: `${id}.md`,
      file_type: "meeting_transcript",
      content_category: "document",
      source: "fireflies",
      source_path: null,
      provider_url: null,
      content: null,
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      source_updated_at: null,
      source_created_at: null,
      synced_at: new Date().toISOString(),
      embedding_status: "pending",
    })
    .execute();
}

async function seedPendingRow(
  db: Kysely<DB>,
  opts: { triggeredBy: string; evidenceFileIds: string[] },
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entity_review_queue")
    .values({
      id,
      proposed_name: "Simran Suri Neeli",
      normalized_name: `simran suri neeli ${id}`, // unique to avoid UNIQUE constraint across tests
      entity_type: "person",
      candidate_entity_id: null,
      candidate_score: null,
      candidate_reason: "token-superset",
      candidate_generated_at: now,
      first_seen_at: now,
      last_seen_at: now,
      occurrence_count: 1,
      status: "pending",
      triggered_by_user_id: opts.triggeredBy,
    })
    .execute();
  for (const fid of opts.evidenceFileIds) {
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: id,
        indexed_file_id: fid,
        source: "fireflies",
        note: null,
        seen_at: now,
      })
      .execute();
  }
  return id;
}

describe("entity-review routes — EXPERIMENTAL_FLAG", () => {
  it("returns 404 when flag is off (route not mounted)", async () => {
    const db = await createTestDb();
    try {
      await seedUsers(db);
      const app = createApp(db, createTestConfig({ ENCRYPTION_KEY, EXPERIMENTAL_FLAG: false }), {
        logger: createTestLogger(),
      });
      const cookie = await login(app, OWNER_EMAIL);
      const res = await app.request("/api/entity-review", { headers: { Cookie: cookie } });
      expect(res.status).toBe(404);
    } finally {
      await db.destroy();
    }
  });

  it("returns 200 when flag is on", async () => {
    const db = await createTestDb();
    try {
      await seedUsers(db);
      const app = createApp(db, createTestConfig({ ENCRYPTION_KEY, EXPERIMENTAL_FLAG: true }), {
        logger: createTestLogger(),
      });
      const cookie = await login(app, OWNER_EMAIL);
      const res = await app.request("/api/entity-review", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
    } finally {
      await db.destroy();
    }
  });
});

describe("entity-review routes — owner-scope & auth-before-mutation", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  let otherId: string;
  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    ownerId = await userIdByEmail(db, OWNER_EMAIL);
    otherId = await userIdByEmail(db, OTHER_EMAIL);
    await seedConnectorConfig(db, "config-owner", ownerId);
    await seedConnectorConfig(db, "config-other", otherId);
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY, EXPERIMENTAL_FLAG: true }), {
      logger: createTestLogger(),
    });
    ownerCookie = await login(app, OWNER_EMAIL);
    otherCookie = await login(app, OTHER_EMAIL);
    adminCookie = await login(app, ADMIN_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("non-owner GET /:id returns 403 and does NOT flip review_started_at", async () => {
    await seedIndexedFile(db, "file-1", "config-owner");
    const reviewId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-1"] });

    const res = await app.request(`/api/entity-review/${reviewId}`, { headers: { Cookie: otherCookie } });
    expect(res.status).toBe(403);

    // Critical regression guard: row state untouched.
    const after = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(after.review_started_at).toBeNull();
    expect(after.review_started_by).toBeNull();
  });

  it("owner GET /:id sets review_started_at", async () => {
    await seedIndexedFile(db, "file-1", "config-owner");
    const reviewId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-1"] });

    const res = await app.request(`/api/entity-review/${reviewId}`, { headers: { Cookie: ownerCookie } });
    expect(res.status).toBe(200);

    const after = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(after.review_started_at).not.toBeNull();
    expect(after.review_started_by).toBe(ownerId);
  });

  it("multi-user-evidence row is admin-only, even for the original triggered_by owner", async () => {
    // Evidence spans both owner's connector and other's connector.
    await seedIndexedFile(db, "file-mine", "config-owner");
    await seedIndexedFile(db, "file-theirs", "config-other");
    const reviewId = await seedPendingRow(db, {
      triggeredBy: ownerId,
      evidenceFileIds: ["file-mine", "file-theirs"],
    });

    // Owner is blocked because the row spans other users.
    const ownerRes = await app.request(`/api/entity-review/${reviewId}`, { headers: { Cookie: ownerCookie } });
    expect(ownerRes.status).toBe(403);

    // Admin can read it.
    const adminRes = await app.request(`/api/entity-review/${reviewId}`, { headers: { Cookie: adminCookie } });
    expect(adminRes.status).toBe(200);
  });

  it("POST confirm 400 without candidateGeneratedAt", async () => {
    await seedIndexedFile(db, "file-1", "config-owner");
    const reviewId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-1"] });

    const res = await app.request(`/api/entity-review/${reviewId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST confirm 403 for non-owner", async () => {
    await seedIndexedFile(db, "file-1", "config-owner");
    const reviewId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-1"] });
    const row = await db
      .selectFrom("entity_review_queue")
      .select(["candidate_generated_at"])
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/entity-review/${reviewId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ candidateGeneratedAt: row.candidate_generated_at }),
    });
    expect(res.status).toBe(403);

    // Row unchanged.
    const after = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe("pending");
  });

  it("non-admin list hides rows whose evidence spans other users", async () => {
    await seedIndexedFile(db, "file-mine", "config-owner");
    await seedIndexedFile(db, "file-theirs", "config-other");
    // Single-owner row — should be visible.
    const okId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-mine"] });
    // Multi-owner row — should be hidden.
    await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-mine", "file-theirs"] });

    const res = await app.request("/api/entity-review", { headers: { Cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).toEqual([okId]);
  });
});
