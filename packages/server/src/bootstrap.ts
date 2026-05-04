/**
 * Server bootstrap — wires config, DB, repos, platform adapters, and HTTP into a
 * running server. Extracted from index.ts so the full stack can be instantiated
 * from tests with a custom Config and { connect: false }.
 */
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Kysely } from "kysely";
import { removeReservedAgentEnv } from "./agent/environment";
import { applyLlmEnvFromSettings } from "./agent/llm-env";
import { type AgentResult, runAgent } from "./agent/runner";
import type { McpServerConfig, RunAgentParams } from "./agent/runner";
import type { Config } from "./config";
import { startSyncScheduler } from "./connectors/sync";
import { createDatabase } from "./db/index";
import { runMigrations } from "./db/migrate";
import { createAgentEnvironmentVariableRepository } from "./db/repositories/agent-environment-variables";
import { createAgentRunsRepo } from "./db/repositories/agent-runs";
import { createAutomationRunsRepository } from "./db/repositories/automation-runs";
import { createAutomationStepContentRepository } from "./db/repositories/automation-step-content";
import { createChannelRepository } from "./db/repositories/channels";
import { createInboxMessagesRepository } from "./db/repositories/inbox-messages";
import { createMcpServerRepository } from "./db/repositories/mcp-servers";
import { createSettingsRepository } from "./db/repositories/settings";
import { createUserRepository } from "./db/repositories/users";
import { createWhatsAppGroupRepository } from "./db/repositories/whatsapp-groups";
import type { DB } from "./db/schema";
import { createApp } from "./http";
import { buildMcpConfig } from "./integrations/factory";
import { createLogger } from "./logger";
import { runManagedSeed } from "./managed-seed";
import { QueueManager } from "./queue";
import { TaskScheduler } from "./scheduler/service";
import { syncFeaturedSkills } from "./skills/sync";
import { createConfiguredSlackBot, validateSlackTokens } from "./slack/adapter";
import type { SlackBot } from "./slack/bot";
import { createSlackStartupManager } from "./slack/startup";
import { ThreadBuffer } from "./slack/thread-buffer";
import { UserCache } from "./slack/user-cache";
import { createToolCallSpans, setAgentResultAttributes, setAgentRunAttributes } from "./telemetry/instrument";
import { initTelemetry } from "./telemetry/setup";
import { wireWhatsAppHandlers } from "./whatsapp/adapter";
import { WhatsAppBot } from "./whatsapp/bot";
import { GroupBuffer } from "./whatsapp/group-buffer";

export interface ServerHandle {
  config: Config;
  server: ReturnType<typeof serve>;
  db: Kysely<DB>;
  whatsapp: WhatsAppBot;
  getSlack: () => SlackBot | null;
  shutdown: () => Promise<void>;
}

export interface CreateServerOptions {
  /** When false, skips whatsapp.start() and Slack startup. Defaults to true. */
  connect?: boolean;
}

export async function createServer(config: Config, options?: CreateServerOptions): Promise<ServerHandle> {
  const connect = options?.connect !== false;

  // 1. Logger
  const logger = createLogger(config);

  // 2. Database
  const db = await createDatabase(config);
  await runMigrations(db);
  logger.info("Database ready");

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
  await runManagedSeed(config, settingsRepo, users);
  const mcpServersRepo = createMcpServerRepository(db);
  const whatsappGroupsRepo = createWhatsAppGroupRepository(db);
  const automationRunsRepo = createAutomationRunsRepository(db);
  const stepContentRepo = createAutomationStepContentRepository(db);
  const staleCount = await automationRunsRepo.markRunningAsFailed("Interrupted by server restart");
  if (staleCount > 0) {
    logger.warn({ staleCount }, "Cleaned up automation runs interrupted by previous shutdown");
  }
  const inboxMessagesRepo = createInboxMessagesRepository(db);
  const agentRunsRepo = createAgentRunsRepo(db);
  const telemetry = initTelemetry(agentRunsRepo, logger, config);
  const tracer = trace.getTracer("sketch");

  const trackedRunAgent = async (params: RunAgentParams): Promise<AgentResult> => {
    const runId = randomUUID();
    const span = tracer.startSpan("chat sketch");
    const shouldInjectAgentEnv = params.contextType === "dm" && !!params.currentUserId;
    const agentEnv = shouldInjectAgentEnv
      ? removeReservedAgentEnv(await agentEnvironmentVariables.listForRuntime(params.currentUserId as string))
      : undefined;
    const enrichedParams = {
      ...params,
      ...(agentEnv && Object.keys(agentEnv).length > 0
        ? {
            agentEnv,
          }
        : {}),
    };
    setAgentRunAttributes(span, enrichedParams, runId);

    try {
      const result = await runAgent(enrichedParams);
      setAgentResultAttributes(span, result);
      createToolCallSpans(tracer, span, runId, result.toolCalls);
      span.end();
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw err;
    }
  };

  // 4. LLM env from DB
  async function applyLlmEnvFromDb() {
    const settingsRow = await settingsRepo.get();
    applyLlmEnvFromSettings(settingsRow, logger);
  }
  await applyLlmEnvFromDb();

  // 5. Shared helpers
  async function buildMcpServers(userEmail: string | null): Promise<Record<string, McpServerConfig>> {
    const allServers = await mcpServersRepo.listAll();
    const servers: Record<string, McpServerConfig> = {};
    for (const s of allServers) {
      // Skip integration providers in skill mode (agent uses the skill's CLI instead)
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
  const threadBuffer = new ThreadBuffer();
  const userCache = new UserCache();
  let slack: SlackBot | null = null;

  // 8. WhatsApp
  const whatsapp = new WhatsAppBot({ db, logger, groupMetadataStore: whatsappGroupsRepo });
  const groupBuffer = new GroupBuffer();

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
    findIntegrationProvider: async () => {
      const row = await mcpServersRepo.findIntegrationProvider();
      if (!row || row.type == null) return null;
      return { type: row.type, credentials: row.credentials };
    },
    automationRunsRepo,
    stepContentRepo,
    userRepo: users,
    inboxMessagesRepo,
    sendDm: sendDirectMessage,
  });
  await scheduler.start();

  // 8.6. Connector sync scheduler — recovers stale syncs, runs periodic sync + enrichment
  const syncScheduler = startSyncScheduler(db, logger, 30 * 60 * 1000);

  const slackAdapterDeps = {
    db,
    config,
    logger,
    repos: { users, channels, settings: settingsRepo },
    queue: queueManager,
    slack: { threadBuffer, userCache },
    runAgent: trackedRunAgent,
    buildMcpServers,
    findIntegrationProvider: async () => {
      const row = await mcpServersRepo.findIntegrationProvider();
      if (!row || row.type == null) return null;
      return { type: row.type, credentials: row.credentials };
    },
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

  if (connect) {
    await startSlackBotIfConfigured().catch(() => {});
  }

  wireWhatsAppHandlers(whatsapp, {
    db,
    config,
    logger,
    repos: { users, settings: settingsRepo, whatsappGroups: whatsappGroupsRepo },
    queue: queueManager,
    groupBuffer,
    runAgent: trackedRunAgent,
    buildMcpServers,
    findIntegrationProvider: async () => {
      const row = await mcpServersRepo.findIntegrationProvider();
      if (!row || row.type == null) return null;
      return { type: row.type, credentials: row.credentials };
    },
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
    findIntegrationProvider: async () => {
      const row = await mcpServersRepo.findIntegrationProvider();
      if (!row || row.type == null) return null;
      return { type: row.type, credentials: row.credentials };
    },
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
  });
  const server = serve({ fetch: app.fetch, port: config.PORT });
  logger.info({ port: config.PORT }, "HTTP server started");

  // 10. Start platforms
  if (connect) {
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
