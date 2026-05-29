import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { Logger } from "../../logger";
import type { VisionConfig } from "../../vision/service";
import { analyzeImageFile, validateWorkspaceImagePath } from "../../vision/service";

const fallbackLogger = {
  info: () => {},
  warn: () => {},
} as unknown as Logger;

export interface VisualAnalysisToolDeps {
  absWorkspace: string;
  config?: VisionConfig | null;
  logger?: Logger;
}

export function createVisualAnalysisTool(deps: VisualAnalysisToolDeps) {
  return tool(
    "VisualAnalysis",
    "Analyze visual attachments from the workspace using the configured vision model. Use this for visual tasks such as OCR, screenshot inspection, diagram interpretation, and animation review when native vision is unavailable or insufficient.",
    {
      file_path: z.string().describe("Absolute path to the visual file within your workspace"),
      question: z.string().describe("The specific visual question to answer about the file"),
    },
    async ({ file_path, question }) => {
      const pathError = validateWorkspaceImagePath(file_path, deps.absWorkspace);
      if (pathError) {
        return { content: [{ type: "text" as const, text: pathError }] };
      }

      const absPath = resolve(file_path);
      if (!existsSync(absPath)) {
        return { content: [{ type: "text" as const, text: `Error: file not found at ${absPath}` }] };
      }

      try {
        const text = await analyzeImageFile(absPath, question, {
          config: deps.config,
          logger: deps.logger ?? fallbackLogger,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Visual analysis failed.";
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    },
  );
}
