import { NoObjectGeneratedError, Output, generateText } from "ai";
import { extractRuntimeModelUsage } from "../../agent/runtime/usage";
import {
  AutomationAuthoringGeneratedOutputError,
  type StructuredAutomationAuthoringGeneration,
  type StructuredAutomationAuthoringGenerator,
} from "./service";

interface GenerateTextInput {
  model: Parameters<typeof generateText>[0]["model"];
  instructions: string;
  prompt: string;
  output: ReturnType<typeof Output.object>;
  maxRetries: 0;
  timeout: { totalMs: number };
  maxOutputTokens: number;
  include: { requestBody: false; requestMessages: false; responseBody: false };
}

interface GenerateTextResultLike {
  output: unknown;
  response: { modelId: string };
  usage: unknown;
}

type GenerateTextLike = (input: GenerateTextInput) => Promise<GenerateTextResultLike>;

interface NoObjectGeneratedLike {
  response?: { modelId?: string };
  usage?: unknown;
}

function sdkCostFromUsage(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const raw = (usage as { raw?: unknown }).raw;
  if (!raw || typeof raw !== "object") return 0;
  const cost = (raw as { cost?: unknown }).cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

function generationFrom(params: {
  output: unknown;
  model: string;
  usage: unknown;
}): StructuredAutomationAuthoringGeneration {
  return {
    output: params.output,
    model: params.model,
    usage: extractRuntimeModelUsage(params.usage),
    sdkCostUsd: sdkCostFromUsage(params.usage),
  };
}

export function createAiSdkAutomationAuthoringGenerator(
  deps: {
    generateText?: GenerateTextLike;
    isNoObjectGeneratedError?: (error: unknown) => boolean;
  } = {},
): StructuredAutomationAuthoringGenerator {
  const runGenerateText: GenerateTextLike =
    deps.generateText ??
    ((input) => generateText(input as Parameters<typeof generateText>[0]) as Promise<GenerateTextResultLike>);
  const isNoObjectGeneratedError = deps.isNoObjectGeneratedError ?? NoObjectGeneratedError.isInstance;

  return {
    async generate(params) {
      try {
        const result = await runGenerateText({
          model: params.provider.model,
          instructions: params.instructions,
          prompt: params.prompt,
          output: Output.object({ schema: params.outputSchema }),
          maxRetries: params.maxRetries,
          timeout: { totalMs: params.timeoutMs },
          maxOutputTokens: params.maxOutputTokens,
          include: { requestBody: false, requestMessages: false, responseBody: false },
        });
        return generationFrom({
          output: result.output,
          model: result.response.modelId || params.provider.modelId,
          usage: result.usage,
        });
      } catch (error) {
        if (!isNoObjectGeneratedError(error)) throw error;
        const structuredError = error as NoObjectGeneratedLike;
        throw new AutomationAuthoringGeneratedOutputError(
          undefined,
          generationFrom({
            output: null,
            model: structuredError.response?.modelId || params.provider.modelId,
            usage: structuredError.usage,
          }),
        );
      }
    },
  };
}
