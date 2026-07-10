import {
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  ToolLoopAgent,
  type ToolSet,
  type UserContent,
  stepCountIs,
} from "ai";
import { reconstructCompactedHistory } from "./compaction";
import type {
  AgentRuntimeCompactionProvider,
  AgentRuntimeCostSummary,
  AgentRuntimeEvents,
  AgentRuntimeMessage,
  AgentRuntimeMessageAppend,
  AgentRuntimeResult,
  AgentRuntimeSessionStore,
  AgentRuntimeStopReason,
  AgentRuntimeUsage,
} from "./contracts";
import { AgentRuntimeProviderError, isRuntimeAbortError } from "./errors";
import { createAgentRuntimeSessionId } from "./ids";
import { capPersistedRuntimeMessages } from "./persisted-content";
import { computeRuntimeCost } from "./pricing";
import type { AgentRuntimeProvider } from "./provider";
import { emptyRuntimeUsage, extractRuntimeModelUsage, mergeRuntimeUsageByModel, usageForModel } from "./usage";

export interface RunAgentRuntimeCoreParams {
  provider: AgentRuntimeProvider;
  prompt: string | UserContent;
  systemPrompt: string;
  tools?: ToolSet;
  maxTurns: number;
  abortSignal?: AbortSignal;
  events?: AgentRuntimeEvents;
  sessionId?: string;
  sessionStore?: AgentRuntimeSessionStore;
  compaction?: AgentRuntimeCompactionProvider;
  persistSession: boolean;
  cacheBreakpoints?: boolean;
  logger?: AgentRuntimeCoreLogger;
}

interface AgentRuntimeCoreLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

export const NOOP_AGENT_RUNTIME_SESSION_STORE: AgentRuntimeSessionStore = {
  async load(): Promise<AgentRuntimeMessage[]> {
    return [];
  },
  async appendTransactional(): Promise<void> {},
  async archive(): Promise<void> {},
};

function mapFinishReason(reason: FinishReason | undefined): AgentRuntimeStopReason {
  if (reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  if (reason === "tool-calls") return "tool_use";
  if (reason === "error" || reason === "content-filter") return "error";
  return "unknown";
}

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function isPersistableModelMessage(value: unknown): value is ModelMessage {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

function toPersistedMessages(params: {
  currentUserMessage: ModelMessage;
  responseMessages: readonly ModelMessage[];
}): AgentRuntimeMessageAppend[] {
  return [params.currentUserMessage, ...params.responseMessages].map((message) => ({
    role: message.role,
    content: message,
  }));
}

async function usageFromResult(params: {
  provider: AgentRuntimeProvider;
  resultUsage?: PromiseLike<LanguageModelUsage>;
  steps?: Array<StepResult<ToolSet>>;
}): Promise<AgentRuntimeUsage> {
  if (params.steps && params.steps.length > 0) {
    return mergeRuntimeUsageByModel(
      params.steps.map((step) => usageForModel(step.model.modelId, extractRuntimeModelUsage(step.usage))),
    );
  }

  if (params.resultUsage) {
    try {
      return usageForModel(params.provider.modelId, extractRuntimeModelUsage(await params.resultUsage));
    } catch {
      return emptyRuntimeUsage(params.provider.modelId);
    }
  }

  return emptyRuntimeUsage(params.provider.modelId);
}

function costFromUsage(provider: AgentRuntimeProvider, usage: AgentRuntimeUsage): AgentRuntimeCostSummary {
  return computeRuntimeCost({ provider: provider.provider, usage, costTable: provider.costTable });
}

function abortedResult(params: {
  startedAt: number;
  sessionId: string;
  provider: AgentRuntimeProvider;
}): AgentRuntimeResult {
  const usage = emptyRuntimeUsage(params.provider.modelId);

  return {
    sessionId: params.sessionId,
    finalText: "",
    stopReason: "aborted",
    num_turns: 0,
    durations: {
      totalMs: Date.now() - params.startedAt,
      providerMs: 0,
    },
    usage,
    cost: costFromUsage(params.provider, usage),
  };
}

/**
 * Pre-run compaction is a latency/cost optimization, not part of the user's turn semantics.
 * Non-abort failures fail open to the already persisted history so transient summarizer or marker errors cannot drop a turn.
 */
async function resolveEffectiveHistory(params: {
  persistSession: boolean;
  sessionStore?: AgentRuntimeSessionStore;
  compaction?: AgentRuntimeCompactionProvider;
  sessionId: string;
  persistedHistory: AgentRuntimeMessage[];
  abortSignal?: AbortSignal;
  logger?: AgentRuntimeCoreLogger;
}): Promise<{ behavior: "continue"; history: AgentRuntimeMessage[] } | { behavior: "aborted" }> {
  const reconstructed = reconstructCompactedHistory(params.persistedHistory);
  if (!params.persistSession || !params.sessionStore || !params.compaction) {
    return { behavior: "continue", history: reconstructed };
  }

  try {
    return {
      behavior: "continue",
      history: await params.compaction.compact({ sessionId: params.sessionId, messages: params.persistedHistory }),
    };
  } catch (err) {
    if (isRuntimeAbortError(err, params.abortSignal)) {
      return { behavior: "aborted" };
    }

    params.logger?.warn(
      { err, sessionId: params.sessionId },
      "AI SDK runtime compaction failed; proceeding with un-compacted history",
    );
    return { behavior: "continue", history: reconstructed };
  }
}

async function settleSteps(
  streamResult: Awaited<ReturnType<ToolLoopAgent["stream"]>> | undefined,
): Promise<Array<StepResult<ToolSet>>> {
  if (!streamResult) return [];
  try {
    return await streamResult.steps;
  } catch {
    return [];
  }
}

async function settleFinishReason(
  streamResult: Awaited<ReturnType<ToolLoopAgent["stream"]>> | undefined,
): Promise<FinishReason | undefined> {
  if (!streamResult) return undefined;
  try {
    return await streamResult.finishReason;
  } catch {
    return undefined;
  }
}

export async function runAgentRuntimeCore(params: RunAgentRuntimeCoreParams): Promise<AgentRuntimeResult> {
  const startedAt = Date.now();
  const sessionId = params.sessionId ?? createAgentRuntimeSessionId();
  if (params.persistSession && !params.sessionStore) {
    throw new Error("AI SDK session persistence requires an AgentRuntimeSessionStore");
  }
  await params.events?.onSessionId?.(sessionId);

  let finalText = "";
  let sawAbort = false;
  let providerMs = 0;
  let observedTurns = 0;
  let persistedHistory: AgentRuntimeMessage[] = [];
  const currentUserMessage: ModelMessage = { role: "user", content: params.prompt };
  if (params.persistSession && params.sessionStore) {
    try {
      persistedHistory = await params.sessionStore.load(sessionId);
    } catch {
      persistedHistory = [];
    }
  }

  const effectiveHistoryResult = await resolveEffectiveHistory({
    persistSession: params.persistSession,
    sessionStore: params.sessionStore,
    compaction: params.compaction,
    sessionId,
    persistedHistory,
    abortSignal: params.abortSignal,
    logger: params.logger,
  });
  if (effectiveHistoryResult.behavior === "aborted") {
    return abortedResult({ startedAt, sessionId, provider: params.provider });
  }
  const effectiveHistory = effectiveHistoryResult.history;
  const historyMessages = effectiveHistory.map((message) => message.content).filter(isPersistableModelMessage);
  const preparedPrompt = params.provider.preparePrompt({
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
    messages: [...historyMessages, currentUserMessage],
    cacheBreakpoints: params.cacheBreakpoints ?? true,
  });
  const agent = new ToolLoopAgent({
    model: params.provider.model,
    tools: params.tools ?? {},
    instructions: preparedPrompt.instructions,
    stopWhen: stepCountIs(params.maxTurns),
    onToolExecutionStart: async (event) => {
      await params.events?.onToolStart?.({
        name: event.toolCall.toolName,
        input: objectInput(event.toolCall.input),
      });
    },
    onToolExecutionEnd: async (event) => {
      const toolOutput = event.toolOutput;
      const toolError = toolOutput.type === "tool-error" ? toolOutput.error : undefined;
      await params.events?.onToolEnd?.({
        name: event.toolCall.toolName,
        input: objectInput(event.toolCall.input),
        result: toolOutput.type === "tool-result" ? toolOutput.output : undefined,
        durationMs: event.toolExecutionMs,
        ...(toolError === undefined
          ? {}
          : {
              error: {
                message: errorMessage(toolError),
                name: errorName(toolError),
              },
            }),
      });
    },
    onStepEnd: (step) => {
      observedTurns = Math.max(observedTurns, step.stepNumber + 1);
      providerMs += step.performance.responseTimeMs;
    },
  });

  let streamResult: Awaited<ReturnType<typeof agent.stream>> | undefined;

  try {
    streamResult = await agent.stream({
      messages: preparedPrompt.messages,
      abortSignal: params.abortSignal,
    });

    for await (const part of streamResult.stream) {
      if (part.type === "text-delta") {
        finalText += part.text;
        await params.events?.onTextDelta?.(part.text);
      } else if (part.type === "abort") {
        sawAbort = true;
      } else if (part.type === "error") {
        throw part.error;
      }
    }
  } catch (error) {
    if (!isRuntimeAbortError(error, params.abortSignal)) {
      throw new AgentRuntimeProviderError({
        provider: params.provider.provider,
        modelId: params.provider.modelId,
        message: `Agent runtime provider failed for ${params.provider.provider}:${params.provider.modelId}`,
        cause: error,
      });
    }
    sawAbort = true;
  }

  const steps = await settleSteps(streamResult);
  const responseMessages = steps.flatMap((step) => step.response.messages).filter(isPersistableModelMessage);
  if (params.persistSession && params.sessionStore && responseMessages.length > 0) {
    await params.sessionStore.appendTransactional(
      sessionId,
      capPersistedRuntimeMessages(toPersistedMessages({ currentUserMessage, responseMessages })),
    );
  }
  const usage = await usageFromResult({
    provider: params.provider,
    resultUsage: streamResult?.usage,
    steps,
  });
  const finishReason = await settleFinishReason(streamResult);
  const stopReason = sawAbort || params.abortSignal?.aborted ? "aborted" : mapFinishReason(finishReason);

  return {
    sessionId,
    finalText,
    stopReason,
    num_turns: Math.max(observedTurns, steps.length),
    durations: {
      totalMs: Date.now() - startedAt,
      providerMs,
    },
    usage,
    cost: costFromUsage(params.provider, usage),
  };
}
