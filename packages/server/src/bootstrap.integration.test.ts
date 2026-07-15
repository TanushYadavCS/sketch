import { afterEach, describe, expect, it, vi } from "vitest";
import type { createServer } from "./bootstrap";
import { createUserRepository } from "./db/repositories/users";
import { createTestConfig } from "./test-utils";
import { WHATSAPP_TEMPLATE_KEYS } from "./whatsapp/templates";

type FetchHandler = (request: Request) => Response | Promise<Response>;

const mockServeState = vi.hoisted(() => ({
  fetch: null as FetchHandler | null,
}));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn((opts: { fetch: FetchHandler; port: number }) => {
    mockServeState.fetch = opts.fetch;
    return {
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: opts.port }),
      close: vi.fn(),
      on: vi.fn(),
    };
  }),
}));

// Avoid env-var side effects from LLM config
vi.mock("./agent/llm-env", () => ({
  applyLlmEnvFromSettings: vi.fn(),
}));

// Avoid pulling in the full Claude SDK at import time
vi.mock("./agent/runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("./agent/concurrency-limiter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent/concurrency-limiter")>();
  return {
    ...actual,
    createAgentRunLimiter: vi.fn(actual.createAgentRunLimiter),
  };
});

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
    mockServeState.fetch = null;
    vi.clearAllMocks();
  });

  async function boot(configOverrides: Record<string, unknown> = {}) {
    // Lazy import so vi.mock hoisting takes effect
    const { createServer } = await import("./bootstrap");
    const config = createTestConfig({ PORT: 0, LOG_LEVEL: "error", ...configOverrides });
    handle = await createServer(config, { connect: false });
    return handle;
  }

  async function request(path: string, init?: RequestInit) {
    if (!mockServeState.fetch) throw new Error("Server fetch handler was not captured");
    return mockServeState.fetch(new Request(`http://localhost${path}`, init));
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

  it("configures the process-wide agent limiter from server config", async () => {
    const { createAgentRunLimiter } = await import("./agent/concurrency-limiter");
    await boot({ MAX_CONCURRENT_AGENT_RUNS: 2 });

    expect(createAgentRunLimiter).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 2,
      }),
    );
  });

  it("health endpoint responds 200", async () => {
    await boot();

    const res = await request("/api/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(body.whatsapp).toEqual({ missingProviderIdEvents: 0 });
  });

  it("sends explicit WhatsApp magic-link templates without proactive parking", async () => {
    const h = await boot({ BASE_URL: "https://sketch.test" });
    const users = createUserRepository(h.db);
    await users.create({
      name: "Alice",
      email: "alice@example.com",
      emailVerified: true,
      whatsappNumber: "+15551234567",
    });
    const sendTemplate = vi.spyOn(h.whatsappRuntime, "sendTemplate").mockResolvedValue({
      providerMessageId: "wa-template-1",
      providerConversationId: "dm:+15551234567",
      providerTimestamp: "2026-07-03T10:00:00.000Z",
    });
    const sendText = vi.spyOn(h.whatsappRuntime, "sendText");
    const getCapabilities = vi.spyOn(h.whatsappRuntime, "getCapabilities");

    const res = await request("/api/auth/magic-link", {
      method: "POST",
      body: JSON.stringify({ email: "alice@example.com" }),
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json()) as { channels: string[] };

    expect(res.status).toBe(200);
    expect(body.channels).toEqual(["whatsapp"]);
    expect(sendTemplate).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+15551234567" },
      expect.objectContaining({
        key: WHATSAPP_TEMPLATE_KEYS.magicLink,
        params: expect.objectContaining({
          recipientName: "Alice",
          botName: "Sketch",
          magicLinkUrl: expect.stringContaining("/api/auth/magic-link/verify?token="),
        }),
      }),
    );
    expect(getCapabilities).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    await expect(h.db.selectFrom("inbox_messages").selectAll().execute()).resolves.toEqual([]);
  });

  it("shutdown resolves without error", async () => {
    const h = await boot();
    await expect(h.shutdown()).resolves.toBeUndefined();
    handle = null; // prevent double-shutdown in afterEach
  });
});
