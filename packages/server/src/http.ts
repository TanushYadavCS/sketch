/**
 * HTTP app factory — API routes, auth middleware, static file serving.
 * Route registration order: API routes → static assets → SPA catch-all.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { agentEnvironmentRoutes } from "./api/agent-environment";
import { agentRunRoutes } from "./api/agent-runs";
import { agentSessionRoutes } from "./api/agent-sessions";
import { apiTokenRoutes } from "./api/api-tokens";
import { type MagicLinkSender, authRoutes } from "./api/auth";
import { channelRoutes } from "./api/channels";
import { connectorRoutes } from "./api/connectors";
import { entityRoutes } from "./api/entities";
import { healthRoutes } from "./api/health";
import { localClaudeSessionEventRoutes } from "./api/local-claude-sessions";
import { localDeviceRoutes } from "./api/local-devices";
import { mcpServerRoutes } from "./api/mcp-servers";
import { createAuthMiddleware } from "./api/middleware";
import { productRoutes } from "./api/products";
import { createProjectRoutes } from "./api/projects";
import { providerIdentityRoutes } from "./api/provider-identities";
import { scheduledTaskRoutes } from "./api/scheduled-tasks";
import { settingsRoutes } from "./api/settings";
import { setupRoutes } from "./api/setup";
import { skillsRoutes } from "./api/skills";
import { verifyJwt } from "./auth/jwt";
import { entityReviewRoutes } from "./entities/review";

import { oauthRoutes, resolveOrigin } from "./api/oauth";
import { systemRoutes } from "./api/system";
import { taskRoutes } from "./api/tasks";
import { usageRoutes } from "./api/usage";
import { userRoutes } from "./api/users";
import { watiWebhookRoutes } from "./api/wati-webhook";
import { webChatRoutes } from "./api/web-chat";
import { whatsappRoutes } from "./api/whatsapp";
import { workflowRoutes } from "./api/workflows";
import { createWorkspaceApi } from "./api/workspace";
import { workspaceSummaryRoutes } from "./api/workspace-summary";
import type { Config } from "./config";
import {
  type AgentEnvironmentRuntimeContext,
  createAgentEnvironmentVariableRepository,
} from "./db/repositories/agent-environment-variables";
import { createChannelRepository } from "./db/repositories/channels";
import { createConnectorRepository } from "./db/repositories/connectors";
import { createConversationRepository } from "./db/repositories/conversations";
import { createEntityRepository } from "./db/repositories/entities";
import { createInboxMessagesRepository } from "./db/repositories/inbox-messages";
import { createMcpServerRepository } from "./db/repositories/mcp-servers";
import { createProviderIdentityRepository } from "./db/repositories/provider-identities";
import { createSettingsRepository } from "./db/repositories/settings";
import { createWhatsAppTemplateMappingRepository } from "./db/repositories/whatsapp-template-mappings";

import type { McpServerConfig, RunAgentParams, RunAgentResult } from "./agent/runner";
import { agentRoutes, dailyBriefRoutes, followupReviewRoutes } from "./agents/routes";
import type { AgentRunService } from "./agents/service";
import { getSmtpConfig } from "./api/shared";
import type { createAutomationRunsRepository } from "./db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "./db/repositories/automation-step-content";
import { createUserRepository } from "./db/repositories/users";
import { createWhatsAppGroupRepository } from "./db/repositories/whatsapp-groups";
import type { DB } from "./db/schema";
import { createEmailTransport, sendMagicLinkEmail } from "./email";
import type { IntegrationProvider } from "./integrations/types";
import { createLocalClaudeEventDispatcher } from "./local-devices/claude-event-dispatcher";
import type { LocalClaudeSessionService } from "./local-devices/claude-sessions";
import type { LocalDeviceGateway } from "./local-devices/gateway";
import {
  reconcileManagedTenantMembers,
  registerManagedTenantMember,
  removeManagedTenantMember,
  withManagedMemberSyncLocks,
} from "./managed-members";
import { createManagedLoginUrl } from "./managed-url";
import { mcpOAuthRoutes } from "./mcp/oauth/routes";
import { mountPublicMcpServer } from "./mcp/server/transport";
import type { QueueManager } from "./queue";
import type { TaskScheduler } from "./scheduler/service";
import type { SlackBot } from "./slack/bot";
import {
  type WhatsAppSocketFacade,
  type WhatsAppSocketStateChange,
  whatsAppSocketStateChangeSchema,
} from "./whatsapp/facade-contract";
import { phoneE164ToWhatsAppJid } from "./whatsapp/provider";
import type { ManagedWhatsAppProvider } from "./whatsapp/providers/managed";
import type { WatiWhatsAppProvider } from "./whatsapp/providers/wati";
import type { WhatsAppRuntime } from "./whatsapp/runtime";
import { buildMagicLinkTemplate } from "./whatsapp/templates";
import type { WhatsAppTemplateRequest } from "./whatsapp/templates";

interface AppDeps {
  whatsapp?: WhatsAppSocketFacade;
  whatsappRuntime?: WhatsAppRuntime;
  watiWebhook?: WatiWhatsAppProvider;
  managedWhatsapp?: ManagedWhatsAppProvider;
  getSlack?: () => SlackBot | null;
  logger?: Logger;
  onSlackTokensUpdated?: (tokens?: { botToken: string; appToken: string }) => Promise<void>;
  onSlackDisconnect?: () => Promise<void>;
  onLlmSettingsUpdated?: () => Promise<void>;
  onSmtpUpdated?: () => Promise<void>;
  scheduler?: Pick<TaskScheduler, "pauseTask" | "resumeTask" | "removeTask" | "executeTaskById"> &
    Partial<Pick<TaskScheduler, "refreshTaskSchedule" | "executeStepById" | "getTaskById">>;
  runAgent?: (params: RunAgentParams) => Promise<RunAgentResult>;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  listAgentEnvForRuntime?: (context: AgentEnvironmentRuntimeContext) => Promise<Record<string, string>>;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  queueManager?: QueueManager;
  sendDm?: (params: {
    userId: string;
    platform: string;
    message: string;
    template?: WhatsAppTemplateRequest;
    senderUserId?: string;
    storeInInbox?: boolean;
    inboxKind?: string;
    inboxMetadata?: Record<string, unknown> | null;
  }) => Promise<{
    channelId: string;
    messageRef: string;
    inboxMessageId?: string;
  }>;
  localDeviceGateway?: LocalDeviceGateway;
  localClaudeSessionService?: LocalClaudeSessionService;
  agentRunService?: AgentRunService;
  limitAgentExecution?: <T>(work: () => Promise<T>) => Promise<T>;
  whatsappWakeToken?: string;
  onWhatsAppWake?: () => Promise<void> | void;
  onWhatsAppSocketStateChange?: (change: WhatsAppSocketStateChange) => Promise<void> | void;
  getWhatsAppHealth?: () => { missingProviderIdEvents: number };
}

/**
 * App-level request body ceiling, enforced before any handler buffers a body.
 *
 * The upload routes (`/api/workspace/files`, `/api/web-chat/attachments`,
 * `/api/web-chat/transcribe`) call `parseBody()` then `Buffer.from(arrayBuffer())`,
 * each holding a full copy of the payload in memory, and only check
 * `MAX_FILE_SIZE_MB` / `MAX_UPLOAD_SIZE_MB` afterwards. Without an upstream
 * guard an authenticated client could POST a multi-GB body and transiently pin
 * roughly twice its size in RAM, matching an observed production OOM.
 *
 * The ceiling is derived from the largest configured upload limit plus a 10%
 * margin for multipart framing overhead, so this coarse guard trips only on
 * egregiously oversized bodies while the finer-grained per-route checks (which
 * return the friendlier `FILE_TOO_LARGE`) still fire for uploads slightly over
 * their own limit rather than being shadowed.
 */
function resolveBodyLimitBytes(config: Config): number {
  const maxUploadMb = Math.max(config.MAX_FILE_SIZE_MB, config.MAX_UPLOAD_SIZE_MB);
  return Math.ceil(maxUploadMb * 1.1 * 1024 * 1024);
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function authorizeWhatsAppGateway(context: Context, token: string): Response | null {
  const remoteAddress = (context.env as Partial<HttpBindings> | undefined)?.incoming?.socket.remoteAddress;
  const requestHost = new URL(context.req.url).hostname;
  const loopback = remoteAddress
    ? isLoopbackAddress(remoteAddress)
    : requestHost === "localhost" || isLoopbackAddress(requestHost);
  if (!loopback) return context.json({ error: "loopback_only" }, 403);
  const header = context.req.header("authorization");
  const actual = Buffer.from(header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "");
  const expected = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return context.json({ error: "unauthorized" }, 401);
  }
  return null;
}

export function createApp(db: Kysely<DB>, config: Config, deps?: AppDeps) {
  const app = new Hono();
  app.use(
    "*",
    bodyLimit({
      maxSize: resolveBodyLimitBytes(config),
      onError: (c) =>
        c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the maximum allowed size" } }, 413),
    }),
  );
  const settings = createSettingsRepository(db, config.ENCRYPTION_KEY);
  const users = createUserRepository(db);
  const channels = createChannelRepository(db);
  const whatsappGroups = createWhatsAppGroupRepository(db);
  const conversations = createConversationRepository(db);
  const whatsappTemplateMappings = createWhatsAppTemplateMappingRepository(db);
  const inboxMessages = createInboxMessagesRepository(db);
  const connectors = createConnectorRepository(db, config.ENCRYPTION_KEY);
  const entityRepo = createEntityRepository(db);
  const agentEnvVars = createAgentEnvironmentVariableRepository(db, config.ENCRYPTION_KEY);
  const mcpServers = createMcpServerRepository(db);
  const logger = deps?.logger ?? (console as unknown as Logger);
  const identities = createProviderIdentityRepository(db, config.ENCRYPTION_KEY);
  const localClaudeEventDispatcher =
    deps?.localClaudeSessionService && deps.runAgent && deps.queueManager
      ? createLocalClaudeEventDispatcher({
          db,
          config,
          logger,
          settingsRepo: settings,
          users,
          conversations,
          queueManager: deps.queueManager,
          runAgent: deps.runAgent,
          buildMcpServers: deps.buildMcpServers,
          loadIntegrationProvider: deps.loadIntegrationProvider,
          scheduler: deps.scheduler as RunAgentParams["scheduler"],
          stepContentRepo: deps.stepContentRepo,
          automationRunsRepo: deps.automationRunsRepo,
          inboxMessagesRepo: inboxMessages,
          getSlack: deps.getSlack,
          whatsapp: deps.whatsapp,
          whatsappRuntime: deps.whatsappRuntime,
          sendDm: deps.sendDm,
        })
      : null;

  if (deps?.whatsappWakeToken && deps.onWhatsAppWake) {
    const whatsappWakeToken = deps.whatsappWakeToken;
    const onWhatsAppWake = deps.onWhatsAppWake;
    app.post("/internal/whatsapp/wake", async (context) => {
      const rejected = authorizeWhatsAppGateway(context, whatsappWakeToken);
      if (rejected) return rejected;
      await onWhatsAppWake();
      return context.body(null, 204);
    });
  }

  if (deps?.whatsappWakeToken && deps.onWhatsAppSocketStateChange) {
    const whatsappWakeToken = deps.whatsappWakeToken;
    const onWhatsAppSocketStateChange = deps.onWhatsAppSocketStateChange;
    app.post("/internal/whatsapp/socket-state", async (context) => {
      const rejected = authorizeWhatsAppGateway(context, whatsappWakeToken);
      if (rejected) return rejected;
      const change = whatsAppSocketStateChangeSchema.parse(await context.req.json());
      await onWhatsAppSocketStateChange(change);
      return context.body(null, 204);
    });
  }

  app.route(
    "/",
    mcpOAuthRoutes({
      db,
      settings,
      users,
      config,
      logger,
    }),
  );

  if (deps?.localClaudeSessionService) {
    app.route(
      "/api/local-claude-sessions",
      localClaudeSessionEventRoutes({
        service: deps.localClaudeSessionService,
        logger,
        dispatchEvent: localClaudeEventDispatcher
          ? (delivery) => localClaudeEventDispatcher.enqueue(delivery)
          : undefined,
      }),
    );
  }

  // Slack HTTP events endpoint — must come before auth middleware so it doesn't
  // require JWT authentication. Only registered when SLACK_MODE=http.
  if (config.SLACK_MODE === "http") {
    app.post("/slack/events", async (c) => {
      const slack = deps?.getSlack?.();
      if (!slack) {
        return c.json({ error: "Slack not configured" }, 503);
      }

      const rawBody = await c.req.text();
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((value, key) => {
        headers[key] = value;
      });

      try {
        const result = await slack.processHttpRequest(rawBody, headers);
        return c.json(result);
      } catch (_err) {
        return c.json({ error: "Invalid request" }, 401);
      }
    });
  }

  if (deps?.watiWebhook && deps.queueManager) {
    app.route("/whatsapp/wati", watiWebhookRoutes(deps.watiWebhook, deps.queueManager, logger));
  }

  app.use(
    "/api/*",
    createAuthMiddleware(settings, {
      managedAuthSecret: config.MANAGED_AUTH_SECRET,
      managedUrl: config.MANAGED_URL,
      hasLocalAdmin: async () => Boolean(await users.findFirstLocalAdmin()),
      resolveLocalSessionUser: async (sub) => {
        let user = await users.findById(sub);
        if (!user && sub.includes("@")) {
          user = await users.findByEmail(sub);
        }
        if (!user) return null;
        return { id: user.id, authRole: user.auth_role, email: user.email };
      },
      findUserByEmail: config.MANAGED_AUTH_SECRET
        ? async (email) => {
            const user = await users.findByEmail(email);
            if (!user) return null;
            return { id: user.id, authRole: user.auth_role, email: user.email };
          }
        : undefined,
      verifySketchApiKey: async (token) => {
        const row = await settings.get();
        return !!row?.sketch_api_key && row.sketch_api_key === token;
      },
    }),
  );

  const sendMagicLink: MagicLinkSender = async ({ user, magicLinkUrl, botName }) => {
    const channels: string[] = [];

    const slack = deps?.getSlack?.();
    if (slack && user.slack_user_id) {
      try {
        const row = await settings.get();
        const dmChannelId = await slack.openDmChannel(user.slack_user_id, row?.slack_bot_token ?? undefined);
        if (dmChannelId) {
          const text = `Here's your sign-in link for ${botName}:\n${magicLinkUrl}\n\nThis link expires in 15 minutes and can only be used once.`;
          await slack.postMessage(dmChannelId, text);
          channels.push("slack");
        }
      } catch (err) {
        logger.warn({ err }, "Failed to send magic link via Slack");
      }
    }

    const settingsRow = await settings.get();
    const smtp = settingsRow ? getSmtpConfig(settingsRow) : null;
    if (smtp && user.email) {
      try {
        const transport = createEmailTransport(smtp);
        await sendMagicLinkEmail(transport, user.email, magicLinkUrl, botName, smtp.from);
        channels.push("email");
      } catch (err) {
        logger.warn({ err }, "Failed to send magic link via email");
      }
    }

    if (deps?.sendDm && user.whatsapp_number) {
      try {
        const text = `Here's your sign-in link for ${botName}:\n${magicLinkUrl}\n\nThis link expires in 15 minutes and can only be used once.`;
        await deps.sendDm({
          userId: user.id,
          platform: "whatsapp",
          message: text,
          template: buildMagicLinkTemplate({
            recipientName: user.name,
            botName,
            magicLinkUrl,
            fallbackText: text,
          }),
        });
        channels.push("whatsapp");
      } catch (err) {
        logger.warn({ err }, "Failed to send magic link via WhatsApp");
      }
    } else if (deps?.whatsappRuntime && user.whatsapp_number) {
      try {
        const text = `Here's your sign-in link for ${botName}:\n${magicLinkUrl}\n\nThis link expires in 15 minutes and can only be used once.`;
        await deps.whatsappRuntime.sendTemplate(
          { kind: "dm", phoneE164: user.whatsapp_number },
          buildMagicLinkTemplate({
            recipientName: user.name,
            botName,
            magicLinkUrl,
            fallbackText: text,
          }),
        );
        channels.push("whatsapp");
      } catch (err) {
        logger.warn({ err }, "Failed to send magic link via WhatsApp");
      }
    } else if (deps?.whatsapp && user.whatsapp_number) {
      try {
        const jid = phoneE164ToWhatsAppJid(user.whatsapp_number);
        const text = `Here's your sign-in link for ${botName}:\n${magicLinkUrl}\n\nThis link expires in 15 minutes and can only be used once.`;
        await deps.whatsapp.send(jid, { kind: "text", text }, { idempotencyKey: randomUUID() });
        channels.push("whatsapp");
      } catch (err) {
        logger.warn({ err }, "Failed to send magic link via WhatsApp");
      }
    }

    return channels;
  };

  // API routes
  app.route("/api/health", healthRoutes(db, deps?.getWhatsAppHealth));
  app.route("/api/auth", authRoutes(settings, db, { config, logger, userRepo: users, sendMagicLink }));
  app.route(
    "/api/setup",
    setupRoutes(settings, {
      managedUrl: config.MANAGED_URL,
      onSlackTokensUpdated: deps?.onSlackTokensUpdated,
      onLlmSettingsUpdated: deps?.onLlmSettingsUpdated,
      userRepo: users,
      whatsappConnected: async () =>
        Boolean(deps?.whatsappRuntime?.isConnected || (await deps?.whatsapp?.pairing.status())?.connected),
    }),
  );
  app.route("/api/settings", settingsRoutes(settings, db, deps?.logger, config));
  app.route("/api/skills", skillsRoutes(config));
  app.route(
    "/api/users",
    userRoutes(users, {
      settings,
      db,
      logger,
      config,
      channels,
      whatsappGroups,
      getSlack: deps?.getSlack,
      registerManagedMember: (input) => registerManagedTenantMember(config, input),
      syncManagedMemberMapping: (input) =>
        registerManagedTenantMember(config, {
          ...input,
          managedWhatsappDmEnabled: config.WHATSAPP_DM_PROVIDER === "managed",
        }),
      removeManagedMember: (input) => removeManagedTenantMember(config, input),
    }),
  );
  app.route(
    "/api/agent-environment-variables",
    agentEnvironmentRoutes(agentEnvVars, { users, channels, whatsappGroups, getSlack: deps?.getSlack, logger }),
  );
  app.route("/api/agent-sessions", agentSessionRoutes(db, { logger }));
  app.route(
    "/api/workflows",
    workflowRoutes({
      db,
      config,
      logger,
      users,
      getSlack: deps?.getSlack,
      whatsapp: deps?.whatsapp,
      whatsappRuntime: deps?.whatsappRuntime,
      runAgent: deps?.runAgent,
      buildMcpServers: deps?.buildMcpServers,
      loadIntegrationProvider: deps?.loadIntegrationProvider,
      listAgentEnvForRuntime:
        deps?.listAgentEnvForRuntime ?? ((context) => agentEnvVars.listForRuntimeContext(context)),
      inboxMessagesRepo: inboxMessages,
      sendDm: deps?.sendDm,
      queueManager: deps?.queueManager,
      limitAgentExecution: deps?.limitAgentExecution,
    }),
  );
  if (deps?.runAgent) {
    app.route(
      "/api/agent-runs",
      agentRunRoutes({
        db,
        config,
        logger,
        users,
        channels,
        settings,
        whatsappGroups,
        inboxMessagesRepo: inboxMessages,
        getSlack: deps.getSlack,
        whatsapp: deps.whatsapp,
        whatsappRuntime: deps.whatsappRuntime,
        runAgent: deps.runAgent,
        buildMcpServers: deps.buildMcpServers,
        loadIntegrationProvider: deps.loadIntegrationProvider,
        scheduler: deps.scheduler as TaskScheduler | undefined,
        stepContentRepo: deps.stepContentRepo,
        automationRunsRepo: deps.automationRunsRepo,
        queueManager: deps.queueManager,
        sendDm: deps.sendDm,
      }),
    );
    app.route(
      "/api/web-chat",
      webChatRoutes({
        db,
        config,
        logger,
        users,
        settings,
        inboxMessagesRepo: inboxMessages,
        runAgent: deps.runAgent,
        buildMcpServers: deps.buildMcpServers,
        loadIntegrationProvider: deps.loadIntegrationProvider,
        scheduler: deps.scheduler as TaskScheduler | undefined,
        stepContentRepo: deps.stepContentRepo,
        automationRunsRepo: deps.automationRunsRepo,
        queueManager: deps.queueManager,
        getSlack: deps.getSlack,
        sendDm: deps.sendDm,
      }),
    );
  }
  app.route("/api/mcp-servers", mcpServerRoutes(mcpServers, users));
  app.route("/api/workspace/summary", workspaceSummaryRoutes({ db, config, users, mcpServers }));
  if (deps?.agentRunService) {
    app.route("/api/daily-briefs", dailyBriefRoutes(deps.agentRunService, db, logger));
    app.route("/api", followupReviewRoutes(deps.agentRunService, db));
    app.route("/api/agents", agentRoutes(deps.agentRunService));
  }
  app.route("/api/workspace", createWorkspaceApi({ config }));
  if (deps?.scheduler) {
    app.route(
      "/api/scheduled-tasks",
      scheduledTaskRoutes(db, deps.scheduler, {
        logger,
        loadIntegrationProvider: deps.loadIntegrationProvider,
      }),
    );
  }
  app.route(
    "/api/channels",
    channelRoutes({
      whatsapp: deps?.whatsapp,
      watiProvider: deps?.watiWebhook,
      whatsappTemplateMappings,
      getSlack: deps?.getSlack,
      whatsappGroups,
      onSlackDisconnect: deps?.onSlackDisconnect,
      settings,
      onSmtpUpdated: deps?.onSmtpUpdated,
    }),
  );

  if (deps?.whatsapp) {
    app.route("/api/channels/whatsapp", whatsappRoutes(deps.whatsapp));
  }

  app.route("/api/usage", usageRoutes(db));
  if (deps?.localDeviceGateway) {
    app.route(
      "/api/local-devices",
      localDeviceRoutes(db, { baseUrl: config.BASE_URL, port: config.PORT, gateway: deps.localDeviceGateway }),
    );
  }
  app.route("/api/entities", entityRoutes(db, { logger, config }));
  app.route("/api/tasks", taskRoutes(db));
  app.route("/api/projects", createProjectRoutes(db));
  app.route("/api/products", productRoutes(db));
  app.route("/api/entity-review", entityReviewRoutes(db, { logger }));
  app.route("/api/api-tokens", apiTokenRoutes(db, { baseUrl: config.BASE_URL }));
  mountPublicMcpServer({
    app,
    db,
    userRepo: users,
    workspaceDir: join(config.DATA_DIR, "external-mcp"),
    logger,
    baseUrl: config.BASE_URL,
  });

  if (deps?.logger) {
    app.route("/api/connectors", connectorRoutes(connectors, db, deps.logger, users, config));
  }

  app.route("/api/identities", providerIdentityRoutes(identities, users));

  if (deps?.logger) {
    app.route(
      "/api/oauth",
      oauthRoutes(settings, identities, connectors, users, db, deps.logger, {
        baseUrl: config.BASE_URL,
        appConfig: config,
        zohoClientId: config.ZOHO_CLIENT_ID,
        zohoClientSecret: config.ZOHO_CLIENT_SECRET,
        microsoftClientId: config.MICROSOFT_CLIENT_ID,
        microsoftClientSecret: config.MICROSOFT_CLIENT_SECRET,
        microsoftTenant: config.MICROSOFT_TENANT,
      }),
    );
  }

  if (config.SYSTEM_SECRET) {
    const onSlackTokensUpdated = deps?.onSlackTokensUpdated;
    const onLlmSettingsUpdated = deps?.onLlmSettingsUpdated;
    const whatsapp = deps?.whatsapp;

    let pairingInProgress = false;
    let pairingSettled: Promise<void> | null = null;

    app.route(
      "/api/system",
      systemRoutes(settings, {
        systemSecret: config.SYSTEM_SECRET,
        onSlackTokensUpdated: onSlackTokensUpdated ? () => onSlackTokensUpdated() : undefined,
        onLlmSettingsUpdated: onLlmSettingsUpdated ? () => onLlmSettingsUpdated() : undefined,
        userRepo: users,
        entityRepo,
        inboxMessagesRepo: inboxMessages,
        mcpServers,
        sendSlackDmToSlackUser: deps?.getSlack
          ? async ({ slackUserId, message }) => {
              const slack = deps.getSlack?.();
              if (!slack) throw new Error("Slack not configured");
              const settingsRow = await settings.get();
              const channelId = await slack.openDmChannel(slackUserId, settingsRow?.slack_bot_token ?? undefined);
              if (!channelId) throw new Error("Failed to open DM channel");
              const messageRef = await slack.postMessage(channelId, message);
              return { channelId, messageRef };
            }
          : undefined,
        sendDm: deps?.sendDm,
        managedWhatsappInbound: deps?.managedWhatsapp,
        reconcileManagedMembers: async () => reconcileManagedTenantMembers(config, users, logger),
        withManagedMemberSyncLocks,
        validateManagedWhatsappInboundIdentity: async (tenantUserId, senderPhoneE164) => {
          const user = await users.findById(tenantUserId);
          return user?.type === "human" && user.whatsapp_number === senderPhoneE164;
        },
        whatsappStatus: whatsapp
          ? async () => ({
              ...(await whatsapp.pairing.status()),
              pairingInProgress,
            })
          : undefined,
        startWhatsAppPairing: whatsapp
          ? async (c: Context) => {
              if ((await whatsapp.pairing.status()).connected) {
                return c.json({ error: { code: "ALREADY_CONNECTED", message: "WhatsApp is already connected" } }, 400);
              }
              if (pairingInProgress) {
                return c.json(
                  { error: { code: "PAIRING_IN_PROGRESS", message: "A pairing attempt is already active" } },
                  409,
                );
              }
              pairingInProgress = true;

              return streamSSE(c, async (stream) => {
                try {
                  pairingSettled = whatsapp.pairing.startQr(async (event) => {
                    if (event.type === "qr") {
                      await stream.writeSSE({ event: "qr", data: JSON.stringify({ qr: event.qr }) });
                    } else if (event.type === "connected") {
                      await stream.writeSSE({
                        event: "connected",
                        data: JSON.stringify({ phoneNumber: event.phoneNumber }),
                      });
                    } else {
                      await stream.writeSSE({ event: "error", data: JSON.stringify({ message: event.message }) });
                    }
                  });
                  await pairingSettled;
                } finally {
                  pairingInProgress = false;
                  pairingSettled = null;
                }
              });
            }
          : undefined,
        cancelWhatsAppPairing: whatsapp
          ? async () => {
              await whatsapp.pairing.cancel();
            }
          : undefined,
        disconnectWhatsApp: whatsapp ? () => whatsapp.pairing.logout() : undefined,
      }),
    );
  }

  // Static file serving for the SPA (production only — dev uses Vite dev server)
  // In production, web assets are copied into dist/public/ alongside the server bundle.
  // In dev (tsx), fall back to the monorepo path.
  const bundledDir = resolve(import.meta.dirname, "public");
  const monorepoDir = resolve(import.meta.dirname, "../../web/dist");
  const webDistDir = existsSync(bundledDir) ? bundledDir : monorepoDir;

  // Managed login redirect: runs before SPA static serving so unauthenticated
  // requests never load the OSS login page. Must be outside the existsSync
  // check so it works even when web assets aren't built (e.g. CI).
  const managedUrl = config.MANAGED_URL;
  if (managedUrl) {
    app.use("*", async (c, next) => {
      const path = c.req.path;
      if (path.startsWith("/api/") || path === "/health") {
        return next();
      }

      const platformToken = getCookie(c, "sketch_platform_session");
      const isValidPlatformSession =
        !!platformToken &&
        !!config.MANAGED_AUTH_SECRET &&
        !!(await verifyJwt(platformToken, config.MANAGED_AUTH_SECRET));

      if (!isValidPlatformSession) {
        const loginUrl = createManagedLoginUrl(managedUrl);
        const requestUrl = new URL(c.req.url);
        const isSlackResult = path === "/channels" && requestUrl.searchParams.has("slack");
        const returnTo =
          path === "/login"
            ? requestUrl.searchParams.get("return_to")
            : isSlackResult
              ? new URL(`${requestUrl.pathname}${requestUrl.search}`, resolveOrigin(c, config.BASE_URL)).toString()
              : path === "/integrations" || path.startsWith("/integrations/")
                ? `${requestUrl.pathname}${requestUrl.search}`
                : null;
        if (returnTo) {
          loginUrl.searchParams.set("return_to", returnTo);
        }
        return c.redirect(loginUrl.toString());
      }

      return next();
    });
  }

  if (existsSync(webDistDir)) {
    // Serve static files: Vite-hashed bundles (/assets/) and logo/favicon PNGs (/logos/)
    app.use("/assets/*", serveStatic({ root: webDistDir }));
    app.use("/logos/*", serveStatic({ root: webDistDir }));

    // SPA catch-all: any non-API route returns index.html for client-side routing
    const indexHtml = readFileSync(join(webDistDir, "index.html"), "utf-8");
    app.get("*", (c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      }
      return c.html(indexHtml);
    });
  }

  return app;
}
