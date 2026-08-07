import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleVertex } from "@ai-sdk/google-vertex";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Instructions, ModelMessage, SystemModelMessage, UserContent, UserModelMessage } from "ai";
import { configSchema } from "../../config";
import type { SettingsTable } from "../../db/schema";
import type { AgentRuntimeCostTable, AgentRuntimeProviderFactoryConfig, AgentRuntimeProviderKind } from "./contracts";
import { ModelRequestTimeoutError } from "./errors";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./pricing";

const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 600_000;
const MODEL_REQUEST_DEADLINE_REASON = Symbol("model request deadline");

export interface AgentRuntimePromptInput {
  systemPrompt: string;
  prompt: string | UserContent;
  messages?: ModelMessage[];
  cacheBreakpoints?: boolean;
}

export interface AgentRuntimePreparedPrompt {
  instructions: Instructions;
  messages: ModelMessage[];
}

export interface AgentRuntimeProvider {
  provider: AgentRuntimeProviderKind;
  modelId: string;
  model: import("ai").LanguageModel;
  costTable: AgentRuntimeCostTable;
  preparePrompt(input: AgentRuntimePromptInput): AgentRuntimePreparedPrompt;
}

export interface AgentRuntimeProviderFactoryDeps {
  fetch?: typeof fetch;
}

type RuntimeLlmSettings = Pick<
  SettingsTable,
  "llm_provider" | "anthropic_api_key" | "aws_access_key_id" | "aws_secret_access_key" | "aws_region" | "model_id"
>;

type RuntimeProviderOptions = NonNullable<SystemModelMessage["providerOptions"]>;

/**
 * A caller abort outranks the deadline. Both signals can be aborted by the time a slow transport
 * finally rejects; without this precedence a user interruption would be reported as a timeout.
 */
function isModelRequestDeadline(deadlineController: AbortController, callerSignal?: AbortSignal | null): boolean {
  if (callerSignal?.aborted) return false;
  return deadlineController.signal.reason === MODEL_REQUEST_DEADLINE_REASON;
}

function deadlineBody(
  body: ReadableStream<Uint8Array>,
  deadlineController: AbortController,
  clearDeadline: () => void,
  callerSignal?: AbortSignal | null,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let clearAfterPull = false;
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          clearAfterPull = true;
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(
          isModelRequestDeadline(deadlineController, callerSignal) ? new ModelRequestTimeoutError(error) : error,
        );
        clearAfterPull = true;
      } finally {
        if (clearAfterPull) clearDeadline();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        clearDeadline();
      }
    },
  });
}

export const withDeadline =
  (ms: number, inner: typeof fetch = fetch): typeof fetch =>
  async (input, init) => {
    const deadlineController = new AbortController();
    const signals = [deadlineController.signal];
    if (init?.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let streamOwnsDeadline = false;
    const clearDeadline = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    timer = setTimeout(() => deadlineController.abort(MODEL_REQUEST_DEADLINE_REASON), ms);

    try {
      const response = await inner(input, { ...init, signal });
      if (!response.body) return response;

      const body = deadlineBody(response.body, deadlineController, clearDeadline, init?.signal);
      const wrappedResponse = new Response(body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
      streamOwnsDeadline = true;
      return wrappedResponse;
    } catch (error) {
      if (isModelRequestDeadline(deadlineController, init?.signal)) throw new ModelRequestTimeoutError(error);
      throw error;
    } finally {
      if (!streamOwnsDeadline) clearDeadline();
    }
  };

function compactHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function isOpenRouterBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "openrouter.ai";
  } catch {
    return false;
  }
}

function normalizeOpenRouterBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) return "https://openrouter.ai/api/v1";
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname.toLowerCase() === "openrouter.ai" && parsed.pathname.replace(/\/$/, "") === "/api") {
      return "https://openrouter.ai/api/v1";
    }
  } catch {
    return baseUrl;
  }
  return baseUrl;
}

function cacheProviderOptions(provider: "anthropic" | "bedrock"): RuntimeProviderOptions {
  return (
    provider === "anthropic"
      ? { anthropic: { cacheControl: { type: "ephemeral" } } }
      : { bedrock: { cachePoint: { type: "default" } } }
  ) as RuntimeProviderOptions;
}

function withLastMessageCacheControl(messages: ModelMessage[], provider: "anthropic" | "bedrock"): ModelMessage[] {
  if (messages.length === 0) return messages;
  const last = messages.at(-1);
  if (!last) return messages;
  const providerOptions = cacheProviderOptions(provider);

  return [
    ...messages.slice(0, -1),
    {
      ...last,
      providerOptions: {
        ...(last as { providerOptions?: Record<string, unknown> }).providerOptions,
        ...providerOptions,
      },
    } as unknown as ModelMessage,
  ];
}

function cachedInstructions(provider: "anthropic" | "bedrock", systemPrompt: string): SystemModelMessage {
  return {
    role: "system",
    content: systemPrompt,
    providerOptions: cacheProviderOptions(provider),
  };
}

function preparePromptWithCache(
  provider: AgentRuntimeProviderKind,
  input: AgentRuntimePromptInput,
): AgentRuntimePreparedPrompt {
  const promptMessage: UserModelMessage = { role: "user", content: input.prompt };
  const messages = input.messages ?? [promptMessage];
  if (!input.cacheBreakpoints) {
    return {
      instructions: input.systemPrompt,
      messages,
    };
  }

  if (provider === "bedrock") {
    return {
      instructions: cachedInstructions("bedrock", input.systemPrompt),
      messages: withLastMessageCacheControl(messages, provider),
    };
  }

  if (provider === "anthropic") {
    return {
      instructions: cachedInstructions("anthropic", input.systemPrompt),
      messages: withLastMessageCacheControl(messages, provider),
    };
  }

  return {
    instructions: input.systemPrompt,
    messages,
  };
}

export function createAgentRuntimeProvider(
  config: AgentRuntimeProviderFactoryConfig,
  deps: AgentRuntimeProviderFactoryDeps = {},
): AgentRuntimeProvider {
  const fetchWithDeadline = withDeadline(config.modelRequestTimeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS, deps.fetch);

  if (config.provider === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: config.apiKey ?? undefined,
      baseURL: config.baseUrl ?? undefined,
      headers: config.headers,
      fetch: fetchWithDeadline,
    });
    return {
      provider: "anthropic",
      modelId: config.modelId,
      model: anthropic(config.modelId),
      costTable: config.costTable,
      preparePrompt: (input) => preparePromptWithCache("anthropic", input),
    };
  }

  if (config.provider === "bedrock") {
    const bedrock = createAmazonBedrock({
      region: config.region ?? undefined,
      accessKeyId: config.awsAccessKeyId ?? undefined,
      secretAccessKey: config.awsSecretAccessKey ?? undefined,
      sessionToken: config.awsSessionToken ?? undefined,
      baseURL: config.baseUrl ?? undefined,
      headers: config.headers,
      fetch: fetchWithDeadline,
    });
    return {
      provider: "bedrock",
      modelId: config.modelId,
      model: bedrock(config.modelId),
      costTable: config.costTable,
      preparePrompt: (input) => preparePromptWithCache("bedrock", input),
    };
  }

  if (config.provider === "openrouter" || config.provider === "openai-compatible") {
    const provider = createOpenAICompatible({
      name: config.provider === "openrouter" ? "openrouter" : "openai-compatible",
      baseURL: config.baseUrl ?? "https://openrouter.ai/api/v1",
      apiKey: config.apiKey ?? undefined,
      headers: config.headers,
      fetch: fetchWithDeadline,
      includeUsage: true,
      // OpenRouter advertises JSON-schema structured output for the authoring model.
      // Without this flag the AI SDK silently downgrades Output.object to JSON-object
      // mode, allowing prose that fails the automation schema.
      supportsStructuredOutputs: config.provider === "openrouter",
    });
    return {
      provider: config.provider,
      modelId: config.modelId,
      model: provider(config.modelId),
      costTable: config.costTable,
      preparePrompt: (input) => preparePromptWithCache(config.provider, input),
    };
  }

  const vertex = createGoogleVertex({
    apiKey: config.apiKey ?? undefined,
    project: config.vertexProject ?? undefined,
    location: config.vertexLocation ?? config.region ?? undefined,
    baseURL: config.baseUrl ?? undefined,
    headers: config.headers,
    fetch: fetchWithDeadline,
  });
  return {
    provider: "vertex",
    modelId: config.modelId,
    model: vertex(config.modelId),
    costTable: config.costTable,
    preparePrompt: (input) => preparePromptWithCache("vertex", input),
  };
}

export function resolveAgentRuntimeProviderConfigFromSettings(
  settings: RuntimeLlmSettings | null,
  env: NodeJS.ProcessEnv = process.env,
  costTable: AgentRuntimeCostTable = DEFAULT_AGENT_RUNTIME_COST_TABLE,
): AgentRuntimeProviderFactoryConfig | null {
  const provider = settings?.llm_provider ?? null;
  const modelRequestTimeoutMs = configSchema.shape.AGENT_MODEL_REQUEST_TIMEOUT_MS.parse(
    env.AGENT_MODEL_REQUEST_TIMEOUT_MS,
  );

  if (provider === "anthropic") {
    const apiKey = settings?.anthropic_api_key || env.ANTHROPIC_API_KEY || null;
    if (!apiKey) return null;
    return {
      provider: "anthropic",
      modelId: settings?.model_id || env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      apiKey,
      modelRequestTimeoutMs,
      costTable,
    };
  }

  if (provider === "bedrock") {
    const awsAccessKeyId = settings?.aws_access_key_id || env.AWS_ACCESS_KEY_ID || null;
    const awsSecretAccessKey = settings?.aws_secret_access_key || env.AWS_SECRET_ACCESS_KEY || null;
    const region = settings?.aws_region || env.AWS_REGION || env.AWS_DEFAULT_REGION || null;
    return {
      provider: "bedrock",
      modelId: settings?.model_id || env.ANTHROPIC_MODEL || "us.anthropic.claude-sonnet-4-6",
      awsAccessKeyId,
      awsSecretAccessKey,
      awsSessionToken: env.AWS_SESSION_TOKEN ?? null,
      region,
      modelRequestTimeoutMs,
      costTable,
    };
  }

  if (provider === "openrouter") {
    const apiKey = settings?.anthropic_api_key || env.ANTHROPIC_AUTH_TOKEN || env.OPENROUTER_API_KEY || null;
    const modelId = settings?.model_id || env.ANTHROPIC_MODEL || null;
    if (!apiKey || !modelId) return null;
    return {
      provider: "openrouter",
      modelId,
      apiKey,
      baseUrl: "https://openrouter.ai/api/v1",
      headers: compactHeaders({
        "HTTP-Referer": env.BASE_URL,
        "X-Title": "Sketch",
      }),
      modelRequestTimeoutMs,
      costTable,
    };
  }

  if (provider === "vertex") {
    return {
      provider: "vertex",
      modelId: settings?.model_id || env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      apiKey: env.GOOGLE_VERTEX_API_KEY ?? null,
      vertexProject: env.GOOGLE_VERTEX_PROJECT ?? null,
      vertexLocation: env.GOOGLE_VERTEX_LOCATION ?? null,
      modelRequestTimeoutMs,
      costTable,
    };
  }

  if (env.CLAUDE_CODE_USE_BEDROCK === "1") {
    const awsAccessKeyId = env.AWS_ACCESS_KEY_ID ?? null;
    const awsSecretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? null;
    const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || null;
    return {
      provider: "bedrock",
      modelId: env.ANTHROPIC_MODEL || "us.anthropic.claude-sonnet-4-6",
      awsAccessKeyId,
      awsSecretAccessKey,
      awsSessionToken: env.AWS_SESSION_TOKEN ?? null,
      region,
      modelRequestTimeoutMs,
      costTable,
    };
  }

  if (env.CLAUDE_CODE_USE_VERTEX === "1") {
    return {
      provider: "vertex",
      modelId: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      apiKey: env.GOOGLE_VERTEX_API_KEY ?? null,
      vertexProject: env.GOOGLE_VERTEX_PROJECT ?? null,
      vertexLocation: env.GOOGLE_VERTEX_LOCATION ?? null,
      modelRequestTimeoutMs,
      costTable,
    };
  }

  const anthropicBaseUrl = env.ANTHROPIC_BASE_URL;
  const hasOpenRouterApiKey = Boolean(env.OPENROUTER_API_KEY);
  const hasOpenRouterBaseUrl = isOpenRouterBaseUrl(anthropicBaseUrl);
  const shouldResolveProviderEnv = Boolean(
    anthropicBaseUrl || env.ANTHROPIC_AUTH_TOKEN || (hasOpenRouterApiKey && env.ANTHROPIC_MODEL),
  );
  if (shouldResolveProviderEnv) {
    const modelId = env.ANTHROPIC_MODEL || null;
    if (!modelId) return null;
    if (hasOpenRouterBaseUrl || hasOpenRouterApiKey) {
      const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.OPENROUTER_API_KEY || null;
      if (!apiKey) return null;
      return {
        provider: "openrouter",
        modelId,
        apiKey,
        baseUrl: normalizeOpenRouterBaseUrl(anthropicBaseUrl),
        modelRequestTimeoutMs,
        costTable,
      };
    }

    const apiKey = env.ANTHROPIC_AUTH_TOKEN || null;
    if (!apiKey) return null;
    return {
      provider: "anthropic",
      modelId,
      apiKey,
      baseUrl: anthropicBaseUrl,
      modelRequestTimeoutMs,
      costTable,
    };
  }

  const apiKey = env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey) return null;
  return {
    provider: "anthropic",
    modelId: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    apiKey,
    modelRequestTimeoutMs,
    costTable,
  };
}
