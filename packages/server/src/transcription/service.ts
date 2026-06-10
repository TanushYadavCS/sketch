import { stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AuxLlmCall } from "../agent/aux-cost";
import type { SettingsTable } from "../db/schema";
import type { Attachment } from "../files";
import { isAudioAttachment } from "../files";
import type { Logger } from "../logger";
import { hasTranscribableAudioExtension } from "./audio-types";
import {
  OPENROUTER_TRANSCRIPTION_MODEL,
  type OpenRouterTranscriptionResult,
  transcribeWithOpenRouter,
} from "./openrouter";

const INLINE_TRANSCRIPT_LIMIT = 8_000;

export type TranscriptionSettings = Pick<SettingsTable, "llm_provider" | "anthropic_api_key">;

export interface TranscriptionConfig {
  apiKey: string;
  model: string;
  source: "db" | "env";
  providerMode: "openrouter" | "env";
}

export interface TranscriptionServiceDeps {
  loadSettings?: () => Promise<TranscriptionSettings | null>;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  mimeType?: string | null;
  onUsage?: (call: AuxLlmCall) => void;
}

/**
 * Reports a transcription call's cost via the sink. Cost is OpenRouter's own
 * `usage.cost` (Whisper is priced per second of audio, so the token-based price
 * map cannot reprice it); a missing figure contributes 0 and is flagged.
 */
function reportTranscriptionUsage(
  deps: Pick<TranscriptionServiceDeps, "onUsage">,
  model: string,
  usage: OpenRouterTranscriptionResult["usage"],
): void {
  if (!deps.onUsage) return;
  deps.onUsage({
    op: "transcription",
    model,
    costUsd: usage?.cost ?? 0,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    seconds: usage?.seconds,
    source: usage?.cost != null ? "openrouter" : "unknown",
  });
}

export type TranscribeAudioFileResult =
  | {
      kind: "inline";
      text: string;
    }
  | {
      kind: "file";
      transcriptPath: string;
    };

export function resolveTranscriptionConfig(
  settings: TranscriptionSettings | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionConfig | null {
  const provider = settings?.llm_provider;
  const dbKey = settings?.anthropic_api_key?.trim();
  if (provider === "openrouter" && dbKey) {
    return {
      apiKey: dbKey,
      model: OPENROUTER_TRANSCRIPTION_MODEL,
      source: "db",
      providerMode: provider,
    };
  }

  const envKey = env.OPENROUTER_API_KEY?.trim();
  if (envKey) {
    return {
      apiKey: envKey,
      model: OPENROUTER_TRANSCRIPTION_MODEL,
      source: "env",
      providerMode: "env",
    };
  }

  return null;
}

export async function resolveTranscriptionConfigFromDeps(
  deps: Pick<TranscriptionServiceDeps, "loadSettings" | "env">,
): Promise<TranscriptionConfig | null> {
  const settings = deps.loadSettings ? await deps.loadSettings() : null;
  return resolveTranscriptionConfig(settings, deps.env);
}

export function isTranscribableAudioPath(filePath: string): boolean {
  return hasTranscribableAudioExtension(filePath);
}

function transcriptPathFor(audioPath: string): string {
  return join(dirname(audioPath), `${basename(audioPath)}.transcript.txt`);
}

async function writeLongTranscript(audioPath: string, transcript: string): Promise<Attachment> {
  const path = transcriptPathFor(audioPath);
  await writeFile(path, transcript);
  const fileStat = await stat(path);
  return {
    originalName: basename(path),
    mimeType: "text/plain",
    localPath: path,
    sizeBytes: fileStat.size,
  };
}

async function loadConfig(deps: TranscriptionServiceDeps): Promise<TranscriptionConfig | null> {
  return resolveTranscriptionConfigFromDeps(deps);
}

export async function transcribeAudioFile(
  audioPath: string,
  deps: TranscriptionServiceDeps,
): Promise<TranscribeAudioFileResult> {
  const config = await loadConfig(deps);
  if (!config) {
    throw new Error("Transcription is not configured.");
  }

  const result = await transcribeWithOpenRouter(audioPath, config, { mimeType: deps.mimeType });
  reportTranscriptionUsage(deps, config.model, result.usage);
  deps.logger.info(
    {
      model: config.model,
      keySource: config.source,
      providerMode: config.providerMode,
      seconds: result.usage?.seconds,
      cost: result.usage?.cost,
    },
    "Audio transcription completed",
  );

  if (result.text.length <= INLINE_TRANSCRIPT_LIMIT) {
    return { kind: "inline", text: result.text };
  }

  const transcript = await writeLongTranscript(audioPath, result.text);
  return { kind: "file", transcriptPath: transcript.localPath };
}

export async function transcribeEagerAttachments(
  attachments: Attachment[],
  deps: TranscriptionServiceDeps,
): Promise<Attachment[]> {
  if (attachments.length === 0) return attachments;

  const config = await loadConfig(deps);
  if (!config) return attachments;

  const enriched: Attachment[] = [];
  for (const attachment of attachments) {
    if (!isAudioAttachment(attachment)) {
      enriched.push(attachment);
      continue;
    }

    try {
      deps.logger.info(
        {
          model: config.model,
          keySource: config.source,
          providerMode: config.providerMode,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        },
        "Starting eager audio transcription",
      );
      const result = await transcribeWithOpenRouter(attachment.localPath, config, { mimeType: attachment.mimeType });
      reportTranscriptionUsage(deps, config.model, result.usage);
      if (result.text.length <= INLINE_TRANSCRIPT_LIMIT) {
        enriched.push({
          ...attachment,
          transcription: { status: "completed", text: result.text },
        });
      } else {
        const transcript = await writeLongTranscript(attachment.localPath, result.text);
        enriched.push({
          ...attachment,
          transcription: { status: "completed", transcriptPath: transcript.localPath },
        });
        enriched.push(transcript);
      }
      deps.logger.info(
        {
          model: config.model,
          keySource: config.source,
          providerMode: config.providerMode,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          seconds: result.usage?.seconds,
          cost: result.usage?.cost,
        },
        "Eager audio transcription completed",
      );
    } catch (err) {
      deps.logger.warn(
        {
          err,
          model: config.model,
          keySource: config.source,
          providerMode: config.providerMode,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        },
        "Eager audio transcription failed",
      );
      enriched.push({
        ...attachment,
        transcription: { status: "failed" },
      });
    }
  }

  return enriched;
}

export function validateWorkspaceAudioPath(filePath: string, workspaceDir: string): string | null {
  const absPath = resolve(filePath);
  const absWorkspace = resolve(workspaceDir);
  const relativePath = relative(absWorkspace, absPath);
  if (relativePath.startsWith("..") || relativePath === "" || isAbsolute(relativePath)) {
    return `Error: audio file must be within your workspace ${absWorkspace}`;
  }
  if (!isTranscribableAudioPath(absPath)) {
    return "Error: file must be a supported audio file.";
  }
  return null;
}
