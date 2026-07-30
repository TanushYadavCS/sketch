import { resolveAgentRuntimeProviderConfigFromSettings } from "../agent/runtime/provider";
import type { createSettingsRepository } from "../db/repositories/settings";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type SettingsRow = Awaited<ReturnType<SettingsRepo["get"]>>;

export type OnboardingPrerequisite = "admin" | "identity" | "llm";

export interface OnboardingReadiness {
  hasAdmin: boolean;
  hasIdentity: boolean;
  hasLlm: boolean;
  readyToComplete: boolean;
  missing: OnboardingPrerequisite[];
}

export function getOnboardingReadiness(
  row: SettingsRow,
  hasAdminUser?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): OnboardingReadiness {
  const hasAdmin = hasAdminUser ?? Boolean(row?.admin_email?.trim());
  const hasIdentity = Boolean(row?.org_name?.trim() && row?.bot_name?.trim());
  const hasLlm = Boolean(resolveAgentRuntimeProviderConfigFromSettings(row ?? null, env));
  const missing: OnboardingPrerequisite[] = [];

  if (!hasAdmin) missing.push("admin");
  if (!hasIdentity) missing.push("identity");
  if (!hasLlm) missing.push("llm");

  return {
    hasAdmin,
    hasIdentity,
    hasLlm,
    readyToComplete: missing.length === 0,
    missing,
  };
}
