/**
 * System API routes — internal management endpoints authenticated by bearer token.
 * Used by managed deployments to update configuration (e.g. Slack tokens) remotely.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { createSettingsRepository } from "../db/repositories/settings";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;

type SlackTokensCallback = (tokens: { botToken: string; appToken?: string }) => unknown;

interface SystemDeps {
  systemSecret: string;
  // biome-ignore lint/complexity/noBannedTypes: Function is needed here to accommodate Vitest mock types in tests
  onSlackTokensUpdated?: Function;
}

const tokenSchema = z.object({
  botToken: z.string().min(1),
  appToken: z.string().optional(),
});

export function systemRoutes(settings: SettingsRepo, deps: SystemDeps) {
  const routes = new Hono();

  routes.use("/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (!auth || auth !== `Bearer ${deps.systemSecret}`) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid system secret" } }, 401);
    }
    return next();
  });

  routes.put("/slack/tokens", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: "botToken is required" } }, 400);
    }

    const { botToken, appToken } = parsed.data;
    await settings.update({
      slackBotToken: botToken,
      ...(appToken ? { slackAppToken: appToken } : {}),
    });

    if (deps.onSlackTokensUpdated) {
      const cb = deps.onSlackTokensUpdated as SlackTokensCallback;
      await cb({ botToken, ...(appToken ? { appToken } : {}) });
    }

    return c.json({ success: true });
  });

  return routes;
}
