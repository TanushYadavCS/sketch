import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createApiTokenRepository } from "../../db/repositories/api-tokens";
import { createExternalMcpToolCallRepository } from "../../db/repositories/external-mcp-tool-calls";
import type { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { type McpAuthContext, createMcpAuthMiddleware } from "./auth";
import { createPublicSketchMcpServer } from "./public-server";

type AuditRepo = ReturnType<typeof createExternalMcpToolCallRepository>;

export function mountMcpServer(params: {
  app: Hono;
  db: Kysely<DB>;
  userRepo: ReturnType<typeof createUserRepository>;
  logger: Logger;
  path: string;
  baseUrl?: string;
  requireAdmin?: boolean;
  createServer: (params: { authContext: McpAuthContext; auditRepo: AuditRepo }) => Promise<McpServer>;
}) {
  const apiTokens = createApiTokenRepository(params.db);
  const auditRepo = createExternalMcpToolCallRepository(params.db);
  const auth = createMcpAuthMiddleware({
    apiTokens,
    users: params.userRepo,
    logger: params.logger,
    baseUrl: params.baseUrl,
    requireAdmin: params.requireAdmin,
  });

  params.app.use(params.path, auth);
  params.app.on(["GET", "DELETE"], params.path, (c) =>
    c.json({ error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported for stateless MCP v1" } }, 405),
  );
  params.app.post(params.path, async (c: Context) => {
    const authContext = c.get("mcpAuth");
    const server = await params.createServer({ authContext, auditRepo });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
}

export function mountPublicMcpServer(params: {
  app: Hono;
  db: Kysely<DB>;
  userRepo: ReturnType<typeof createUserRepository>;
  workspaceDir: string;
  logger: Logger;
  baseUrl?: string;
}) {
  mountMcpServer({
    app: params.app,
    db: params.db,
    userRepo: params.userRepo,
    logger: params.logger,
    path: "/mcp",
    baseUrl: params.baseUrl,
    createServer: ({ authContext, auditRepo }) =>
      createPublicSketchMcpServer({
        db: params.db,
        userRepo: params.userRepo,
        userId: authContext.userId,
        tokenId: authContext.tokenId,
        workspaceDir: params.workspaceDir,
        auditRepo,
      }),
  });
}
