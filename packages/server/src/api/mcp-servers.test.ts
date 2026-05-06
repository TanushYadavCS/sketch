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
        listApps: vi.fn(),
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
        "https://sketch.example.com/callback",
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
      expect(mockProvider.listConnections).toHaveBeenCalledWith("member@test.com");
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
        listConnections: vi.fn(),
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
      expect(mockProvider.removeConnection).toHaveBeenCalledWith("member@test.com", "conn-1");
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
});
