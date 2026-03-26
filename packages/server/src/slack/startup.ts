import type { Logger } from "../logger";
import { resolveSlackTokens } from "./tokens";

type SlackTokenSource = {
  botToken: string | null | undefined;
  appToken: string | null | undefined;
};

type StartupTokens = {
  botToken: string;
  appToken?: string;
};

type SlackRuntimeBot = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

interface SlackStartupDeps<TBot extends SlackRuntimeBot> {
  logger: Pick<Logger, "info" | "warn" | "error">;
  slackMode?: "socket" | "http";
  getSettingsTokens: () => Promise<SlackTokenSource | null>;
  validateTokens: (botToken: string, appToken?: string) => Promise<void>;
  getCurrentBot: () => TBot | null;
  setCurrentBot: (bot: TBot | null) => void;
  createBot: (tokens: StartupTokens) => TBot;
}

export function createSlackStartupManager<TBot extends SlackRuntimeBot>(deps: SlackStartupDeps<TBot>) {
  let startupPromise: Promise<void> | null = null;

  return async (tokens?: StartupTokens) => {
    if (startupPromise) {
      return startupPromise;
    }

    startupPromise = (async () => {
      try {
        const mode = deps.slackMode ?? "socket";

        const resolved = tokens
          ? { botToken: tokens.botToken, ...(tokens.appToken ? { appToken: tokens.appToken } : {}) }
          : await resolveSlackTokens(mode, async () => {
              const settingsTokens = await deps.getSettingsTokens();
              return settingsTokens ? { botToken: settingsTokens.botToken, appToken: settingsTokens.appToken } : null;
            });

        if (!resolved) {
          deps.logger.info("Slack tokens not configured — skipping Slack bot startup");
          return;
        }

        const { botToken, appToken } = resolved;

        try {
          await deps.validateTokens(botToken, appToken);
        } catch (err) {
          deps.logger.warn({ err }, "Slack tokens failed validation");
          throw new Error("Invalid Slack tokens");
        }

        const existingBot = deps.getCurrentBot();
        if (existingBot) {
          await existingBot.stop().catch((err) => deps.logger.warn({ err }, "Failed to stop existing Slack bot"));
          deps.setCurrentBot(null);
        }

        const nextBot = deps.createBot({
          botToken,
          ...(appToken ? { appToken } : {}),
        });
        deps.setCurrentBot(nextBot);

        try {
          await nextBot.start();
          deps.logger.info("Slack bot connected");
        } catch (err) {
          deps.logger.error({ err }, "Failed to start Slack bot, disabling Slack integration");
          deps.setCurrentBot(null);
          throw new Error("Invalid Slack tokens");
        }
      } catch (err) {
        if (tokens) {
          throw err;
        }
        deps.logger.warn({ err }, "Skipping Slack startup");
      } finally {
        startupPromise = null;
      }
    })();

    return startupPromise;
  };
}
