import pino from "pino";
import pretty from "pino-pretty";
import type { Config } from "./config";

export function createLogger(config: Config) {
  const options = {
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
  };

  if (process.env.NODE_ENV === "production") return pino(options);

  return pino(options, pretty({ colorize: true, minimumLevel: config.LOG_LEVEL }));
}

export type Logger = ReturnType<typeof createLogger>;
