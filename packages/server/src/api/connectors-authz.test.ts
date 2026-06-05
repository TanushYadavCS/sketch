/**
 * Authorization tests for connectors API and OAuth client config.
 *
 * Covers the matrix from CONNECTOR_AUTH_GATING.md: which (role × connector × action)
 * tuples are allowed. The defense-in-depth enumeration at the end asserts every
 * gated `/:id/*` route returns 403 for an unauthorized caller — this catches the
 * forgotten-helper-call failure mode (`if (denied) return denied;` left out).
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

const config = createTestConfig();
const logger = createTestLogger();

const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const OTHER_MEMBER_EMAIL = "other@test.com";
const PASSWORD = "testpassword123";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
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
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "member",
  });
  await users.create({
    name: "other",
    email: OTHER_MEMBER_EMAIL,
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

async function userIdFor(db: Kysely<DB>, email: string): Promise<string> {
  const u = await createUserRepository(db).findByEmail(email);
  if (!u) throw new Error(`user ${email} missing`);
  return u.id;
}

/**
 * Insert a connector_config directly via the repo.
 * For org-wide connectors (clickup, notion, linear), `createdBy` is the admin.
 * For per-user (fireflies, google_drive), pass the actual owner.
 */
async function insertConfig(
  db: Kysely<DB>,
  opts: {
    connectorType:
      | "google_drive"
      | "gmail"
      | "outlook"
      | "teams"
      | "fireflies"
      | "clickup"
      | "notion"
      | "linear"
      | "zoho_crm";
    createdBy: string;
  },
) {
  const repo = createConnectorRepository(db);
  return repo.createConfig({
    connectorType: opts.connectorType,
    authType:
      opts.connectorType === "google_drive" ||
      opts.connectorType === "gmail" ||
      opts.connectorType === "outlook" ||
      opts.connectorType === "teams" ||
      opts.connectorType === "zoho_crm"
        ? "oauth"
        : "api_key",
    credentials: JSON.stringify({ type: "api_key", api_key: "stub" }),
    createdBy: opts.createdBy,
  });
}

/** Insert an indexed_file linked to a connector for file-scoped authz tests. */
async function insertFile(db: Kysely<DB>, opts: { connectorConfigId: string; fileName?: string }): Promise<string> {
  const repo = createConnectorRepository(db);
  const result = await repo.upsertFile({
    source: "fireflies",
    providerFileId: `pf-${Math.random().toString(36).slice(2)}`,
    providerUrl: null,
    fileName: opts.fileName ?? "test-file",
    fileType: null,
    contentCategory: "document",
    content: null,
    sourcePath: null,
    contentHash: null,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    connectorConfigId: opts.connectorConfigId,
  });
  await repo.linkConnectorFile(opts.connectorConfigId, result.id);
  return result.id;
}

describe("Connectors API — authorization", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;
  let otherMemberCookie: string;
  let memberId: string;
  let otherMemberId: string;
  let adminId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, config, { logger });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
    otherMemberCookie = await login(app, OTHER_MEMBER_EMAIL);
    memberId = await userIdFor(db, MEMBER_EMAIL);
    otherMemberId = await userIdFor(db, OTHER_MEMBER_EMAIL);
    adminId = await userIdFor(db, ADMIN_EMAIL);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await db.destroy();
    } catch {}
  });

  describe("PATCH /:id/scope, POST /:id/syncs, POST /:id/enrichments — admin OR owner", () => {
    it("non-owner non-admin → 403 on PATCH /:id/scope", async () => {
      const cfg = await insertConfig(db, { connectorType: "notion", createdBy: adminId });
      const res = await app.request(`/api/connectors/${cfg.id}/scope`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ scopeConfig: {} }),
      });
      expect(res.status).toBe(403);
    });

    it("owner → 200 on PATCH /:id/scope own connector", async () => {
      const cfg = await insertConfig(db, { connectorType: "notion", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}/scope`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ scopeConfig: { foo: "bar" } }),
      });
      expect(res.status).toBe(200);
    });

    it("admin → 200 on PATCH /:id/scope any connector", async () => {
      const cfg = await insertConfig(db, { connectorType: "notion", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}/scope`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ scopeConfig: {} }),
      });
      expect(res.status).toBe(200);
    });

    it("non-owner non-admin → 403 on POST /:id/syncs", async () => {
      const cfg = await insertConfig(db, { connectorType: "notion", createdBy: adminId });
      const res = await app.request(`/api/connectors/${cfg.id}/syncs`, {
        method: "POST",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(403);
    });

    it("owner → 201 on POST /:id/syncs own connector", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}/syncs`, {
        method: "POST",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(201);
    });

    it("admin → 201 on POST /:id/syncs any connector", async () => {
      const cfg = await insertConfig(db, { connectorType: "notion", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}/syncs`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(201);
    });

    it("non-owner non-admin → 403 on POST /:id/enrichments", async () => {
      const cfg = await insertConfig(db, { connectorType: "notion", createdBy: adminId });
      const res = await app.request(`/api/connectors/${cfg.id}/enrichments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ fileIds: ["file-1"], instruction: "test" }),
      });
      expect(res.status).toBe(403);
    });

    it("owner → 201 on POST /:id/enrichments own connector", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}/enrichments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ fileIds: ["file-1"], instruction: "summarize" }),
      });
      expect(res.status).toBe(201);
    });
  });

  describe("POST /files/:fileId/enrichments — gated via owning connector", () => {
    it("non-owner non-admin → 403 (file belongs to another user's per-user connector)", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const fileId = await insertFile(db, { connectorConfigId: cfg.id });
      const res = await app.request(`/api/connectors/files/${fileId}/enrichments`, {
        method: "POST",
        headers: { Cookie: otherMemberCookie },
      });
      expect(res.status).toBe(403);
    });

    it("owner → 200 on own file", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const fileId = await insertFile(db, { connectorConfigId: cfg.id });
      const res = await app.request(`/api/connectors/files/${fileId}/enrichments`, {
        method: "POST",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(200);
    });

    it("unknown fileId → 404", async () => {
      const res = await app.request("/api/connectors/files/does-not-exist/enrichments", {
        method: "POST",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id — admin OR owner", () => {
    it("non-owner non-admin → 403", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}`, {
        method: "DELETE",
        headers: { Cookie: otherMemberCookie },
      });
      expect(res.status).toBe(403);
    });

    it("owner → 200", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}`, {
        method: "DELETE",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(200);
    });

    it("admin → 200 on member's per-user row (offboarding)", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /:id/rotate-key — owner only (no admin override)", () => {
    it("admin → 403 on a member's per-user row (no key to rotate to)", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}/rotate-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ api_key: "new-key" }),
      });
      expect(res.status).toBe(403);
    });

    it("non-owner non-admin → 403", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}/rotate-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: otherMemberCookie },
        body: JSON.stringify({ api_key: "new-key" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("POST / — branch on perUserAuth", () => {
    it("member → 403 creating an org-wide (notion) connector", async () => {
      const res = await app.request("/api/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          connectorType: "notion",
          authType: "api_key",
          credentials: { api_key: "stub" },
        }),
      });
      expect(res.status).toBe(403);
    });

    it("duplicate per-user (Fireflies same user twice) → 409", async () => {
      // Pre-insert a fireflies row for member directly via repo (skipping outbound API calls).
      await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request("/api/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          connectorType: "fireflies",
          authType: "api_key",
          credentials: { api_key: "another-key" },
        }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe("Cross-user reads on per-user rows → 403", () => {
    it("member can't GET /:id of another member's per-user row", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}`, {
        headers: { Cookie: otherMemberCookie },
      });
      expect(res.status).toBe(403);
    });

    it("member can't GET /:id/files of another user's per-user row", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}/files`, {
        headers: { Cookie: otherMemberCookie },
      });
      expect(res.status).toBe(403);
    });

    it("member can't GET /:id/entity-count of another user's per-user row", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}/entity-count`, {
        headers: { Cookie: otherMemberCookie },
      });
      expect(res.status).toBe(403);
    });

    it("admin → 200 on member's per-user row", async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const res = await app.request(`/api/connectors/${cfg.id}`, {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(200);
    });

    it("any member → 200 on org-wide row", async () => {
      const cfg = await insertConfig(db, { connectorType: "notion", createdBy: adminId });
      const res = await app.request(`/api/connectors/${cfg.id}`, {
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(200);
    });

    it("member → 200 on org-wide row's /:id/files", async () => {
      const cfg = await insertConfig(db, { connectorType: "notion", createdBy: adminId });
      const res = await app.request(`/api/connectors/${cfg.id}/files`, {
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(200);
    });
  });

  /*
   * Per-connector browse-by-id routes for org-wide types (notion, clickup) can't
   * return 403 via denyIfCannotRead — org-wide rows are visible to all by design.
   * Their authz gating is exercised by the enumeration block below, which hits the
   * Drive routes (per-user) and the generic /:id/browse + /:id/browse-children
   * routes.
   */

  describe("GET / — list visibility", () => {
    it("member sees org-wide rows + own per-user rows but not others'", async () => {
      const orgCfg = await insertConfig(db, { connectorType: "notion", createdBy: adminId });
      const ownCfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const otherCfg = await insertConfig(db, { connectorType: "fireflies", createdBy: otherMemberId });

      const res = await app.request("/api/connectors", { headers: { Cookie: memberCookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.connectors.map((c: { id: string }) => c.id);
      expect(ids).toContain(orgCfg.id);
      expect(ids).toContain(ownCfg.id);
      expect(ids).not.toContain(otherCfg.id);
    });

    it("admin sees all rows", async () => {
      const orgCfg = await insertConfig(db, { connectorType: "notion", createdBy: adminId });
      const memberCfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const otherCfg = await insertConfig(db, { connectorType: "fireflies", createdBy: otherMemberId });

      const res = await app.request("/api/connectors", { headers: { Cookie: adminCookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.connectors.map((c: { id: string }) => c.id);
      expect(ids).toContain(orgCfg.id);
      expect(ids).toContain(memberCfg.id);
      expect(ids).toContain(otherCfg.id);
    });

    it("each row carries perUserAuth + requiresOAuthClientSetup", async () => {
      await insertConfig(db, { connectorType: "google_drive", createdBy: adminId });
      await insertConfig(db, { connectorType: "teams", createdBy: memberId });
      const res = await app.request("/api/connectors", { headers: { Cookie: adminCookie } });
      const body = await res.json();
      const drive = body.connectors.find((c: { connectorType: string }) => c.connectorType === "google_drive");
      const teams = body.connectors.find((c: { connectorType: string }) => c.connectorType === "teams");
      expect(drive.perUserAuth).toBe(true);
      expect(drive.requiresOAuthClientSetup).toBe(true);
      expect(teams.perUserAuth).toBe(true);
      expect(teams.requiresOAuthClientSetup).toBe(true);
    });
  });

  describe("OAuth /api/oauth/google/config — admin only", () => {
    it("member PUT /api/oauth/google/config → 403", async () => {
      const res = await app.request("/api/oauth/google/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ clientId: "cid", clientSecret: "csec" }),
      });
      expect(res.status).toBe(403);
    });

    it("admin PUT /api/oauth/google/config → 200", async () => {
      const res = await app.request("/api/oauth/google/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ clientId: "cid", clientSecret: "csec" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("OAuth /api/oauth/microsoft/config — admin only", () => {
    it("member PUT /api/oauth/microsoft/config → 403", async () => {
      const res = await app.request("/api/oauth/microsoft/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ clientId: "cid", clientSecret: "csec", tenant: "tenant-id" }),
      });
      expect(res.status).toBe(403);
    });

    it("admin PUT /api/oauth/microsoft/config → 200", async () => {
      const res = await app.request("/api/oauth/microsoft/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ clientId: "cid", clientSecret: "csec", tenant: "tenant-id" }),
      });
      expect(res.status).toBe(200);

      const status = await app.request("/api/oauth/microsoft/status", { headers: { Cookie: adminCookie } });
      const body = await status.json();
      expect(body.configured).toBe(true);
      expect(body.clientId).toBe("cid");
      expect(body.tenant).toBe("tenant-id");
    });

    it("admin PUT /api/oauth/microsoft/config requires tenant", async () => {
      const res = await app.request("/api/oauth/microsoft/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ clientId: "cid", clientSecret: "csec" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("tenant is required");
    });
  });

  describe("OAuth /api/oauth/google/authorize — 412 when client not configured", () => {
    it("member starts OAuth before admin configured client → 412 OAUTH_CLIENT_NOT_CONFIGURED", async () => {
      const res = await app.request("/api/oauth/google/authorize", {
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(412);
      const body = await res.json();
      expect(body.error.code).toBe("OAUTH_CLIENT_NOT_CONFIGURED");
      expect(body.error.connector).toBe("google_drive");
    });

    it("after admin configures client → 302 redirect to Google", async () => {
      const settings = createSettingsRepository(db);
      await settings.update({ googleOauthClientId: "cid", googleOauthClientSecret: "csec" });

      const res = await app.request("/api/oauth/google/authorize", {
        headers: { Cookie: memberCookie },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("accounts.google.com");
    });

    it("Gmail OAuth uses the same Google client config with Gmail scope", async () => {
      const settings = createSettingsRepository(db);
      await settings.update({ googleOauthClientId: "cid", googleOauthClientSecret: "csec" });

      const res = await app.request("/api/oauth/google/authorize?connector=gmail", {
        headers: { Cookie: memberCookie },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("accounts.google.com");
      expect(decodeURIComponent(location)).toContain("https://www.googleapis.com/auth/gmail.readonly");
      expect(decodeURIComponent(location)).not.toContain("https://www.googleapis.com/auth/drive.readonly");
    });
  });

  describe("OAuth /api/oauth/microsoft/authorize — connector-aware scopes", () => {
    it("member starts Microsoft OAuth before admin configured client → 412 OAUTH_CLIENT_NOT_CONFIGURED", async () => {
      const res = await app.request("/api/oauth/microsoft/authorize?connector=teams", {
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(412);
      const body = await res.json();
      expect(body.error.code).toBe("OAUTH_CLIENT_NOT_CONFIGURED");
      expect(body.error.connector).toBe("teams");
    });

    it("Microsoft OAuth callback accepts provider redirects without an active session", async () => {
      const res = await app.request("/api/oauth/microsoft/callback", { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/files?oauth=error&connector=outlook&reason=missing_params");
    });

    it("Teams OAuth uses saved Microsoft client settings, Teams scopes, and connector-aware state", async () => {
      const settings = createSettingsRepository(db);
      await settings.update({
        microsoftOauthClientId: "cid",
        microsoftOauthClientSecret: "csec",
        microsoftOauthTenant: "tenant-id",
      });

      const res = await app.request("/api/oauth/microsoft/authorize?connector=teams", {
        headers: { Cookie: memberCookie },
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      const location = decodeURIComponent(res.headers.get("location") ?? "");
      expect(location).toContain("login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize");
      expect(location).toContain("OnlineMeetingTranscript.Read.All");
      expect(location).toContain("OnlineMeetingRecording.Read.All");
      expect(location).toContain("Calendars.Read");
      expect(location).toContain(`${memberId}:teams:`);
      expect(location).not.toContain("Mail.Read");
    });
  });

  describe("OAuth /api/oauth/zoho — experimental admin-only flow", () => {
    it("is hidden when EXPERIMENTAL_FLAG is false", async () => {
      const res = await app.request("/api/oauth/zoho/status", {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(404);
    });

    it("hides existing Zoho configs and files when EXPERIMENTAL_FLAG is false", async () => {
      const cfg = await insertConfig(db, { connectorType: "zoho_crm", createdBy: adminId });
      await createConnectorRepository(db).upsertFile({
        source: "zoho_crm",
        providerFileId: "Accounts:a1",
        providerUrl: null,
        fileName: "Acme Corp",
        fileType: "crm_account",
        contentCategory: "structured",
        content: null,
        sourcePath: null,
        contentHash: "account-hash",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        connectorConfigId: cfg.id,
        rollupGroupId: "Accounts:a1",
      });

      const list = await app.request("/api/connectors", { headers: { Cookie: adminCookie } });
      expect(await list.json()).toMatchObject({ connectors: [] });

      const files = await app.request("/api/connectors/all-files", { headers: { Cookie: adminCookie } });
      expect(await files.json()).toMatchObject({ files: [], total: 0, enrichedTotal: 0 });

      const bySource = await app.request("/api/connectors/file-counts-by-source", {
        headers: { Cookie: adminCookie },
      });
      expect(await bySource.json()).toMatchObject({ counts: [] });

      const read = await app.request(`/api/connectors/${cfg.id}`, { headers: { Cookie: adminCookie } });
      expect(read.status).toBe(404);

      const sync = await app.request(`/api/connectors/${cfg.id}/syncs`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      expect(sync.status).toBe(404);
    });

    it("member cannot start Zoho OAuth when experimental features are enabled", async () => {
      const flaggedApp = createApp(
        db,
        createTestConfig({ EXPERIMENTAL_FLAG: true, ZOHO_CLIENT_ID: "zid", ZOHO_CLIENT_SECRET: "zsec" }),
        { logger },
      );

      const res = await flaggedApp.request("/api/oauth/zoho/authorize?region=in", {
        headers: { Cookie: memberCookie },
      });

      expect(res.status).toBe(403);
    });

    it("admin authorize ignores query-string user_id and redirects to the selected Zoho region", async () => {
      const flaggedApp = createApp(
        db,
        createTestConfig({ EXPERIMENTAL_FLAG: true, ZOHO_CLIENT_ID: "zid", ZOHO_CLIENT_SECRET: "zsec" }),
        { logger },
      );

      const res = await flaggedApp.request("/api/oauth/zoho/authorize?region=in&user_id=attacker", {
        headers: { Cookie: adminCookie },
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toContain("https://accounts.zoho.in/oauth/v2/auth");
      const state = new URL(location ?? "").searchParams.get("state");
      expect(state?.startsWith(`${adminId}:`)).toBe(true);
      expect(state).not.toContain("attacker");
    });

    it("authorize is blocked with 409 when Zoho CRM is already connected", async () => {
      const flaggedApp = createApp(
        db,
        createTestConfig({ EXPERIMENTAL_FLAG: true, ZOHO_CLIENT_ID: "zid", ZOHO_CLIENT_SECRET: "zsec" }),
        { logger },
      );

      await createConnectorRepository(db).createConfig({
        connectorType: "zoho_crm",
        authType: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          access_token: "a",
          refresh_token: "r",
          client_id: "c",
          client_secret: "s",
        }),
        createdBy: adminId,
      });

      const res = await flaggedApp.request("/api/oauth/zoho/authorize?region=in", {
        headers: { Cookie: adminCookie },
        redirect: "manual",
      });

      expect(res.status).toBe(409);
    });

    it("callback exchanges tokens and stores a Zoho connector config", async () => {
      const flaggedApp = createApp(
        db,
        createTestConfig({ EXPERIMENTAL_FLAG: true, ZOHO_CLIENT_ID: "zid", ZOHO_CLIENT_SECRET: "zsec" }),
        { logger },
      );

      const authorize = await flaggedApp.request("/api/oauth/zoho/authorize?region=in", {
        headers: { Cookie: adminCookie },
        redirect: "manual",
      });
      const state = new URL(authorize.headers.get("location") ?? "").searchParams.get("state");
      expect(state).toBeTruthy();

      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            api_domain: "https://www.zohoapis.in",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ users: [{ id: "zu-1", email: "admin@zoho.test" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const callback = await flaggedApp.request(
        `/api/oauth/zoho/callback?code=grant-code&state=${encodeURIComponent(state ?? "")}&accounts-server=${encodeURIComponent("https://accounts.zoho.in")}`,
        { redirect: "manual" },
      );

      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain("/files?oauth=success&connector=zoho_crm");

      const configs = await createConnectorRepository(db).findConfigsByType("zoho_crm");
      expect(configs).toHaveLength(1);
      expect(configs[0]?.created_by).toBe(adminId);
      expect(configs[0]?.credential_hint).toBe("admin@zoho.test");
      const credentials = JSON.parse(configs[0]?.credentials ?? "{}") as {
        refresh_token?: string;
        region?: string;
        api_domain?: string;
        accounts_server?: string;
      };
      expect(credentials).toMatchObject({
        refresh_token: "refresh-token",
        region: "in",
        api_domain: "https://www.zohoapis.in",
        accounts_server: "https://accounts.zoho.in",
      });
    });
  });

  describe("GET /files/:fileId/content — admin content bypass setting", () => {
    /**
     * Insert a file restricted to a scope that does NOT include the admin's email,
     * so the admin would normally be denied content access. Returns the file id.
     */
    async function insertRestrictedFile(): Promise<string> {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      await db
        .insertInto("access_scopes")
        .values({
          id: "scope-restricted",
          connector_config_id: cfg.id,
          scope_type: "drive",
          provider_scope_id: "drive-r",
        })
        .execute();
      await db
        .insertInto("access_scope_members")
        .values({ access_scope_id: "scope-restricted", email: OTHER_MEMBER_EMAIL })
        .execute();
      const repo = createConnectorRepository(db);
      const result = await repo.upsertFile({
        source: "fireflies",
        providerFileId: `pf-restricted-${Math.random().toString(36).slice(2)}`,
        providerUrl: null,
        fileName: "restricted.txt",
        fileType: "text/plain",
        contentCategory: "document",
        content: "secret payload",
        sourcePath: null,
        contentHash: null,
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        connectorConfigId: cfg.id,
      });
      await repo.linkConnectorFile(cfg.id, result.id);
      await db
        .updateTable("indexed_files")
        .set({ access_scope_id: "scope-restricted" })
        .where("id", "=", result.id)
        .execute();
      return result.id;
    }

    it("admin → 403 when admin_can_read_all_files=0 (default)", async () => {
      const fileId = await insertRestrictedFile();
      const res = await app.request(`/api/connectors/files/${fileId}/content`, {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(403);
    });

    it("admin → 200 with content when admin_can_read_all_files=1", async () => {
      const fileId = await insertRestrictedFile();
      await createSettingsRepository(db).update({ adminCanReadAllFiles: true });

      const res = await app.request(`/api/connectors/files/${fileId}/content`, {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.file?.content).toBe("secret payload");
    });

    it("member without access → 403 even when admin_can_read_all_files=1", async () => {
      const fileId = await insertRestrictedFile();
      await createSettingsRepository(db).update({ adminCanReadAllFiles: true });

      const res = await app.request(`/api/connectors/files/${fileId}/content`, {
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("file shares — POST / PUT share-everyone authz", () => {
    async function insertSharableFile(): Promise<string> {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      const repo = createConnectorRepository(db);
      const result = await repo.upsertFile({
        source: "fireflies",
        providerFileId: `pf-share-${Math.random().toString(36).slice(2)}`,
        providerUrl: null,
        fileName: "sharable.txt",
        fileType: "text/plain",
        contentCategory: "document",
        content: null,
        sourcePath: null,
        contentHash: null,
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        connectorConfigId: cfg.id,
      });
      await repo.linkConnectorFile(cfg.id, result.id);
      return result.id;
    }

    it("only admin or connector owner can POST a share; share-everyone is admin-only", async () => {
      const fileId = await insertSharableFile();

      // memberCookie is the connector owner → 200; otherMemberCookie is not → 403.
      const ownerRes = await app.request(`/api/connectors/files/${fileId}/shares`, {
        method: "POST",
        headers: { Cookie: memberCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com" }),
      });
      expect(ownerRes.status).toBe(200);

      const strangerRes = await app.request(`/api/connectors/files/${fileId}/shares`, {
        method: "POST",
        headers: { Cookie: otherMemberCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com" }),
      });
      expect(strangerRes.status).toBe(403);

      // Admin can also share.
      const adminRes = await app.request(`/api/connectors/files/${fileId}/shares`, {
        method: "POST",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "carol@example.com" }),
      });
      expect(adminRes.status).toBe(200);

      // share-everyone is admin-only: the connector owner (member) is denied.
      const ownerEveryone = await app.request(`/api/connectors/files/${fileId}/share-everyone`, {
        method: "PUT",
        headers: { Cookie: memberCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(ownerEveryone.status).toBe(403);

      const adminEveryone = await app.request(`/api/connectors/files/${fileId}/share-everyone`, {
        method: "PUT",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(adminEveryone.status).toBe(200);
    });
  });

  /**
   * Defense-in-depth: enumerate every gated `/:id/*` route and assert each returns 403
   * for an unauthorized caller. This catches the failure mode where a future route
   * author forgets `if (denied) return denied;` — the helper would return a Response
   * but it'd never reach the client.
   */
  describe("enumeration regression — all gated /:id/* routes 403 for unauthorized member", () => {
    let cfgId: string;
    beforeEach(async () => {
      const cfg = await insertConfig(db, { connectorType: "fireflies", createdBy: memberId });
      cfgId = cfg.id;
    });

    // Reads: deny → 403. Each entry uses the per-user fireflies row from beforeEach,
    // except the per-connector browse-by-id routes which are gated against a
    // matching per-user row of that type.
    const reads = [
      ["GET", "/api/connectors/{id}", "fireflies"],
      ["GET", "/api/connectors/{id}/files", "fireflies"],
      ["GET", "/api/connectors/{id}/entity-count", "fireflies"],
      ["GET", "/api/connectors/{id}/browse", "fireflies"],
      ["GET", "/api/connectors/{id}/browse-children/x", "google_drive"],
      ["GET", "/api/connectors/google-drive/browse/{id}", "google_drive"],
      ["GET", "/api/connectors/google-drive/browse/{id}/folder/x", "google_drive"],
    ] as const;

    const writes = [
      ["DELETE", "/api/connectors/{id}", "fireflies", undefined],
      ["POST", "/api/connectors/{id}/syncs", "fireflies", undefined],
      ["PATCH", "/api/connectors/{id}/scope", "fireflies", JSON.stringify({ scopeConfig: {} })],
      ["POST", "/api/connectors/{id}/enrichments", "fireflies", JSON.stringify({ fileIds: ["x"], instruction: "y" })],
      ["POST", "/api/connectors/{id}/rotate-key", "fireflies", JSON.stringify({ api_key: "new-key" })],
    ] as const;

    /**
     * Resolve a fixture row matching the route's expected connector_type. Routes
     * that hardcode a type (e.g. `/google-drive/browse/:id`) 400 if given the wrong
     * type before authz runs, so we need a row of the matching type.
     */
    async function rowFor(connectorType: "fireflies" | "google_drive"): Promise<string> {
      if (connectorType === "fireflies") return cfgId;
      const cfg = await insertConfig(db, { connectorType, createdBy: memberId });
      return cfg.id;
    }

    for (const [method, path, type] of reads) {
      it(`${method} ${path} as non-owner non-admin → 403`, async () => {
        const id = await rowFor(type);
        const url = path.replace("{id}", id);
        const res = await app.request(url, { method, headers: { Cookie: otherMemberCookie } });
        expect(res.status).toBe(403);
      });
    }

    for (const [method, path, type, body] of writes) {
      it(`${method} ${path} as non-owner non-admin → 403`, async () => {
        const id = await rowFor(type);
        const url = path.replace("{id}", id);
        const init: RequestInit = {
          method,
          headers: { "Content-Type": "application/json", Cookie: otherMemberCookie },
          body,
        };
        const res = await app.request(url, init);
        expect(res.status).toBe(403);
      });
    }
  });
});
