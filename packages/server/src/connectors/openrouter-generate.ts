import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GeminiGenerator, GenerateOptions } from "./gemini-generate";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DEFAULT_MAX_TOKENS = 8192;

interface OpenRouterGeneratorOptions {
  model?: string | null;
  timeoutMs?: number;
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
  };
  error?: {
    message?: string;
  };
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

  async function generate(prompt: string, opts?: GenerateOptions): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
    const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;

    try {
      const response = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          usage: { include: true },
          messages: [
            ...(opts?.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : []),
            { role: "user", content: prompt },
          ],
          max_tokens: maxTokens,
          temperature: 0,
          ...(opts?.responseMimeType === "application/json"
            ? {
                provider: { require_parameters: true },
                response_format: { type: "json_object" },
              }
            : {}),
        }),
      });

      const body = (await response.json().catch(() => ({}))) as OpenRouterChatResponse;
      if (!response.ok) {
        throw new Error(body.error?.message ?? `OpenRouter generation failed with HTTP ${response.status}`);
      }

      const choice = body.choices?.[0];
      const text = extractTextContent(choice?.message?.content)?.trim();

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
