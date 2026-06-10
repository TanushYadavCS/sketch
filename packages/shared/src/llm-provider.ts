/**
 * Provider modes Sketch's runner can configure from DB settings.
 *
 * - "anthropic": direct Anthropic API
 * - "bedrock": direct AWS Bedrock
 * - "openrouter": OpenRouter via its Anthropic-compatible endpoint. Any routing
 *   preset is carried inside `model_id` (the `<model>@preset/<alias>` composite),
 *   not the provider name. (Formerly named "openrouter_bedrock".)
 */
export const LLM_PROVIDERS = ["anthropic", "bedrock", "openrouter"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value);
}
