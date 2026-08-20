import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type GeminiGenerator, type GenerateOptions, reportMeta } from "./gemini-generate";

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

interface OpenRouterChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: unknown;
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

export function createOpenRouterGenerator(apiKey: string, options: OpenRouterGeneratorOptions = {}): GeminiGenerator {
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
    try {
      return JSON.parse(stripJsonFence(text)) as T;
    } catch (err) {
      const labelPrefix = opts?.label ? `[${opts.label}] ` : "";
      throw new Error(
        `OpenRouter ${labelPrefix}failed to parse JSON response (${text.length} chars, starts: ${text.slice(0, 100)}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { generate, generateJSON };
}
