import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestConfig } from "../test-utils";
import {
  assertFollowupReviewQaDatabasePath,
  assertFollowupReviewQaPaths,
  createFollowupReviewQaConfig,
} from "./followup-review-qa-config";

const PROJECT_ROOT = "/tmp/sketch";
const QA_ROOT = join(PROJECT_ROOT, "data", "manual-qa", "web-chat-followup-review");

describe("follow-up review QA config", () => {
  it("accepts only a SQLite database contained by the manual QA data directory", () => {
    const config = createTestConfig({
      DB_TYPE: "sqlite",
      DATA_DIR: QA_ROOT,
      SQLITE_PATH: join(QA_ROOT, "sketch.db"),
    });

    expect(() => assertFollowupReviewQaPaths(config, PROJECT_ROOT)).not.toThrow();
    expect(() =>
      assertFollowupReviewQaPaths(
        createTestConfig({ DB_TYPE: "postgres", DATA_DIR: QA_ROOT, SQLITE_PATH: join(QA_ROOT, "sketch.db") }),
        PROJECT_ROOT,
      ),
    ).toThrow("DB_TYPE=sqlite");
    expect(() =>
      assertFollowupReviewQaPaths(
        createTestConfig({
          DB_TYPE: "sqlite",
          DATA_DIR: join(PROJECT_ROOT, "data"),
          SQLITE_PATH: join(PROJECT_ROOT, "data", "sketch.db"),
        }),
        PROJECT_ROOT,
      ),
    ).toThrow("DATA_DIR");
    expect(() =>
      assertFollowupReviewQaPaths(
        createTestConfig({
          DB_TYPE: "sqlite",
          DATA_DIR: QA_ROOT,
          SQLITE_PATH: join(PROJECT_ROOT, "data", "sketch.db"),
        }),
        PROJECT_ROOT,
      ),
    ).toThrow("SQLITE_PATH");
  });

  it("rejects runtime-isolation targets outside the manual QA root", () => {
    expect(() => assertFollowupReviewQaDatabasePath(join(QA_ROOT, "sketch.db"), PROJECT_ROOT)).not.toThrow();
    expect(() => assertFollowupReviewQaDatabasePath(join(PROJECT_ROOT, "data", "sketch.db"), PROJECT_ROOT)).toThrow(
      "database must be inside",
    );
  });

  it("removes provider credentials and isolates runtime config directories", () => {
    const safeConfig = createFollowupReviewQaConfig(
      createTestConfig({
        DATA_DIR: QA_ROOT,
        PORT: 5002,
        OPENROUTER_API_KEY: "live-key",
        WATI_ACCESS_TOKEN: "live-token",
        MANAGED_WHATSAPP_TENANT_TOKEN: "live-managed-token",
        POSTHOG_API_KEY: "live-posthog-key",
        BOOTSTRAP_SLACK_BOT_TOKEN: "live-slack-token",
      }),
    );

    expect(safeConfig).toMatchObject({
      OPENROUTER_API_KEY: undefined,
      WHATSAPP_DM_PROVIDER: "baileys",
      WATI_ACCESS_TOKEN: undefined,
      MANAGED_WHATSAPP_TENANT_TOKEN: undefined,
      POSTHOG_API_KEY: undefined,
      BOOTSTRAP_SLACK_BOT_TOKEN: undefined,
      BASE_URL: "http://localhost:5002",
      CLAUDE_CONFIG_DIR: join(QA_ROOT, "claude-config"),
      SKETCH_CONFIG_DIR: join(QA_ROOT, "sketch-config"),
    });
  });
});
