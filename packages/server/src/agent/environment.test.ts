import { describe, expect, it } from "vitest";
import { isReservedAgentEnvName, removeReservedAgentEnv } from "./environment";

describe("agent environment helpers", () => {
  it("identifies runtime-reserved names", () => {
    expect(isReservedAgentEnvName("CLAUDE_CODE_USE_BEDROCK")).toBe(true);
    expect(isReservedAgentEnvName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isReservedAgentEnvName("OPENAI_API_KEY")).toBe(true);
    expect(isReservedAgentEnvName("GH_TOKEN")).toBe(true);
    expect(isReservedAgentEnvName("LINEAR_API_KEY")).toBe(true);
    expect(isReservedAgentEnvName("AWS_ACCESS_KEY_ID")).toBe(true);
    expect(isReservedAgentEnvName("TEST_ENV_VALUE")).toBe(false);
  });

  it("removes reserved names before runtime injection", () => {
    expect(
      removeReservedAgentEnv({
        ANTHROPIC_API_KEY: "sk-test",
        AWS_ACCESS_KEY_ID: "aws-test",
        TEST_ENV_VALUE: "visible",
      }),
    ).toEqual({
      TEST_ENV_VALUE: "visible",
    });
  });
});
