import { z } from "zod";
import type { AgentEnvironmentShareTargetInput } from "./agent-environment";

export const cliIntegrationAppIdSchema = z.enum(["github", "linear"]);
export type CliIntegrationAppId = z.infer<typeof cliIntegrationAppIdSchema>;

export const cliIntegrationExecutionModeSchema = z.enum(["cli", "api"]);
export type CliIntegrationExecutionMode = z.infer<typeof cliIntegrationExecutionModeSchema>;

export const cliIntegrationConnectionStatusSchema = z.enum(["active", "invalid"]);
export type CliIntegrationConnectionStatus = z.infer<typeof cliIntegrationConnectionStatusSchema>;

export const cliIntegrationCredentialFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  secret: z.literal(true),
  inputType: z.literal("password"),
});

export interface CliIntegrationAppDefinition {
  id: CliIntegrationAppId;
  name: string;
  description: string;
  icon: string;
  skillId: string;
  executionMode: CliIntegrationExecutionMode;
  executable: string;
  credentialFields: Array<z.infer<typeof cliIntegrationCredentialFieldSchema>>;
}

export interface CliIntegrationConnection {
  id: string;
  appId: CliIntegrationAppId;
  appName: string;
  executionMode: CliIntegrationExecutionMode;
  ownerUserId: string;
  ownerName?: string | null;
  accountExternalId: string | null;
  accountLogin: string;
  accountAvatarUrl?: string | null;
  accountType?: string | null;
  status: CliIntegrationConnectionStatus;
  verifiedAt: string;
  lastVerificationError: string | null;
  createdAt: string;
  updatedAt: string;
  isOwnedByViewer?: boolean;
  canUse?: boolean;
  canManage?: boolean;
  shares: AgentEnvironmentShareTargetInput[];
}

export interface CliIntegrationCatalogApp {
  id: CliIntegrationAppId;
  name: string;
  description: string;
  icon: string;
  executionMode: CliIntegrationExecutionMode;
  connected: boolean;
  connectionId: string | null;
}

export const cliSkillFrontmatterSchema = z.object({
  providerType: z.string().trim().min(1).optional(),
  requiresEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
});

export type CliSkillFrontmatter = z.infer<typeof cliSkillFrontmatterSchema>;

export function parseCliSkillFrontmatter(value: {
  providerType?: unknown;
  "provider-type"?: unknown;
  requiresEnv?: unknown;
  "requires-env"?: unknown;
}): CliSkillFrontmatter | null {
  const rawRequiresEnv = value.requiresEnv ?? value["requires-env"] ?? [];
  const requiresEnv = Array.isArray(rawRequiresEnv)
    ? rawRequiresEnv
    : typeof rawRequiresEnv === "string"
      ? rawRequiresEnv
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      : rawRequiresEnv;
  const parsed = cliSkillFrontmatterSchema.safeParse({
    providerType: value.providerType ?? value["provider-type"],
    requiresEnv,
  });
  return parsed.success ? parsed.data : null;
}

export const cliIntegrationShareTargetSchema = z.object({
  type: z.enum(["user", "slack_channel", "whatsapp_group", "org"]),
  id: z.string().trim().min(1),
});

export type CliIntegrationShareTarget = z.infer<typeof cliIntegrationShareTargetSchema>;

export const githubCliIntegrationApp: CliIntegrationAppDefinition = {
  id: "github",
  name: "GitHub",
  description: "Use GitHub through the managed GitHub CLI in Sketch.",
  icon: "https://github.githubassets.com/favicons/favicon.svg",
  skillId: "github",
  executionMode: "cli",
  executable: "gh",
  credentialFields: [
    {
      id: "token",
      label: "Personal access token",
      envName: "GH_TOKEN",
      secret: true,
      inputType: "password",
    },
  ],
};

export const linearManagedIntegrationApp: CliIntegrationAppDefinition = {
  id: "linear",
  name: "Linear",
  description: "Use Linear through the managed GraphQL API in Sketch.",
  icon: "https://linear.app/favicon.svg",
  skillId: "linear",
  executionMode: "api",
  executable: "",
  credentialFields: [
    {
      id: "api-key",
      label: "Personal API key",
      envName: "LINEAR_API_KEY",
      secret: true,
      inputType: "password",
    },
  ],
};

export const cliIntegrationAppDefinitions: Readonly<Record<CliIntegrationAppId, CliIntegrationAppDefinition>> = {
  github: githubCliIntegrationApp,
  linear: linearManagedIntegrationApp,
};

export function cliIntegrationAppDefinition(appId: string): CliIntegrationAppDefinition | null {
  const parsed = cliIntegrationAppIdSchema.safeParse(appId.trim().toLowerCase());
  return parsed.success ? cliIntegrationAppDefinitions[parsed.data] : null;
}

export function isCliIntegrationAppId(value: string): value is CliIntegrationAppId {
  return cliIntegrationAppIdSchema.safeParse(value.trim().toLowerCase()).success;
}

export function cliSkillRequiredEnv(skillId: string): string[] {
  const normalized = skillId
    .trim()
    .toLowerCase()
    .replace(/\s+cli$/, "");
  const definition = Object.values(cliIntegrationAppDefinitions).find((app) =>
    [app.id, app.skillId, app.name].some((value) => value.toLowerCase() === normalized),
  );
  return definition?.credentialFields.map((field) => field.envName) ?? [];
}

export function normalizeCliIntegrationAppId(value: string): string {
  return value.trim().toLowerCase();
}

export function isCanvasBlockedCliAppId(value: string): boolean {
  const normalized = normalizeCliIntegrationAppId(value);
  return normalized === "github" || normalized === "github-oauth";
}

export function isCanvasBlockedCliComponentKey(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "github" || normalized.startsWith("github-") || normalized.startsWith("github_");
}
