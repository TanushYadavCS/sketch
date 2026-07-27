import { describe, expect, it, vi } from "vitest";
import { validAuthoringDefinition } from "./fixtures";
import { createAiSdkAutomationAuthoringGenerator } from "./generator";
import { automationAuthoringOutputSchema } from "./schema";
import { AutomationAuthoringGeneratedOutputError, type StructuredAutomationAuthoringGenerator } from "./service";

const provider = {
  provider: "openrouter" as const,
  modelId: "anthropic/claude-sonnet-4.6",
  model: {} as never,
};

function request(): Parameters<StructuredAutomationAuthoringGenerator["generate"]>[0] {
  return {
    operation: "create",
    provider,
    instructions: "Return a definition",
    prompt: "Create a digest",
    outputSchema: automationAuthoringOutputSchema,
    attempt: 1,
    maxRetries: 0,
    timeoutMs: 30_000,
    maxOutputTokens: 4096,
  };
}

describe("AI SDK automation authoring generator", () => {
  it("uses structured output with hard retry, timeout, output, and retained-body bounds", async () => {
    const generateText = vi.fn().mockResolvedValue({
      output: { kind: "definition", definition: validAuthoringDefinition },
      response: { modelId: "anthropic/claude-sonnet-4.6" },
      usage: {
        inputTokens: 120,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0 },
        outputTokens: 50,
      },
    });
    const generator = createAiSdkAutomationAuthoringGenerator({ generateText });

    await expect(generator.generate(request())).resolves.toMatchObject({
      output: { kind: "definition" },
      model: "anthropic/claude-sonnet-4.6",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
      },
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: provider.model,
        instructions: "Return a definition",
        prompt: "Create a digest",
        maxRetries: 0,
        timeout: { totalMs: 30_000 },
        maxOutputTokens: 4096,
        include: { requestBody: false, requestMessages: false, responseBody: false },
        output: expect.anything(),
      }),
    );
  });

  it("classifies structured-output parse failures as validation failures with usage but no response text", async () => {
    const generateText = vi.fn().mockRejectedValue({
      name: "AI_NoObjectGeneratedError",
      text: "sensitive invalid draft",
      response: { modelId: "anthropic/claude-sonnet-4.6" },
      usage: {
        inputTokens: 80,
        inputTokenDetails: { noCacheTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokens: 10,
      },
    });
    const generator = createAiSdkAutomationAuthoringGenerator({
      generateText,
      isNoObjectGeneratedError: (error) =>
        Boolean(
          error && typeof error === "object" && (error as { name?: string }).name === "AI_NoObjectGeneratedError",
        ),
    });

    try {
      await generator.generate(request());
      throw new Error("expected structured output failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationAuthoringGeneratedOutputError);
      expect(error).not.toHaveProperty("text");
      expect((error as AutomationAuthoringGeneratedOutputError).generation).toMatchObject({
        model: "anthropic/claude-sonnet-4.6",
        usage: { inputTokens: 80, outputTokens: 10 },
      });
    }
  });
});
