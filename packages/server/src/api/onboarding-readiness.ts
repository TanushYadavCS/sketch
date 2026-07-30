import type { AgentRuntimeProviderKind } from "../agent/runtime/contracts";
import { resolveAgentRuntimeProviderConfigFromSettings } from "../agent/runtime/provider";
import type { createSettingsRepository } from "../db/repositories/settings";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type SettingsRow = Awaited<ReturnType<SettingsRepo["get"]>>;

export type OnboardingPrerequisite = "admin" | "identity" | "llm";

export interface OnboardingReadiness {
  hasAdmin: boolean;
  hasIdentity: boolean;
  hasLlm: boolean;
  llmProvider: AgentRuntimeProviderKind | null;
  readyToComplete: boolean;
  missing: OnboardingPrerequisite[];
}

function hasCompletePersistedLlmSettings(row: SettingsRow): boolean {
  if (row?.llm_provider === "anthropic") {
    return Boolean(row.anthropic_api_key?.trim());
  }
  if (row?.llm_provider === "bedrock") {
    return Boolean(row.aws_access_key_id?.trim() && row.aws_secret_access_key?.trim() && row.aws_region?.trim());
  }
  if (row?.llm_provider === "openrouter") {
    return Boolean(row.anthropic_api_key?.trim() && row.model_id?.trim());
  }
  return false;
}

export function getOnboardingReadiness(
  row: SettingsRow,
  hasAdminUser?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): OnboardingReadiness {
  const hasAdmin = hasAdminUser ?? Boolean(row?.admin_email?.trim());
  const hasIdentity = Boolean(row?.org_name?.trim() && row?.bot_name?.trim());
  const llmConfig = hasCompletePersistedLlmSettings(row)
    ? resolveAgentRuntimeProviderConfigFromSettings(row ?? null, env)
    : resolveAgentRuntimeProviderConfigFromSettings(null, env);
  const hasLlm = Boolean(llmConfig);
  const missing: OnboardingPrerequisite[] = [];

  if (!hasAdmin) missing.push("admin");
  if (!hasIdentity) missing.push("identity");
  if (!hasLlm) missing.push("llm");

  return {
    hasAdmin,
    hasIdentity,
    hasLlm,
    llmProvider: llmConfig?.provider ?? null,
    readyToComplete: missing.length === 0,
    missing,
  };
}
