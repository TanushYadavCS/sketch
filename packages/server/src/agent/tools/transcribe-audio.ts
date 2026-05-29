import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { Logger } from "../../logger";
import type { TranscriptionSettings } from "../../transcription/service";
import { transcribeAudioFile, validateWorkspaceAudioPath } from "../../transcription/service";

const fallbackLogger = {
  info: () => {},
  warn: () => {},
} as unknown as Logger;

export interface TranscribeAudioToolDeps {
  absWorkspace: string;
  loadSettings?: () => Promise<TranscriptionSettings | null>;
  logger?: Logger;
}

export function createTranscribeAudioTool(deps: TranscribeAudioToolDeps) {
  return tool(
    "TranscribeAudio",
    "Transcribe an audio attachment from the workspace into text. Use this for buffered audio files when the spoken content is relevant to the user's request.",
    { file_path: z.string().describe("Absolute path to the audio file within your workspace") },
    async ({ file_path }) => {
      const pathError = validateWorkspaceAudioPath(file_path, deps.absWorkspace);
      if (pathError) {
        return { content: [{ type: "text" as const, text: pathError }] };
      }

      const absPath = resolve(file_path);
      if (!existsSync(absPath)) {
        return { content: [{ type: "text" as const, text: `Error: file not found at ${absPath}` }] };
      }

      try {
        const result = await transcribeAudioFile(absPath, {
          loadSettings: deps.loadSettings,
          logger: deps.logger ?? fallbackLogger,
        });
        if (result.kind === "file") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Transcript is too long to inline. Read the transcript file: ${result.transcriptPath}`,
              },
            ],
          };
        }
        return { content: [{ type: "text" as const, text: result.text ?? "" }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Audio transcription failed.";
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    },
  );
}
