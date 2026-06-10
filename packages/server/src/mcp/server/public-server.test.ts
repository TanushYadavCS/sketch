import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiToken, getApiTokenDisplayPrefix, hashApiToken } from "../../auth/api-token";
import { createApiTokenRepository } from "../../db/repositories/api-tokens";
import { createSettingsRepository } from "../../db/repositories/settings";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createApp } from "../../http";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

async function createPat() {
  const settings = createSettingsRepository(db);
  await settings.create();
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const users = createUserRepository(db);
  const user = await users.create({ name: "MCP User", email: "mcp@example.com", emailVerified: true });
  const plaintext = generateApiToken();
  await createApiTokenRepository(db).create({
    userId: user.id,
    name: "Claude Code",
    tokenHash: hashApiToken(plaintext),
    prefix: getApiTokenDisplayPrefix(plaintext),
  });
  return plaintext;
}

function mcpHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": "2025-03-26",
  };
}

describe("public MCP server", () => {
  it("is available without EXPERIMENTAL_FLAG and advertises OAuth discovery", async () => {
    const app = createApp(db, createTestConfig({ EXPERIMENTAL_FLAG: false }), { logger: createTestLogger() });
    const res = await app.request("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
  });

  it("rejects non-Sketch PAT bearer tokens", async () => {
    const app = createApp(db, createTestConfig({ EXPERIMENTAL_FLAG: true }), { logger: createTestLogger() });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("sk_live_wrong"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("lists the four public sketch tools for a valid PAT", async () => {
    const token = await createPat();
    const app = createApp(db, createTestConfig({ EXPERIMENTAL_FLAG: true }), { logger: createTestLogger() });

    const res = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "sketch_get_entity_context",
      "sketch_get_file_content",
      "sketch_search",
      "sketch_search_entities",
    ]);
  });

  it("rate limits by token even when the forwarded IP changes", async () => {
    const token = await createPat();
    const app = createApp(db, createTestConfig({ EXPERIMENTAL_FLAG: true }), { logger: createTestLogger() });
    const statuses: number[] = [];
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);

    try {
      for (let i = 0; i < 61; i += 1) {
        const res = await app.request("/mcp", {
          method: "POST",
          headers: {
            ...mcpHeaders(token),
            "x-forwarded-for": `203.0.113.${i}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }),
        });
        statuses.push(res.status);
      }
    } finally {
      nowSpy.mockRestore();
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
    expect(statuses.at(-1)).toBe(429);
  });
});
