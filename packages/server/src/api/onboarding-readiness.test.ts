import { describe, expect, it } from "vitest";
import { getOnboardingReadiness } from "./onboarding-readiness";

type SettingsRow = NonNullable<Parameters<typeof getOnboardingReadiness>[0]>;

function readySettings(overrides: Partial<SettingsRow> = {}): SettingsRow {
  return {
    admin_email: "admin@test.com",
    org_name: "Acme",
    bot_name: "Sketch",
    llm_provider: null,
    anthropic_api_key: null,
    aws_access_key_id: null,
    aws_secret_access_key: null,
    aws_region: null,
    model_id: null,
    ...overrides,
  } as SettingsRow;
}

describe("getOnboardingReadiness", () => {
  it.each([
    ["Anthropic", { ANTHROPIC_API_KEY: "sk-ant-env" }, "anthropic"],
    ["Bedrock with ambient AWS credentials", { CLAUDE_CODE_USE_BEDROCK: "1" }, "bedrock"],
    ["Vertex", { CLAUDE_CODE_USE_VERTEX: "1" }, "vertex"],
    [
      "a custom Anthropic endpoint",
      {
        ANTHROPIC_BASE_URL: "https://anthropic-gateway.example.com",
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
        ANTHROPIC_MODEL: "gateway-model",
      },
      "anthropic",
    ],
  ])("counts environment-backed %s configuration as ready", (_name, env, llmProvider) => {
    expect(getOnboardingReadiness(readySettings(), undefined, env)).toMatchObject({
      hasLlm: true,
      llmProvider,
      readyToComplete: true,
      missing: [],
    });
  });

  it("still rejects an incomplete environment-backed configuration", () => {
    expect(
      getOnboardingReadiness(readySettings(), undefined, {
        ANTHROPIC_BASE_URL: "https://anthropic-gateway.example.com",
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
      }),
    ).toMatchObject({
      hasLlm: false,
      readyToComplete: false,
      missing: ["llm"],
    });
  });

  it("rejects incomplete persisted Bedrock settings without ambient Bedrock routing", () => {
    expect(
      getOnboardingReadiness(
        readySettings({
          llm_provider: "bedrock",
          model_id: "us.anthropic.claude-sonnet-4-6",
        }),
        undefined,
        {},
      ),
    ).toMatchObject({
      hasLlm: false,
      llmProvider: null,
      readyToComplete: false,
      missing: ["llm"],
    });
  });

  it("uses ambient Bedrock routing when persisted Bedrock settings are incomplete", () => {
    expect(
      getOnboardingReadiness(
        readySettings({
          llm_provider: "bedrock",
          model_id: "us.anthropic.claude-sonnet-4-6",
        }),
        undefined,
        { CLAUDE_CODE_USE_BEDROCK: "1" },
      ),
    ).toMatchObject({
      hasLlm: true,
      llmProvider: "bedrock",
      readyToComplete: true,
      missing: [],
    });
  });
});
