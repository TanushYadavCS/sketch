import type { Context, Next } from "hono";
import type { Logger } from "pino";
import { hashApiToken, isSketchPat } from "../../auth/api-token";
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

export function createMcpAuthMiddleware(params: { apiTokens: ApiTokenRepo; users: UserRepo; logger: Logger }) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Bearer token required" } }, 401);
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!isSketchPat(token)) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid token" } }, 401);
    }

    const row = await params.apiTokens.findByHash(hashApiToken(token));
    if (!row) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid token" } }, 401);
    }

    const user = await params.users.findById(row.user_id);
    if (!user) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid token" } }, 401);
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
