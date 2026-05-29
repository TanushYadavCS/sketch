import { extname, isAbsolute, relative, resolve } from "node:path";
import type { Config } from "../config";
import type { Logger } from "../logger";
import { analyzeImageWithOpenRouter } from "./openrouter";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

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

  const model = env.VISION_PROVIDER?.trim();
  const apiKey = env.VISION_API_KEY?.trim();
  if (!model || !apiKey) return null;

  return { apiKey, model, source: "env" };
}

export function resolveVisionConfigFromAppConfig(
  config: Pick<Config, "VISION_ENABLED" | "VISION_PROVIDER" | "VISION_API_KEY">,
): VisionConfig | null {
  const model = config.VISION_PROVIDER?.trim();
  const apiKey = config.VISION_API_KEY?.trim();
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

export function isAnalyzableImagePath(filePath: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function validateWorkspaceImagePath(filePath: string, workspaceDir: string): string | null {
  const absPath = resolve(filePath);
  const absWorkspace = resolve(workspaceDir);
  const relativePath = relative(absWorkspace, absPath);
  if (relativePath.startsWith("..") || relativePath === "" || isAbsolute(relativePath)) {
    return `Error: image file must be within your workspace ${absWorkspace}`;
  }
  if (!isAnalyzableImagePath(absPath)) {
    return "Error: file must be a supported image file.";
  }
  return null;
}
