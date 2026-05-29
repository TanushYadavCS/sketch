import { readFile } from "node:fs/promises";
import { extensionFromPath, normalizeMimeType } from "./audio-types";

export const OPENROUTER_TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
const OPENROUTER_TRANSCRIPTION_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const DEFAULT_AUDIO_FORMAT = "mp3";
const SUPPORTED_AUDIO_FORMATS = new Set(["aac", "flac", "m4a", "mp3", "mp4", "mpeg", "mpga", "ogg", "wav", "webm"]);
const MIME_AUDIO_FORMATS: Record<string, string> = {
  "audio/aac": "aac",
  "audio/x-aac": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mpga": "mpga",
  "audio/ogg": "ogg",
  "application/ogg": "ogg",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

export interface OpenRouterTranscriptionConfig {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export interface OpenRouterTranscriptionResult {
  text: string;
  usage?: {
    seconds?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
  };
}

export interface OpenRouterTranscriptionOptions {
  mimeType?: string | null;
}

interface OpenRouterTranscriptionResponse {
  text?: unknown;
  usage?: OpenRouterTranscriptionResult["usage"];
  error?: {
    message?: string;
  };
}

function audioFormatFromMimeType(mimeType: string | null | undefined): string | null {
  const normalized = normalizeMimeType(mimeType);
  return normalized ? (MIME_AUDIO_FORMATS[normalized] ?? null) : null;
}

function audioFormatFromExtension(path: string): string | null {
  const ext = extensionFromPath(path);
  if (!ext) return null;
  if (ext === "oga") return "ogg";
  return SUPPORTED_AUDIO_FORMATS.has(ext) ? ext : null;
}

function audioFormatFromHeader(data: Buffer): string | null {
  if (data.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
  if (data.length > 1 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return "mp3";
  if (data.subarray(0, 4).toString("ascii") === "fLaC") return "flac";
  if (data.subarray(0, 4).toString("ascii") === "OggS") return "ogg";
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
  if (data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = data.subarray(8, 12).toString("ascii").trim().toLowerCase();
    return brand.startsWith("m4a") ? "m4a" : "mp4";
  }
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF") {
    return data.subarray(8, 12).toString("ascii") === "WAVE" ? "wav" : null;
  }
  return null;
}

export function audioFormatFromPath(path: string, options: { mimeType?: string | null; data?: Buffer } = {}): string {
  return (
    audioFormatFromMimeType(options.mimeType) ??
    audioFormatFromExtension(path) ??
    (options.data ? audioFormatFromHeader(options.data) : null) ??
    DEFAULT_AUDIO_FORMAT
  );
}

export async function transcribeWithOpenRouter(
  audioPath: string,
  config: OpenRouterTranscriptionConfig,
  options: OpenRouterTranscriptionOptions = {},
): Promise<OpenRouterTranscriptionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 55_000);

  try {
    const data = await readFile(audioPath);
    const format = audioFormatFromPath(audioPath, { mimeType: options.mimeType, data });
    const response = await fetch(OPENROUTER_TRANSCRIPTION_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model ?? OPENROUTER_TRANSCRIPTION_MODEL,
        input_audio: {
          data: data.toString("base64"),
          format,
        },
      }),
    });

    const body = (await response.json().catch(() => ({}))) as OpenRouterTranscriptionResponse;
    if (!response.ok) {
      const message = body.error?.message ?? `OpenRouter transcription failed with HTTP ${response.status}`;
      throw new Error(message);
    }

    if (typeof body.text !== "string") {
      throw new Error("OpenRouter transcription response did not include text");
    }

    return {
      text: body.text,
      usage: body.usage,
    };
  } finally {
    clearTimeout(timeout);
  }
}
