/**
 * API route tests for mcp-servers endpoints.
 * Tests all 9 endpoints: CRUD (admin-only), connection testing, and
 * integration sub-resources (apps, connections) which require member role.
 *
 * Uses in-memory SQLite via createTestDb(), seeds admin for auth,
 * and mocks the provider factory + MCP SDK to avoid real network calls.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createMcpServerRepository } from "../db/repositories/mcp-servers";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { CanvasProviderRequestError } from "../integrations/canvas";
import { createTestConfig, createTestDb } from "../test-utils";

vi.mock("../integrations/factory", () => ({
  createProvider: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = vi.fn().mockResolvedValue(undefined);
    listTools = vi.fn().mockResolvedValue({ tools: [{ name: "tool1" }] });
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSETransport {},
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableTransport {},
}));

const config = createTestConfig();

async function seedAdmin(db: Kysely<DB>, email = "admin@test.com", password = "testpassword123") {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();
  await settings.create();
  await users.create({
    name: normalizedEmail.split("@")[0],
    email: normalizedEmail,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function loginAdmin(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function getJwtSecret(db: Kysely<DB>): Promise<string> {
  const settings = createSettingsRepository(db);
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("JWT secret not found in test DB");
  return row.jwt_secret;
}

async function getMemberCookie(db: Kysely<DB>): Promise<string> {
  const users = createUserRepository(db);
  const user = await users.create({ name: "Test Member" });
  await users.update(user.id, { email: "member@test.com" });
  const secret = await getJwtSecret(db);
  const token = await signJwt(user.id, "member", secret);
  return `sketch_session=${token}`;
}

async function getMemberCookieNoEmail(db: Kysely<DB>): Promise<string> {
  const users = createUserRepository(db);
  const user = await users.create({ name: "No Email Member" });
  const secret = await getJwtSecret(db);
  const token = await signJwt(user.id, "member", secret);
  return `sketch_session=${token}`;
}

const validServerBody = {
  displayName: "My Canvas",
  url: "https://canvas.example.com/mcp",
  apiUrl: "https://canvas.example.com",
  credentials: { apiKey: "sk-test-123" },
  type: "canvas",
};

const plainMcpBody = {
  displayName: "Plain MCP",
  url: "https://mcp.example.com",
  credentials: { bearerToken: "tok-abc" },
};

async function createCanvasProviderServer(db: Kysely<DB>) {
  const repo = createMcpServerRepository(db);
  return repo.create({
    type: "canvas",
    displayName: "Canvas",
    url: "https://canvas.example.com/mcp",
    apiUrl: "https://canvas.example.com",
    credentials: JSON.stringify({ apiKey: "sk-test" }),
  });
}

describe("MCP Servers API", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // Already destroyed
    }
  });

  // --- GET /api/mcp-servers ---

  describe("GET /api/mcp-servers", () => {
    it("returns empty list initially", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.servers).toEqual([]);
    });

    it("returns servers with masked credentials", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      await repo.create({
        type: "canvas",
        displayName: "My Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test-secret-key-12345" }),
      });

      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.servers).toHaveLength(1);
      expect(body.servers[0].displayName).toBe("My Canvas");
      expect(body.servers[0].credentials.apiKey).toBe("sk-t****2345");
    });
  });

  // --- POST /api/mcp-servers ---

  describe("POST /api/mcp-servers", () => {
    it("creates an integration provider server", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(validServerBody),
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.server.displayName).toBe("My Canvas");
      expect(body.server.type).toBe("canvas");
      expect(body.server.slug).toBe("my-canvas");
    });

    it("creates a plain MCP server", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(plainMcpBody),
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.server.type).toBeNull();
      expect(body.server.slug).toBe("plain-mcp");
    });

    it("returns 400 for invalid input (missing displayName)", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ url: "https://example.com", credentials: {} }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 409 when an integration provider already exists", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      await app.request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(validServerBody),
      });

      const res = await app.request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ ...validServerBody, displayName: "Second Canvas" }),
      });
      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toContain("integration provider already exists");
    });

    it("returns 400 for integration provider with invalid credentials", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ ...validServerBody, credentials: { notAnApiKey: "value" } }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Invalid credentials");
    });
  });

  // --- PATCH /api/mcp-servers/:id ---

  describe("PATCH /api/mcp-servers/:id", () => {
    it("updates server fields", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        displayName: "Original",
        url: "https://old.com/mcp",
        credentials: JSON.stringify({ bearerToken: "tok" }),
      });

      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request(`/api/mcp-servers/${server.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ displayName: "Updated", url: "https://new.com/mcp" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.server.displayName).toBe("Updated");
      expect(body.server.url).toBe("https://new.com/mcp");
    });

    it("returns 404 for missing server", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers/nonexistent-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ displayName: "Updated" }),
      });
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  // --- DELETE /api/mcp-servers/:id ---

  describe("DELETE /api/mcp-servers/:id", () => {
    it("removes a server", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        displayName: "To Delete",
        url: "https://delete.com/mcp",
        credentials: JSON.stringify({}),
      });

      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request(`/api/mcp-servers/${server.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);

      const after = await repo.getById(server.id);
      expect(after).toBeNull();
    });

    it("returns 404 for missing server", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers/nonexistent-id", {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(404);
    });
  });

  // --- POST /api/mcp-servers/connection-tests ---

  describe("POST /api/mcp-servers/connection-tests", () => {
    it("validates input and returns 400 for missing fields", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers/connection-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns ok status on successful MCP connection test", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers/connection-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          url: "https://mcp.example.com",
          credentials: JSON.stringify({ apiKey: "test-key" }),
        }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.toolCount).toBe(1);
    });
  });

  // --- POST /api/mcp-servers/:id/connection-tests ---

  describe("POST /api/mcp-servers/:id/connection-tests", () => {
    it("returns 404 for unknown server", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers/unknown-id/connection-tests", {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(404);
    });

    it("tests connection using stored credentials", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        displayName: "Test Server",
        url: "https://mcp.example.com",
        credentials: JSON.stringify({ apiKey: "real-key" }),
      });

      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request(`/api/mcp-servers/${server.id}/connection-tests`, {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.toolCount).toBe(1);
    });
  });

  // --- GET /api/mcp-servers/:id/health ---

  describe("GET /api/mcp-servers/:id/health", () => {
    it("returns absent for unknown id", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers/missing-id/health", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "absent" });
    });

    it("returns not_provider for plain MCP rows (type is null)", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        displayName: "Plain",
        url: "https://plain.com/mcp",
        credentials: JSON.stringify({}),
      });

      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request(`/api/mcp-servers/${server.id}/health`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "not_provider" });
    });

    it("returns ok when the provider factory succeeds", async () => {
      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue({
        type: "canvas",
      } as never);

      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-real" }),
        type: "canvas",
      });

      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request(`/api/mcp-servers/${server.id}/health`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "ok", type: "canvas" });
    });

    it("returns load_failed with the error message when the factory throws", async () => {
      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockImplementation(() => {
        throw new Error("apiKey: Required");
      });

      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({}),
        type: "canvas",
      });

      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request(`/api/mcp-servers/${server.id}/health`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "load_failed", type: "canvas", reason: "apiKey: Required" });
    });
  });

  // --- GET /api/mcp-servers/:id/apps ---

  describe("GET /api/mcp-servers/:id/apps", () => {
    it("returns 400 for non-provider server", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        displayName: "Plain",
        url: "https://plain.com/mcp",
        credentials: JSON.stringify({}),
      });

      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request(`/api/mcp-servers/${server.id}/apps`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("not an integration provider");
    });

    it("returns 404 for non-existent server", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/mcp-servers/nonexistent-id/apps", {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(404);
    });

    it("delegates to provider and returns apps", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [{ id: "app-1", name: "Slack", description: "Slack app", icon: null, category: "communication" }],
          pageInfo: { endCursor: "cursor-1", hasMore: true },
        }),
        initiateConnection: vi.fn(),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request(`/api/mcp-servers/${server.id}/apps?q=slack&limit=10`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.apps).toHaveLength(1);
      expect(body.apps[0].name).toBe("Slack");
      expect(body.pageInfo.hasMore).toBe(true);

      expect(mockProvider.listApps).toHaveBeenCalledWith("slack", 10, undefined);
    });
  });

  // --- POST /api/mcp-servers/:id/connections/intents ---

  describe("POST /api/mcp-servers/:id/connections/intents", () => {
    it("routes Canvas GitHub intents to the CLI integration without calling Canvas", async () => {
      await seedAdmin(db);
      const server = await createCanvasProviderServer(db);
      const mockProvider = {
        type: "canvas",
        listApps: vi.fn(),
        initiateConnection: vi.fn(),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);
      const res = await app.request(`/api/mcp-servers/${server.id}/connections/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ appId: "github" }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "CLI_INTEGRATION" } });
      expect(mockProvider.initiateConnection).not.toHaveBeenCalled();
      expect(mockProvider.listApps).not.toHaveBeenCalled();
    });

    it("uses the requested safe app slug directly before catalog lookup", async () => {
      await seedAdmin(db);
      const server = await createCanvasProviderServer(db);
      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [
            { id: "notion", name: "Notion Enterprise", description: "" },
            { id: "notion-oauth", name: "Notion", description: "" },
          ],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi.fn().mockResolvedValue({ redirectUrl: "https://auth.example.com/notion" }),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          appId: "Notion",
          appName: "Notion",
          callbackUrl: "https://sketch.example.com/integrations/callback",
        }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        app: { id: "notion", name: "Notion", description: "" },
        redirectUrl: "https://auth.example.com/notion",
      });
      expect(mockProvider.listApps).not.toHaveBeenCalled();
      expect(mockProvider.initiateConnection).toHaveBeenCalledWith(
        "member@test.com",
        "notion",
        "https://sketch.example.com/integrations/callback?app=notion",
        "Test Member",
        "member",
      );
    });

    it("resolves a unique exact app name hit", async () => {
      await seedAdmin(db);
      const server = await createCanvasProviderServer(db);
      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [
            { id: "notion-oauth", name: "Notion", description: "" },
            { id: "slack", name: "Slack", description: "" },
          ],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi
          .fn()
          .mockRejectedValueOnce(new CanvasProviderRequestError(404, "NOT_FOUND", "App not found"))
          .mockResolvedValueOnce({ redirectUrl: "https://auth.example.com/notion" }),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ appId: "notion" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.app).toEqual({ id: "notion-oauth", name: "Notion", description: "" });
      expect(body.redirectUrl).toBe("https://auth.example.com/notion");
      expect(mockProvider.initiateConnection).toHaveBeenNthCalledWith(
        1,
        "member@test.com",
        "notion",
        "",
        "Test Member",
        "member",
      );
      expect(mockProvider.initiateConnection).toHaveBeenNthCalledWith(
        2,
        "member@test.com",
        "notion-oauth",
        "",
        "Test Member",
        "member",
      );
    });

    it("returns 404 only after the requested app slug and catalog fallback both miss", async () => {
      await seedAdmin(db);
      const server = await createCanvasProviderServer(db);
      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi
          .fn()
          .mockRejectedValue(new CanvasProviderRequestError(404, "NOT_FOUND", "App not found")),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ appId: "notion" }),
      });
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toEqual({ code: "NOT_FOUND", message: "App not found" });
      expect(mockProvider.initiateConnection).toHaveBeenCalledOnce();
    });

    it("returns 409 for an ambiguous exact app name hit", async () => {
      await seedAdmin(db);
      const server = await createCanvasProviderServer(db);
      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [
            { id: "notion-oauth", name: "Notion", description: "" },
            { id: "notion-enterprise", name: "Notion", description: "" },
          ],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi
          .fn()
          .mockRejectedValue(new CanvasProviderRequestError(404, "NOT_FOUND", "App not found")),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ appId: "notion" }),
      });
      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.error).toEqual({ code: "CONFLICT", message: "App name is ambiguous" });
      expect(mockProvider.initiateConnection).toHaveBeenCalledOnce();
    });

    it("initiates the connection with the canonical app id", async () => {
      await seedAdmin(db);
      const server = await createCanvasProviderServer(db);
      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [{ id: "google-calendar-oauth", name: "Google Calendar", description: "" }],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi
          .fn()
          .mockRejectedValueOnce(new CanvasProviderRequestError(404, "NOT_FOUND", "App not found"))
          .mockResolvedValueOnce({ redirectUrl: "https://auth.example.com/google-calendar" }),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          appId: "google-calendar",
          callbackUrl: "https://sketch.example.com/integrations/callback?app=google-calendar",
        }),
      });
      expect(res.status).toBe(200);

      expect(mockProvider.initiateConnection).toHaveBeenCalledWith(
        "member@test.com",
        "google-calendar-oauth",
        "https://sketch.example.com/integrations/callback?app=google-calendar-oauth",
        "Test Member",
        "member",
      );
    });

    it("uses returned card app slugs directly when catalog search misses", async () => {
      await seedAdmin(db);
      const server = await createCanvasProviderServer(db);
      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi.fn().mockResolvedValue({ redirectUrl: "https://auth.example.com/gmail" }),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          appId: "google-gmail-oauth",
          appName: "Gmail",
          description: "Email",
          icon: "https://img.example.com/gmail.svg",
          callbackUrl: "https://sketch.example.com/integrations/callback?app=google-gmail-oauth",
        }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.app).toEqual({
        id: "google-gmail-oauth",
        name: "Gmail",
        description: "Email",
        icon: "https://img.example.com/gmail.svg",
      });
      expect(mockProvider.listApps).not.toHaveBeenCalled();
      expect(mockProvider.initiateConnection).toHaveBeenCalledWith(
        "member@test.com",
        "google-gmail-oauth",
        "https://sketch.example.com/integrations/callback?app=google-gmail-oauth",
        "Test Member",
        "member",
      );
    });

    it("falls back to provider search when a shorthand app slug is rejected", async () => {
      await seedAdmin(db);
      const server = await createCanvasProviderServer(db);
      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [{ id: "google-gmail-oauth", name: "Gmail", description: "Email" }],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi
          .fn()
          .mockRejectedValueOnce(new CanvasProviderRequestError(404, "NOT_FOUND", "App not found"))
          .mockResolvedValueOnce({ redirectUrl: "https://auth.example.com/gmail" }),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          appId: "gmail",
          callbackUrl: "https://sketch.example.com/integrations/callback?app=gmail",
        }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.app).toEqual({ id: "google-gmail-oauth", name: "Gmail", description: "Email" });
      expect(mockProvider.initiateConnection).toHaveBeenNthCalledWith(
        2,
        "member@test.com",
        "google-gmail-oauth",
        "https://sketch.example.com/integrations/callback?app=google-gmail-oauth",
        "Test Member",
        "member",
      );
    });

    it("prefers the most specific canonical app id from provider search results", async () => {
      await seedAdmin(db);
      const server = await createCanvasProviderServer(db);
      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [
            { id: "whatsapp", name: "WhatsApp", description: "Messaging" },
            { id: "whatsapp-business", name: "WhatsApp Business", description: "Business messaging" },
          ],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi
          .fn()
          .mockRejectedValueOnce(new CanvasProviderRequestError(404, "NOT_FOUND", "App not found"))
          .mockResolvedValueOnce({ redirectUrl: "https://auth.example.com/whatsapp-business" }),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          appId: "whatsapp-business-oauth",
          callbackUrl: "https://sketch.example.com/integrations/callback?app=whatsapp-business-oauth",
        }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.app).toEqual({
        id: "whatsapp-business",
        name: "WhatsApp Business",
        description: "Business messaging",
      });
      expect(mockProvider.initiateConnection).toHaveBeenCalledWith(
        "member@test.com",
        "whatsapp-business",
        "https://sketch.example.com/integrations/callback?app=whatsapp-business",
        "Test Member",
        "member",
      );
    });
  });

  // --- POST /api/mcp-servers/:id/connections ---

  describe("POST /api/mcp-servers/:id/connections", () => {
    it("returns 400 when user has no email", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const app = createApp(db, config);
      const memberCookie = await getMemberCookieNoEmail(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ appId: "slack" }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.message).toContain("no email");
    });

    it("initiates connection via provider for member with email", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [{ id: "slack", name: "Slack", description: "" }],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi.fn().mockResolvedValue({ redirectUrl: "https://auth.example.com/connect" }),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ appId: "slack", callbackUrl: "https://sketch.example.com/callback" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.redirectUrl).toBe("https://auth.example.com/connect");
      expect(mockProvider.initiateConnection).toHaveBeenCalledWith(
        "member@test.com",
        "slack",
        "https://sketch.example.com/callback?app=slack",
        "Test Member",
        "member",
      );
    });

    it("passes admin role to provider when admin initiates connection", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [{ id: "google-calendar-oauth", name: "Google Calendar", description: "" }],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi.fn().mockResolvedValue({ redirectUrl: "https://auth.example.com/connect" }),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const adminCookie = await loginAdmin(app);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ appId: "google-calendar-oauth" }),
      });
      expect(res.status).toBe(200);

      expect(mockProvider.initiateConnection).toHaveBeenCalledWith(
        "admin@test.com",
        "google-calendar-oauth",
        "",
        "admin",
        "admin",
      );
    });

    it("canonicalizes shorthand app IDs before initiating direct connections", async () => {
      await seedAdmin(db);
      const server = await createCanvasProviderServer(db);
      const mockProvider = {
        type: "canvas",
        listApps: vi.fn().mockResolvedValue({
          apps: [{ id: "google-gmail-oauth", name: "Gmail", description: "Email" }],
          pageInfo: { endCursor: null, hasMore: false },
        }),
        initiateConnection: vi
          .fn()
          .mockRejectedValueOnce(new CanvasProviderRequestError(404, "NOT_FOUND", "App not found"))
          .mockResolvedValueOnce({ redirectUrl: "https://auth.example.com/gmail" }),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          appId: "gmail",
          callbackUrl: "https://sketch.example.com/integrations/callback",
        }),
      });
      expect(res.status).toBe(200);

      expect(mockProvider.initiateConnection).toHaveBeenCalledWith(
        "member@test.com",
        "google-gmail-oauth",
        "https://sketch.example.com/integrations/callback?app=google-gmail-oauth",
        "Test Member",
        "member",
      );
    });

    it("returns 404 for non-existent server", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/mcp-servers/nonexistent-id/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ appId: "slack" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-provider server", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        displayName: "Plain",
        url: "https://plain.com/mcp",
        credentials: JSON.stringify({}),
      });

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ appId: "slack" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // --- GET /api/mcp-servers/:id/connections ---

  describe("GET /api/mcp-servers/:id/connections", () => {
    it("returns connections for member with email", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const mockProvider = {
        type: "canvas",
        listApps: vi.fn(),
        initiateConnection: vi.fn(),
        listConnections: vi.fn().mockResolvedValue([
          {
            id: "conn-1",
            providerId: server.id,
            appId: "slack",
            appName: "Slack",
            status: "active",
            createdAt: "2025-01-01T00:00:00Z",
          },
        ]),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections`, {
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.connections).toHaveLength(1);
      expect(body.connections[0].appName).toBe("Slack");
      expect(mockProvider.listConnections).toHaveBeenCalledWith("member@test.com", "Test Member");
    });

    it("fills shared connection owner names from Sketch users when Canvas omits them", async () => {
      await seedAdmin(db);
      const users = createUserRepository(db);
      await users.create({
        name: "Tanush Yadav",
        email: "tanushyadav87@gmail.com",
        emailVerified: true,
      });
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const mockProvider = {
        type: "canvas",
        listApps: vi.fn(),
        initiateConnection: vi.fn(),
        listConnections: vi.fn().mockResolvedValue([
          {
            id: "secrets:owner-1:aimfox:aimfox",
            providerId: server.id,
            source: "canvas_user_secrets",
            appId: "aimfox",
            appName: "Aimfox",
            accountName: "tanushyadav87@gmail.com's Aimfox Connection",
            status: "active",
            accessLevel: "organization",
            isOwnedByViewer: false,
            canManageAccess: false,
            canDelete: false,
            createdAt: "2026-05-27T00:00:00Z",
          },
        ]),
        removeConnection: vi.fn(),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections`, {
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.connections[0].ownerName).toBe("Tanush Yadav");
    });

    it("returns 404 for non-existent server", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/mcp-servers/nonexistent-id/connections", {
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(404);
    });
  });

  // --- DELETE /api/mcp-servers/:id/connections/:connectionId ---

  describe("DELETE /api/mcp-servers/:id/connections/:connectionId", () => {
    it("removes connection for member with email", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const mockProvider = {
        type: "canvas",
        listApps: vi.fn(),
        initiateConnection: vi.fn(),
        listConnections: vi.fn().mockResolvedValue([
          {
            id: "conn-1",
            providerId: server.id,
            appId: "slack",
            appName: "Slack",
            status: "active",
            canDelete: true,
            isOwnedByViewer: true,
            createdAt: "2025-01-01T00:00:00Z",
          },
        ]),
        removeConnection: vi.fn().mockResolvedValue(undefined),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/conn-1`, {
        method: "DELETE",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(mockProvider.removeConnection).toHaveBeenCalledWith("member@test.com", "conn-1", "Test Member");
    });

    it("rejects deleting non-owner shared Canvas connections", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const mockProvider = {
        type: "canvas",
        listApps: vi.fn(),
        initiateConnection: vi.fn(),
        listConnections: vi.fn().mockResolvedValue([
          {
            id: "secrets:owner-1:linear:linear",
            providerId: server.id,
            source: "canvas_user_secrets",
            appId: "linear",
            appName: "Linear",
            status: "active",
            accessLevel: "organization",
            isOwnedByViewer: false,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ]),
        removeConnection: vi.fn().mockResolvedValue(undefined),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/secrets%3Aowner-1%3Alinear%3Alinear`, {
        method: "DELETE",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error).toEqual({ code: "FORBIDDEN", message: "Only the owner can disconnect this app" });
      expect(mockProvider.removeConnection).not.toHaveBeenCalled();
    });

    it("returns 404 for non-existent server", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/mcp-servers/nonexistent-id/connections/conn-1", {
        method: "DELETE",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-provider server", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        displayName: "Plain",
        url: "https://plain.com/mcp",
        credentials: JSON.stringify({}),
      });

      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/conn-1`, {
        method: "DELETE",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(400);
    });
  });

  // --- PATCH /api/mcp-servers/:id/connections/:connectionId/access ---

  describe("PATCH /api/mcp-servers/:id/connections/:connectionId/access", () => {
    it("is mounted", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const mockProvider = {
        type: "canvas",
        listApps: vi.fn(),
        initiateConnection: vi.fn(),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        updateConnectionAccess: vi.fn().mockResolvedValue(null),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, createTestConfig({}));
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(
        `/api/mcp-servers/${server.id}/connections/secrets%3Aowner%3Alinear%3Alinear/access`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: memberCookie },
          body: JSON.stringify({ accessLevel: "organization" }),
        },
      );

      expect(res.status).toBe(200);
      expect(mockProvider.updateConnectionAccess).toHaveBeenCalledWith(
        "member@test.com",
        "secrets:owner:linear:linear",
        "organization",
        "Test Member",
      );
    });

    it("forwards the member email and requested access level to the provider", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const mockProvider = {
        type: "canvas",
        listApps: vi.fn(),
        initiateConnection: vi.fn(),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        updateConnectionAccess: vi.fn().mockResolvedValue(null),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, createTestConfig({}));
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(
        `/api/mcp-servers/${server.id}/connections/secrets%3Aowner%3Alinear%3Alinear/access`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: memberCookie },
          body: JSON.stringify({ accessLevel: "organization" }),
        },
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(mockProvider.updateConnectionAccess).toHaveBeenCalledWith(
        "member@test.com",
        "secrets:owner:linear:linear",
        "organization",
        "Test Member",
      );
    });

    it("returns Canvas validation errors in the Sketch error shape", async () => {
      await seedAdmin(db);
      const repo = createMcpServerRepository(db);
      const server = await repo.create({
        type: "canvas",
        displayName: "Canvas",
        url: "https://canvas.example.com/mcp",
        apiUrl: "https://canvas.example.com",
        credentials: JSON.stringify({ apiKey: "sk-test" }),
      });

      const mockProvider = {
        type: "canvas",
        listApps: vi.fn(),
        initiateConnection: vi.fn(),
        listConnections: vi.fn(),
        removeConnection: vi.fn(),
        updateConnectionAccess: vi
          .fn()
          .mockRejectedValue(
            new CanvasProviderRequestError(400, "BAD_REQUEST", "Only Canvas-owned accounts can be shared"),
          ),
        isBrokerCapable: () => false,
        getBrokerSpec: () => null,
      };

      const { createProvider } = await import("../integrations/factory");
      vi.mocked(createProvider).mockReturnValue(mockProvider);

      const app = createApp(db, createTestConfig({}));
      const memberCookie = await getMemberCookie(db);

      const res = await app.request(`/api/mcp-servers/${server.id}/connections/pd-1/access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ accessLevel: "organization" }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toEqual({ code: "BAD_REQUEST", message: "Only Canvas-owned accounts can be shared" });
    });
  });
});
