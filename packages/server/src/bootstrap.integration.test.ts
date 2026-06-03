import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createServer } from "./bootstrap";
import { createTestConfig } from "./test-utils";

// Avoid env-var side effects from LLM config
vi.mock("./agent/llm-env", () => ({
  applyLlmEnvFromSettings: vi.fn(),
}));

// Avoid pulling in the full Claude SDK at import time
vi.mock("./agent/runner", () => ({
  runAgent: vi.fn(),
}));

// Avoid syncing skills from remote repo during tests
vi.mock("./skills/sync", () => ({
  syncFeaturedSkills: vi.fn(),
}));

// Avoid managed seed side effects during tests
vi.mock("./managed-seed", () => ({
  runManagedSeed: vi.fn(),
}));

type ServerHandle = Awaited<ReturnType<typeof createServer>>;

describe("bootstrap", () => {
  let handle: ServerHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.shutdown();
      handle = null;
    }
  });

  async function boot(configOverrides: Record<string, unknown> = {}) {
    // Lazy import so vi.mock hoisting takes effect
    const { createServer } = await import("./bootstrap");
    const config = createTestConfig({ PORT: 0, LOG_LEVEL: "error", ...configOverrides });
    handle = await createServer(config, { connect: false });
    return handle;
  }

  it("starts and returns expected handle shape", { timeout: 15_000 }, async () => {
    const h = await boot();

    expect(h.config).toBeDefined();
    expect(h.server).toBeDefined();
    expect(h.db).toBeDefined();
    expect(h.whatsapp).toBeDefined();
    expect(typeof h.getSlack).toBe("function");
    expect(typeof h.shutdown).toBe("function");
  });

  it("has no Slack bot when tokens are not configured", async () => {
    const h = await boot();
    expect(h.getSlack()).toBeNull();
  });

  it("health endpoint responds 200", async () => {
    const h = await boot();
    const { port } = h.server.address() as AddressInfo;

    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
  });

  it("shutdown resolves without error", async () => {
    const h = await boot();
    await expect(h.shutdown()).resolves.toBeUndefined();
    handle = null; // prevent double-shutdown in afterEach
  });
});
