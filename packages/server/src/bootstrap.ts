import { randomUUID } from "node:crypto";
import { join } from "node:path";
/**
 * Server bootstrap — wires config, DB, repos, platform adapters, and HTTP into a
 * running server. Extracted from index.ts so the full stack can be instantiated
 * from tests with a custom Config and { connect: false }.
 */
import { serve } from "@hono/node-server";
import { DisconnectReason } from "@whiskeysockets/baileys";
import type { Kysely } from "kysely";
import { type AgentRunAdmissionOptions, createAgentRunLimiter } from "./agent/concurrency-limiter";
import { disableSdkAttributionHeader, removeReservedAgentEnv } from "./agent/environment";
import { createQuestionInteractionServiceFromRepository } from "./agent/interactions/service";
import { applyLlmEnvFromSettings } from "./agent/llm-env";
import { type RunAgentResult, runAgent } from "./agent/runner";
import type { McpServerConfig, RunAgentParams } from "./agent/runner";
import { resolveAgentRuntimeProviderConfigFromSettings } from "./agent/runtime/provider";
import { createAgentOutputDeliveryService } from "./agents/output-delivery";
import { AgentScheduler } from "./agents/scheduler";
import { AgentRunService } from "./agents/service";
import { createAiSdkAutomationAuthoringGenerator } from "./automation/authoring/generator";
import { createAutomationAuthoringProviderLoader } from "./automation/authoring/provider";
import { createAutomationAuthoringService } from "./automation/authoring/service";
import { createAutomationAuthoringTelemetry } from "./automation/authoring/telemetry";
import { createAutomationCapabilityRegistry } from "./automation/capabilities";
import { createChatAutomationAuthoring } from "./automation/chat-authoring";
import { isAutomationWebhookTrigger, parseAutomationTriggerConfig } from "./automation/webhook";
import type { Config } from "./config";
import { migrateManagedConnectorCredentialsToCanvas } from "./connectors/managed-credential-migration";
import { ensureSlackConnectorConfig } from "./connectors/slack-provisioning";
import { archiveAllSlackChannelFiles } from "./connectors/slack-salience";
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
import { createQuestionInteractionsRepository } from "./db/repositories/question-interactions";
import { createSettingsRepository } from "./db/repositories/settings";
import { createSlackChannelParticipantsRepository } from "./db/repositories/slack-channel-participants";
import { createUserEntityLinkSweepService } from "./db/repositories/user-entity-link-sweep";
import { createUserWhatsAppLidRepository } from "./db/repositories/user-whatsapp-lids";
import { createUserRepository } from "./db/repositories/users";
import { createWebhookEndpointRepository } from "./db/repositories/webhook-endpoints";
import { createWhatsAppGroupRepository } from "./db/repositories/whatsapp-groups";
import { createWhatsAppInboundEventsRepository } from "./db/repositories/whatsapp-inbound-events";
import { createWhatsAppProviderEventRepository } from "./db/repositories/whatsapp-provider-events";
import { createWhatsAppTemplateMappingRepository } from "./db/repositories/whatsapp-template-mappings";
import type { DB } from "./db/schema";
import { configureMaterializeDefaults } from "./entities/materialize";
import { startNormalizationBackfill } from "./entities/normalization-backfill";
import { isPersonalOrSharedDomain } from "./entities/personal-domains";
import type { ProposeEntityType } from "./entities/propose";
import { createApp } from "./http";
import { buildMcpConfig, createProvider } from "./integrations/factory";
import type { IntegrationProvider, IntegrationStatus } from "./integrations/types";
import { LocalClaudeSessionService } from "./local-devices/claude-sessions";
import { LocalDeviceGateway } from "./local-devices/gateway";
import { createLogger } from "./logger";
import type { Logger } from "./logger";
import { reconcileManagedTenantMembers } from "./managed-members";
import { runManagedSeed } from "./managed-seed";
import { channelsReconnectUrl, createOperationalAlertDefinitions } from "./operational-alerts/definitions";
import { createOperationalAlertService } from "./operational-alerts/service";
import { createWhatsAppOperationalAlertTransport } from "./operational-alerts/whatsapp-transport";
import { OperationalAlertWorker } from "./operational-alerts/worker";
import { QueueManager } from "./queue";
import { TaskScheduler } from "./scheduler/service";
import { syncFeaturedSkills } from "./skills/sync";
import { createConfiguredSlackBot, validateSlackTokens } from "./slack/adapter";
import type { SlackBot } from "./slack/bot";
import { createSlackEntitySync } from "./slack/entity-sync";
import { createSettingsBackedSlackIndexingFacade } from "./slack/indexing-facade";
import { SlackMembershipReconciler } from "./slack/membership-reconciler";
import { createSlackStartupManager } from "./slack/startup";
import { UserCache } from "./slack/user-cache";
import { type ProviderContext, createWorkflowStepRecorder, instrumentAgentRun } from "./telemetry/agent-run-telemetry";
import { initTelemetry } from "./telemetry/setup";
import { resolveVisionConfigFromAppConfig } from "./vision/service";
import { wireWhatsAppHandlers } from "./whatsapp/adapter";
import { createDbAuthState } from "./whatsapp/auth-store";
import { WhatsAppBackfillWorker } from "./whatsapp/backfill-worker";
import { WhatsAppBot } from "./whatsapp/bot";
import type { WhatsAppSocketFacade } from "./whatsapp/facade-contract";
import { GatewayClientFacade } from "./whatsapp/gateway-client-facade";
import { InProcessWhatsAppLease, WhatsAppGatewaySupervisor } from "./whatsapp/gateway/supervisor";
import { InProcessSocketFacade } from "./whatsapp/in-process-socket-facade";
import { WhatsAppInboundConsumer } from "./whatsapp/inbound-consumer";
import { safeWhatsAppErrorFields } from "./whatsapp/privacy";
import { WORKFLOW_OUTPUT_INBOX_KIND, deliverProactiveDm } from "./whatsapp/proactive-delivery";
import { whatsappDeliveryTargetFromTarget } from "./whatsapp/provider";
import { createBaileysWhatsAppProviders } from "./whatsapp/providers/baileys";
import { WHATSAPP_MANAGED_PROVIDER_ID, createManagedWhatsAppProvider } from "./whatsapp/providers/managed";
import { WHATSAPP_WATI_PROVIDER_ID, createWatiWhatsAppProvider } from "./whatsapp/providers/wati";
import { startWhatsAppInboundRetention } from "./whatsapp/retention";
import { createWhatsAppRuntime } from "./whatsapp/runtime";
import type { WhatsAppTemplateRequest } from "./whatsapp/templates";
import { WhatsAppUserLidRefresh } from "./whatsapp/user-lid-refresh";
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
 * Options for createServer. `connect: false` avoids Slack and WhatsApp startup.
 * `externalStartup: false` also skips startup work that can contact remote services.
 * `backgroundWork: false` keeps schedulers, backfills, and inbound consumers stopped.
 */
export interface CreateServerOptions {
  connect?: boolean;
  externalStartup?: boolean;
  backgroundWork?: boolean;
}

export async function seedSlackOrganizationDomain(
  db: Kysely<DB>,
  logger?: Pick<Logger, "warn">,
): Promise<string | null> {
  const admins = await db
    .selectFrom("users")
    .select(["email", "email_verified_at"])
    .where("auth_role", "=", "admin")
    .where("email_verified_at", "is not", null)
    .where("email", "is not", null)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
  const domains = new Map<string, string>();
  for (const admin of admins) {
    const rawVerifiedAt: unknown = admin.email_verified_at;
    const verifiedAt =
      rawVerifiedAt instanceof Date
        ? rawVerifiedAt.toISOString()
        : typeof rawVerifiedAt === "string"
          ? rawVerifiedAt
          : null;
    if (!verifiedAt) continue;
    const email = admin.email?.trim().toLowerCase() ?? "";
    const at = email.lastIndexOf("@");
    const domain = at > 0 ? email.slice(at + 1).trim() : "";
    if (!domain || isPersonalOrSharedDomain(domain)) continue;
    domains.set(domain, verifiedAt);
  }

  if (domains.size === 0) {
    logger?.warn(
      "No corporate admin email domains could be seeded; classification defaults to external without domain or roster evidence",
    );
    return null;
  }

  for (const [domain, verifiedAt] of domains) {
    await db
      .insertInto("organization_domains")
      .values({
        id: randomUUID(),
        domain,
        source: "admin_email_seed",
        verified_at: verifiedAt,
      })
      .onConflict((oc) => oc.column("domain").doNothing())
      .execute();
  }
  return domains.keys().next().value ?? null;
}

export async function createServer(config: Config, options?: CreateServerOptions): Promise<ServerHandle> {
  const connect = options?.connect !== false;
  const externalStartup = options?.externalStartup !== false;
  const backgroundWork = options?.backgroundWork !== false;

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
  if (externalStartup) await syncFeaturedSkills(config, logger);

  // 3. Repositories
  const users = createUserRepository(db, { slackEntitySyncEnabled: config.SLACK_ENTITY_SYNC });
  const userWhatsAppLids = createUserWhatsAppLidRepository(db);
  const channels = createChannelRepository(db);
  const settingsRepo = createSettingsRepository(db, config.ENCRYPTION_KEY);
  const operationalAlertsRepo = createOperationalAlertsRepository(db);
  const operationalAlertService = createOperationalAlertService({ alerts: operationalAlertsRepo, logger });
  const agentEnvironmentVariables = createAgentEnvironmentVariableRepository(db, config.ENCRYPTION_KEY);
  await backfillFilesConnectorCredentialEncryption(db, config.ENCRYPTION_KEY, logger);
  await runManagedSeed(config, settingsRepo, users);
  await seedSlackOrganizationDomain(db, logger);
  if (externalStartup) await migrateManagedConnectorCredentialsToCanvas({ db, appConfig: config, logger });
  const mcpServersRepo = createMcpServerRepository(db);
  const whatsappGroupsRepo = createWhatsAppGroupRepository(db);
  const conversationsRepo = createConversationRepository(db);
  const slackChannelParticipantsRepo = createSlackChannelParticipantsRepository(db);
  const whatsappProviderEventsRepo = createWhatsAppProviderEventRepository(db);
  const whatsappTemplateMappingsRepo = createWhatsAppTemplateMappingRepository(db);
  const questionInteractionsRepo = createQuestionInteractionsRepository(db);
  const questionInteractions = createQuestionInteractionServiceFromRepository(questionInteractionsRepo);
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
  let chatAutomationAuthoring: ReturnType<typeof createChatAutomationAuthoring> | undefined;

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
      slackEntitySyncEnabled: params.slackEntitySyncEnabled ?? config.SLACK_ENTITY_SYNC,
      localDeviceInvoker: params.localDeviceInvoker ?? localDeviceGateway,
      localClaudeSessionService: params.localClaudeSessionService ?? localClaudeSessionService,
      agentRuntime: params.agentRuntime ?? config.AGENT_RUNTIME,
      loadAgentRuntimeProviderConfig:
        params.loadAgentRuntimeProviderConfig ??
        (async () => resolveAgentRuntimeProviderConfigFromSettings(await settingsRepo.get())),
      automationAuthoringEnabled:
        params.contextType !== "scheduled_task" && config.AUTOMATION_AUTHORING_MODEL !== undefined,
      chatAutomationAuthoring: params.contextType !== "scheduled_task" ? chatAutomationAuthoring : undefined,
      ...(Object.keys(resolvedAgentEnv).length > 0
        ? {
            agentEnv: resolvedAgentEnv,
          }
        : {}),
    };
    return limitExecution(() =>
      instrumentAgentRun(
        tracer,
        pricing,
        providerCtx,
        enrichedParams,
        () => runAgent(enrichedParams),
        config.AGENT_RUN_WATCHDOG_MS,
      ),
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
  const slackMembershipReconciler = new SlackMembershipReconciler({
    db,
    logger,
    getSlack: () => slack,
  });

  // 8. WhatsApp
  const usesBaileys = config.WHATSAPP_DM_PROVIDER === "baileys" || config.WHATSAPP_GROUP_PROVIDER === "baileys";
  let whatsappSupervisor: WhatsAppGatewaySupervisor | null = null;
  let inProcessWhatsAppLease: InProcessWhatsAppLease | null = null;
  let whatsappBot: WhatsAppBot | null = null;
  let whatsapp: WhatsAppSocketFacade;
  const observeInProcessBaileysSocketState = async (
    socketState: "connected" | "disconnected" | "logged-out",
    socketGeneration: number,
    statusCode?: number,
  ): Promise<void> => {
    const identity = inProcessWhatsAppLease?.socketStateIdentity;
    if (!identity) return;
    await operationalAlertService.observeBaileysSocketState({
      ...identity,
      socketGeneration,
      socketState,
      ...(statusCode === undefined ? {} : { statusCode }),
      reason: `inprocess_${socketState}`,
    });
  };
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
      onConnectionOpen: usesBaileys
        ? async (socketGeneration) => {
            await observeInProcessBaileysSocketState("connected", socketGeneration);
          }
        : undefined,
      onConnectionClose: usesBaileys
        ? async (statusCode, socketGeneration) => {
            await observeInProcessBaileysSocketState(
              statusCode === DisconnectReason.loggedOut ? "logged-out" : "disconnected",
              socketGeneration,
              statusCode,
            );
          }
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
  const baileysWhatsApp = createBaileysWhatsAppProviders(whatsapp, whatsappBot ?? gatewayInboundSource, logger, {
    getLeaseGeneration: () => inProcessWhatsAppLease?.generation ?? null,
  });
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
  const whatsappUserLidRefresh = new WhatsAppUserLidRefresh({
    whatsapp,
    store: userWhatsAppLids,
    logger,
  });
  const operationalAlertWorker =
    backgroundWork && connect && usesBaileys
      ? new OperationalAlertWorker({
          alerts: operationalAlertsRepo,
          users,
          settings: settingsRepo,
          definitions: createOperationalAlertDefinitions({
            isBaileysGatewayDisconnected: () =>
              whatsappSupervisor
                ? whatsappSupervisor.requiresPairing || !whatsappSupervisor.isConnected
                : Boolean(whatsappBot && !whatsappBot.isConnected),
            getConnectedWhatsAppNumber: async () => (await whatsapp.pairing.status()).phoneNumber ?? null,
            reconnectUrl: channelsReconnectUrl(config.BASE_URL),
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

  const webhookEndpoints = createWebhookEndpointRepository(db);
  const batchSize = 500;
  let lastTaskId: string | undefined;
  for (;;) {
    let query = db
      .selectFrom("scheduled_tasks")
      .select(["id", "steps", "schedule_type", "schedule_value"])
      .where("schedule_type", "=", "external")
      .orderBy("id", "asc")
      .limit(batchSize);
    if (lastTaskId) query = query.where("id", ">", lastTaskId);
    const nativeWebhookTasks = await query.execute();
    if (nativeWebhookTasks.length === 0) break;
    for (const task of nativeWebhookTasks) {
      const trigger = parseAutomationTriggerConfig(task.steps, {
        scheduleType: task.schedule_type,
        scheduleValue: task.schedule_value,
      });
      if (isAutomationWebhookTrigger(trigger)) await webhookEndpoints.ensureForTask(task.id);
    }
    lastTaskId = nativeWebhookTasks[nativeWebhookTasks.length - 1]?.id;
    if (nativeWebhookTasks.length < batchSize) break;
  }

  // 8.5. Task scheduler — getSlack is a lazy getter so the live slack reference is captured correctly
  const automationCapabilityRegistry = createAutomationCapabilityRegistry();
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
    automationCapabilityRegistry,
  });
  if (config.AUTOMATION_AUTHORING_MODEL) {
    const loadAuthoringProvider = createAutomationAuthoringProviderLoader({
      modelId: config.AUTOMATION_AUTHORING_MODEL,
      loadProviderConfig: async () => resolveAgentRuntimeProviderConfigFromSettings(await settingsRepo.get()),
    });
    const authoring = createAutomationAuthoringService({
      loadProvider: async () => {
        const provider = await loadAuthoringProvider();
        return {
          provider: "openrouter",
          modelId: provider.modelId,
          model: provider.model,
        };
      },
      generator: createAiSdkAutomationAuthoringGenerator(),
      telemetry: createAutomationAuthoringTelemetry({ logger, pricing }),
      configuredModelId: config.AUTOMATION_AUTHORING_MODEL,
    });
    chatAutomationAuthoring = createChatAutomationAuthoring({
      db,
      authoring,
      scheduler,
      loadIntegrationProvider,
      encryptionKey: config.ENCRYPTION_KEY,
    });
  }
  if (backgroundWork) await scheduler.start();

  // 8.6. Connector sync scheduler — recovers stale syncs, runs periodic sync + enrichment
  const slackIndexingFacade = createSettingsBackedSlackIndexingFacade({
    db,
    encryptionKey: config.ENCRYPTION_KEY,
    userCache,
    onOAuthScopes: (scopes) => {
      if (!scopes) {
        logger.warn(
          { requiredScope: "users:read.email" },
          "Slack OAuth scopes were not returned; users:read.email status is indeterminate",
        );
        return;
      }
      if (!scopes.includes("users:read.email")) {
        logger.warn(
          { requiredScope: "users:read.email", grantedScopes: scopes },
          "Slack OAuth token is missing users:read.email; Slack entity classification will degrade",
        );
      }
    },
  });
  const slackEntitySync = createSlackEntitySync({
    db,
    logger,
    enabled: config.SLACK_ENTITY_SYNC && backgroundWork && externalStartup,
    publicChannelsEnabled: config.SLACK_ENTITY_SYNC_PUBLIC_CHANNELS,
    userInfoCap: config.SLACK_ENTITY_SYNC_USER_INFO_CAP,
    sweepIntervalMs: config.SLACK_ENTITY_SWEEP_INTERVAL_MS,
    getActiveConnection: async () => {
      const settings = await settingsRepo.get();
      if (!settings?.slack_bot_token || !settings.slack_team_id) return null;
      return { botToken: settings.slack_bot_token, teamId: settings.slack_team_id };
    },
    createFacade: (botToken) => {
      const pinned = slackIndexingFacade.withToken?.(botToken, { isolatedLimiter: true });
      if (!pinned || !pinned.listUsersPage || !pinned.listChannelsPage || !pinned.listChannelMembersPage) {
        throw new Error("Slack indexing facade cannot pin a connection token");
      }
      return {
        listUsersPage: pinned.listUsersPage,
        listChannelsPage: pinned.listChannelsPage,
        listChannelMembersPage: pinned.listChannelMembersPage,
        getUserInfo: pinned.getUserInfo,
      };
    },
  });
  if (backgroundWork && externalStartup) slackEntitySync.start();
  const userEntityLinkSweep = createUserEntityLinkSweepService({ db, users, logger });
  if (config.SLACK_ENTITY_SYNC && backgroundWork && externalStartup) userEntityLinkSweep.start();
  const syncScheduler = backgroundWork
    ? startSyncScheduler(db, logger, 30 * 60 * 1000, { appConfig: config, slackIndexingFacade })
    : null;
  if (backgroundWork && (await settingsRepo.get())?.slack_bot_token) {
    await ensureSlackConnectorConfig({ db, encryptionKey: config.ENCRYPTION_KEY, logger });
  }

  // 8.7. Fix 2b normalization backfill — populates indexed corroboration columns
  // for pre-migration rows in the background; readers stay on the legacy path
  // until it completes, so this must not block startup readiness.
  const normalizationBackfill = backgroundWork ? startNormalizationBackfill(db, logger) : null;
  const whatsappWindowKeepAliveJob =
    backgroundWork && config.WHATSAPP_WINDOW_KEEPALIVE_ENABLED
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
  if (backgroundWork) agentScheduler.start();

  const slackAdapterDeps = {
    db,
    config,
    logger,
    repos: {
      users,
      channels,
      settings: settingsRepo,
      conversations: conversationsRepo,
      slackChannelParticipants: slackChannelParticipantsRepo,
    },
    queue: queueManager,
    questionInteractions,
    slack: { userCache },
    runAgent: trackedRunAgent,
    buildMcpServers,
    loadIntegrationProvider,
    scheduler,
    stepContentRepo,
    automationRunsRepo,
    inboxMessagesRepo,
    sendDm: sendDirectMessage,
    slackEntitySync,
    recordSlackChannelParticipantJoined: (channelId: string, slackUserId: string) =>
      slackMembershipReconciler.recordParticipantJoined(channelId, slackUserId),
    recordSlackChannelParticipantObserved: (channelId: string, slackUserId: string) =>
      slackMembershipReconciler.recordParticipantObserved(channelId, slackUserId),
    recordSlackChannelParticipantLeft: (channelId: string, slackUserId: string) =>
      slackMembershipReconciler.recordParticipantLeft(channelId, slackUserId),
    onSlackChannelDiscovered: () => {
      void slackMembershipReconciler.wake().catch((err) => {
        logger.warn({ err }, "Slack membership reconciliation failed after channel discovery");
      });
    },
  };

  const startSlackBotIfConfigured = createSlackStartupManager({
    logger,
    slackMode: config.SLACK_MODE,
    getSettingsTokens: async () => {
      const settingsRow = await settingsRepo.get();
      return {
        botToken: settingsRow?.slack_bot_token,
        appToken: settingsRow?.slack_app_token,
        teamId: settingsRow?.slack_team_id,
      };
    },
    validateTokens: validateSlackTokens,
    onConnectionActivated: (connection) => slackEntitySync.onConnectionActivated(connection),
    getCurrentTeamId: async () => (await settingsRepo.get())?.slack_team_id ?? null,
    getCurrentBot: () => slack,
    setCurrentBot: (bot) => {
      slack = bot;
    },
    createBot: (tokens) => createConfiguredSlackBot(tokens, slackAdapterDeps),
    beforeExplicitTokenReplacement: async (replacement) => {
      const previousTeamId = replacement?.previousTeamId ?? null;
      const nextTeamId = replacement?.nextTeamId ?? null;
      if (previousTeamId && previousTeamId === nextTeamId) return;

      const participantsBefore = await db
        .selectFrom("slack_channel_participants")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      await slackMembershipReconciler.clearAllParticipants();

      const slackConnector = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .executeTakeFirst();
      let filesArchived = 0;
      if (slackConnector) {
        filesArchived = await archiveAllSlackChannelFiles({
          db,
          logger,
          connectorConfigId: slackConnector.id,
          slackEntitySyncEnabled: config.SLACK_ENTITY_SYNC,
        });
      }
      let syncRowsFenced = 0;
      if (previousTeamId) {
        const result = await db
          .updateTable("slack_user_sync_state")
          .set({ inactive_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .where("team_id", "=", previousTeamId)
          .where("inactive_at", "is", null)
          .executeTakeFirst();
        syncRowsFenced = Number(result.numUpdatedRows ?? 0);
      }
      if (Number(participantsBefore.count) > 0 || filesArchived > 0 || syncRowsFenced > 0) {
        logger.warn(
          { previousTeamId, nextTeamId, filesArchived, syncRowsFenced },
          "Slack team changed; old-team participants and indexed files were fenced",
        );
      }
    },
  });

  const whatsappAdapterDeps = {
    db,
    config,
    logger,
    repos: { users, settings: settingsRepo, whatsappGroups: whatsappGroupsRepo, conversations: conversationsRepo },
    queue: queueManager,
    questionInteractions,
    runAgent: trackedRunAgent,
    buildMcpServers,
    loadIntegrationProvider,
    scheduler,
    stepContentRepo,
    automationRunsRepo,
    inboxMessagesRepo,
    sendDm: sendDirectMessage,
  };
  const whatsappHandlers = wireWhatsAppHandlers(whatsappRuntime, whatsappAdapterDeps);
  const whatsappInboundConsumerRef: { current: WhatsAppInboundConsumer | null } = { current: null };
  const whatsappBackfillWorker =
    whatsapp instanceof GatewayClientFacade
      ? new WhatsAppBackfillWorker({
          db,
          config,
          logger,
          facade: whatsapp,
          handlers: whatsappHandlers,
          shouldHandleInboundMessage: whatsappRuntime.shouldHandleInboundMessage,
          onRequestAccepted: () => whatsappInboundConsumerRef.current?.wake(),
        })
      : null;
  const whatsappInboundConsumer = new WhatsAppInboundConsumer({
    db,
    logger,
    handlers: whatsappHandlers,
    shouldHandleInboundMessage: whatsappRuntime.shouldHandleInboundMessage,
    stagingDir: join(config.DATA_DIR, "wa-staging"),
    backfillWindowDays: config.WHATSAPP_HISTORY_LOOKBACK_DAYS,
    backfillWorker: whatsappBackfillWorker ?? undefined,
  });
  whatsappInboundConsumerRef.current = whatsappInboundConsumer;
  if (backgroundWork) {
    await createWhatsAppInboundEventsRepository(db).resetDispatched();
    whatsappInboundConsumer.start();
    whatsappBackfillWorker?.start();
  }
  const whatsappInboundRetention = backgroundWork
    ? startWhatsAppInboundRetention({
        db,
        logger,
        stagingDir: join(config.DATA_DIR, "wa-staging"),
      })
    : null;

  let managedMemberReconciliationPromise: ReturnType<typeof reconcileManagedTenantMembers> | null = null;
  let managedMemberReconciliationShuttingDown = false;
  const runManagedMemberReconciliation = () => {
    if (managedMemberReconciliationShuttingDown) {
      return Promise.resolve({ skipped: true, total: 0, synced: 0, conflictUserIds: [], failedUserIds: [] });
    }
    if (managedMemberReconciliationPromise) return managedMemberReconciliationPromise;
    const run = reconcileManagedTenantMembers(config, users, logger).then((result) => {
      if (!result.skipped) {
        logger.info(
          {
            total: result.total,
            synced: result.synced,
            conflicts: result.conflictUserIds.length,
            failed: result.failedUserIds.length,
          },
          "Managed member reconciliation completed",
        );
      }
      return result;
    });
    managedMemberReconciliationPromise = run;
    const clearRun = () => {
      if (managedMemberReconciliationPromise === run) {
        managedMemberReconciliationPromise = null;
      }
    };
    void run.then(clearRun, clearRun);
    return run;
  };
  const startManagedMemberReconciliation = () => {
    void runManagedMemberReconciliation().catch((err) => {
      logger.warn({ err }, "Managed member reconciliation could not start");
    });
  };

  // 9. HTTP server
  const app = createApp(db, config, {
    whatsapp,
    whatsappRuntime,
    captureWhatsAppLid: (userId, phoneE164) => {
      void whatsappUserLidRefresh.capture(userId, phoneE164).catch((error) => {
        logger.warn(
          { operation: "capture_whatsapp_lid_after_user_update", ...safeWhatsAppErrorFields(error) },
          "Detached WhatsApp LID capture failed",
        );
      });
    },
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
      void slackMembershipReconciler.wake().catch((err) => {
        logger.warn({ err }, "Slack membership reconciliation failed after token update");
      });
      if (tokens?.botToken) {
        await ensureSlackConnectorConfig({ db, encryptionKey: config.ENCRYPTION_KEY, logger });
      }
    },
    onSlackDisconnect: async () => {
      if (slack) {
        await slack.stop();
        slack = null;
      }
      await slackMembershipReconciler.clearAllParticipants();
      await settingsRepo.update({ slackBotToken: null, slackAppToken: null });
      /**
       * Revoke indexed-channel access in the same gesture instead of waiting
       * for the next scheduled sync: until archival runs, previously emitted
       * slices stay searchable under their last-known ACLs. The unconfigured
       * sync path repeats this archival as a backstop, so a failure here only
       * delays revocation rather than losing it.
       */
      try {
        const slackConnector = await db
          .selectFrom("connector_configs")
          .select("id")
          .where("connector_type", "=", "slack")
          .orderBy("created_at", "asc")
          .orderBy("id", "asc")
          .executeTakeFirst();
        if (slackConnector) {
          await archiveAllSlackChannelFiles({
            db,
            logger,
            connectorConfigId: slackConnector.id,
            slackEntitySyncEnabled: config.SLACK_ENTITY_SYNC,
          });
        }
      } catch (err) {
        logger.warn({ err }, "Failed to archive Slack files on disconnect; next sync will archive");
      }
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
    reconcileManagedMembers: runManagedMemberReconciliation,
    ...(whatsapp instanceof GatewayClientFacade
      ? {
          whatsappWakeToken: whatsapp.gatewayToken,
          onWhatsAppWake: () => whatsappInboundConsumer.wake(),
          onWhatsAppSocketStateChange: async (
            change: Parameters<WhatsAppGatewaySupervisor["handleSocketStateChange"]>[0],
          ) => {
            const accepted = (await whatsappSupervisor?.handleSocketStateChange(change)) ?? false;
            if (accepted && change.socketState === "connected") {
              await whatsappBackfillWorker?.handleConnected({
                leaseGeneration: change.generation,
                socketGeneration: change.socketGeneration,
              });
            }
          },
        }
      : {}),
  });
  const server = serve({ fetch: app.fetch, port: config.PORT });
  await whatsappSupervisor?.refreshHealth();
  localDeviceGateway.attach(server);
  logger.info({ port: config.PORT }, "HTTP server started");

  const managedMemberReconciliationEnabled = backgroundWork && externalStartup;
  const managedMemberReconciliationTimer = managedMemberReconciliationEnabled
    ? setInterval(startManagedMemberReconciliation, 5 * 60 * 1000)
    : null;
  managedMemberReconciliationTimer?.unref();
  if (managedMemberReconciliationEnabled) startManagedMemberReconciliation();
  const questionInteractionExpiryTimer = backgroundWork
    ? setInterval(
        () => {
          void questionInteractionsRepo.expireDue().catch((err) => {
            logger.warn({ err }, "Question interaction expiry sweep failed");
          });
        },
        5 * 60 * 1000,
      )
    : null;
  questionInteractionExpiryTimer?.unref();
  if (backgroundWork) {
    void questionInteractionsRepo.expireDue().catch((err) => {
      logger.warn({ err }, "Question interaction expiry sweep failed");
    });
  }

  // 10. Start platforms
  if (connect) {
    await startSlackBotIfConfigured().catch(() => {});
    if (backgroundWork && externalStartup) slackMembershipReconciler.start();

    const whatsappConnected = whatsappBot ? await whatsappBot.start() : (await whatsapp.pairing.status()).connected;
    if (whatsappConnected) {
      logger.info("WhatsApp connected");
    } else {
      logger.info("WhatsApp not paired — use GET /api/channels/whatsapp/pair to connect");
    }

    if (backgroundWork && usesBaileys) whatsappUserLidRefresh.start();

    if (!slack && !whatsappConnected) {
      logger.info("No channels active — pair WhatsApp via GET /api/channels/whatsapp/pair or configure Slack tokens");
    }
  }

  // 11. Shutdown handle
  async function shutdown() {
    logger.info("Shutting down...");
    managedMemberReconciliationShuttingDown = true;
    whatsappUserLidRefresh.stop();
    if (managedMemberReconciliationTimer) clearInterval(managedMemberReconciliationTimer);
    if (questionInteractionExpiryTimer) clearInterval(questionInteractionExpiryTimer);
    await operationalAlertWorker?.stop();
    if (backgroundWork) {
      await whatsappBackfillWorker?.stop();
      await whatsappInboundConsumer.stop();
    }
    whatsappInboundRetention?.stop();
    normalizationBackfill?.stop();
    await managedMemberReconciliationPromise?.catch(() => undefined);
    await telemetry.shutdown();
    await syncScheduler?.stop();
    await slackEntitySync.stop();
    await userEntityLinkSweep.stop();
    whatsappWindowKeepAliveJob?.stop();
    if (backgroundWork) {
      agentScheduler.stop();
      scheduler.stop();
    }
    await slackMembershipReconciler.stop();
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
