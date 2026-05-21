import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const config = createTestConfig();
const logger = createTestLogger();

const ADMIN_EMAIL = "admin@test.com";
const PASSWORD = "testpassword123";

async function seedAdmin(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("POST /api/entities/reset", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
    app = createApp(db, config, { logger });
    adminCookie = await login(app);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("clears ECR state for connector resets even when no entities match", async () => {
    const now = new Date().toISOString();
    const admin = await createUserRepository(db).findByEmail(ADMIN_EMAIL);
    if (!admin) throw new Error("admin user missing");

    await db
      .insertInto("connector_configs")
      .values({
        id: "cfg",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: admin.id,
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "file-1",
        connector_config_id: "cfg",
        provider_file_id: "provider-file-1",
        file_name: "File",
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content_hash: "hash",
        is_archived: 0,
        synced_at: now,
      })
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: "manual-entity",
        name: "Manual Person",
        source_type: "person",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("entity_candidates")
      .values({
        id: "candidate-1",
        name: "Candidate",
        type: "person",
        variations: "[]",
        first_seen_file_id: "file-1",
        seen_file_ids: JSON.stringify(["file-1"]),
        seen_count: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: "review-1",
        proposed_name: "Candidate",
        normalized_name: "candidate",
        entity_type: "person",
        triggered_by_user_id: admin.id,
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({ id: "evidence-1", review_id: "review-1", indexed_file_id: "file-1", source: "google_drive" })
      .execute();
    await db
      .insertInto("entity_alias_rejections")
      .values({
        id: "rejection-1",
        entity_id: "manual-entity",
        rejected_name: "Candidate",
        normalized_rejected_name: "candidate",
        rejected_by: admin.id,
      })
      .execute();

    const res = await app.request("/api/entities/reset", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ categories: ["connectors"] }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      entitiesDeleted: 0,
      candidatesCleared: 1,
      reviewQueueCleared: 1,
      reviewEvidenceCleared: 1,
      rejectionsCleared: 1,
    });
    await expect(db.selectFrom("entities").select("id").execute()).resolves.toEqual([{ id: "manual-entity" }]);
    await expect(db.selectFrom("entity_candidates").select("id").execute()).resolves.toEqual([]);
    await expect(db.selectFrom("entity_review_queue").select("id").execute()).resolves.toEqual([]);
    await expect(db.selectFrom("entity_review_evidence").select("id").execute()).resolves.toEqual([]);
    await expect(db.selectFrom("entity_alias_rejections").select("id").execute()).resolves.toEqual([]);
  });
});
