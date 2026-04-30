/**
 * RBAC tests for GET /api/entities/:id/mentions.
 *
 * Mirrors the file-visibility predicate model: admin sees all mentions; a member
 * sees only mentions that point to files they can access (unrestricted /
 * scope-member / per-file share). The hidden-count footer is computed as
 * unfiltered_total - filtered_total and exposed to the frontend so users see
 * "+N mentions in files you don't have access to".
 */
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
const ALICE_EMAIL = "alice@test.com";
const STRANGER_EMAIL = "stranger@test.com";
const PASSWORD = "testpassword123";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);
  await settings.create();
  for (const [name, email, role] of [
    ["admin", ADMIN_EMAIL, "admin"],
    ["alice", ALICE_EMAIL, "member"],
    ["stranger", STRANGER_EMAIL, "member"],
  ] as const) {
    await users.create({ name, email, emailVerified: true, passwordHash: hash, authRole: role });
  }
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

describe("GET /api/entities/:id/mentions — RBAC", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let aliceCookie: string;
  let strangerCookie: string;
  const entityId = "ent-1";

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, config, { logger });
    adminCookie = await login(app, ADMIN_EMAIL);
    aliceCookie = await login(app, ALICE_EMAIL);
    strangerCookie = await login(app, STRANGER_EMAIL);

    const adminUser = await createUserRepository(db).findByEmail(ADMIN_EMAIL);
    if (!adminUser) throw new Error("admin user missing");
    const adminId = adminUser.id;

    await db
      .insertInto("connector_configs")
      .values({
        id: "cfg",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: adminId,
      })
      .execute();
    await db
      .insertInto("access_scopes")
      .values({ id: "scope-a", connector_config_id: "cfg", scope_type: "drive", provider_scope_id: "drive-a" })
      .execute();
    await db.insertInto("access_scope_members").values({ access_scope_id: "scope-a", email: ALICE_EMAIL }).execute();

    const baseFile = {
      connector_config_id: "cfg",
      file_name: "f",
      file_type: "doc",
      content_category: "document" as const,
      source: "google_drive",
      content_hash: "h",
      is_archived: 0 as const,
      synced_at: new Date().toISOString(),
    };
    await db
      .insertInto("indexed_files")
      .values([
        { id: "f-unrestricted", ...baseFile, provider_file_id: "p1" },
        { id: "f-scope-a", ...baseFile, provider_file_id: "p2", access_scope_id: "scope-a" },
        { id: "f-scope-other", ...baseFile, provider_file_id: "p3", access_scope_id: "scope-a" },
      ])
      .execute();
    // f-scope-other is in scope-a but no member rows beyond alice; we want a file
    // alice cannot reach, so use a separate scope-only-bob.
    await db
      .insertInto("access_scopes")
      .values({ id: "scope-b", connector_config_id: "cfg", scope_type: "drive", provider_scope_id: "drive-b" })
      .execute();
    await db
      .updateTable("indexed_files")
      .set({ access_scope_id: "scope-b" })
      .where("id", "=", "f-scope-other")
      .execute();

    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id: entityId,
        name: "Beetu",
        source_type: "person",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const baseMention = {
      entity_id: entityId,
      context_snippet: "snippet",
      chunk_index: 0,
      mentioned_at: new Date().toISOString(),
    };
    await db
      .insertInto("entity_mentions")
      .values([
        { id: "m-unrestricted", ...baseMention, indexed_file_id: "f-unrestricted" },
        { id: "m-scope-a", ...baseMention, indexed_file_id: "f-scope-a" },
        { id: "m-scope-other", ...baseMention, indexed_file_id: "f-scope-other" },
      ])
      .execute();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("admin sees every mention, hiddenCount=0", async () => {
    const res = await app.request(`/api/entities/${entityId}/mentions`, {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mentions: { id: string }[]; total: number; hiddenCount: number };
    expect(body.mentions.map((m) => m.id).sort()).toEqual(["m-scope-a", "m-scope-other", "m-unrestricted"]);
    expect(body.total).toBe(3);
    expect(body.hiddenCount).toBe(0);
  });

  it("alice sees unrestricted + scope-a only, hiddenCount counts scope-other", async () => {
    const res = await app.request(`/api/entities/${entityId}/mentions`, {
      headers: { Cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mentions: { id: string }[]; total: number; hiddenCount: number };
    expect(body.mentions.map((m) => m.id).sort()).toEqual(["m-scope-a", "m-unrestricted"]);
    expect(body.total).toBe(2);
    expect(body.hiddenCount).toBe(1);
  });

  it("stranger sees only the unrestricted mention, hiddenCount counts both scoped", async () => {
    const res = await app.request(`/api/entities/${entityId}/mentions`, {
      headers: { Cookie: strangerCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mentions: { id: string }[]; total: number; hiddenCount: number };
    expect(body.mentions.map((m) => m.id)).toEqual(["m-unrestricted"]);
    expect(body.total).toBe(1);
    expect(body.hiddenCount).toBe(2);
  });
});
