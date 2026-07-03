import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema, loadConfig, validateConfig } from "./config";
import type { Config } from "./config";

describe("configSchema", () => {
  describe("valid configs", () => {
    it("parses minimal config with all defaults", () => {
      const result = configSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("coerces PORT string to number", () => {
      const result = configSchema.safeParse({ PORT: "8080" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(8080);
      }
    });

    it("applies all defaults correctly", () => {
      const result = configSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.DB_TYPE).toBe("sqlite");
        expect(result.data.PORT).toBe(3000);
        expect(result.data.LOG_LEVEL).toBe("info");
        expect(result.data.DATA_DIR).toBe("./data");
        expect(result.data.SQLITE_PATH).toBe("./data/sketch.db");
        expect(result.data.SLACK_CHANNEL_HISTORY_LIMIT).toBe(5);
        expect(result.data.SLACK_THREAD_HISTORY_LIMIT).toBe(50);
        expect(result.data.WHATSAPP_DM_PROVIDER).toBe("baileys");
        expect(result.data.WHATSAPP_GROUP_PROVIDER).toBe("baileys");
        expect(result.data.MAX_CONCURRENT_AGENT_RUNS).toBe(4);
        expect(result.data.MAX_FILE_SIZE_MB).toBe(20);
        expect(result.data.VISION_ENABLED).toBe(false);
      }
    });

    it("parses WhatsApp provider configuration", () => {
      const result = configSchema.safeParse({
        WHATSAPP_DM_PROVIDER: "wati",
        WHATSAPP_GROUP_PROVIDER: "none",
        WATI_API_ENDPOINT: "https://tenant.wati.io",
        WATI_ACCESS_TOKEN: "access-token",
        WATI_WEBHOOK_TOKEN: "webhook-token",
        WATI_CHANNEL_PHONE_NUMBER: "+15551234567",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.WHATSAPP_DM_PROVIDER).toBe("wati");
        expect(result.data.WHATSAPP_GROUP_PROVIDER).toBe("none");
        expect(result.data.WATI_API_ENDPOINT).toBe("https://tenant.wati.io");
        expect(result.data.WATI_ACCESS_TOKEN).toBe("access-token");
        expect(result.data.WATI_WEBHOOK_TOKEN).toBe("webhook-token");
        expect(result.data.WATI_CHANNEL_PHONE_NUMBER).toBe("+15551234567");
      }
    });

    it("parses managed WhatsApp provider configuration", () => {
      const result = configSchema.safeParse({
        WHATSAPP_DM_PROVIDER: "managed",
        WHATSAPP_GROUP_PROVIDER: "baileys",
        MANAGED_WHATSAPP_PLATFORM_URL: "https://app.getsketch.ai",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.WHATSAPP_DM_PROVIDER).toBe("managed");
        expect(result.data.MANAGED_WHATSAPP_PLATFORM_URL).toBe("https://app.getsketch.ai");
        expect(result.data.MANAGED_WHATSAPP_TENANT_TOKEN).toBe("tenant-token");
      }
    });

    it("parses vision analysis environment settings", () => {
      const result = configSchema.safeParse({
        VISION_ENABLED: "true",
        VISION_MODEL: "xiaomi/mimo-v2.5",
        OPENROUTER_API_KEY: "sk-or-vision",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.VISION_ENABLED).toBe(true);
        expect(result.data.VISION_MODEL).toBe("xiaomi/mimo-v2.5");
        expect(result.data.OPENROUTER_API_KEY).toBe("sk-or-vision");
        expect("VISION_PROVIDER" in result.data).toBe(false);
        expect("VISION_API_KEY" in result.data).toBe(false);
        expect(result.data.SYNC_ALLOW_LARGE_RECONCILE).toBe(false);
        expect(result.data.SYNC_MAX_RECONCILE_RATIO).toBe(0.5);
        expect(result.data.CO_MENTION_CONTRIBUTES_TO_THRESHOLD).toBe(3);
        expect(result.data.MICROSOFT_TENANT).toBe("common");
        expect(result.data.OUTLOOK_INITIAL_LOOKBACK_DAYS).toBe(365);
        expect(result.data.OUTLOOK_MAX_INFLIGHT).toBe(4);
        expect(result.data.TEAMS_INITIAL_LOOKBACK_DAYS).toBe(365);
        expect(result.data.TEAMS_MAX_INFLIGHT).toBe(4);
        expect(result.data.TEAMS_PROCESSING_LAG_MS).toBe(2 * 60 * 60 * 1000);
      }
    });

    it("parses entity graph heuristic thresholds", () => {
      const result = configSchema.safeParse({
        LLM_PROMOTION_THRESHOLD: "4",
        CO_MENTION_CONTRIBUTES_TO_THRESHOLD: "5",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.LLM_PROMOTION_THRESHOLD).toBe(4);
        expect(result.data.CO_MENTION_CONTRIBUTES_TO_THRESHOLD).toBe(5);
      }
    });

    it("parses sync reconcile guard configuration", () => {
      const result = configSchema.safeParse({
        SYNC_ALLOW_LARGE_RECONCILE: "1",
        SYNC_MAX_RECONCILE_RATIO: "0.75",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SYNC_ALLOW_LARGE_RECONCILE).toBe(true);
        expect(result.data.SYNC_MAX_RECONCILE_RATIO).toBe(0.75);
      }
    });

    it("parses Microsoft connector sync limits", () => {
      const result = configSchema.safeParse({
        MICROSOFT_TENANT: "organizations",
        OUTLOOK_INITIAL_LOOKBACK_DAYS: "180",
        OUTLOOK_MAX_INFLIGHT: "3",
        TEAMS_INITIAL_LOOKBACK_DAYS: "120",
        TEAMS_MAX_INFLIGHT: "2",
        TEAMS_PROCESSING_LAG_MS: "300000",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.MICROSOFT_TENANT).toBe("organizations");
        expect(result.data.OUTLOOK_INITIAL_LOOKBACK_DAYS).toBe(180);
        expect(result.data.OUTLOOK_MAX_INFLIGHT).toBe(3);
        expect(result.data.TEAMS_INITIAL_LOOKBACK_DAYS).toBe(120);
        expect(result.data.TEAMS_MAX_INFLIGHT).toBe(2);
        expect(result.data.TEAMS_PROCESSING_LAG_MS).toBe(300000);
      }
    });

    it("coerces SLACK_CHANNEL_HISTORY_LIMIT string to number", () => {
      const result = configSchema.safeParse({ SLACK_CHANNEL_HISTORY_LIMIT: "10" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SLACK_CHANNEL_HISTORY_LIMIT).toBe(10);
      }
    });

    it("coerces SLACK_THREAD_HISTORY_LIMIT string to number", () => {
      const result = configSchema.safeParse({ SLACK_THREAD_HISTORY_LIMIT: "100" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SLACK_THREAD_HISTORY_LIMIT).toBe(100);
      }
    });

    it("coerces MAX_FILE_SIZE_MB string to number", () => {
      const result = configSchema.safeParse({ MAX_FILE_SIZE_MB: "50" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.MAX_FILE_SIZE_MB).toBe(50);
      }
    });

    it("coerces MAX_CONCURRENT_AGENT_RUNS string to number", () => {
      const result = configSchema.safeParse({ MAX_CONCURRENT_AGENT_RUNS: "2" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.MAX_CONCURRENT_AGENT_RUNS).toBe(2);
      }
    });
  });

  describe("invalid configs", () => {
    it("rejects invalid DB_TYPE", () => {
      const result = configSchema.safeParse({ DB_TYPE: "mysql" });
      expect(result.success).toBe(false);
    });

    it("rejects invalid LOG_LEVEL", () => {
      const result = configSchema.safeParse({ LOG_LEVEL: "trace" });
      expect(result.success).toBe(false);
    });

    it("rejects sync reconcile ratios outside 0..1", () => {
      const result = configSchema.safeParse({ SYNC_MAX_RECONCILE_RATIO: "1.2" });
      expect(result.success).toBe(false);
    });

    it("rejects co-mention thresholds below 2", () => {
      const result = configSchema.safeParse({ CO_MENTION_CONTRIBUTES_TO_THRESHOLD: "1" });
      expect(result.success).toBe(false);
    });

    it("rejects Microsoft connector concurrency outside the bounded Graph limit", () => {
      expect(configSchema.safeParse({ OUTLOOK_MAX_INFLIGHT: "32" }).success).toBe(false);
      expect(configSchema.safeParse({ TEAMS_MAX_INFLIGHT: "32" }).success).toBe(false);
    });

    it("rejects agent concurrency below one", () => {
      const result = configSchema.safeParse({ MAX_CONCURRENT_AGENT_RUNS: "0" });
      expect(result.success).toBe(false);
    });

    it("rejects invalid Wati endpoint URLs", () => {
      const result = configSchema.safeParse({ WATI_API_ENDPOINT: "not-a-url" });
      expect(result.success).toBe(false);
    });
  });
});

describe("loadConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves DATA_DIR and SQLITE_PATH relative to DOTENV_CONFIG_PATH dir", () => {
    vi.stubEnv("DOTENV_CONFIG_PATH", "/project/root/.env");
    vi.stubEnv("DATA_DIR", "./data");
    vi.stubEnv("SQLITE_PATH", "./data/sketch.db");
    const config = loadConfig();
    expect(config.DATA_DIR).toBe("/project/root/data");
    expect(config.SQLITE_PATH).toBe("/project/root/data/sketch.db");
  });

  it("resolves relative paths against cwd when DOTENV_CONFIG_PATH is not set", () => {
    vi.stubEnv("DOTENV_CONFIG_PATH", "");
    vi.stubEnv("DATA_DIR", "./data");
    vi.stubEnv("SQLITE_PATH", "./data/sketch.db");
    const config = loadConfig();
    expect(config.DATA_DIR).toBe(resolve(process.cwd(), "./data"));
    expect(config.SQLITE_PATH).toBe(resolve(process.cwd(), "./data/sketch.db"));
  });

  it("leaves absolute paths unchanged", () => {
    vi.stubEnv("DATA_DIR", "/absolute/data");
    vi.stubEnv("SQLITE_PATH", "/absolute/data/sketch.db");
    const config = loadConfig();
    expect(config.DATA_DIR).toBe("/absolute/data");
    expect(config.SQLITE_PATH).toBe("/absolute/data/sketch.db");
  });
});

describe("validateConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeConfig(overrides: Partial<Config> = {}): Config {
    return {
      DB_TYPE: "sqlite",
      SQLITE_PATH: "./data/sketch.db",
      DATA_DIR: "./data",
      PORT: 3000,
      LOG_LEVEL: "info",
      ...overrides,
    } as Config;
  }

  function mockProcessExit() {
    return vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
  }

  describe("Slack token validation", () => {
    it("does not exit when Slack tokens are missing (WhatsApp-only deployment)", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig();
      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("database validation", () => {
    it("exits when DB_TYPE is postgres without DATABASE_URL", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({
        DB_TYPE: "postgres",
      });
      expect(() => validateConfig(config)).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("does not exit when DB_TYPE is postgres with DATABASE_URL set", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({
        DB_TYPE: "postgres",
        DATABASE_URL: "postgresql://localhost:5432/sketch",
      });
      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("SLACK_MODE validation", () => {
    it("exits when SLACK_MODE is http without SLACK_SIGNING_SECRET", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({ SLACK_MODE: "http" });
      expect(() => validateConfig(config)).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("does not exit when SLACK_MODE is http with SLACK_SIGNING_SECRET set", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({ SLACK_MODE: "http", SLACK_SIGNING_SECRET: "secret123" });
      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("does not exit when SLACK_MODE is socket without SLACK_SIGNING_SECRET", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({ SLACK_MODE: "socket" });
      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("does not exit when SLACK_MODE is absent (defaults to socket)", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig();
      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("connector credential encryption validation", () => {
    it("does not exit at startup when local connector credentials are enabled without ENCRYPTION_KEY", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({ CONNECTOR_CREDENTIAL_SOURCE: "local" });

      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("does not exit when local connector credentials have ENCRYPTION_KEY", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({
        CONNECTOR_CREDENTIAL_SOURCE: "local",
        ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });

      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("does not exit when Canvas connector credentials are enabled without ENCRYPTION_KEY", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({ CONNECTOR_CREDENTIAL_SOURCE: "canvas" });

      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("Wati validation", () => {
    it("does not require Wati credentials unless Wati is the configured DM provider", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({ WHATSAPP_DM_PROVIDER: "baileys" });

      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("exits when Wati is configured without an API endpoint", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({
        WHATSAPP_DM_PROVIDER: "wati",
        WATI_ACCESS_TOKEN: "access-token",
        WATI_WEBHOOK_TOKEN: "webhook-token",
      });
      expect(() => validateConfig(config)).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when Wati is configured without an access token", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({
        WHATSAPP_DM_PROVIDER: "wati",
        WATI_API_ENDPOINT: "https://tenant.wati.io",
        WATI_WEBHOOK_TOKEN: "webhook-token",
      });
      expect(() => validateConfig(config)).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when Wati is configured without a webhook token", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({
        WHATSAPP_DM_PROVIDER: "wati",
        WATI_API_ENDPOINT: "https://tenant.wati.io",
        WATI_ACCESS_TOKEN: "access-token",
      });
      expect(() => validateConfig(config)).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("accepts complete Wati configuration", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({
        WHATSAPP_DM_PROVIDER: "wati",
        WATI_API_ENDPOINT: "https://tenant.wati.io",
        WATI_ACCESS_TOKEN: "access-token",
        WATI_WEBHOOK_TOKEN: "webhook-token",
      });
      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("managed WhatsApp validation", () => {
    it("exits when managed WhatsApp is configured without a platform URL", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({
        WHATSAPP_DM_PROVIDER: "managed",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
      });
      expect(() => validateConfig(config)).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when managed WhatsApp is configured without a tenant token", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({
        WHATSAPP_DM_PROVIDER: "managed",
        MANAGED_WHATSAPP_PLATFORM_URL: "https://app.getsketch.ai",
      });
      expect(() => validateConfig(config)).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("accepts complete managed WhatsApp configuration", () => {
      const exitSpy = mockProcessExit();
      const config = makeConfig({
        WHATSAPP_DM_PROVIDER: "managed",
        MANAGED_WHATSAPP_PLATFORM_URL: "https://app.getsketch.ai",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
      });
      validateConfig(config);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});

describe("configSchema SLACK_MODE field", () => {
  it("defaults SLACK_MODE to socket when not set", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SLACK_MODE).toBe("socket");
    }
  });

  it("accepts SLACK_MODE=socket", () => {
    const result = configSchema.safeParse({ SLACK_MODE: "socket" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SLACK_MODE).toBe("socket");
    }
  });

  it("accepts SLACK_MODE=http", () => {
    const result = configSchema.safeParse({ SLACK_MODE: "http" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SLACK_MODE).toBe("http");
    }
  });

  it("rejects invalid SLACK_MODE values", () => {
    const result = configSchema.safeParse({ SLACK_MODE: "websocket" });
    expect(result.success).toBe(false);
  });

  it("accepts SLACK_SIGNING_SECRET as optional", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SLACK_SIGNING_SECRET).toBeUndefined();
    }
  });

  it("accepts SLACK_SIGNING_SECRET when provided", () => {
    const result = configSchema.safeParse({ SLACK_SIGNING_SECRET: "abc123secret" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SLACK_SIGNING_SECRET).toBe("abc123secret");
    }
  });
});
