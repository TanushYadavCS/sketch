/**
 * Gemini Flash text generation client.
 *
 * Uses the @google/genai SDK for reliable structured output and proper
 * handling of thinking model responses (Gemini 2.5 Flash).
 *
 * For thinking models, maxOutputTokens only covers the response (not thinking).
 * We set thinkingBudget separately to control thinking token usage.
 */
import { type GenerateContentResponse, GoogleGenAI } from "@google/genai";

const MODEL = "gemini-2.5-flash";

/** Max output tokens for the response. Set high because thinking models may
 *  count thinking tokens against this budget depending on API version. */
const DEFAULT_MAX_TOKENS = 8192;

export interface GenerateOptions {
  /** System instruction for the model. */
  systemPrompt?: string;
  /** Max output tokens (default 2048). */
  maxTokens?: number;
  /** Response MIME type — set to "application/json" for structured output. */
  responseMimeType?: string;
}

export function createGeminiGenerator(apiKey: string) {
  const ai = new GoogleGenAI({ apiKey });

  /**
   * Generate text from a prompt.
   */
  async function generate(prompt: string, opts?: GenerateOptions): Promise<string> {
    const config: Record<string, unknown> = {
      maxOutputTokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinkingConfig: { thinkingBudget: 0 },
    };

    if (opts?.responseMimeType) {
      config.responseMimeType = opts.responseMimeType;
    }

    const response: GenerateContentResponse = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        ...config,
        systemInstruction: opts?.systemPrompt,
      },
    });

    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const text = response.text;

    if (!text) {
      throw new Error(`Gemini: no text in response (finishReason: ${finishReason})`);
    }

    if (finishReason === "MAX_TOKENS") {
      throw new Error(`Gemini: response truncated (MAX_TOKENS), got ${text.length} chars. Increase maxOutputTokens.`);
    }

    return text;
  }

  /**
   * Generate and parse a JSON response.
   * Uses Gemini's native JSON response mode for reliable structured output.
   */
  async function generateJSON<T>(prompt: string, opts?: Omit<GenerateOptions, "responseMimeType">): Promise<T> {
    const text = await generate(prompt, { ...opts, responseMimeType: "application/json" });
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(
        `Gemini: failed to parse JSON response (${text.length} chars, starts: ${text.slice(0, 100)}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { generate, generateJSON };
}

export type GeminiGenerator = ReturnType<typeof createGeminiGenerator>;
