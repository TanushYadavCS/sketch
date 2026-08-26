import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSendMessageToTarget } from "./agent/tools/messaging";
import { handleSearchEntities } from "./agent/tools/search";
import { SLACK_CHANNEL_HISTORY_DENIED_TEXT, handleSlackChannelHistory } from "./agent/tools/slack-channel-history";
import { UploadCollector } from "./agent/tools/types";
import type { createServer } from "./bootstrap";
import { seedSlackOrganizationDomain } from "./bootstrap";
import { createSettingsRepository } from "./db/repositories/settings";
import { upsertSlackPersonEntity } from "./db/repositories/slack-entity-sync";
import { createUserRepository } from "./db/repositories/users";
import type { DB } from "./db/schema";
import { createTestConfig, createTestDb, createTestPgDb } from "./test-utils";
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

vi.mock("./agent/llm-env", () => ({
  applyLlmEnvFromSettings: vi.fn(),
}));

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

vi.mock("./skills/sync", () => ({
  syncFeaturedSkills: vi.fn(),
}));

vi.mock("./connectors/managed-credential-migration", () => ({
  migrateManagedConnectorCredentialsToCanvas: vi.fn(),
}));

vi.mock("./managed-members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./managed-members")>();
  return {
    ...actual,
    reconcileManagedTenantMembers: vi.fn().mockResolvedValue({
      skipped: false,
      total: 0,
      synced: 0,
      conflictUserIds: [],
      failedUserIds: [],
    }),
  };
});

vi.mock("./managed-seed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./managed-seed")>();
  return { ...actual, runManagedSeed: vi.fn(actual.runManagedSeed) };
});

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

  async function boot(
    configOverrides: Record<string, unknown> = {},
    connect = false,
    externalStartup = true,
    backgroundWork = true,
  ) {
    const { createServer } = await import("./bootstrap");
    const config = createTestConfig({ PORT: 0, LOG_LEVEL: "error", ...configOverrides });
    handle = await createServer(config, { connect, externalStartup, backgroundWork });
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

  it("does not start the user entity link sweep when Slack entity sync is disabled", async () => {
    const h = await boot({ SLACK_ENTITY_SYNC: false });

    await expect(h.db.selectFrom("user_entity_link_sweep_runs").selectAll().execute()).resolves.toEqual([]);
  });

  it("keeps admin read-all bypass out of automation, invoke, and membership authorization paths", async () => {
    const h = await boot({}, false, false, false);
    const users = createUserRepository(h.db);
    const settings = createSettingsRepository(h.db);
    const apiKey = "sk_admin_file_parity_route";
    await settings.ensure();
    await settings.update({
      onboardingCompletedAt: new Date().toISOString(),
      sketchApiKey: apiKey,
      adminCanReadAllFiles: true,
    });
    const admin = await users.create({
      name: "Admin",
      email: "admin@example.com",
      emailVerified: true,
      authRole: "admin",
    });
    const target = await users.create({
      name: "Target",
      email: "target@example.com",
      emailVerified: true,
      authRole: "member",
    });
    const now = new Date("2026-08-26T00:00:00.000Z").toISOString();
    await h.db
      .insertInto("connector_configs")
      .values({
        id: "cfg-no-escape",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: admin.id,
      })
      .execute();
    await h.db
      .insertInto("access_scopes")
      .values({
        id: "scope-no-escape",
        connector_config_id: "cfg-no-escape",
        scope_type: "drive",
        provider_scope_id: "private",
      })
      .execute();
    await h.db
      .insertInto("indexed_files")
      .values({
        id: "file-no-escape",
        connector_config_id: "cfg-no-escape",
        provider_file_id: "provider-no-escape",
        file_name: "Admin bypass private file",
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content: "admin bypass private payload",
        synced_at: now,
        source_updated_at: now,
        access_scope_id: "scope-no-escape",
      })
      .execute();
    await h.db
      .insertInto("entities")
      .values({
        id: "entity-no-escape",
        name: "Admin Bypass Entity",
        source_type: "project",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await h.db
      .insertInto("entity_mentions")
      .values({
        id: "mention-no-escape",
        entity_id: "entity-no-escape",
        indexed_file_id: "file-no-escape",
        chunk_index: 0,
        context_snippet: "admin bypass entity context",
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: now,
      })
      .execute();

    const automationEntityResult = await handleSearchEntities(
      { queries: ["Admin Bypass Entity"] },
      {
        uploadCollector: new UploadCollector(),
        workspaceDir: "/tmp",
        db: h.db,
        userRepo: users,
        currentUserId: admin.id,
        adminReadAllEnabled: true,
        publicMcp: { filterEntityMetadata: true },
      },
    );
    expect(automationEntityResult.content[0]?.text).toBe("No entities found matching those queries.");

    const { runAgent } = await import("./agent/runner");
    vi.mocked(runAgent).mockResolvedValueOnce({
      messageSent: true,
      sessionId: "invoke-session",
      costUsd: 0,
      auxCostUsd: 0,
      pendingUploads: [],
      pendingIntegrationConnections: [],
      trace: { progressEvents: [], finalText: "done", automationArtifacts: [] },
      rawUsage: {
        model: "mock",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
        durationApiMs: 0,
        numTurns: 1,
        stopReason: "stop",
        errorSubtype: null,
        isResumedSession: false,
        totalAttachments: 0,
        imageCount: 0,
        nonImageCount: 0,
        mimeTypes: [],
        fileSizes: [],
        promptMode: "text",
        toolCalls: [],
        auxLlmCalls: [],
        sdkCostUsd: 0,
      },
    });
    const invoke = await request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        requesterUserId: admin.id,
        message: "try admin bypass",
        target: { type: "user", userId: target.id },
      }),
    });
    expect(invoke.status).toBe(200);
    await invoke.text();
    const invokedParams = vi.mocked(runAgent).mock.calls.at(-1)?.[0];
    expect(invokedParams).toMatchObject({ currentUserId: admin.id, contextType: "dm" });
    expect(invokedParams).not.toHaveProperty("isAdminReadAllEnabled");

    const sendTargetMessage = vi.fn().mockResolvedValue({ messageRef: "sent" });
    const sendResult = await handleSendMessageToTarget(
      {
        message: "private payload",
        target: { platform: "slack", targetType: "channel", targetId: "C-private" },
      },
      {
        db: h.db,
        currentUserId: admin.id,
        userRepo: users,
        sendTargetMessage,
      },
    );
    expect(sendResult.content[0]?.text).toContain("not a known member");
    expect(sendTargetMessage).not.toHaveBeenCalled();

    const historyResult = await handleSlackChannelHistory(
      {
        channelRef: "conversation:1",
        startedAt: "2026-08-26T00:00:00.000Z",
        endedAt: "2026-08-26T01:00:00.000Z",
      },
      {
        uploadCollector: new UploadCollector(),
        workspaceDir: "/tmp",
        db: h.db,
        userRepo: users,
        currentUserId: admin.id,
        adminReadAllEnabled: true,
      },
    );
    expect(historyResult.content[0]?.text).toBe(SLACK_CHANNEL_HISTORY_DENIED_TEXT);
  });

  it("starts the user entity link sweep when Slack entity sync is enabled", async () => {
    const h = await boot({ SLACK_ENTITY_SYNC: true });

    await vi.waitFor(async () => {
      await expect(h.db.selectFrom("user_entity_link_sweep_runs").selectAll().execute()).resolves.toHaveLength(1);
    });
  });

  it("seeds the bootstrap admin domain before Slack classification on first boot", async () => {
    const h = await boot(
      {
        BOOTSTRAP_ADMIN_EMAIL: "admin@acme.example",
        BOOTSTRAP_ADMIN_PASSWORD_HASH: "password-hash",
      },
      false,
      false,
      false,
    );

    await expect(h.db.selectFrom("organization_domains").select("domain").execute()).resolves.toEqual([
      { domain: "acme.example" },
    ]);

    const result = await upsertSlackPersonEntity(h.db, {
      teamId: "T-first-boot",
      slackUserId: "U-first-boot",
      name: "Acme User",
      realName: "Acme User",
      displayName: "acme-user",
      email: "user@acme.example",
      phone: null,
      profileTeamId: "T-first-boot",
      isBot: false,
      isGuest: false,
      isStranger: false,
      isRestricted: false,
      isUltraRestricted: false,
      deleted: false,
      providerUpdatedAt: "2026-08-07T00:00:00.000Z",
      fetchedAt: "2026-08-07T00:00:00.000Z",
      profile: null,
    });

    expect(result.state.classification).toBe("internal");
  });

  it("runs remote startup work by default", async () => {
    const { syncFeaturedSkills } = await import("./skills/sync");
    const { migrateManagedConnectorCredentialsToCanvas } = await import("./connectors/managed-credential-migration");
    const { reconcileManagedTenantMembers } = await import("./managed-members");

    await boot();

    expect(syncFeaturedSkills).toHaveBeenCalledOnce();
    expect(migrateManagedConnectorCredentialsToCanvas).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(reconcileManagedTenantMembers).toHaveBeenCalledOnce());
  });

  it("skips remote startup work when external startup is disabled", async () => {
    const { syncFeaturedSkills } = await import("./skills/sync");
    const { migrateManagedConnectorCredentialsToCanvas } = await import("./connectors/managed-credential-migration");
    const { reconcileManagedTenantMembers } = await import("./managed-members");

    await boot(
      {
        MANAGED_WHATSAPP_PLATFORM_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
      },
      false,
      false,
    );

    expect(syncFeaturedSkills).not.toHaveBeenCalled();
    expect(migrateManagedConnectorCredentialsToCanvas).not.toHaveBeenCalled();
    expect(reconcileManagedTenantMembers).not.toHaveBeenCalled();
  });

  it("keeps schedulers and inbound consumers stopped when background work is disabled", async () => {
    const { AgentScheduler } = await import("./agents/scheduler");
    const { TaskScheduler } = await import("./scheduler/service");
    const { WhatsAppInboundConsumer } = await import("./whatsapp/inbound-consumer");
    const agentStart = vi.spyOn(AgentScheduler.prototype, "start");
    const taskStart = vi.spyOn(TaskScheduler.prototype, "start");
    const inboundStart = vi.spyOn(WhatsAppInboundConsumer.prototype, "start");

    await boot({}, false, false, false);

    expect(agentStart).not.toHaveBeenCalled();
    expect(taskStart).not.toHaveBeenCalled();
    expect(inboundStart).not.toHaveBeenCalled();
  });

  it("configures independent interactive and scheduled agent limiters", async () => {
    const { createAgentRunLimiter } = await import("./agent/concurrency-limiter");
    await boot({ MAX_CONCURRENT_INTERACTIVE_AGENT_RUNS: 2, MAX_CONCURRENT_SCHEDULED_AGENT_RUNS: 3 });

    expect(createAgentRunLimiter).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 2,
        queue: "interactive",
      }),
    );
    expect(createAgentRunLimiter).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 3,
        queue: "scheduled",
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

  it("starts in gateway mode when the initial gateway requires pairing", { timeout: 15_000 }, async () => {
    const { WhatsAppGatewaySupervisor } = await import("./whatsapp/gateway/supervisor");
    vi.spyOn(WhatsAppGatewaySupervisor.prototype, "start").mockResolvedValue(null);

    const h = await boot({ WHATSAPP_RUNTIME_MODE: "gateway" }, true);

    await expect(h.whatsapp.pairing.status()).resolves.toEqual({ connected: false, phoneNumber: null });
    const res = await request("/api/health");
    expect(res.status).toBe(200);
  });

  it("starts operational alerts for the default in-process WhatsApp runtime", { timeout: 15_000 }, async () => {
    const { OperationalAlertWorker } = await import("./operational-alerts/worker");
    const start = vi.spyOn(OperationalAlertWorker.prototype, "start");

    await boot({}, true);

    expect(start).toHaveBeenCalledOnce();
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
    handle = null;
  });

  it("waits for active managed member reconciliation during shutdown", async () => {
    const { reconcileManagedTenantMembers } = await import("./managed-members");
    let confirmStarted = () => {};
    let releaseReconciliation = () => {};
    const started = new Promise<void>((resolve) => {
      confirmStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    vi.mocked(reconcileManagedTenantMembers).mockImplementationOnce(async () => {
      confirmStarted();
      await blocked;
      return { skipped: false, total: 0, synced: 0, conflictUserIds: [], failedUserIds: [] };
    });
    const h = await boot();
    await started;

    let shutdownCompleted = false;
    const shutdown = h.shutdown().then(() => {
      shutdownCompleted = true;
    });
    handle = null;
    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);

    releaseReconciliation();
    await expect(shutdown).resolves.toBeUndefined();
    expect(shutdownCompleted).toBe(true);
  });

  it("waits for manual managed member reconciliation during shutdown", async () => {
    const { reconcileManagedTenantMembers } = await import("./managed-members");
    let confirmStarted = () => {};
    let releaseReconciliation = () => {};
    const started = new Promise<void>((resolve) => {
      confirmStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    vi.mocked(reconcileManagedTenantMembers).mockImplementationOnce(async () => {
      confirmStarted();
      await blocked;
      return { skipped: false, total: 0, synced: 0, conflictUserIds: [], failedUserIds: [] };
    });
    const h = await boot({ SYSTEM_SECRET: "test-system-secret" }, false, false);
    const reconciliation = request("/api/system/managed-member-reconciliations", {
      method: "POST",
      headers: { Authorization: "Bearer test-system-secret" },
    });
    await started;

    let shutdownCompleted = false;
    const shutdown = h.shutdown().then(() => {
      shutdownCompleted = true;
    });
    handle = null;
    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);
    const lateReconciliation = await request("/api/system/managed-member-reconciliations", {
      method: "POST",
      headers: { Authorization: "Bearer test-system-secret" },
    });
    expect(lateReconciliation.status).toBe(200);
    await expect(lateReconciliation.json()).resolves.toEqual({
      skipped: true,
      total: 0,
      synced: 0,
      conflictUserIds: [],
      failedUserIds: [],
    });
    expect(reconcileManagedTenantMembers).toHaveBeenCalledOnce();

    releaseReconciliation();
    await expect(reconciliation.then((response) => response.status)).resolves.toBe(200);
    await expect(shutdown).resolves.toBeUndefined();
    expect(shutdownCompleted).toBe(true);
  });
});

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    });

    afterEach(async () => {
      await db.destroy();
    });

    it("seeds every verified admin corporate domain idempotently", async () => {
      await db
        .insertInto("users")
        .values([
          {
            id: "admin-1",
            name: "Personal Admin",
            email: "admin@gmail.com",
            email_verified_at: "2026-08-01T00:00:00.000Z",
            auth_role: "admin",
          },
          {
            id: "admin-2",
            name: "First Corporate Admin",
            email: "first@acme.example",
            email_verified_at: "2026-08-02T00:00:00.000Z",
            auth_role: "admin",
          },
          {
            id: "admin-3",
            name: "Second Corporate Admin",
            email: "second@other.example",
            email_verified_at: "2026-08-03T00:00:00.000Z",
            auth_role: "admin",
          },
        ])
        .execute();

      const logger = { warn: vi.fn() };
      await expect(seedSlackOrganizationDomain(db, logger)).resolves.toBe("acme.example");
      await expect(seedSlackOrganizationDomain(db, logger)).resolves.toBe("acme.example");
      await expect(
        db
          .selectFrom("organization_domains")
          .select("domain")
          .where("source", "=", "admin_email_seed")
          .orderBy("domain", "asc")
          .execute(),
      ).resolves.toEqual([{ domain: "acme.example" }, { domain: "other.example" }]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("warns when no verified admin corporate domain can be seeded", async () => {
      await db
        .insertInto("users")
        .values({
          id: "admin-personal",
          name: "Personal Admin",
          email: "admin@gmail.com",
          email_verified_at: "2026-08-01T00:00:00.000Z",
          auth_role: "admin",
        })
        .execute();
      const logger = { warn: vi.fn() };

      await expect(seedSlackOrganizationDomain(db, logger)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        "No corporate admin email domains could be seeded; classification defaults to external without domain or roster evidence",
      );
    });
  });
}

runSuite("Slack organization domain seeding SQLite", createTestDb);
runSuite("Slack organization domain seeding Postgres", createTestPgDb);
