import type { AgentRuntimeMessageAppend } from "./contracts";

/**
 * The AI SDK runtime persists every user turn and response message into agent_messages, then reloads and
 * re-parses the live window each turn. Base64 image payloads and very large tool outputs make those rows
 * enormous, so the reload cost and memory footprint grow without bound. The model already saw the full,
 * un-capped output during the turn it was produced (the tool loop runs in memory before persistence), so
 * capping only affects historical context on later turns: oversized text is truncated with a marker, and
 * oversized binary attachments are replaced by a short reference noting media type and size. The correlated
 * tool-call message (with its file path input) stays in history, so the model can re-read a referenced file.
 *
 * Caps are generous so ordinary messages persist byte-for-byte unchanged; a message is only rebuilt when
 * something actually exceeds a cap, which keeps the common path reference-identical to the input.
 */
const MAX_PERSISTED_TEXT_BYTES = 131_072;
const MAX_PERSISTED_BINARY_BASE64_BYTES = 262_144;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateText(value: string, limitBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limitBytes) return value;
  const head = bytes.subarray(0, limitBytes).toString("utf8");
  return `${head}\n[sketch: persisted history truncated, original ${bytes.byteLength} bytes]`;
}

function binaryReference(params: { mediaType?: unknown; bytes: number; filename?: unknown }): string {
  const mediaType = typeof params.mediaType === "string" && params.mediaType.length > 0 ? params.mediaType : "binary";
  const filename = typeof params.filename === "string" && params.filename.length > 0 ? ` (${params.filename})` : "";
  return `[sketch: ${mediaType} attachment omitted from persisted history${filename}, ${params.bytes} bytes]`;
}

interface Capped<T> {
  value: T;
  changed: boolean;
}

function unchanged<T>(value: T): Capped<T> {
  return { value, changed: false };
}

function capToolResultContentPart(part: unknown): Capped<unknown> {
  if (!isRecord(part)) return unchanged(part);

  if (part.type === "text" && typeof part.text === "string" && byteLength(part.text) > MAX_PERSISTED_TEXT_BYTES) {
    return { value: { ...part, text: truncateText(part.text, MAX_PERSISTED_TEXT_BYTES) }, changed: true };
  }

  if (part.type === "file" && isRecord(part.data) && part.data.type === "data" && typeof part.data.data === "string") {
    if (byteLength(part.data.data) > MAX_PERSISTED_BINARY_BASE64_BYTES) {
      return {
        value: {
          type: "text",
          text: binaryReference({
            mediaType: part.mediaType,
            bytes: byteLength(part.data.data),
            filename: part.filename,
          }),
        },
        changed: true,
      };
    }
  }

  if (
    (part.type === "file-data" || part.type === "image-data") &&
    typeof part.data === "string" &&
    byteLength(part.data) > MAX_PERSISTED_BINARY_BASE64_BYTES
  ) {
    return {
      value: { type: "text", text: binaryReference({ mediaType: part.mediaType, bytes: byteLength(part.data) }) },
      changed: true,
    };
  }

  return unchanged(part);
}

function capToolResultOutput(output: unknown): Capped<unknown> {
  if (!isRecord(output)) return unchanged(output);

  if (
    (output.type === "text" || output.type === "error-text") &&
    typeof output.value === "string" &&
    byteLength(output.value) > MAX_PERSISTED_TEXT_BYTES
  ) {
    return { value: { ...output, value: truncateText(output.value, MAX_PERSISTED_TEXT_BYTES) }, changed: true };
  }

  if (output.type === "json" || output.type === "error-json") {
    const serialized = JSON.stringify(output.value) ?? "";
    if (byteLength(serialized) > MAX_PERSISTED_TEXT_BYTES) {
      return { value: { type: "text", value: truncateText(serialized, MAX_PERSISTED_TEXT_BYTES) }, changed: true };
    }
  }

  if (output.type === "content" && Array.isArray(output.value)) {
    let changed = false;
    const value = output.value.map((part) => {
      const capped = capToolResultContentPart(part);
      changed ||= capped.changed;
      return capped.value;
    });
    return changed ? { value: { ...output, value }, changed: true } : unchanged(output);
  }

  return unchanged(output);
}

function capMessagePart(part: unknown): Capped<unknown> {
  if (!isRecord(part)) return unchanged(part);

  if (part.type === "text" && typeof part.text === "string" && byteLength(part.text) > MAX_PERSISTED_TEXT_BYTES) {
    return { value: { ...part, text: truncateText(part.text, MAX_PERSISTED_TEXT_BYTES) }, changed: true };
  }

  if (
    part.type === "image" &&
    typeof part.image === "string" &&
    byteLength(part.image) > MAX_PERSISTED_BINARY_BASE64_BYTES
  ) {
    return {
      value: { type: "text", text: binaryReference({ mediaType: part.mediaType, bytes: byteLength(part.image) }) },
      changed: true,
    };
  }

  if (part.type === "file") {
    if (typeof part.data === "string" && byteLength(part.data) > MAX_PERSISTED_BINARY_BASE64_BYTES) {
      return {
        value: {
          type: "text",
          text: binaryReference({ mediaType: part.mediaType, bytes: byteLength(part.data), filename: part.filename }),
        },
        changed: true,
      };
    }
    if (isRecord(part.data) && part.data.type === "data" && typeof part.data.data === "string") {
      if (byteLength(part.data.data) > MAX_PERSISTED_BINARY_BASE64_BYTES) {
        return {
          value: {
            type: "text",
            text: binaryReference({
              mediaType: part.mediaType,
              bytes: byteLength(part.data.data),
              filename: part.filename,
            }),
          },
          changed: true,
        };
      }
    }
  }

  if (part.type === "tool-result") {
    const output = capToolResultOutput(part.output);
    if (output.changed) return { value: { ...part, output: output.value }, changed: true };
  }

  return unchanged(part);
}

function capModelMessageContent(content: unknown): Capped<unknown> {
  if (!isRecord(content)) return unchanged(content);
  const inner = content.content;

  if (typeof inner === "string") {
    if (byteLength(inner) <= MAX_PERSISTED_TEXT_BYTES) return unchanged(content);
    return { value: { ...content, content: truncateText(inner, MAX_PERSISTED_TEXT_BYTES) }, changed: true };
  }

  if (Array.isArray(inner)) {
    let changed = false;
    const parts = inner.map((part) => {
      const capped = capMessagePart(part);
      changed ||= capped.changed;
      return capped.value;
    });
    return changed ? { value: { ...content, content: parts }, changed: true } : unchanged(content);
  }

  return unchanged(content);
}

/**
 * Caps oversized text and binary payloads in the messages a turn is about to persist. Returns the same message
 * objects when nothing exceeds a cap so unchanged transcripts serialize identically to before this pass existed.
 */
export function capPersistedRuntimeMessages(
  messages: readonly AgentRuntimeMessageAppend[],
): AgentRuntimeMessageAppend[] {
  return messages.map((message) => {
    const capped = capModelMessageContent(message.content);
    return capped.changed ? { role: message.role, content: capped.value } : message;
  });
}
