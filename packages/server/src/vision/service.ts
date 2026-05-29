import { isAbsolute, relative, resolve } from "node:path";
import type { Config } from "../config";
import type { Logger } from "../logger";
import { analyzeImageWithOpenRouter } from "./openrouter";

export interface VisionConfig {
  apiKey: string;
  model: string;
  source: "env";
}

export interface VisionServiceDeps {
  config?: VisionConfig | null;
  logger: Logger;
}

export function resolveVisionConfig(env: NodeJS.ProcessEnv = process.env): VisionConfig | null {
  const enabled = env.VISION_ENABLED === "true" || env.VISION_ENABLED === "1";
  if (!enabled) return null;

  const model = env.VISION_MODEL?.trim();
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!model || !apiKey) return null;

  return { apiKey, model, source: "env" };
}

export function resolveVisionConfigFromAppConfig(
  config: Pick<Config, "VISION_ENABLED" | "VISION_MODEL" | "OPENROUTER_API_KEY">,
): VisionConfig | null {
  const model = config.VISION_MODEL?.trim();
  const apiKey = config.OPENROUTER_API_KEY?.trim();
  if (!config.VISION_ENABLED || !model || !apiKey) return null;
  return { apiKey, model, source: "env" };
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
