/**
 * Provider modes Sketch's runner can configure from DB settings.
 *
 * - "anthropic": direct Anthropic API
 * - "bedrock": direct AWS Bedrock
 * - "openrouter_bedrock": OpenRouter to Bedrock via the strict-routing preset (managed tier)
 */
export const LLM_PROVIDERS = ["anthropic", "bedrock", "openrouter_bedrock"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value);
}
