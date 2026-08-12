/**
 * Gemini Flash text generation client.
 *
 * Uses the @google/genai SDK for reliable structured output and proper
 * handling of thinking model responses (Gemini 2.5 Flash).
 *
 * For thinking models, maxOutputTokens only covers the response (not thinking).
 * We set thinkingBudget separately to control thinking token usage.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenerateContentResponse } from "@google/genai";
import { type GeminiClientOptions, runGeminiRequest } from "./gemini-control";

const MODEL = "gemini-2.5-flash";

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
    candidatesTokens: number | undefined;
  },
): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = payload.label.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${ts}__${safeLabel}.json`;
  try {
    await mkdir(dumpDir, { recursive: true });
    await writeFile(join(dumpDir, filename), JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // best-effort; never throw from the dump path
  }
}

/** Max output tokens for the response. Set high because thinking models may
 *  count thinking tokens against this budget depending on API version. */
const DEFAULT_MAX_TOKENS = 8192;

export interface GenerateOptions {
  /** System instruction for the model. */
  systemPrompt?: string;
  /** Per-call model override for providers that support model routing. */
  model?: string | null;
  /** Per-call reasoning effort for reasoning-capable providers. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Max output tokens (default 2048). */
  maxTokens?: number;
  /** Response MIME type — set to "application/json" for structured output. */
  responseMimeType?: string;
  /** Caller label included in error messages and diagnostic logs (e.g. "extractEntities"). */
  label?: string;
  /** When set, write a JSON file capturing prompt + raw response under this dir.
   *  Used by the per-file "Enrich File" debug path. Never set in bulk runs. */
  dumpDir?: string;
}

export function createGeminiGenerator(apiKey: string, options?: GeminiClientOptions) {
  let ai: import("@google/genai").GoogleGenAI | undefined;

  /**
   * Lazily import and construct the genai client. Keeping `@google/genai` (a
   * large SDK with deep zod schema trees) out of the static import graph stops it
   * from being dragged — via the http.ts route graph — into the ~24 test files
   * that never make a Gemini call, which is a primary driver of the per-worker
   * memory floor.
   */
  async function getClient(): Promise<import("@google/genai").GoogleGenAI> {
    if (!ai) {
      const { GoogleGenAI } = await import("@google/genai");
      ai = new GoogleGenAI({ apiKey });
    }
    return ai;
  }

  /**
   * Generate text from a prompt.
   */
  async function generate(prompt: string, opts?: GenerateOptions): Promise<string> {
    const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const config: Record<string, unknown> = {
      maxOutputTokens: maxTokens,
      thinkingConfig: { thinkingBudget: 0 },
    };

    if (opts?.responseMimeType) {
      config.responseMimeType = opts.responseMimeType;
    }

    const labelPrefix = opts?.label ? `[${opts.label}] ` : "";

    const client = await getClient();
    const response: GenerateContentResponse = await runGeminiRequest(
      apiKey,
      () =>
        client.models.generateContent({
          model: MODEL,
          contents: prompt,
          config: {
            ...config,
            systemInstruction: opts?.systemPrompt,
          },
        }),
      options,
    );

    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const text = response.text;
    const usage = response.usageMetadata;

    if (opts?.dumpDir) {
      await dumpCall(opts.dumpDir, {
        label: opts?.label ?? "unlabeled",
        prompt,
        systemPrompt: opts?.systemPrompt,
        maxTokens,
        text,
        finishReason,
        promptTokens: usage?.promptTokenCount,
        candidatesTokens: usage?.candidatesTokenCount,
      });
    }

    if (!text) {
      throw new Error(
        `Gemini ${labelPrefix}no text in response (finishReason: ${finishReason}, promptChars: ${prompt.length}, maxTokens: ${maxTokens}, promptTokens: ${usage?.promptTokenCount ?? "?"}, candidatesTokens: ${usage?.candidatesTokenCount ?? "?"})`,
      );
    }

    if (finishReason === "MAX_TOKENS") {
      throw new Error(
        `Gemini ${labelPrefix}response truncated (MAX_TOKENS), got ${text.length} chars (promptChars: ${prompt.length}, maxTokens: ${maxTokens}, promptTokens: ${usage?.promptTokenCount ?? "?"}, candidatesTokens: ${usage?.candidatesTokenCount ?? "?"}). Increase maxOutputTokens.`,
      );
    }

    return text;
  }

  /**
   * Generate and parse a JSON response.
   * Uses Gemini's native JSON response mode for reliable structured output.
   */
  async function generateJSON<T>(prompt: string, opts?: Omit<GenerateOptions, "responseMimeType">): Promise<T> {
    const text = await generate(prompt, { ...opts, responseMimeType: "application/json" });
    const labelPrefix = opts?.label ? `[${opts.label}] ` : "";
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(
        `Gemini ${labelPrefix}failed to parse JSON response (${text.length} chars, starts: ${text.slice(0, 100)}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { generate, generateJSON };
}

export type GeminiGenerator = ReturnType<typeof createGeminiGenerator>;
