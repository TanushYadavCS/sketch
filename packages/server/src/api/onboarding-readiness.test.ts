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
    ["Anthropic", { ANTHROPIC_API_KEY: "sk-ant-env" }],
    ["Bedrock with ambient AWS credentials", { CLAUDE_CODE_USE_BEDROCK: "1" }],
    ["Vertex", { CLAUDE_CODE_USE_VERTEX: "1" }],
    [
      "a custom Anthropic endpoint",
      {
        ANTHROPIC_BASE_URL: "https://anthropic-gateway.example.com",
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
        ANTHROPIC_MODEL: "gateway-model",
      },
    ],
  ])("counts environment-backed %s configuration as ready", (_name, env) => {
    expect(getOnboardingReadiness(readySettings(), undefined, env)).toMatchObject({
      hasLlm: true,
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
});
