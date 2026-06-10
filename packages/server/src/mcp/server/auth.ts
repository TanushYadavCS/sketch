import type { Context, Next } from "hono";
import type { Logger } from "pino";
import { hashApiToken, isSketchOAuthAccessToken, isSketchPat } from "../../auth/api-token";
import type { createApiTokenRepository } from "../../db/repositories/api-tokens";
import type { createUserRepository } from "../../db/repositories/users";
import { createTokenBucketRateLimiter } from "./rate-limit";

type ApiTokenRepo = ReturnType<typeof createApiTokenRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;

export interface McpAuthContext {
  tokenId: string;
  userId: string;
  userEmail: string | null;
  tokenPrefix: string;
}

declare module "hono" {
  interface ContextVariableMap {
    mcpAuth: McpAuthContext;
  }
}

const limiter = createTokenBucketRateLimiter({ capacity: 60, refillPerMinute: 60 });

function resolveBaseUrl(c: Context, configuredBaseUrl?: string): string {
  if (configuredBaseUrl) return configuredBaseUrl.replace(/\/+$/, "");
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const host = c.req.header("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

function unauthorized(c: Context, message: string, configuredBaseUrl?: string) {
  const baseUrl = resolveBaseUrl(c, configuredBaseUrl);
  c.header("WWW-Authenticate", `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
  return c.json({ error: { code: "UNAUTHORIZED", message } }, 401);
}

export function createMcpAuthMiddleware(params: {
  apiTokens: ApiTokenRepo;
  users: UserRepo;
  logger: Logger;
  baseUrl?: string;
}) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return unauthorized(c, "Bearer token required", params.baseUrl);
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!isSketchPat(token) && !isSketchOAuthAccessToken(token)) {
      return unauthorized(c, "Invalid token", params.baseUrl);
    }

    const row = await params.apiTokens.findByHash(hashApiToken(token));
    if (!row) {
      return unauthorized(c, "Invalid token", params.baseUrl);
    }
    if (isSketchPat(token) && row.kind !== "pat") {
      return unauthorized(c, "Invalid token", params.baseUrl);
    }
    if (isSketchOAuthAccessToken(token) && row.kind !== "oauth") {
      return unauthorized(c, "Invalid token", params.baseUrl);
    }

    const user = await params.users.findById(row.user_id);
    if (!user) {
      return unauthorized(c, "Invalid token", params.baseUrl);
    }

    if (!limiter.consume(row.id)) {
      return c.json({ error: { code: "RATE_LIMITED", message: "Too many MCP requests" } }, 429);
    }

    c.set("mcpAuth", {
      tokenId: row.id,
      userId: row.user_id,
      userEmail: user.email,
      tokenPrefix: row.prefix,
    });

    void params.apiTokens.touchLastUsed(row.id).catch((err) => {
      params.logger.warn({ err, tokenId: row.id }, "Failed to update API token last_used_at");
    });

    return next();
  };
}
