/**
 * PR-2a coverage for the connector hierarchy mapping: the PATCH /:id/scope merge
 * (a partial scope update must preserve sibling keys it does not touch) and the
 * flag-gated exposure of a connector's declared `hierarchyLevels` on the GET routes.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const logger = createTestLogger();
const ADMIN_EMAIL = "admin@test.com";
const PASSWORD = "testpassword123";

async function seedAdmin(db: Kysely<DB>): Promise<string> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  const hash = await hashPassword(PASSWORD);
  const admin = await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  return admin.id;
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function insertClickUp(db: Kysely<DB>, createdBy: string): Promise<string> {
  const cfg = await createConnectorRepository(db).createConfig({
    connectorType: "clickup",
    authType: "api_key",
    credentials: JSON.stringify({ type: "api_key", api_key: "stub" }),
    createdBy,
  });
  return cfg.id;
}

describe("Connectors API — hierarchy mapping scope", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    // Keep the background re-sync triggered by PATCH /scope offline.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await db.destroy();
    } catch {}
  });

  it("merges scope_config so a partial update preserves sibling keys", async () => {
    const app = createApp(db, createTestConfig(), { logger });
    const adminId = await seedAdmin(db);
    const cookie = await login(app);
    const id = await insertClickUp(db, adminId);

    await app.request(`/api/connectors/${id}/scope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ scopeConfig: { workspaces: ["ws-1"] } }),
    });
    await app.request(`/api/connectors/${id}/scope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ scopeConfig: { hierarchyMapping: { space: "team", folder: "project" } } }),
    });

    const stored = JSON.parse((await createConnectorRepository(db).findConfigById(id))?.scope_config ?? "{}");
    expect(stored.workspaces).toEqual(["ws-1"]);
    expect(stored.hierarchyMapping).toEqual({ space: "team", folder: "project" });
  });

  it("exposes hierarchyLevels on GET only when EXPERIMENTAL_FLAG is on", async () => {
    const adminId = await seedAdmin(db);

    const onApp = createApp(db, { ...createTestConfig(), EXPERIMENTAL_FLAG: true }, { logger });
    const onCookie = await login(onApp);
    const id = await insertClickUp(db, adminId);
    const onRes = await onApp.request(`/api/connectors/${id}`, { headers: { Cookie: onCookie } });
    const onBody = await onRes.json();
    expect(Array.isArray(onBody.connector.hierarchyLevels)).toBe(true);
    expect(onBody.connector.hierarchyLevels.map((l: { key: string }) => l.key)).toEqual([
      "workspace",
      "space",
      "folder",
      "list",
    ]);

    const offApp = createApp(db, { ...createTestConfig(), EXPERIMENTAL_FLAG: false }, { logger });
    const offCookie = await login(offApp);
    const offRes = await offApp.request(`/api/connectors/${id}`, { headers: { Cookie: offCookie } });
    const offBody = await offRes.json();
    expect(offBody.connector.hierarchyLevels).toBeUndefined();
  });
});
