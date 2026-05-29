import { extname } from "node:path";

const AUDIO_ATTACHMENT_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "mp4", "oga", "ogg", "wav", "webm"]);
const TRANSCRIBABLE_AUDIO_EXTENSIONS = new Set([...AUDIO_ATTACHMENT_EXTENSIONS, "bin"]);
const GENERIC_MIME_TYPES = new Set(["application/octet-stream", "binary/octet-stream"]);

export function normalizeMimeType(mimeType: string | null | undefined): string | null {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  return normalized || null;
}

export function isGenericMimeType(mimeType: string | null | undefined): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized ? GENERIC_MIME_TYPES.has(normalized) : false;
}

export function isAudioMimeType(mimeType: string | null | undefined): boolean {
  return normalizeMimeType(mimeType)?.startsWith("audio/") ?? false;
}

export function extensionFromPath(path: string): string | null {
  const ext = extname(path).replace(".", "").toLowerCase();
  return ext || null;
}

export function hasAudioAttachmentExtension(path: string): boolean {
  const ext = extensionFromPath(path);
  return ext ? AUDIO_ATTACHMENT_EXTENSIONS.has(ext) : false;
}

export function hasTranscribableAudioExtension(path: string): boolean {
  const ext = extensionFromPath(path);
  return ext ? TRANSCRIBABLE_AUDIO_EXTENSIONS.has(ext) : false;
}

export function shouldTreatAsAudioAttachment(params: { mimeType: string; localPath: string }): boolean {
  if (isAudioMimeType(params.mimeType)) return true;
  const normalizedMimeType = normalizeMimeType(params.mimeType);
  if (normalizedMimeType && !isGenericMimeType(normalizedMimeType)) return false;
  return hasAudioAttachmentExtension(params.localPath);
}
