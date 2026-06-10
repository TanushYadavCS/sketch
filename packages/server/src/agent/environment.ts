import { isReservedAgentEnvName } from "@sketch/shared";

export { isReservedAgentEnvName };

export function removeReservedAgentEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isReservedAgentEnvName(name)));
}

/**
 * Disables Claude Code's per-request attribution block. The SDK otherwise
 * prepends a block carrying a per-request prompt fingerprint to the system
 * prompt, which breaks literal-prefix prompt caching on LLM gateways such as
 * OpenRouter (cache reads collapse to zero, inflating input cost ~100x on the
 * cacheable system+tools prefix). Anthropic strips this block server-side, so
 * first-party prompt caching is unaffected and nothing in Sketch reads the
 * header. Applied process-wide at boot because every SDK query() inherits
 * process.env, so a single default covers the agent runner, the workflow
 * runtime, and any future call site.
 */
export function disableSdkAttributionHeader(): void {
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
}
