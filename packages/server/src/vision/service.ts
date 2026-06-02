import { isAbsolute, relative, resolve } from "node:path";
import type { Config } from "../config";
import type { SettingsTable } from "../db/schema";
import type { Logger } from "../logger";
import { analyzeImageWithOpenRouter } from "./openrouter";

export interface VisionConfig {
  apiKey: string;
  model: string;
  source: "db" | "env";
  providerMode: "openrouter" | "openrouter_bedrock" | "env";
}

export type VisionSettings = Pick<SettingsTable, "llm_provider" | "anthropic_api_key">;

export interface VisionServiceDeps {
  config?: VisionConfig | null;
  logger: Logger;
}

function resolveOpenRouterKey(
  settings: VisionSettings | null | undefined,
  envKey: string | null | undefined,
): Pick<VisionConfig, "apiKey" | "source" | "providerMode"> | null {
  const provider = settings?.llm_provider;
  const dbKey = settings?.anthropic_api_key?.trim();
  if ((provider === "openrouter" || provider === "openrouter_bedrock") && dbKey) {
    return { apiKey: dbKey, source: "db", providerMode: provider };
  }

  const trimmedEnvKey = envKey?.trim();
  if (trimmedEnvKey) {
    return { apiKey: trimmedEnvKey, source: "env", providerMode: "env" };
  }

  return null;
}

export function resolveVisionConfig(
  env: NodeJS.ProcessEnv = process.env,
  settings?: VisionSettings | null,
): VisionConfig | null {
  const enabled = env.VISION_ENABLED === "true" || env.VISION_ENABLED === "1";
  if (!enabled) return null;

  const model = env.VISION_MODEL?.trim();
  const keyConfig = resolveOpenRouterKey(settings, env.OPENROUTER_API_KEY);
  if (!model || !keyConfig) return null;

  return { ...keyConfig, model };
}

export function resolveVisionConfigFromAppConfig(
  config: Pick<Config, "VISION_ENABLED" | "VISION_MODEL" | "OPENROUTER_API_KEY">,
  settings?: VisionSettings | null,
): VisionConfig | null {
  const model = config.VISION_MODEL?.trim();
  const keyConfig = resolveOpenRouterKey(settings, config.OPENROUTER_API_KEY);
  if (!config.VISION_ENABLED || !model || !keyConfig) return null;
  return { ...keyConfig, model };
}

function loadConfig(deps: VisionServiceDeps): VisionConfig | null {
  return deps.config ?? null;
}

export async function analyzeImageFile(imagePath: string, question: string, deps: VisionServiceDeps): Promise<string> {
  const config = loadConfig(deps);
  if (!config) {
    throw new Error("Visual analysis is not configured.");
  }

  const result = await analyzeImageWithOpenRouter(imagePath, question, {
    apiKey: config.apiKey,
    model: config.model,
  });
  deps.logger.info(
    {
      model: config.model,
      keySource: config.source,
      providerMode: config.providerMode,
      totalTokens: result.usage?.total_tokens,
      cost: result.usage?.cost,
    },
    "Visual analysis completed",
  );

  return result.text;
}

export function validateWorkspaceVisualPath(filePath: string, workspaceDir: string): string | null {
  const absPath = resolve(filePath);
  const absWorkspace = resolve(workspaceDir);
  const relativePath = relative(absWorkspace, absPath);
  if (relativePath.startsWith("..") || relativePath === "" || isAbsolute(relativePath)) {
    return `Error: visual file must be within your workspace ${absWorkspace}`;
  }
  return null;
}
