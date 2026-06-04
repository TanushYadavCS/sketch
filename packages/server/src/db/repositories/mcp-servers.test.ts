/**
 * Tests for the mcp_servers repository.
 * Validates CRUD operations, slug auto-generation, and collision avoidance.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createMcpServerRepository, generateSlug } from "./mcp-servers";

let db: Kysely<DB>;
let repo: ReturnType<typeof createMcpServerRepository>;

beforeEach(async () => {
  db = await createTestDb();
  repo = createMcpServerRepository(db);
});

afterEach(async () => {
  await db.destroy();
});

const validServer = {
  displayName: "My Canvas",
  url: "https://canvas.example.com/mcp",
  apiUrl: "https://canvas.example.com",
  type: "canvas" as string | null,
  credentials: JSON.stringify({ apiKey: "sk-test-123" }),
};

const validPlainMcp = {
  displayName: "Plain MCP",
  url: "https://mcp.example.com",
  credentials: JSON.stringify({ bearerToken: "tok-123" }),
};

describe("generateSlug()", () => {
  it("converts spaces to hyphens and lowercases", () => {
    expect(generateSlug("My Canvas Server")).toBe("my-canvas-server");
  });

  it("strips special characters", () => {
    expect(generateSlug("Hello! World@#$")).toBe("hello-world");
  });

  it("collapses multiple hyphens", () => {
    expect(generateSlug("a - - b")).toBe("a-b");
  });

  it("trims leading/trailing hyphens", () => {
    expect(generateSlug(" -hello- ")).toBe("hello");
  });
});

describe("listAll()", () => {
  it("returns empty array initially", async () => {
    const result = await repo.listAll();
    expect(result).toEqual([]);
  });

  it("returns servers ordered by created_at asc", async () => {
    const first = await repo.create({ ...validServer, displayName: "First" });
    const second = await repo.create({ ...validServer, displayName: "Second" });
    await db
      .updateTable("mcp_servers")
      .set({ created_at: "2020-01-01T00:00:00.000Z" })
      .where("id", "=", first.id)
      .execute();
    await db
      .updateTable("mcp_servers")
      .set({ created_at: "2020-01-02T00:00:00.000Z" })
      .where("id", "=", second.id)
      .execute();
    const result = await repo.listAll();
    expect(result).toHaveLength(2);
    expect(result[0].display_name).toBe("First");
    expect(result[1].display_name).toBe("Second");
  });
});

describe("create()", () => {
  it("inserts and returns a server with all fields", async () => {
    const server = await repo.create(validServer);
    expect(server.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(server.type).toBe("canvas");
    expect(server.slug).toBe("my-canvas");
    expect(server.display_name).toBe("My Canvas");
    expect(server.url).toBe("https://canvas.example.com/mcp");
    expect(server.api_url).toBe("https://canvas.example.com");
    expect(server.credentials).toBe(validServer.credentials);
    expect(server.created_at).toBeDefined();
    expect(server.updated_at).toBeDefined();
  });

  it("creates a plain MCP server with null type and api_url", async () => {
    const server = await repo.create(validPlainMcp);
    expect(server.type).toBeNull();
    expect(server.api_url).toBeNull();
    expect(server.url).toBe("https://mcp.example.com");
  });

  it("auto-generates slug from display name", async () => {
    const server = await repo.create({ ...validServer, displayName: "My Cool Server" });
    expect(server.slug).toBe("my-cool-server");
  });

  it("appends number on slug collision", async () => {
    await repo.create({ ...validServer, displayName: "My Canvas" });
    const second = await repo.create({ ...validServer, displayName: "My Canvas" });
    expect(second.slug).toBe("my-canvas-2");
  });

  it("increments slug suffix on multiple collisions", async () => {
    await repo.create({ ...validServer, displayName: "My Canvas" });
    await repo.create({ ...validServer, displayName: "My Canvas" });
    const third = await repo.create({ ...validServer, displayName: "My Canvas" });
    expect(third.slug).toBe("my-canvas-3");
  });
});

describe("getById()", () => {
  it("returns server when found", async () => {
    const created = await repo.create(validServer);
    const found = await repo.getById(created.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.slug).toBe("my-canvas");
  });

  it("returns null when not found", async () => {
    const found = await repo.getById("nonexistent-id");
    expect(found).toBeNull();
  });
});

describe("getBySlug()", () => {
  it("returns server when found", async () => {
    const created = await repo.create(validServer);
    const found = await repo.getBySlug("my-canvas");
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.type).toBe("canvas");
  });

  it("returns null when not found", async () => {
    const found = await repo.getBySlug("nonexistent-slug");
    expect(found).toBeNull();
  });
});

describe("findIntegrationProvider()", () => {
  it("returns first server with non-null type", async () => {
    await repo.create(validPlainMcp);
    await repo.create(validServer);
    const provider = await repo.findIntegrationProvider();
    expect(provider).not.toBeNull();
    expect(provider?.type).toBe("canvas");
  });

  it("returns null when only plain MCP servers exist", async () => {
    await repo.create(validPlainMcp);
    const provider = await repo.findIntegrationProvider();
    expect(provider).toBeNull();
  });

  it("returns null when no servers exist", async () => {
    const provider = await repo.findIntegrationProvider();
    expect(provider).toBeNull();
  });
});

describe("update()", () => {
  it("modifies specified fields, leaves others unchanged", async () => {
    const created = await repo.create(validServer);
    await repo.update(created.id, { displayName: "Updated Name", url: "https://new-url.com/mcp" });
    const updated = await repo.getById(created.id);
    expect(updated?.display_name).toBe("Updated Name");
    expect(updated?.url).toBe("https://new-url.com/mcp");
    expect(updated?.api_url).toBe("https://canvas.example.com");
    expect(updated?.credentials).toBe(validServer.credentials);
  });

  it("does nothing when no fields provided", async () => {
    const created = await repo.create(validServer);
    await repo.update(created.id, {});
    const unchanged = await repo.getById(created.id);
    expect(unchanged?.display_name).toBe("My Canvas");
  });

  it("sets apiUrl to null explicitly", async () => {
    const created = await repo.create(validServer);
    expect(created.api_url).toBe("https://canvas.example.com");
    await repo.update(created.id, { apiUrl: null });
    const updated = await repo.getById(created.id);
    expect(updated?.api_url).toBeNull();
  });

  it("updates credentials", async () => {
    const created = await repo.create(validServer);
    const newCreds = JSON.stringify({ apiKey: "sk-new-456" });
    await repo.update(created.id, { credentials: newCreds });
    const updated = await repo.getById(created.id);
    expect(updated?.credentials).toBe(newCreds);
  });
});

describe("remove()", () => {
  it("deletes a server", async () => {
    const created = await repo.create(validServer);
    await repo.remove(created.id);
    const found = await repo.getById(created.id);
    expect(found).toBeNull();
  });

  it("does not throw on non-existent id", async () => {
    await expect(repo.remove("nonexistent-id")).resolves.not.toThrow();
  });
});

describe("findByType()", () => {
  it("returns canvas provider when one exists", async () => {
    await repo.create(validServer);
    const found = await repo.findByType("canvas");
    expect(found).not.toBeNull();
    expect(found?.type).toBe("canvas");
  });

  it("returns null when no canvas provider exists", async () => {
    const found = await repo.findByType("canvas");
    expect(found).toBeNull();
  });

  it("returns null when only other provider types exist", async () => {
    await repo.create({ ...validServer, type: "composio", displayName: "Composio" });
    const found = await repo.findByType("canvas");
    expect(found).toBeNull();
  });

  it("does not match plain MCP servers (type null)", async () => {
    await repo.create({ ...validServer, type: null, displayName: "Plain Server" });
    const found = await repo.findByType("canvas");
    expect(found).toBeNull();
  });
});
