import { Hono } from "hono";
import type { Kysely } from "kysely";
import { z } from "zod";
import { generateApiToken, getApiTokenDisplayPrefix, hashApiToken } from "../auth/api-token";
import { createApiTokenRepository } from "../db/repositories/api-tokens";
import type { DB } from "../db/schema";

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

function toResponseToken(row: {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function getMcpUrl(c: import("hono").Context, baseUrl?: string): string {
  if (baseUrl) return `${baseUrl.replace(/\/$/, "")}/mcp`;
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(/:$/, "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
  return `${proto}://${host}/mcp`;
}

export function apiTokenRoutes(db: Kysely<DB>, opts: { baseUrl?: string }) {
  const routes = new Hono();
  const apiTokens = createApiTokenRepository(db);

  routes.get("/", async (c) => {
    const rows = await apiTokens.listForUser(c.get("sub"));
    return c.json({
      tokens: rows.map(toResponseToken),
      mcpUrl: getMcpUrl(c, opts.baseUrl),
    });
  });

  routes.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createTokenSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const token = generateApiToken();
    const row = await apiTokens.create({
      userId: c.get("sub"),
      name: parsed.data.name,
      tokenHash: hashApiToken(token),
      prefix: getApiTokenDisplayPrefix(token),
    });

    return c.json({
      token: toResponseToken(row),
      plaintext: token,
      mcpUrl: getMcpUrl(c, opts.baseUrl),
    });
  });

  routes.delete("/:id", async (c) => {
    const revoked = await apiTokens.revoke(c.get("sub"), c.req.param("id"));
    if (!revoked) {
      return c.json({ error: { code: "NOT_FOUND", message: "API token not found" } }, 404);
    }
    return c.json({ success: true });
  });

  return routes;
}
