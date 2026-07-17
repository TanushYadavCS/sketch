import { join } from "node:path";
/**
 * Server bootstrap — wires config, DB, repos, platform adapters, and HTTP into a
 * running server. Extracted from index.ts so the full stack can be instantiated
 * from tests with a custom Config and { connect: false }.
 */
import { serve } from "@hono/node-server";
import type { Kysely } from "kysely";
import { type AgentRunAdmissionOptions, createAgentRunLimiter } from "./agent/concurrency-limiter";
import { disableSdkAttributionHeader, removeReservedAgentEnv } from "./agent/environment";
import { applyLlmEnvFromSettings } from "./agent/llm-env";
import { type RunAgentResult, runAgent } from "./agent/runner";
import type { McpServerConfig, RunAgentParams } from "./agent/runner";
import { resolveAgentRuntimeProviderConfigFromSettings } from "./agent/runtime/provider";
import { createAgentOutputDeliveryService } from "./agents/output-delivery";
import { AgentScheduler } from "./agents/scheduler";
import { AgentRunService } from "./agents/service";
import type { Config } from "./config";
import { migrateManagedConnectorCredentialsToCanvas } from "./connectors/managed-credential-migration";
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
import { createOperationalAlertsRepository } from "./db/repositories/operational-alerts";
import { createSettingsRepository } from "./db/repositories/settings";
import { createUserRepository } from "./db/repositories/users";
import { createWhatsAppGroupRepository } from "./db/repositories/whatsapp-groups";
import { createWhatsAppInboundEventsRepository } from "./db/repositories/whatsapp-inbound-events";
import { createWhatsAppProviderEventRepository } from "./db/repositories/whatsapp-provider-events";
import { createWhatsAppTemplateMappingRepository } from "./db/repositories/whatsapp-template-mappings";
import type { DB } from "./db/schema";
import { configureMaterializeDefaults } from "./entities/materialize";
import { startNormalizationBackfill } from "./entities/normalization-backfill";
import type { ProposeEntityType } from "./entities/propose";
import { createApp } from "./http";
import { buildMcpConfig, createProvider } from "./integrations/factory";
import type { IntegrationProvider, IntegrationStatus } from "./integrations/types";
import { LocalClaudeSessionService } from "./local-devices/claude-sessions";
import { LocalDeviceGateway } from "./local-devices/gateway";
import { createLogger } from "./logger";
import { runManagedSeed } from "./managed-seed";
import { createOperationalAlertDefinitions } from "./operational-alerts/definitions";
import { createOperationalAlertService } from "./operational-alerts/service";
import { createWhatsAppOperationalAlertTransport } from "./operational-alerts/whatsapp-transport";
import { OperationalAlertWorker } from "./operational-alerts/worker";
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
import { createDbAuthState } from "./whatsapp/auth-store";
import { WhatsAppBot } from "./whatsapp/bot";
import type { WhatsAppSocketFacade } from "./whatsapp/facade-contract";
import { GatewayClientFacade } from "./whatsapp/gateway-client-facade";
import { InProcessWhatsAppLease, WhatsAppGatewaySupervisor } from "./whatsapp/gateway/supervisor";
import { InProcessSocketFacade } from "./whatsapp/in-process-socket-facade";
import { WhatsAppInboundConsumer } from "./whatsapp/inbound-consumer";
import { WORKFLOW_OUTPUT_INBOX_KIND, deliverProactiveDm } from "./whatsapp/proactive-delivery";
import { whatsappDeliveryTargetFromTarget } from "./whatsapp/provider";
import { createBaileysWhatsAppProviders } from "./whatsapp/providers/baileys";
import { WHATSAPP_MANAGED_PROVIDER_ID, createManagedWhatsAppProvider } from "./whatsapp/providers/managed";
import { WHATSAPP_WATI_PROVIDER_ID, createWatiWhatsAppProvider } from "./whatsapp/providers/wati";
import { startWhatsAppInboundRetention } from "./whatsapp/retention";
import { createWhatsAppRuntime } from "./whatsapp/runtime";
import type { WhatsAppTemplateRequest } from "./whatsapp/templates";
import { startWhatsAppWindowKeepAliveJob } from "./whatsapp/window-keepalive";

export interface ServerHandle {
  config: Config;
  server: ReturnType<typeof serve>;
  db: Kysely<DB>;
  whatsapp: WhatsAppSocketFacade;
  whatsappRuntime: ReturnType<typeof createWhatsAppRuntime>;
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
    featureAutoMintThreshold: config.FEATURE_AUTO_MINT_THRESHOLD,
    birthGateTypes: new Set<ProposeEntityType>(["project", "product", "team"]),
    birthGateLiveTypes: new Set<ProposeEntityType>(["product", "project"]),
    structuralAutoBirthTypes: new Set<ProposeEntityType>(["project"]),
    birthGateDryRun: config.BIRTH_GATE_DRY_RUN,
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
  const operationalAlertsRepo = createOperationalAlertsRepository(db);
  const operationalAlertService = createOperationalAlertService({ alerts: operationalAlertsRepo });
  const agentEnvironmentVariables = createAgentEnvironmentVariableRepository(db, config.ENCRYPTION_KEY);
  await backfillFilesConnectorCredentialEncryption(db, config.ENCRYPTION_KEY, logger);
  await runManagedSeed(config, settingsRepo, users);
  await migrateManagedConnectorCredentialsToCanvas({ db, appConfig: config, logger });
  const mcpServersRepo = createMcpServerRepository(db);
  const whatsappGroupsRepo = createWhatsAppGroupRepository(db);
  const conversationsRepo = createConversationRepository(db);
  const whatsappProviderEventsRepo = createWhatsAppProviderEventRepository(db);
  const whatsappTemplateMappingsRepo = createWhatsAppTemplateMappingRepository(db);
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
  const interactiveAgentRunLimiter = createAgentRunLimiter({
    limit: config.MAX_CONCURRENT_INTERACTIVE_AGENT_RUNS,
    queue: "interactive",
    logger,
  });
  const scheduledAgentRunLimiter = createAgentRunLimiter({
    limit: config.MAX_CONCURRENT_SCHEDULED_AGENT_RUNS,
    queue: "scheduled",
    logger,
  });
  const limitAgentExecution = <T>(work: () => Promise<T>): Promise<T> => interactiveAgentRunLimiter.run(work);
  const limitScheduledAgentExecution = <T>(work: () => Promise<T>): Promise<T> => scheduledAgentRunLimiter.run(work);

  /**
   * Current LLM provider context, refreshed at startup and on settings change
   * via applyLlmEnvFromDb. Drives provider-aware cost recomputation without an
   * extra per-run settings query.
   */
  let providerCtx: ProviderContext = { provider: null, modelId: null };

  const recordWorkflowStep = createWorkflowStepRecorder(tracer, pricing, () => providerCtx);

  const runTrackedAgent = async (
    params: RunAgentParams,
    limitExecution: <T>(work: () => Promise<T>) => Promise<T>,
  ): Promise<RunAgentResult> => {
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
      maxAttachmentTotalBytes: params.maxAttachmentTotalBytes ?? config.MAX_ATTACHMENT_TOTAL_MB * 1024 * 1024,
      settingsEncryptionKey: params.settingsEncryptionKey ?? config.ENCRYPTION_KEY,
      localDeviceInvoker: params.localDeviceInvoker ?? localDeviceGateway,
      localClaudeSessionService: params.localClaudeSessionService ?? localClaudeSessionService,
      agentRuntime: params.agentRuntime ?? config.AGENT_RUNTIME,
      loadAgentRuntimeProviderConfig:
        params.loadAgentRuntimeProviderConfig ??
        (async () => resolveAgentRuntimeProviderConfigFromSettings(await settingsRepo.get())),
      ...(Object.keys(resolvedAgentEnv).length > 0
        ? {
            agentEnv: resolvedAgentEnv,
          }
        : {}),
    };
    return limitExecution(() =>
      instrumentAgentRun(tracer, pricing, providerCtx, enrichedParams, () => runAgent(enrichedParams)),
    );
  };
  const trackedRunAgent = (params: RunAgentParams): Promise<RunAgentResult> =>
    runTrackedAgent(params, limitAgentExecution);
  const trackedScheduledRunAgent = (
    params: RunAgentParams,
    admission?: AgentRunAdmissionOptions,
  ): Promise<RunAgentResult> => runTrackedAgent(params, (work) => scheduledAgentRunLimiter.run(work, admission));

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
  const queueManager = new QueueManager({ logger });

  // 7. Slack infrastructure
  const userCache = new UserCache();
  let slack: SlackBot | null = null;

  // 8. WhatsApp
  const usesBaileys = config.WHATSAPP_DM_PROVIDER === "baileys" || config.WHATSAPP_GROUP_PROVIDER === "baileys";
  let whatsappSupervisor: WhatsAppGatewaySupervisor | null = null;
  let inProcessWhatsAppLease: InProcessWhatsAppLease | null = null;
  let whatsappBot: WhatsAppBot | null = null;
  let whatsapp: WhatsAppSocketFacade;
  if (config.WHATSAPP_RUNTIME_MODE === "gateway" && usesBaileys) {
    whatsappSupervisor = new WhatsAppGatewaySupervisor({
      db,
      config,
      logger,
      onSocketStateChange: (change) => operationalAlertService.observeBaileysSocketState(change),
    });
    /**
     * Keeps one application facade stable across gateway child exits and reads
     * status from the live supervisor client after startup or pairing.
     */
    const createGatewayFacade = async (): Promise<GatewayClientFacade> => {
      const lease = await db
        .selectFrom("whatsapp_session_lease")
        .select("gateway_http_token")
        .where("id", "=", "default")
        .executeTakeFirst();
      return new GatewayClientFacade({
        baseUrl: `http://127.0.0.1:${config.WHATSAPP_GATEWAY_PORT}`,
        token: lease?.gateway_http_token ?? "gateway-not-started",
        logger,
        beforePairingStart: () => whatsappSupervisor?.ensurePairingReady().then(() => undefined) ?? Promise.resolve(),
        pairingStatus: async () =>
          whatsappSupervisor?.facade?.pairing.status() ?? { connected: false, phoneNumber: null },
      });
    };
    if (connect) await whatsappSupervisor.start();
    whatsapp = await createGatewayFacade();
  } else {
    inProcessWhatsAppLease = new InProcessWhatsAppLease({
      db,
      config,
      logger,
      onOwnershipLost: async () => {
        await whatsappBot?.stop();
      },
    });
    whatsappBot = new WhatsAppBot({
      db,
      logger,
      groupMetadataStore: whatsappGroupsRepo,
      beforeSocketOpen: usesBaileys
        ? async () => {
            await inProcessWhatsAppLease?.acquire();
            await inProcessWhatsAppLease?.assertOwned();
          }
        : undefined,
      authStateFactory: usesBaileys
        ? () =>
            createDbAuthState(db, logger, {
              withWriteFence: (callback) => {
                if (!inProcessWhatsAppLease) throw new Error("In-process WhatsApp lease is unavailable");
                return inProcessWhatsAppLease.withLeaseFence(callback);
              },
            })
        : undefined,
      onLoggedOut: usesBaileys
        ? async () => {
            await inProcessWhatsAppLease?.resetHistoryGeneration();
          }
        : undefined,
    });
    whatsapp = new InProcessSocketFacade(
      whatsappBot,
      logger,
      usesBaileys
        ? async () => {
            await inProcessWhatsAppLease?.resetHistoryGeneration();
          }
        : undefined,
    );
  }
  const gatewayInboundSource = {
    get isConnected() {
      return whatsappSupervisor?.isConnected ?? false;
    },
    onMessage() {},
    onHistoryMessages() {},
  };
  const baileysWhatsApp = createBaileysWhatsAppProviders(whatsapp, whatsappBot ?? gatewayInboundSource, logger);
  const watiWhatsApp =
    config.WHATSAPP_DM_PROVIDER === WHATSAPP_WATI_PROVIDER_ID
      ? createWatiWhatsAppProvider({
          apiEndpoint: config.WATI_API_ENDPOINT ?? "",
          accessToken: config.WATI_ACCESS_TOKEN ?? "",
          webhookToken: config.WATI_WEBHOOK_TOKEN ?? "",
          channelPhoneNumber: config.WATI_CHANNEL_PHONE_NUMBER,
          logger,
          providerEvents: whatsappProviderEventsRepo,
          templateMappings: whatsappTemplateMappingsRepo,
        })
      : null;
  const managedWhatsApp =
    config.WHATSAPP_DM_PROVIDER === WHATSAPP_MANAGED_PROVIDER_ID
      ? createManagedWhatsAppProvider({
          platformUrl: config.MANAGED_WHATSAPP_PLATFORM_URL ?? "",
          tenantToken: config.MANAGED_WHATSAPP_TENANT_TOKEN ?? "",
          logger,
        })
      : null;
  const whatsappRuntime = createWhatsAppRuntime({
    dmProviderId: config.WHATSAPP_DM_PROVIDER,
    groupProviderId: config.WHATSAPP_GROUP_PROVIDER,
    dmProviders: [
      baileysWhatsApp.dmProvider,
      ...(watiWhatsApp ? [watiWhatsApp.dmProvider] : []),
      ...(managedWhatsApp ? [managedWhatsApp.dmProvider] : []),
    ],
    groupProviders: [baileysWhatsApp.groupProvider],
    inboundProviders: [
      baileysWhatsApp.inboundProvider,
      ...(watiWhatsApp ? [watiWhatsApp.inboundProvider] : []),
      ...(managedWhatsApp ? [managedWhatsApp.inboundProvider] : []),
    ],
    logger,
  });
  const operationalAlertWorker =
    connect && whatsappSupervisor
      ? new OperationalAlertWorker({
          alerts: operationalAlertsRepo,
          users,
          settings: settingsRepo,
          definitions: createOperationalAlertDefinitions({
            isBaileysGatewayDisconnected: () =>
              Boolean(whatsappSupervisor?.requiresPairing || !whatsappSupervisor?.isConnected),
          }),
          transports: {
            whatsapp: createWhatsAppOperationalAlertTransport({
              whatsapp: whatsappRuntime,
              conversations: conversationsRepo,
            }),
          },
          logger,
        })
      : null;
  operationalAlertService.setWake(() => operationalAlertWorker?.wake());
  operationalAlertWorker?.start();

  const sendDirectMessage = async ({
    userId,
    platform,
    message,
    template,
    senderUserId,
    inboxKind,
    inboxMetadata,
  }: {
    userId: string;
    platform: string;
    message: string;
    template?: WhatsAppTemplateRequest;
    senderUserId?: string;
    /**
     * This adapter does not create a duplicate inbox row for successful
     * in-window WhatsApp text sends; callers that want sender-visible inbox
     * bookkeeping own that after delivery. Out-of-window WhatsApp content is
     * always parked by proactive delivery regardless of this flag so the full
     * message is never silently dropped.
     */
    storeInInbox?: boolean;
    inboxKind?: string;
    inboxMetadata?: Record<string, unknown> | null;
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

      const target = { kind: "dm" as const, phoneE164: recipient.whatsapp_number };
      const channelId = whatsappDeliveryTargetFromTarget(target);
      if (template) {
        const sent = await whatsappRuntime.sendTemplate(target, template);
        return { channelId, messageRef: sent?.providerMessageId ?? "" };
      }

      const result = await deliverProactiveDm({
        target,
        recipientUserId: userId,
        senderUserId: senderUserId ?? userId,
        text: message,
        whatsapp: whatsappRuntime,
        conversations: conversationsRepo,
        inboxMessages: inboxMessagesRepo,
        logger,
        recipientName: recipient.name,
        recipientPhoneE164: recipient.whatsapp_number,
        inboxKind: inboxKind ?? (senderUserId ? "note" : WORKFLOW_OUTPUT_INBOX_KIND),
        inboxMetadata: inboxMetadata ?? null,
      });
      const sent = result.sent;

      if (result.mode === "text" && sent?.providerMessageId) {
        const settingsRow = await settingsRepo.get();
        const conversation = await conversationsRepo.getOrCreate(
          { platform: "whatsapp", kind: "dm", providerConversationId: channelId },
          recipient.name,
        );
        await conversationsRepo.insertMessage({
          conversationId: conversation.id,
          providerMessageId: sent.providerMessageId,
          senderJid: "bot",
          senderName: settingsRow?.bot_name ?? "Sketch",
          isBot: true,
          addressedToSketch: false,
          text: message,
          providerTimestamp: sent.providerTimestamp,
        });
      }

      return {
        channelId,
        messageRef: sent?.providerMessageId ?? "",
        ...(result.inboxMessageId ? { inboxMessageId: result.inboxMessageId } : {}),
      };
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
    whatsapp: whatsappRuntime,
    settingsRepo,
    runAgent: trackedRunAgent,
    runScheduledAgent: trackedScheduledRunAgent,
    buildMcpServers,
    loadIntegrationProvider,
    listAgentEnvForRuntime: (context) => agentEnvironmentVariables.listForRuntimeContext(context),
    automationRunsRepo,
    stepContentRepo,
    userRepo: users,
    inboxMessagesRepo,
    sendDm: sendDirectMessage,
    recordWorkflowStep,
    limitAgentExecution,
    limitScheduledAgentExecution,
  });
  await scheduler.start();

  // 8.6. Connector sync scheduler — recovers stale syncs, runs periodic sync + enrichment
  const syncScheduler = startSyncScheduler(db, logger, 30 * 60 * 1000, { appConfig: config });

  // 8.7. Fix 2b normalization backfill — populates indexed corroboration columns
  // for pre-migration rows in the background; readers stay on the legacy path
  // until it completes, so this must not block startup readiness.
  const normalizationBackfill = startNormalizationBackfill(db, logger);
  const whatsappWindowKeepAliveJob = config.WHATSAPP_WINDOW_KEEPALIVE_ENABLED
    ? startWhatsAppWindowKeepAliveJob({
        db,
        logger,
        whatsapp: whatsappRuntime,
        settingsRepo,
      })
    : null;
  const agentOutputDelivery = createAgentOutputDeliveryService({
    db,
    logger,
    getSlack: () => slack,
    whatsapp: whatsappRuntime,
    settingsRepo,
  });
  const agentRunService = new AgentRunService({
    db,
    config,
    logger,
    users,
    settings: settingsRepo,
    runAgent: trackedRunAgent,
    runScheduledAgent: trackedScheduledRunAgent,
    buildMcpServers,
    loadIntegrationProvider,
    queueManager,
    outputDelivery: agentOutputDelivery,
    getSlack: () => slack,
    getWhatsApp: () => whatsapp,
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

  const whatsappHandlers = wireWhatsAppHandlers(whatsappRuntime, {
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
  const whatsappInboundConsumer = new WhatsAppInboundConsumer({
    db,
    logger,
    handlers: whatsappHandlers,
    shouldHandleInboundMessage: whatsappRuntime.shouldHandleInboundMessage,
    stagingDir: join(config.DATA_DIR, "wa-staging"),
  });
  await createWhatsAppInboundEventsRepository(db).resetDispatched();
  whatsappInboundConsumer.start();
  const whatsappInboundRetention = startWhatsAppInboundRetention({
    db,
    logger,
    stagingDir: join(config.DATA_DIR, "wa-staging"),
  });

  // 9. HTTP server
  const app = createApp(db, config, {
    whatsapp,
    whatsappRuntime,
    watiWebhook: watiWhatsApp ?? undefined,
    managedWhatsapp: managedWhatsApp ?? undefined,
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
    getWhatsAppHealth: () => ({ missingProviderIdEvents: whatsappInboundConsumer.missingProviderIdEvents }),
    localDeviceGateway,
    localClaudeSessionService,
    agentRunService,
    limitAgentExecution,
    ...(whatsapp instanceof GatewayClientFacade
      ? {
          whatsappWakeToken: whatsapp.gatewayToken,
          onWhatsAppWake: () => whatsappInboundConsumer.wake(),
          onWhatsAppSocketStateChange: (change: Parameters<WhatsAppGatewaySupervisor["handleSocketStateChange"]>[0]) =>
            whatsappSupervisor?.handleSocketStateChange(change),
        }
      : {}),
  });
  const server = serve({ fetch: app.fetch, port: config.PORT });
  await whatsappSupervisor?.refreshHealth();
  localDeviceGateway.attach(server);
  logger.info({ port: config.PORT }, "HTTP server started");

  // 10. Start platforms
  if (connect) {
    await startSlackBotIfConfigured().catch(() => {});

    const whatsappConnected = whatsappBot ? await whatsappBot.start() : (await whatsapp.pairing.status()).connected;
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
    await operationalAlertWorker?.stop();
    await whatsappInboundConsumer.stop();
    whatsappInboundRetention.stop();
    normalizationBackfill.stop();
    await telemetry.shutdown();
    await syncScheduler.stop();
    whatsappWindowKeepAliveJob?.stop();
    agentScheduler.stop();
    scheduler.stop();
    if (slack) await slack.stop();
    if (whatsappSupervisor) {
      await whatsappSupervisor.shutdown();
    } else {
      await whatsapp.shutdown();
      await inProcessWhatsAppLease?.release();
    }
    server.close();
    await db.destroy();
  }

  return {
    config,
    server,
    db,
    whatsapp,
    whatsappRuntime,
    getSlack: () => slack,
    shutdown,
  };
}
