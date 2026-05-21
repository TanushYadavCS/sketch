/**
 * HTTP app factory — API routes, auth middleware, static file serving.
 * Route registration order: API routes → static assets → SPA catch-all.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { agentEnvironmentRoutes } from "./api/agent-environment";
import { agentRunRoutes } from "./api/agent-runs";
import { agentSessionRoutes } from "./api/agent-sessions";
import { type MagicLinkSender, authRoutes } from "./api/auth";
import { channelRoutes } from "./api/channels";
import { connectorRoutes } from "./api/connectors";
import { entityRoutes } from "./api/entities";
import { healthRoutes } from "./api/health";
import { mcpServerRoutes } from "./api/mcp-servers";
import { createAuthMiddleware } from "./api/middleware";
import { providerIdentityRoutes } from "./api/provider-identities";
import { scheduledTaskRoutes } from "./api/scheduled-tasks";
import { settingsRoutes } from "./api/settings";
import { setupRoutes } from "./api/setup";
import { skillsRoutes } from "./api/skills";
import { verifyJwt } from "./auth/jwt";
import { entityReviewRoutes } from "./entities/review";

import { oauthRoutes } from "./api/oauth";
import { systemRoutes } from "./api/system";
import { usageRoutes } from "./api/usage";
import { userRoutes } from "./api/users";
import { whatsappRoutes } from "./api/whatsapp";
import { workflowRoutes } from "./api/workflows";
import { createWorkspaceApi } from "./api/workspace";
import type { Config } from "./config";
import {
  type AgentEnvironmentRuntimeContext,
  createAgentEnvironmentVariableRepository,
} from "./db/repositories/agent-environment-variables";
import { createChannelRepository } from "./db/repositories/channels";
import { createConnectorRepository } from "./db/repositories/connectors";
import { createInboxMessagesRepository } from "./db/repositories/inbox-messages";
import { createMcpServerRepository } from "./db/repositories/mcp-servers";
import { createProviderIdentityRepository } from "./db/repositories/provider-identities";
import { createSettingsRepository } from "./db/repositories/settings";

import type { AgentResult, McpServerConfig, RunAgentParams } from "./agent/runner";
import { getSmtpConfig } from "./api/shared";
import type { createAutomationRunsRepository } from "./db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "./db/repositories/automation-step-content";
import { createUserRepository } from "./db/repositories/users";
import { createWhatsAppGroupRepository } from "./db/repositories/whatsapp-groups";
import type { DB } from "./db/schema";
import { createEmailTransport, sendMagicLinkEmail } from "./email";
import type { IntegrationProvider } from "./integrations/types";
import type { QueueManager } from "./queue";
import type { TaskScheduler } from "./scheduler/service";
import type { SlackBot } from "./slack/bot";
import type { WhatsAppBot } from "./whatsapp/bot";

interface AppDeps {
  whatsapp?: WhatsAppBot;
  getSlack?: () => SlackBot | null;
  logger?: Logger;
  onSlackTokensUpdated?: (tokens?: { botToken: string; appToken: string }) => Promise<void>;
  onSlackDisconnect?: () => Promise<void>;
  onLlmSettingsUpdated?: () => Promise<void>;
  onSmtpUpdated?: () => Promise<void>;
  scheduler?: Pick<TaskScheduler, "pauseTask" | "resumeTask" | "removeTask" | "executeTaskById">;
  runAgent?: (params: RunAgentParams) => Promise<AgentResult>;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  listAgentEnvForRuntime?: (context: AgentEnvironmentRuntimeContext) => Promise<Record<string, string>>;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  queueManager?: QueueManager;
  sendDm?: (params: { userId: string; platform: string; message: string }) => Promise<{
    channelId: string;
    messageRef: string;
  }>;
}

export function createApp(db: Kysely<DB>, config: Config, deps?: AppDeps) {
  const app = new Hono();
  const settings = createSettingsRepository(db, config.ENCRYPTION_KEY);
  const users = createUserRepository(db);
  const channels = createChannelRepository(db);
  const whatsappGroups = createWhatsAppGroupRepository(db);
  const inboxMessages = createInboxMessagesRepository(db);
  const connectors = createConnectorRepository(db);
  const agentEnvVars = createAgentEnvironmentVariableRepository(db, config.ENCRYPTION_KEY);
  const mcpServers = createMcpServerRepository(db);
  const logger = deps?.logger ?? (console as unknown as Logger);

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

  // Auth middleware on all /api/* routes (with setup mode + auth checks)
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

    if (deps?.whatsapp && user.whatsapp_number) {
      try {
        const jid = `${user.whatsapp_number.replace("+", "")}@s.whatsapp.net`;
        const text = `Here's your sign-in link for ${botName}:\n${magicLinkUrl}\n\nThis link expires in 15 minutes and can only be used once.`;
        await deps.whatsapp.sendText(jid, text);
        channels.push("whatsapp");
      } catch (err) {
        logger.warn({ err }, "Failed to send magic link via WhatsApp");
      }
    }

    return channels;
  };

  // API routes
  app.route("/api/health", healthRoutes(db));
  app.route("/api/auth", authRoutes(settings, db, { config, logger, userRepo: users, sendMagicLink }));
  app.route(
    "/api/setup",
    setupRoutes(settings, {
      managedUrl: config.MANAGED_URL,
      onSlackTokensUpdated: deps?.onSlackTokensUpdated,
      onLlmSettingsUpdated: deps?.onLlmSettingsUpdated,
      userRepo: users,
    }),
  );
  app.route("/api/settings", settingsRoutes(settings, db, deps?.logger));
  app.route("/api/skills", skillsRoutes(config));
  app.route(
    "/api/users",
    userRoutes(users, { settings, db, logger, config, channels, whatsappGroups, getSlack: deps?.getSlack }),
  );
  app.route(
    "/api/agent-environment-variables",
    agentEnvironmentRoutes(agentEnvVars, { users, channels, whatsappGroups, getSlack: deps?.getSlack, logger }),
  );
  app.route("/api/agent-sessions", agentSessionRoutes());
  app.route(
    "/api/workflows",
    workflowRoutes({
      db,
      config,
      logger,
      users,
      getSlack: deps?.getSlack,
      whatsapp: deps?.whatsapp,
      runAgent: deps?.runAgent,
      buildMcpServers: deps?.buildMcpServers,
      loadIntegrationProvider: deps?.loadIntegrationProvider,
      listAgentEnvForRuntime:
        deps?.listAgentEnvForRuntime ?? ((context) => agentEnvVars.listForRuntimeContext(context)),
      inboxMessagesRepo: inboxMessages,
      sendDm: deps?.sendDm,
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
  }
  app.route("/api/mcp-servers", mcpServerRoutes(mcpServers, users));
  app.route("/api/workspace", createWorkspaceApi({ config }));
  if (deps?.scheduler) {
    app.route("/api/scheduled-tasks", scheduledTaskRoutes(db, deps.scheduler, logger));
  }
  app.route(
    "/api/channels",
    channelRoutes({
      whatsapp: deps?.whatsapp,
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
  app.route("/api/entities", entityRoutes(db));
  if (config.EXPERIMENTAL_FLAG) {
    app.route("/api/entity-review", entityReviewRoutes(db));
  }

  if (deps?.logger) {
    app.route("/api/connectors", connectorRoutes(connectors, db, deps.logger, users));
  }

  const identities = createProviderIdentityRepository(db);
  app.route("/api/identities", providerIdentityRoutes(identities, users));

  if (deps?.logger) {
    app.route("/api/oauth", oauthRoutes(settings, identities, connectors, users, db, deps.logger, config.BASE_URL));
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
        whatsappStatus: whatsapp
          ? () => ({
              connected: whatsapp.isConnected,
              phoneNumber: whatsapp.phoneNumber,
              pairingInProgress,
            })
          : undefined,
        startWhatsAppPairing: whatsapp
          ? (c: Context) => {
              if (whatsapp.isConnected) {
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
                  pairingSettled = whatsapp.startPairing({
                    onQr: async (qr) => {
                      await stream.writeSSE({ event: "qr", data: JSON.stringify({ qr }) });
                    },
                    onConnected: async (phoneNumber) => {
                      await stream.writeSSE({ event: "connected", data: JSON.stringify({ phoneNumber }) });
                    },
                    onError: async (message) => {
                      await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
                    },
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
          ? () => {
              whatsapp.cancelPairing();
            }
          : undefined,
        disconnectWhatsApp: whatsapp ? () => whatsapp.disconnect() : undefined,
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
  if (config.MANAGED_URL) {
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
        return c.redirect(`${config.MANAGED_URL}/login`);
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
