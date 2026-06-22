/**
 * MCP servers API routes.
 * Unified CRUD for both plain MCP servers and integration providers.
 * Admin-only server management. Member-only connection management.
 * Connection testing via @modelcontextprotocol/sdk.
 *
 * Integration-specific sub-resources (apps, connections) delegate to the
 * provider adapter from integrations/factory.ts, scoped to the member's email.
 */
import type { IntegrationApp, IntegrationConnection } from "@sketch/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { createMcpServerRepository } from "../db/repositories/mcp-servers";
import type { createUserRepository } from "../db/repositories/users";
import { CanvasProviderRequestError } from "../integrations/canvas";
import { createProvider } from "../integrations/factory";
import { type IntegrationProvider, canvasCredentialsSchema } from "../integrations/types";

type McpServerRepo = ReturnType<typeof createMcpServerRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;

function maskCredentials(rawCredentials: string): Record<string, string> {
  try {
    const parsed = JSON.parse(rawCredentials) as Record<string, string>;
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && (key.toLowerCase().includes("key") || key.toLowerCase().includes("secret"))) {
        masked[key] = value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : "****";
      } else {
        masked[key] = value;
      }
    }
    return masked;
  } catch {
    return {};
  }
}

const addServerSchema = z.object({
  displayName: z.string().min(1, "Display name is required"),
  url: z.string().min(1, "MCP URL is required"),
  apiUrl: z.string().url().optional(),
  credentials: z.record(z.string(), z.unknown()),
  type: z.string().min(1).optional(),
  mode: z.enum(["mcp", "skill"]).optional(),
});

const updateServerSchema = z.object({
  displayName: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  apiUrl: z.string().url().nullable().optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  mode: z.enum(["mcp", "skill"]).optional(),
});

const connectionTestSchema = z.object({
  url: z.string().min(1, "URL is required"),
  credentials: z.string().min(1, "Credentials are required"),
});

const createConnectionSchema = z.object({
  appId: z.string().min(1, "App ID is required"),
  callbackUrl: z.string().url().optional(),
});

const integrationAppIdSchema = z
  .string()
  .trim()
  .min(1, "App ID is required")
  .max(128, "App ID must be at most 128 characters")
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/i,
    "App ID must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens",
  );

const createConnectionIntentSchema = z.object({
  appId: integrationAppIdSchema,
  callbackUrl: z.string().url().optional(),
});

const updateConnectionAccessSchema = z.object({
  accessLevel: z.enum(["personal", "organization"]),
});

const CONNECTION_INTENT_APP_LIMIT = 50;
const CONNECTION_INTENT_MAX_PAGES = 20;

/**
 * Maps raw MCP SDK errors to user-friendly messages.
 * Common failures: unreachable server, wrong content type, auth errors.
 */
function friendlyConnectionError(err: unknown): string {
  if (!(err instanceof Error)) return "Connection failed";
  const msg = err.message;
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("EHOSTUNREACH")) {
    return "Server is not reachable. Check that the URL is correct and the server is running.";
  }
  if (msg.includes("ETIMEDOUT") || msg.includes("ESOCKETTIMEDOUT") || msg.includes("timeout")) {
    return "Connection timed out. The server may be down or too slow to respond.";
  }
  if (msg.includes("content type") || msg.includes("content-type") || msg.includes("text/event-stream")) {
    return "Server is not reachable or is not a valid MCP server. Check the URL.";
  }
  if (msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("Forbidden")) {
    return "Authentication failed. Check your credentials.";
  }
  return msg;
}

async function testMcpConnection(
  url: string,
  credentials: string,
): Promise<{ status: "ok" | "error"; toolCount?: number; error?: string }> {
  const parsed = JSON.parse(credentials);
  const token = parsed.apiKey ?? parsed.bearerToken;
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const [{ Client }, { StreamableHTTPClientTransport }, { SSEClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/client/sse.js"),
  ]);
  const client = new Client({ name: "sketch", version: "1.0.0" });

  try {
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    } catch {
      await client.connect(new SSEClientTransport(new URL(url), { requestInit: { headers } }));
    }
    const result = await client.listTools();
    await client.close();
    return { status: "ok", toolCount: result.tools.length };
  } catch (err) {
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
    return { status: "error", error: friendlyConnectionError(err) };
  }
}

/**
 * Looks up an MCP server by ID and verifies it is an integration provider
 * (non-null type and api_url). Returns the row or a JSON error response.
 */
async function resolveProvider(
  c: import("hono").Context,
  mcpServers: McpServerRepo,
): Promise<
  | { ok: true; row: Awaited<ReturnType<McpServerRepo["getById"]>> & { type: string; api_url: string } }
  | { ok: false; response: Response }
> {
  const id = c.req.param("id");
  const row = await mcpServers.getById(id);
  if (!row) {
    return { ok: false, response: c.json({ error: { code: "NOT_FOUND", message: "Server not found" } }, 404) };
  }
  if (!row.type || !row.api_url) {
    return {
      ok: false,
      response: c.json({ error: { code: "BAD_REQUEST", message: "Server is not an integration provider" } }, 400),
    };
  }
  return { ok: true, row: row as typeof row & { type: string; api_url: string } };
}

/**
 * Resolves the authenticated user's Canvas identity from the JWT subject.
 * Returns the email/name or a JSON error response if the user has no email.
 */
async function resolveUserIdentity(
  c: import("hono").Context,
  users: UserRepo,
): Promise<{ ok: true; email: string; name?: string } | { ok: false; response: Response }> {
  const userId = c.get("sub");
  const user = await users.findById(userId);
  if (!user?.email) {
    return {
      ok: false,
      response: c.json({ error: { code: "BAD_REQUEST", message: "User has no email address" } }, 400),
    };
  }
  return { ok: true, email: user.email, name: user.name ?? undefined };
}

function serializeServer(row: {
  id: string;
  type: string | null;
  slug: string;
  display_name: string;
  url: string;
  api_url: string | null;
  credentials: string;
  mode: string;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    displayName: row.display_name,
    url: row.url,
    apiUrl: row.api_url,
    credentials: maskCredentials(row.credentials),
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hasDisplayOwnerName(connection: IntegrationConnection): boolean {
  const ownerName = connection.ownerName?.trim();
  return !!ownerName && !isEmail(ownerName);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizeConnectionIntentLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

async function listConnectionIntentApps(
  provider: Pick<IntegrationProvider, "listApps">,
  query: string,
): Promise<{ apps: IntegrationApp[]; exhausted: boolean }> {
  const apps: IntegrationApp[] = [];
  let after: string | undefined;

  for (let page = 0; page < CONNECTION_INTENT_MAX_PAGES; page++) {
    const result = await provider.listApps(query, CONNECTION_INTENT_APP_LIMIT, after);
    apps.push(...result.apps);
    if (!result.pageInfo.hasMore) return { apps, exhausted: true };
    if (!result.pageInfo.endCursor || result.pageInfo.endCursor === after) return { apps, exhausted: false };
    after = result.pageInfo.endCursor;
  }

  return { apps, exhausted: false };
}

function resolveConnectionIntentApp(
  apps: IntegrationApp[],
  requestedAppId: string,
  exhausted: boolean,
):
  | { ok: true; app: IntegrationApp }
  | { ok: false; status: 404 | 409; code: "NOT_FOUND" | "CONFLICT"; message: string } {
  const requestedKey = normalizeConnectionIntentLookup(requestedAppId);
  const idMatches = apps.filter((app) => normalizeConnectionIntentLookup(app.id) === requestedKey);
  if (idMatches.length === 1) return { ok: true, app: idMatches[0] };
  if (idMatches.length > 1) {
    return { ok: false, status: 409, code: "CONFLICT", message: "App ID is ambiguous" };
  }

  const nameMatches = apps.filter((app) => normalizeConnectionIntentLookup(app.name) === requestedKey);
  if (nameMatches.length === 1 && exhausted) return { ok: true, app: nameMatches[0] };
  if (nameMatches.length > 1 || !exhausted) {
    return { ok: false, status: 409, code: "CONFLICT", message: "App name is ambiguous" };
  }

  return { ok: false, status: 404, code: "NOT_FOUND", message: "App not found" };
}

function connectionIntentCallbackUrl(callbackUrl: string | undefined, appId: string): string {
  if (!callbackUrl) return "";
  const url = new URL(callbackUrl);
  url.searchParams.set("app", appId);
  return url.toString();
}

function extractEmails(value?: string): string[] {
  return value?.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [];
}

function extractSecretOwnerId(connectionId: string): string | null {
  const match = /^secrets:([^:]+):/.exec(connectionId);
  return match?.[1] ?? null;
}

async function resolveUserName(
  users: UserRepo,
  values: Array<string | null | undefined>,
  cache: Map<string, string | null>,
): Promise<string | null> {
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) continue;
    const cacheKey = `${isEmail(value) ? "email" : "id"}:${value.toLocaleLowerCase()}`;
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      continue;
    }
    const user = isEmail(value) ? await users.findByEmail(value) : await users.findById(value);
    if (user?.name) {
      cache.set(cacheKey, user.name);
      return user.name;
    }
    if (!isEmail(value)) {
      const emailUser = await users.findByEmail(value);
      if (emailUser?.name) {
        cache.set(cacheKey, emailUser.name);
        return emailUser.name;
      }
    }
    cache.set(cacheKey, null);
  }
  return null;
}

async function enrichConnectionOwnerNames(
  connections: IntegrationConnection[],
  users: UserRepo,
): Promise<IntegrationConnection[]> {
  const ownerNameCache = new Map<string, string | null>();
  return Promise.all(
    connections.map(async (connection) => {
      if (
        connection.accessLevel !== "organization" ||
        connection.isOwnedByViewer !== false ||
        hasDisplayOwnerName(connection)
      ) {
        return connection;
      }

      const ownerName = await resolveUserName(
        users,
        [
          connection.ownerUserId,
          extractSecretOwnerId(connection.id),
          connection.ownerName,
          ...extractEmails(connection.accountName),
        ],
        ownerNameCache,
      );

      return ownerName ? { ...connection, ownerName } : connection;
    }),
  );
}

function isAccessControlledConnection(connection: IntegrationConnection): boolean {
  return (
    connection.source === "canvas_user_secrets" ||
    connection.accessLevel !== undefined ||
    connection.isOwnedByViewer !== undefined ||
    connection.canDelete !== undefined
  );
}

function canDisconnectConnection(connection: IntegrationConnection): boolean {
  return connection.canDelete !== false && connection.isOwnedByViewer !== false;
}

export function mcpServerRoutes(mcpServers: McpServerRepo, users: UserRepo) {
  const routes = new Hono();

  // --- MCP Server CRUD (admin-only) ---

  routes.get("/", async (c) => {
    const servers = await mcpServers.listAll();
    return c.json({ servers: servers.map(serializeServer) });
  });

  routes.post("/", async (c) => {
    const body = await c.req.json();
    const parsed = addServerSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const { displayName, url, apiUrl, credentials, type, mode } = parsed.data;

    if (type) {
      const credParsed = canvasCredentialsSchema.safeParse(credentials);
      if (!credParsed.success) {
        const message = credParsed.error.issues[0]?.message ?? "Invalid credentials";
        return c.json({ error: { code: "VALIDATION_ERROR", message: `Invalid credentials: ${message}` } }, 400);
      }

      const existingProvider = await mcpServers.findIntegrationProvider();
      if (existingProvider) {
        return c.json({ error: { code: "CONFLICT", message: "An integration provider already exists" } }, 409);
      }
    }

    try {
      const server = await mcpServers.create({
        type: type ?? null,
        displayName,
        url,
        apiUrl: apiUrl ?? null,
        credentials: JSON.stringify(credentials),
        mode: mode ?? "mcp",
      });
      return c.json({ server: serializeServer(server) }, 201);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: { code: "CONFLICT", message: "A server with this slug already exists" } }, 409);
      }
      throw err;
    }
  });

  routes.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await mcpServers.getById(id);
    if (!existing) {
      return c.json({ error: { code: "NOT_FOUND", message: "Server not found" } }, 404);
    }

    const body = await c.req.json();
    const parsed = updateServerSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const updates: Parameters<typeof mcpServers.update>[1] = {};
    if (parsed.data.displayName !== undefined) updates.displayName = parsed.data.displayName;
    if (parsed.data.url !== undefined) updates.url = parsed.data.url;
    if (parsed.data.apiUrl !== undefined) updates.apiUrl = parsed.data.apiUrl;
    if (parsed.data.credentials !== undefined) updates.credentials = JSON.stringify(parsed.data.credentials);
    if (parsed.data.mode !== undefined) updates.mode = parsed.data.mode;

    await mcpServers.update(id, updates);
    const updated = await mcpServers.getById(id);
    if (!updated) {
      return c.json({ error: { code: "NOT_FOUND", message: "Server not found after update" } }, 404);
    }
    return c.json({ server: serializeServer(updated) });
  });

  routes.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await mcpServers.getById(id);
    if (!existing) {
      return c.json({ error: { code: "NOT_FOUND", message: "Server not found" } }, 404);
    }
    await mcpServers.remove(id);
    return c.json({ success: true });
  });

  // --- Connection testing ---

  routes.post("/connection-tests", async (c) => {
    const body = await c.req.json();
    const parsed = connectionTestSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const result = await testMcpConnection(parsed.data.url, parsed.data.credentials);
    return c.json(result);
  });

  routes.post("/:id/connection-tests", async (c) => {
    const id = c.req.param("id");
    const row = await mcpServers.getById(id);
    if (!row) {
      return c.json({ error: { code: "NOT_FOUND", message: "Server not found" } }, 404);
    }
    const result = await testMcpConnection(row.url, row.credentials);
    return c.json(result);
  });

  /**
   * Reports whether the integration provider for `:id` is currently constructible.
   * Always 200 so the frontend can poll without console-spamming. The `status`
   * field carries the state. `reason` echoes the factory's `err.message`; the
   * provider factories (`createProvider` + `canvasCredentialsSchema`) never include
   * raw credential values in their throws — see the safety note in the plan.
   */
  routes.get("/:id/health", async (c) => {
    const id = c.req.param("id");
    const row = await mcpServers.getById(id);
    if (!row) return c.json({ status: "absent" });
    if (!row.type) return c.json({ status: "not_provider" });
    try {
      createProvider(row.type, row.api_url ?? "", row.credentials, row.id);
      return c.json({ status: "ok", type: row.type });
    } catch (err) {
      return c.json({
        status: "load_failed",
        type: row.type,
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  });

  // --- Integration sub-resources ---

  routes.get("/:id/apps", async (c) => {
    const resolved = await resolveProvider(c, mcpServers);
    if (!resolved.ok) return resolved.response;
    const { row } = resolved;

    const query = c.req.query("q");
    const limitStr = c.req.query("limit");
    const after = c.req.query("after");
    const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;

    const provider = createProvider(row.type, row.api_url, row.credentials, row.id);
    const result = await provider.listApps(query, limit, after);
    return c.json({ apps: result.apps, pageInfo: result.pageInfo });
  });

  routes.post("/:id/connections", async (c) => {
    const resolved = await resolveProvider(c, mcpServers);
    if (!resolved.ok) return resolved.response;
    const { row } = resolved;

    const body = await c.req.json();
    const parsed = createConnectionSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const userResult = await resolveUserIdentity(c, users);
    if (!userResult.ok) return userResult.response;

    const provider = createProvider(row.type, row.api_url, row.credentials, row.id);
    const result = await provider.initiateConnection(
      userResult.email,
      parsed.data.appId,
      parsed.data.callbackUrl ?? "",
      userResult.name,
      c.get("role"),
    );
    return c.json(result);
  });

  routes.post("/:id/connections/intents", async (c) => {
    const resolved = await resolveProvider(c, mcpServers);
    if (!resolved.ok) return resolved.response;
    const { row } = resolved;

    const body = await c.req.json();
    const parsed = createConnectionIntentSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const userResult = await resolveUserIdentity(c, users);
    if (!userResult.ok) return userResult.response;

    const provider = createProvider(row.type, row.api_url, row.credentials, row.id);
    const listed = await listConnectionIntentApps(provider, parsed.data.appId);
    const appResult = resolveConnectionIntentApp(listed.apps, parsed.data.appId, listed.exhausted);
    if (!appResult.ok) {
      return c.json({ error: { code: appResult.code, message: appResult.message } }, appResult.status);
    }

    const result = await provider.initiateConnection(
      userResult.email,
      appResult.app.id,
      connectionIntentCallbackUrl(parsed.data.callbackUrl, appResult.app.id),
      userResult.name,
      c.get("role"),
    );
    return c.json({ app: appResult.app, redirectUrl: result.redirectUrl });
  });

  routes.get("/:id/connections", async (c) => {
    const resolved = await resolveProvider(c, mcpServers);
    if (!resolved.ok) return resolved.response;
    const { row } = resolved;

    const userResult = await resolveUserIdentity(c, users);
    if (!userResult.ok) return userResult.response;

    const provider = createProvider(row.type, row.api_url, row.credentials, row.id);
    const connections = await provider.listConnections(userResult.email, userResult.name);
    const enrichedConnections = await enrichConnectionOwnerNames(connections, users);
    return c.json({ connections: enrichedConnections });
  });

  routes.delete("/:id/connections/:connectionId", async (c) => {
    const resolved = await resolveProvider(c, mcpServers);
    if (!resolved.ok) return resolved.response;
    const { row } = resolved;

    const userResult = await resolveUserIdentity(c, users);
    if (!userResult.ok) return userResult.response;

    const connectionId = c.req.param("connectionId");
    const provider = createProvider(row.type, row.api_url, row.credentials, row.id);
    const connections = await provider.listConnections(userResult.email, userResult.name);
    const connection = connections.find((item) => item.id === connectionId);
    if (connection && isAccessControlledConnection(connection) && !canDisconnectConnection(connection)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Only the owner can disconnect this app" } }, 403);
    }

    await provider.removeConnection(userResult.email, connectionId, userResult.name);
    return c.json({ success: true });
  });

  routes.patch("/:id/connections/:connectionId/access", async (c) => {
    const resolved = await resolveProvider(c, mcpServers);
    if (!resolved.ok) return resolved.response;
    const { row } = resolved;

    const body = await c.req.json();
    const parsed = updateConnectionAccessSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const userResult = await resolveUserIdentity(c, users);
    if (!userResult.ok) return userResult.response;

    const connectionId = c.req.param("connectionId");
    const provider = createProvider(row.type, row.api_url, row.credentials, row.id);
    if (!provider.updateConnectionAccess) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Provider does not support connection access" } }, 400);
    }

    try {
      const connection = await provider.updateConnectionAccess(
        userResult.email,
        connectionId,
        parsed.data.accessLevel,
        userResult.name,
      );
      return c.json({ success: true, connection });
    } catch (err) {
      if (err instanceof CanvasProviderRequestError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status as 400 | 401 | 403 | 404 | 500);
      }
      throw err;
    }
  });

  return routes;
}
