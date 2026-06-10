import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createApiTokenRepository } from "../../db/repositories/api-tokens";
import { createExternalMcpToolCallRepository } from "../../db/repositories/external-mcp-tool-calls";
import type { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createMcpAuthMiddleware } from "./auth";
import { createPublicSketchMcpServer } from "./public-server";

export function mountPublicMcpServer(params: {
  app: Hono;
  db: Kysely<DB>;
  userRepo: ReturnType<typeof createUserRepository>;
  workspaceDir: string;
  logger: Logger;
  baseUrl?: string;
}) {
  const apiTokens = createApiTokenRepository(params.db);
  const auditRepo = createExternalMcpToolCallRepository(params.db);
  const auth = createMcpAuthMiddleware({
    apiTokens,
    users: params.userRepo,
    logger: params.logger,
    baseUrl: params.baseUrl,
  });

  params.app.use("/mcp", auth);
  params.app.on(["GET", "DELETE"], "/mcp", (c) =>
    c.json({ error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported for stateless MCP v1" } }, 405),
  );
  params.app.post("/mcp", async (c: Context) => {
    const authContext = c.get("mcpAuth");
    const server = await createPublicSketchMcpServer({
      db: params.db,
      userRepo: params.userRepo,
      userId: authContext.userId,
      tokenId: authContext.tokenId,
      workspaceDir: params.workspaceDir,
      auditRepo,
    });
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
