import { describe, expect, it } from "vitest";
import { configSchema } from "./config";

describe("agent model request timeout config", () => {
  it("defaults to ten minutes", () => {
    expect(configSchema.parse({}).AGENT_MODEL_REQUEST_TIMEOUT_MS).toBe(600_000);
  });

  it("coerces positive integer values and rejects zero", () => {
    expect(configSchema.parse({ AGENT_MODEL_REQUEST_TIMEOUT_MS: "1234" }).AGENT_MODEL_REQUEST_TIMEOUT_MS).toBe(1234);
    expect(configSchema.safeParse({ AGENT_MODEL_REQUEST_TIMEOUT_MS: "0" }).success).toBe(false);
  });
});

describe("agent run watchdog config", () => {
  it("defaults to fifteen minutes", () => {
    expect(configSchema.parse({}).AGENT_RUN_WATCHDOG_MS).toBe(900_000);
  });

  it("coerces positive integer values and rejects zero", () => {
    expect(configSchema.parse({ AGENT_RUN_WATCHDOG_MS: "1234" }).AGENT_RUN_WATCHDOG_MS).toBe(1234);
    expect(configSchema.safeParse({ AGENT_RUN_WATCHDOG_MS: "0" }).success).toBe(false);
  });
});
