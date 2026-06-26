/**
 * Server bootstrap — wires config, DB, repos, platform adapters, and HTTP into a
 * running server. Extracted from index.ts so the full stack can be instantiated
 * from tests with a custom Config and { connect: false }.
 */
import { serve } from "@hono/node-server";
import type { Kysely } from "kysely";
import { disableSdkAttributionHeader, removeReservedAgentEnv } from "./agent/environment";
import { applyLlmEnvFromSettings } from "./agent/llm-env";
import { type RunAgentResult, runAgent } from "./agent/runner";
import type { McpServerConfig, RunAgentParams } from "./agent/runner";
import { AgentScheduler } from "./agents/scheduler";
import { AgentRunService } from "./agents/service";
import type { Config } from "./config";
import { startSyncScheduler } from "./connectors/sync";
import { createPricingService } from "./cost/cost-pricing";
import { OpenRouterPriceMap } from "./cost/openrouter-price-map";
import { backfillFilesConnectorCredentialEncryption } from "./db/credential-encryption-backfill";
import { createDatabase } from "./db/index";
import { runMigrations } from "./db/migrate";
import { createAgentEnvironmentVariableRepository } from "./db/repositories/agent-environment-variables";
import { createAgentRunsRepo } from "./db/repositories/agent-runs";
import { createAutomationRunsRepository } from "./db/repositories/automation-runs";
import { createAutomationStepContentRepository } from "./db/repositories/automation-step-content";
import { createChannelRepository } from "./db/repositories/channels";
import { createConversationRepository } from "./db/repositories/conversations";
import { createInboxMessagesRepository } from "./db/repositories/inbox-messages";
import { createLocalClaudeSessionRepository } from "./db/repositories/local-claude-sessions";
import { createLocalDeviceRepository } from "./db/repositories/local-devices";
import { createMcpServerRepository } from "./db/repositories/mcp-servers";
import { createSettingsRepository } from "./db/repositories/settings";
import { createUserRepository } from "./db/repositories/users";
import { createWhatsAppGroupRepository } from "./db/repositories/whatsapp-groups";
import type { DB } from "./db/schema";
import { configureMaterializeDefaults } from "./entities/materialize";
import type { ProposeEntityType } from "./entities/propose";
import { createApp } from "./http";
import { buildMcpConfig, createProvider } from "./integrations/factory";
import type { IntegrationProvider, IntegrationStatus } from "./integrations/types";
import { LocalClaudeSessionService } from "./local-devices/claude-sessions";
import { LocalDeviceGateway } from "./local-devices/gateway";
import { createLogger } from "./logger";
import { runManagedSeed } from "./managed-seed";
import { QueueManager } from "./queue";
import { TaskScheduler } from "./scheduler/service";
import { syncFeaturedSkills } from "./skills/sync";
import { createConfiguredSlackBot, validateSlackTokens } from "./slack/adapter";
import type { SlackBot } from "./slack/bot";
import { createSlackStartupManager } from "./slack/startup";
import { UserCache } from "./slack/user-cache";
import { type ProviderContext, createWorkflowStepRecorder, instrumentAgentRun } from "./telemetry/agent-run-telemetry";
import { initTelemetry } from "./telemetry/setup";
import { resolveVisionConfigFromAppConfig } from "./vision/service";
import { wireWhatsAppHandlers } from "./whatsapp/adapter";
import { WhatsAppBot } from "./whatsapp/bot";

export interface ServerHandle {
  config: Config;
  server: ReturnType<typeof serve>;
  db: Kysely<DB>;
  whatsapp: WhatsAppBot;
  getSlack: () => SlackBot | null;
  shutdown: () => Promise<void>;
}

/**
 * Options for createServer. When `connect` is false (default true), the stack
 * is built without starting WhatsApp or Slack, which lets tests instantiate the
 * full server without live platform connections.
 */
export interface CreateServerOptions {
  connect?: boolean;
}

export async function createServer(config: Config, options?: CreateServerOptions): Promise<ServerHandle> {
  const connect = options?.connect !== false;

  // 1. Logger
  const logger = createLogger(config);

  disableSdkAttributionHeader();

  // 2. Database
  const db = await createDatabase(config);
  await runMigrations(db);
  logger.info("Database ready");

  configureMaterializeDefaults({
    llmPromotionThreshold: config.LLM_PROMOTION_THRESHOLD,
    llmTaskCorroborationThreshold: config.LLM_TASK_CORROBORATION_THRESHOLD,
    birthGateTypes: config.EXPERIMENTAL_FLAG
      ? new Set<ProposeEntityType>(["project", "product", "team"])
      : new Set<ProposeEntityType>(),
    birthGateLiveTypes: config.EXPERIMENTAL_FLAG
      ? new Set<ProposeEntityType>(["product"])
      : new Set<ProposeEntityType>(),
    birthGateDryRun: config.BIRTH_GATE_DRY_RUN,
    experimentalFlag: config.EXPERIMENTAL_FLAG,
  });

  // Migration 039 backfills the legacy admin-owned Fireflies row to a real user id.
  // If no users exist yet, the row stays owned by 'admin' and never becomes editable
  // through the per-user UI — surface a warning so an operator can clean up later.
  try {
    const orphaned = await db
      .selectFrom("connector_configs")
      .select("id")
      .where("connector_type", "=", "fireflies")
      .where("created_by", "=", "admin")
      .executeTakeFirst();
    if (orphaned) {
      logger.warn(
        { connectorId: orphaned.id },
        "Found Fireflies config with 'admin' owner and no admin user to assign — manual cleanup required",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to check for orphaned admin Fireflies configs");
  }

  // 2.5. Sync featured skills
  await syncFeaturedSkills(config, logger);

  // 3. Repositories
  const users = createUserRepository(db);
  const channels = createChannelRepository(db);
  const settingsRepo = createSettingsRepository(db, config.ENCRYPTION_KEY);
  const agentEnvironmentVariables = createAgentEnvironmentVariableRepository(db, config.ENCRYPTION_KEY);
  await backfillFilesConnectorCredentialEncryption(db, config.ENCRYPTION_KEY, logger);
  await runManagedSeed(config, settingsRepo, users);
  const mcpServersRepo = createMcpServerRepository(db);
  const whatsappGroupsRepo = createWhatsAppGroupRepository(db);
  const conversationsRepo = createConversationRepository(db);
  const automationRunsRepo = createAutomationRunsRepository(db);
  const stepContentRepo = createAutomationStepContentRepository(db);
  const staleCount = await automationRunsRepo.markRunningAsFailed("Interrupted by server restart");
  if (staleCount > 0) {
    logger.warn({ staleCount }, "Cleaned up automation runs interrupted by previous shutdown");
  }
  const inboxMessagesRepo = createInboxMessagesRepository(db);
  const localDevicesRepo = createLocalDeviceRepository(db);
  const localDeviceGateway = new LocalDeviceGateway(localDevicesRepo, logger);
  const localClaudeSessionsRepo = createLocalClaudeSessionRepository(db);
  const localClaudeSessionService = new LocalClaudeSessionService(localClaudeSessionsRepo, localDeviceGateway, {
    baseUrl: config.BASE_URL,
    port: config.PORT,
  });
  const agentRunsRepo = createAgentRunsRepo(db);
  const telemetry = initTelemetry(agentRunsRepo, logger, config);
  const tracer = telemetry.tracer;
  const priceMap = new OpenRouterPriceMap({ ttlMs: config.OPENROUTER_PRICE_TTL_HOURS * 60 * 60 * 1000, logger });
  const pricing = createPricingService(priceMap, logger);

  /**
   * Current LLM provider context, refreshed at startup and on settings change
   * via applyLlmEnvFromDb. Drives provider-aware cost recomputation without an
   * extra per-run settings query.
   */
  let providerCtx: ProviderContext = { provider: null, modelId: null };

  const recordWorkflowStep = createWorkflowStepRecorder(tracer, pricing, () => providerCtx);

  const trackedRunAgent = async (params: RunAgentParams): Promise<RunAgentResult> => {
    const resolvedAgentEnv = removeReservedAgentEnv(
      await agentEnvironmentVariables.listForRuntimeContext({
        ...params,
        allowOrgSharedEnv: params.claudeConfigDir !== undefined,
      }),
    );
    const loadTranscriptionSettings = params.loadTranscriptionSettings ?? (() => settingsRepo.get());
    const transcriptionSettings =
      params.visionConfig === undefined || params.visionConfig === null
        ? await loadTranscriptionSettings().catch((err) => {
            logger.warn({ err }, "Failed to load settings for visual analysis config");
            return null;
          })
        : null;
    const enrichedParams = {
      ...params,
      loadTranscriptionSettings,
      visionConfig: params.visionConfig ?? resolveVisionConfigFromAppConfig(config, transcriptionSettings),
      geminiConfig: params.geminiConfig ?? {
        maxRpm: config.GEMINI_MAX_RPM,
        maxRetries: config.GEMINI_MAX_RETRIES,
      },
      openRouterApiKey: params.openRouterApiKey ?? config.OPENROUTER_API_KEY,
      settingsEncryptionKey: params.settingsEncryptionKey ?? config.ENCRYPTION_KEY,
      localDeviceInvoker: params.localDeviceInvoker ?? localDeviceGateway,
      localClaudeSessionService: params.localClaudeSessionService ?? localClaudeSessionService,
      experimentalFlag: params.experimentalFlag ?? config.EXPERIMENTAL_FLAG,
      ...(Object.keys(resolvedAgentEnv).length > 0
        ? {
            agentEnv: resolvedAgentEnv,
          }
        : {}),
    };
    return instrumentAgentRun(tracer, pricing, providerCtx, enrichedParams, () => runAgent(enrichedParams));
  };

  // 4. LLM env from DB
  async function applyLlmEnvFromDb() {
    const settingsRow = await settingsRepo.get();
    applyLlmEnvFromSettings(settingsRow, logger);
    providerCtx = { provider: settingsRow?.llm_provider ?? null, modelId: settingsRow?.model_id ?? null };
  }
  await applyLlmEnvFromDb();

  // 5. Shared helpers
  /**
   * Builds the MCP server config map for a user. Skill-mode integration rows are
   * skipped: those agents use the skill's own CLI rather than an MCP server.
   */
  async function buildMcpServers(userEmail: string | null): Promise<Record<string, McpServerConfig>> {
    const allServers = await mcpServersRepo.listAll();
    const servers: Record<string, McpServerConfig> = {};
    for (const s of allServers) {
      if (s.type != null && s.mode === "skill") continue;
      try {
        servers[s.slug] = buildMcpConfig(s.url, s.credentials, userEmail, s.type);
      } catch (err) {
        logger.warn({ err, serverId: s.id, serverSlug: s.slug }, "Failed to build MCP config for server");
      }
    }
    return servers;
  }

  // 6. Queue manager
  const queueManager = new QueueManager();

  // 7. Slack infrastructure
  const userCache = new UserCache();
  let slack: SlackBot | null = null;

  // 8. WhatsApp
  const whatsapp = new WhatsAppBot({ db, logger, groupMetadataStore: whatsappGroupsRepo });

  const sendDirectMessage = async ({
    userId,
    platform,
    message,
  }: {
    userId: string;
    platform: string;
    message: string;
  }) => {
    const recipient = await users.findById(userId);

    if (platform === "slack") {
      if (!recipient?.slack_user_id) throw new Error("No Slack ID for recipient");
      const currentSlack = slack;
      if (!currentSlack) throw new Error("Slack bot is not connected");

      const settings = await settingsRepo.get();
      const channelId = await currentSlack.openDmChannel(
        recipient.slack_user_id,
        settings?.slack_bot_token ?? undefined,
      );
      if (!channelId) throw new Error("Failed to open DM channel");

      const messageRef = await currentSlack.postMessage(channelId, message);
      return { channelId, messageRef };
    }

    if (platform === "whatsapp") {
      if (!recipient?.whatsapp_number) throw new Error("No WhatsApp number for recipient");
      const channelId = `${recipient.whatsapp_number.replace("+", "")}@s.whatsapp.net`;
      await whatsapp.sendText(channelId, message);
      return { channelId, messageRef: "" };
    }

    throw new Error(`Unsupported platform: ${platform}`);
  };

  /**
   * Resolves the full status of the active integration provider, including the
   * load-failure branch. Wraps the row-level finder
   * `mcpServersRepo.findIntegrationProvider()` (which keeps that name because
   * it really is a row finder) with the runtime factory and discriminates the
   * three outcomes — `absent`, `ok`, `load_failed` — instead of collapsing the
   * last two into `null`.
   *
   * Legacy rows may have a null api_url; the broker path doesn't need it, and
   * HTTP-only consumers gate on api_url separately. We pass an empty string so
   * an accidental HTTP call fails loudly rather than silently treating
   * skill-mode rows as unconfigured.
   */
  const getIntegrationStatus = async (): Promise<IntegrationStatus> => {
    const row = await mcpServersRepo.findIntegrationProvider();
    if (!row || row.type == null) return { kind: "absent" };
    try {
      return {
        kind: "ok",
        provider: createProvider(row.type, row.api_url ?? "", row.credentials, row.id),
      };
    } catch (err) {
      logger.error(
        { err, serverId: row.id, type: row.type, event: "integration_provider_load_failed" },
        "Failed to instantiate integration provider",
      );
      return {
        kind: "load_failed",
        reason: err instanceof Error ? err.message : "unknown error",
        type: row.type,
      };
    }
  };

  /**
   * Hot-path adapter: returns the live provider or `null`. Callers on the
   * Slack/WhatsApp message path use this so a misconfigured integration does
   * not take down general chat — `load_failed` collapses to `null` here, the
   * same as `absent`. New callers that need to surface the broken state
   * (status endpoints, agent prompt blocks) consume `getIntegrationStatus`
   * directly.
   */
  const loadIntegrationProvider = async (): Promise<IntegrationProvider | null> => {
    const status = await getIntegrationStatus();
    return status.kind === "ok" ? status.provider : null;
  };

  // 8.5. Task scheduler — getSlack is a lazy getter so the live slack reference is captured correctly
  const scheduler = new TaskScheduler({
    db,
    config,
    logger,
    queueManager,
    getSlack: () => slack,
    whatsapp,
    settingsRepo,
    runAgent: trackedRunAgent,
    buildMcpServers,
    loadIntegrationProvider,
    listAgentEnvForRuntime: (context) => agentEnvironmentVariables.listForRuntimeContext(context),
    automationRunsRepo,
    stepContentRepo,
    userRepo: users,
    inboxMessagesRepo,
    sendDm: sendDirectMessage,
    recordWorkflowStep,
  });
  await scheduler.start();

  // 8.6. Connector sync scheduler — recovers stale syncs, runs periodic sync + enrichment
  const syncScheduler = startSyncScheduler(db, logger, 30 * 60 * 1000, { appConfig: config });
  const agentRunService = new AgentRunService({
    db,
    config,
    logger,
    users,
    settings: settingsRepo,
    runAgent: trackedRunAgent,
    buildMcpServers,
    loadIntegrationProvider,
    queueManager,
  });
  const agentScheduler = new AgentScheduler({ service: agentRunService, logger });
  agentScheduler.start();

  const slackAdapterDeps = {
    db,
    config,
    logger,
    repos: { users, channels, settings: settingsRepo, conversations: conversationsRepo },
    queue: queueManager,
    slack: { userCache },
    runAgent: trackedRunAgent,
    buildMcpServers,
    loadIntegrationProvider,
    scheduler,
    stepContentRepo,
    automationRunsRepo,
    inboxMessagesRepo,
    sendDm: sendDirectMessage,
  };

  const startSlackBotIfConfigured = createSlackStartupManager({
    logger,
    slackMode: config.SLACK_MODE,
    getSettingsTokens: async () => {
      const settingsRow = await settingsRepo.get();
      return {
        botToken: settingsRow?.slack_bot_token,
        appToken: settingsRow?.slack_app_token,
      };
    },
    validateTokens: validateSlackTokens,
    getCurrentBot: () => slack,
    setCurrentBot: (bot) => {
      slack = bot;
    },
    createBot: (tokens) => createConfiguredSlackBot(tokens, slackAdapterDeps),
  });

  wireWhatsAppHandlers(whatsapp, {
    db,
    config,
    logger,
    repos: { users, settings: settingsRepo, whatsappGroups: whatsappGroupsRepo, conversations: conversationsRepo },
    queue: queueManager,
    runAgent: trackedRunAgent,
    buildMcpServers,
    loadIntegrationProvider,
    scheduler,
    stepContentRepo,
    automationRunsRepo,
    inboxMessagesRepo,
    sendDm: sendDirectMessage,
  });

  // 9. HTTP server
  const app = createApp(db, config, {
    whatsapp,
    getSlack: () => slack,
    scheduler,
    runAgent: trackedRunAgent,
    buildMcpServers,
    loadIntegrationProvider,
    listAgentEnvForRuntime: (context) => agentEnvironmentVariables.listForRuntimeContext(context),
    stepContentRepo,
    automationRunsRepo,
    queueManager,
    onSlackTokensUpdated: async (tokens) => {
      await startSlackBotIfConfigured(tokens);
    },
    onSlackDisconnect: async () => {
      if (slack) {
        await slack.stop();
        slack = null;
      }
      await settingsRepo.update({ slackBotToken: null, slackAppToken: null });
      logger.info("Slack disconnected and tokens cleared");
    },
    onLlmSettingsUpdated: async () => {
      await applyLlmEnvFromDb();
    },
    sendDm: sendDirectMessage,
    onSmtpUpdated: async () => {
      logger.info("SMTP configuration updated");
    },
    logger,
    localDeviceGateway,
    localClaudeSessionService,
    agentRunService,
  });
  const server = serve({ fetch: app.fetch, port: config.PORT });
  localDeviceGateway.attach(server);
  logger.info({ port: config.PORT }, "HTTP server started");

  // 10. Start platforms
  if (connect) {
    await startSlackBotIfConfigured().catch(() => {});

    const whatsappConnected = await whatsapp.start();
    if (whatsappConnected) {
      logger.info("WhatsApp connected");
    } else {
      logger.info("WhatsApp not paired — use GET /api/channels/whatsapp/pair to connect");
    }

    if (!slack && !whatsappConnected) {
      logger.info("No channels active — pair WhatsApp via GET /api/channels/whatsapp/pair or configure Slack tokens");
    }
  }

  // 11. Shutdown handle
  async function shutdown() {
    logger.info("Shutting down...");
    await telemetry.shutdown();
    await syncScheduler.stop();
    agentScheduler.stop();
    scheduler.stop();
    if (slack) await slack.stop();
    await whatsapp.stop();
    server.close();
    await db.destroy();
  }

  return {
    config,
    server,
    db,
    whatsapp,
    getSlack: () => slack,
    shutdown,
  };
}
