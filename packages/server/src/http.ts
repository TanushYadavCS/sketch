/**
 * HTTP app factory — API routes, auth middleware, static file serving.
 * Route registration order: API routes → static assets → SPA catch-all.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { authRoutes } from "./api/auth";
import { channelRoutes } from "./api/channels";
import { connectorRoutes } from "./api/connectors";
import { emailRoutes } from "./api/email";
import { healthRoutes } from "./api/health";
import { mcpServerRoutes } from "./api/mcp-servers";
import { createAuthMiddleware } from "./api/middleware";
import { providerIdentityRoutes } from "./api/provider-identities";
import { scheduledTaskRoutes } from "./api/scheduled-tasks";
import { settingsRoutes } from "./api/settings";
import { setupRoutes } from "./api/setup";
import { skillsRoutes } from "./api/skills";

import { oauthRoutes } from "./api/oauth";
import { systemRoutes } from "./api/system";
import { userRoutes } from "./api/users";
import { whatsappRoutes } from "./api/whatsapp";
import { createWorkspaceApi } from "./api/workspace";
import type { Config } from "./config";
import { createConnectorRepository } from "./db/repositories/connectors";
import { createMcpServerRepository } from "./db/repositories/mcp-servers";
import { createProviderIdentityRepository } from "./db/repositories/provider-identities";
import { createSettingsRepository } from "./db/repositories/settings";

import { createUserRepository } from "./db/repositories/users";
import type { DB } from "./db/schema";
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
  scheduler?: Pick<TaskScheduler, "pauseTask" | "resumeTask" | "removeTask">;
}

export function createApp(db: Kysely<DB>, config: Config, deps?: AppDeps) {
  const app = new Hono();
  const settings = createSettingsRepository(db, config.ENCRYPTION_KEY);
  const users = createUserRepository(db);
  const connectors = createConnectorRepository(db);
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
      findUserByEmail: config.MANAGED_AUTH_SECRET
        ? async (email) => {
            const user = await users.findByEmail(email);
            if (!user) return null;
            return { id: user.id, role: user.role as "admin" | "member" };
          }
        : undefined,
    }),
  );

  // API routes
  app.route("/api/health", healthRoutes(db));
  app.route("/api/auth", authRoutes(settings, db, { config, logger }));
  app.route(
    "/api/setup",
    setupRoutes(settings, {
      managedUrl: config.MANAGED_URL,
      onSlackTokensUpdated: deps?.onSlackTokensUpdated,
      onLlmSettingsUpdated: deps?.onLlmSettingsUpdated,
    }),
  );
  app.route("/api/settings", settingsRoutes(settings, db, deps?.logger));
  app.route("/api/skills", skillsRoutes(config));
  app.route("/api/users", userRoutes(users, { settings, db, logger, config }));
  app.route("/api/mcp-servers", mcpServerRoutes(mcpServers, users));
  app.route("/api/workspace", createWorkspaceApi({ config }));
  if (deps?.scheduler) {
    app.route("/api/scheduled-tasks", scheduledTaskRoutes(db, deps.scheduler));
  }
  app.route(
    "/api/channels",
    channelRoutes({
      whatsapp: deps?.whatsapp,
      getSlack: deps?.getSlack,
      onSlackDisconnect: deps?.onSlackDisconnect,
      settings,
      onSmtpUpdated: deps?.onSmtpUpdated,
    }),
  );

  if (deps?.whatsapp) {
    app.route("/api/channels/whatsapp", whatsappRoutes(deps.whatsapp));
  }

  app.route("/api/channels/email", emailRoutes(settings));

  if (deps?.logger) {
    app.route("/api/connectors", connectorRoutes(connectors, db, deps.logger));
  }

  const identities = createProviderIdentityRepository(db);
  app.route("/api/identities", providerIdentityRoutes(identities, users));

  if (deps?.logger) {
    app.route("/api/oauth", oauthRoutes(settings, identities, connectors, users, db, deps.logger, config.BASE_URL));
  }

  if (config.SYSTEM_SECRET) {
    const onSlackTokensUpdated = deps?.onSlackTokensUpdated;
    app.route(
      "/api/system",
      systemRoutes(settings, {
        systemSecret: config.SYSTEM_SECRET,
        onSlackTokensUpdated: onSlackTokensUpdated ? () => onSlackTokensUpdated() : undefined,
      }),
    );
  }

  // Static file serving for the SPA (production only — dev uses Vite dev server)
  // In production, web assets are copied into dist/public/ alongside the server bundle.
  // In dev (tsx), fall back to the monorepo path.
  const bundledDir = resolve(import.meta.dirname, "public");
  const monorepoDir = resolve(import.meta.dirname, "../../web/dist");
  const webDistDir = existsSync(bundledDir) ? bundledDir : monorepoDir;

  if (existsSync(webDistDir)) {
    // Serve hashed assets (JS, CSS, images)
    app.use("/assets/*", serveStatic({ root: webDistDir }));

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
