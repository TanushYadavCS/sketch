import { conversationSummaryDefinition } from "./definitions/conversation-summary";
import { dailyBriefDefinition } from "./definitions/daily-brief";
import type { AgentDefinition } from "./types";

/**
 * Curated catalog of prebuilt agents. The list is code-owned: shipping a new agent
 * means adding a definition here, never a user-authored row. v1 ships the Daily Brief.
 */
export const AGENT_REGISTRY: readonly AgentDefinition[] = [dailyBriefDefinition, conversationSummaryDefinition];

const BY_KEY = new Map(AGENT_REGISTRY.map((def) => [def.key, def]));

export function listAgentDefinitions(): readonly AgentDefinition[] {
  return AGENT_REGISTRY;
}

export function getAgentDefinition(key: string): AgentDefinition | undefined {
  return BY_KEY.get(key);
}

export function requireAgentDefinition(key: string): AgentDefinition {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown agent: ${key}`);
  return def;
}
