import pino from "pino";
import type { Config } from "./config";

export function createLogger(config: Config) {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        "authorization",
        "Authorization",
        "headers.authorization",
        "headers.Authorization",
        "req.headers.authorization",
        "req.headers.Authorization",
        "token",
        "apiToken",
        "tokenHash",
        "token_hash",
      ],
      censor: "[REDACTED]",
    },
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino-pretty", options: { colorize: true, minimumLevel: config.LOG_LEVEL } }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
