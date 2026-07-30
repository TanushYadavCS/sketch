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

export function getOnboardingReadiness(row: SettingsRow, hasAdminUser?: boolean): OnboardingReadiness {
  const hasAdmin = hasAdminUser ?? Boolean(row?.admin_email?.trim());
  const hasIdentity = Boolean(row?.org_name?.trim() && row?.bot_name?.trim());
  const hasAnthropic = row?.llm_provider === "anthropic" && Boolean(row?.anthropic_api_key?.trim());
  const hasBedrock =
    row?.llm_provider === "bedrock" &&
    Boolean(row?.aws_access_key_id?.trim() && row?.aws_secret_access_key?.trim() && row?.aws_region?.trim());
  const hasOpenRouter =
    row?.llm_provider === "openrouter" && Boolean(row?.anthropic_api_key?.trim() && row?.model_id?.trim());
  const hasLlm = hasAnthropic || hasBedrock || hasOpenRouter;
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
