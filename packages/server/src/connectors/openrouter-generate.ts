import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type GeminiGenerator, type GenerateMeta, type GenerateOptions, reportMeta } from "./gemini-generate";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DEFAULT_MAX_TOKENS = 8192;

/** Effort applied when we discover mid-flight that the model is reasoning-tier.
 *  Matches the cap project minting already uses: at the endpoint's default
 *  effort the tenant model spends its whole token budget reasoning and returns
 *  no content. */
const FALLBACK_REASONING_EFFORT = "medium" as const;

interface OpenRouterGeneratorOptions {
  model?: string | null;
  timeoutMs?: number;
  /** Reasoning effort forwarded to OpenRouter. Project minting caps this at
   *  "medium" because at default effort the tenant model spent its whole token
   *  budget on reasoning and emitted nothing. When set, `temperature` is
   *  omitted up front. Callers that don't know the model's tier can leave this
   *  unset: a rejected `temperature` is detected from the response and retried
   *  without it (see `isParameterRejection`). */
  reasoningEffort?: "low" | "medium" | "high";
}

interface OpenRouterToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenRouterChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: unknown;
      tool_calls?: OpenRouterToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
  error?: {
    message?: string;
  };
}

/** A read-only capability the agentic loop exposes to the model. `run` returns
 *  the string sent back as the tool result; it must never write. */
export interface AgenticTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: unknown): Promise<string>;
}

export interface AgenticToolStep {
  name: string;
  args: unknown;
  result: string;
  durationMs: number;
  cached: boolean;
}

export interface AgenticOutcome<T> {
  value: T;
  toolSteps: AgenticToolStep[];
  rounds: number;
  meta: GenerateMeta;
}

export type AgenticOptions = Omit<GenerateOptions, "responseMimeType"> & {
  tools: AgenticTool[];
  /** Rounds that may carry tool calls before the loop forces a final answer
   *  with tool_choice "none". */
  maxToolRounds: number;
  /** Awaited as each tool call completes, so a caller persisting a transcript
   *  keeps partial state on a mid-loop crash. Errors are swallowed. */
  onToolStep?: (step: AgenticToolStep) => void | Promise<void>;
};

export interface OpenRouterGenerator extends GeminiGenerator {
  generateAgenticJSON<T>(prompt: string, opts: AgenticOptions): Promise<AgenticOutcome<T>>;
}

const MAX_TOOL_CALLS_PER_ROUND = 3;
const MAX_TOOL_ARG_BYTES = 2048;
const MAX_TOOL_RESULT_CHARS = 2000;

/** Reasoning-tier endpoints reject `temperature`, and with `require_parameters`
 *  that rejection filters out every endpoint, so OpenRouter answers 404 "No
 *  endpoints found that can handle the requested parameters" instead of naming
 *  the offending field. Model IDs give nothing to match on (the tenant routes
 *  through a preset alias), so we detect it from the response and retry. */
function isParameterRejection(status: number, message: string | undefined): boolean {
  return status === 404 && /no endpoints found/i.test(message ?? "");
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : null;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonResponse<T>(text: string, label: string | undefined): T {
  try {
    return JSON.parse(stripJsonFence(text)) as T;
  } catch (err) {
    const labelPrefix = label ? `[${label}] ` : "";
    throw new Error(
      `OpenRouter ${labelPrefix}failed to parse JSON response (${text.length} chars, starts: ${text.slice(0, 100)}): ${err instanceof Error ? err.message : err}`,
    );
  }
}

function truncateToolResult(result: string): string {
  return result.length > MAX_TOOL_RESULT_CHARS ? `${result.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]` : result;
}

function toolError(message: string): string {
  return JSON.stringify({ error: message });
}

async function dumpCall(
  dumpDir: string,
  payload: {
    label: string;
    prompt: string;
    systemPrompt?: string;
    maxTokens: number;
    text: string | undefined;
    finishReason: string | undefined;
    promptTokens: number | undefined;
    completionTokens: number | undefined;
    costUsd: number | undefined;
  },
): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = payload.label.replace(/[^a-zA-Z0-9_-]/g, "_");
  try {
    await mkdir(dumpDir, { recursive: true });
    await writeFile(join(dumpDir, `${ts}__openrouter_${safeLabel}.json`), JSON.stringify(payload, null, 2), "utf8");
  } catch {}
}

export function createOpenRouterGenerator(
  apiKey: string,
  options: OpenRouterGeneratorOptions = {},
): OpenRouterGenerator {
  const model = options.model?.trim() || DEFAULT_MODEL;
  /** Set once dropping `temperature` has been *confirmed* to fix a rejection,
   *  so later calls skip the wasted first attempt for the lifetime of this
   *  generator. A retry that also fails proves nothing and leaves this unset. */
  let temperatureRejected = false;

  async function generate(prompt: string, opts?: GenerateOptions): Promise<string> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
    const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const requestedModel = opts?.model?.trim();
    const modelForCall = requestedModel || model;
    const requiresParameters = opts?.responseMimeType === "application/json";

    async function postChat(withTemperature: boolean) {
      const effort =
        opts?.reasoningEffort ?? options.reasoningEffort ?? (withTemperature ? undefined : FALLBACK_REASONING_EFFORT);
      const response = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelForCall,
          usage: { include: true },
          messages: [
            ...(opts?.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : []),
            { role: "user", content: prompt },
          ],
          max_tokens: maxTokens,
          ...(withTemperature ? { temperature: 0 } : {}),
          ...(effort ? { reasoning: { effort } } : {}),
          ...(requiresParameters
            ? {
                provider: { require_parameters: true },
                response_format: { type: "json_object" },
              }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as OpenRouterChatResponse;
      return { response, body };
    }

    try {
      const withTemperature = !opts?.reasoningEffort && !options.reasoningEffort && !temperatureRejected;
      let { response, body } = await postChat(withTemperature);

      /** Only `require_parameters` turns an unsupported parameter into a 404 —
       *  without it OpenRouter silently drops what the endpoint can't take — so
       *  a rejection is only attributable to `temperature` on JSON calls. If
       *  dropping it doesn't help, the parameter wasn't the problem: keep the
       *  first response's error, which describes the real failure, and don't
       *  make the fallback sticky. */
      if (
        !response.ok &&
        withTemperature &&
        requiresParameters &&
        isParameterRejection(response.status, body.error?.message)
      ) {
        const first = { response, body };
        const retry = await postChat(false).catch(() => null);
        if (retry?.response.ok) {
          temperatureRejected = true;
          ({ response, body } = retry);
        } else {
          ({ response, body } = first);
        }
      }

      if (!response.ok) {
        reportMeta(opts, {
          outcome: "http_error",
          rawText: JSON.stringify(body),
          durationMs: Date.now() - startedAt,
          model: modelForCall,
        });
        throw new Error(body.error?.message ?? `OpenRouter generation failed with HTTP ${response.status}`);
      }

      const choice = body.choices?.[0];
      const text = extractTextContent(choice?.message?.content)?.trim();

      /** Fires before the no-text/truncation checks so the observer still sees
       *  the raw response those errors would otherwise hide. */
      reportMeta(opts, {
        outcome: "ok",
        rawText: text ?? JSON.stringify(body),
        durationMs: Date.now() - startedAt,
        model: modelForCall,
        ...(body.usage?.prompt_tokens !== undefined && body.usage?.completion_tokens !== undefined
          ? { usage: { promptTokens: body.usage.prompt_tokens, completionTokens: body.usage.completion_tokens } }
          : {}),
      });

      if (opts?.dumpDir) {
        await dumpCall(opts.dumpDir, {
          label: opts?.label ?? "unlabeled",
          prompt,
          systemPrompt: opts?.systemPrompt,
          maxTokens,
          text,
          finishReason: choice?.finish_reason,
          promptTokens: body.usage?.prompt_tokens,
          completionTokens: body.usage?.completion_tokens,
          costUsd: body.usage?.cost,
        });
      }

      if (!text) throw new Error("OpenRouter generation response did not include text");
      if (choice?.finish_reason === "length") {
        throw new Error(`OpenRouter response truncated (length), got ${text.length} chars`);
      }

      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function generateJSON<T>(prompt: string, opts?: Omit<GenerateOptions, "responseMimeType">): Promise<T> {
    const text = await generate(prompt, { ...opts, responseMimeType: "application/json" });
    return parseJsonResponse<T>(text, opts?.label);
  }

  /**
   * Multi-round tool loop over the same chat endpoint. JSON is enforced by the
   * prompt contract plus fence-strip parsing, not response_format — OpenRouter
   * routes cannot be relied on to honor response_format and tools together.
   * `provider.require_parameters` stays on so a route that cannot honor
   * `tools` is rejected outright instead of silently ignoring them: agentic
   * mode fails closed, it never degrades to an untooled call.
   */
  async function generateAgenticJSON<T>(prompt: string, opts: AgenticOptions): Promise<AgenticOutcome<T>> {
    const startedAt = Date.now();
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const modelForCall = opts.model?.trim() || model;
    const effort = opts.reasoningEffort ?? options.reasoningEffort ?? FALLBACK_REASONING_EFFORT;
    const toolsByName = new Map(opts.tools.map((tool) => [tool.name, tool]));
    const toolDeclarations = opts.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    const messages: Array<Record<string, unknown>> = [
      ...(opts.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : []),
      { role: "user", content: prompt },
    ];
    const toolSteps: AgenticToolStep[] = [];
    const resultCache = new Map<string, string>();
    let promptTokens = 0;
    let completionTokens = 0;
    let usageSeen = false;
    let rounds = 0;
    let toolRoundsUsed = 0;

    function aggregatedUsage() {
      return usageSeen ? { usage: { promptTokens, completionTokens } } : {};
    }

    async function postChat(toolChoice: "auto" | "none") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
      try {
        const response = await fetch(OPENROUTER_CHAT_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelForCall,
            usage: { include: true },
            messages,
            max_tokens: maxTokens,
            reasoning: { effort },
            tools: toolDeclarations,
            tool_choice: toolChoice,
            provider: { require_parameters: true },
          }),
        });
        const body = (await response.json().catch(() => ({}))) as OpenRouterChatResponse;
        return { response, body };
      } finally {
        clearTimeout(timeout);
      }
    }

    async function runToolCall(call: OpenRouterToolCall, indexInRound: number): Promise<string> {
      const name = call.function?.name ?? "";
      const argsJson = call.function?.arguments ?? "";
      let args: unknown = null;
      let result: string;
      let cached = false;
      const stepStartedAt = Date.now();

      let parsedArgs: { ok: true; value: unknown } | { ok: false } = { ok: false };
      try {
        parsedArgs = { ok: true, value: argsJson.trim() ? JSON.parse(argsJson) : {} };
      } catch {}
      const tool = toolsByName.get(name);

      if (indexInRound >= MAX_TOOL_CALLS_PER_ROUND) {
        result = toolError(`per-round tool call limit (${MAX_TOOL_CALLS_PER_ROUND}) reached`);
      } else if (Buffer.byteLength(argsJson, "utf8") > MAX_TOOL_ARG_BYTES) {
        result = toolError(`tool arguments exceed ${MAX_TOOL_ARG_BYTES} bytes`);
      } else if (!parsedArgs.ok) {
        result = toolError("tool arguments were not valid JSON");
      } else if (!tool) {
        result = toolError(`unknown tool: ${name}`);
      } else {
        args = parsedArgs.value;
        const cacheKey = `${name}\u0000${argsJson}`;
        const hit = resultCache.get(cacheKey);
        if (hit !== undefined) {
          result = hit;
          cached = true;
        } else {
          try {
            result = truncateToolResult(await tool.run(args));
          } catch (err) {
            result = toolError(err instanceof Error ? err.message : String(err));
          }
          resultCache.set(cacheKey, result);
        }
      }

      const step: AgenticToolStep = { name, args, result, durationMs: Date.now() - stepStartedAt, cached };
      toolSteps.push(step);
      if (opts.onToolStep) {
        try {
          await opts.onToolStep(step);
        } catch {}
      }
      return result;
    }

    while (true) {
      const forced = toolRoundsUsed >= opts.maxToolRounds;
      const { response, body } = await postChat(forced ? "none" : "auto");
      rounds += 1;
      if (body.usage?.prompt_tokens !== undefined && body.usage?.completion_tokens !== undefined) {
        promptTokens += body.usage.prompt_tokens;
        completionTokens += body.usage.completion_tokens;
        usageSeen = true;
      }

      if (!response.ok) {
        reportMeta(opts, {
          outcome: "http_error",
          rawText: JSON.stringify(body),
          durationMs: Date.now() - startedAt,
          model: modelForCall,
          ...aggregatedUsage(),
        });
        throw new Error(body.error?.message ?? `OpenRouter agentic generation failed with HTTP ${response.status}`);
      }

      const message = body.choices?.[0]?.message;
      const toolCalls = (message?.tool_calls ?? []).filter((call) => call && typeof call === "object");
      const text = extractTextContent(message?.content ?? null)?.trim() ?? null;

      if (toolCalls.length === 0) {
        const meta: GenerateMeta = {
          outcome: "ok",
          rawText: text ?? JSON.stringify(body),
          durationMs: Date.now() - startedAt,
          model: modelForCall,
          ...aggregatedUsage(),
        };
        reportMeta(opts, meta);
        if (!text) throw new Error("OpenRouter agentic response had neither text nor tool calls");
        const value = parseJsonResponse<T>(text, opts.label);
        return { value, toolSteps, rounds, meta };
      }

      if (forced) {
        reportMeta(opts, {
          outcome: "ok",
          rawText: JSON.stringify(body),
          durationMs: Date.now() - startedAt,
          model: modelForCall,
          ...aggregatedUsage(),
        });
        throw new Error(
          `OpenRouter agentic loop still requested tools after the forced final round (${rounds} rounds)`,
        );
      }

      toolRoundsUsed += 1;
      messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: message?.tool_calls });
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const result = await runToolCall(call, i);
        messages.push({ role: "tool", tool_call_id: call.id ?? `call_${rounds}_${i}`, content: result });
      }
    }
  }

  return { generate, generateJSON, generateAgenticJSON };
}
