import { WEB_CHAT_PROGRESS_RENDERER_MODES, type WebChatProgressRendererMode } from "@sketch/shared";
import {
  type ProgressSettingsSummary,
  REASONING_TEXT_OPTIONS,
  TOOL_PROGRESS_OPTIONS,
  type ToolProgressCommand,
  getToolProgressSuggestion,
} from "./commands";

export interface ProgressDisplaySettings extends ProgressSettingsSummary {}

export interface ProgressDisplayDefaults {
  toolProgress?: ToolProgressCommand;
  reasoningText?: boolean;
}

export function resolveToolProgress(
  value: string | null | undefined,
  fallback: ToolProgressCommand = "friendly",
): ToolProgressCommand {
  if (TOOL_PROGRESS_OPTIONS.includes(value as ToolProgressCommand)) return value as ToolProgressCommand;
  if (value == null) return fallback;
  return "friendly";
}

export function resolveReasoningText(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return value === "1" || value.toLowerCase() === "true";
  }
  return fallback;
}

export function resolveProgressDisplaySettings(
  input: {
    tool_progress?: string | null;
    reasoning_text?: unknown;
  },
  defaults: ProgressDisplayDefaults = {},
): ProgressDisplaySettings {
  return {
    toolProgress: resolveToolProgress(input.tool_progress, defaults.toolProgress),
    reasoningText: resolveReasoningText(input.reasoning_text, defaults.reasoningText),
  };
}

export function resolveWebChatProgressRendererMode(
  value: unknown,
  fallback: ToolProgressCommand = "friendly",
): WebChatProgressRendererMode {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "verbose") return "technical";
    if (WEB_CHAT_PROGRESS_RENDERER_MODES.includes(normalized as WebChatProgressRendererMode)) {
      return normalized as WebChatProgressRendererMode;
    }
  }
  return fallback === "technical" ? "technical" : fallback;
}

export function progressDisplaySettingsForWebChatMode(
  base: ProgressDisplaySettings,
  mode: WebChatProgressRendererMode,
): ProgressDisplaySettings {
  if (mode === "technical") {
    return { toolProgress: "technical", reasoningText: base.reasoningText };
  }
  return { toolProgress: mode, reasoningText: false };
}

export function isToolProgressCommand(text: string | null | undefined): boolean {
  return /^\/toolprogress(?:\s|$)/.test(text?.trim() ?? "");
}

export function isReasoningTextCommand(text: string | null | undefined): boolean {
  return /^\/reasoningtext(?:\s|$)/.test(text?.trim() ?? "");
}

export function getUnknownToolProgressMessage(text: string | null | undefined): string {
  const rawArg =
    text
      ?.trim()
      .match(/^\/toolprogress\s+(.+)$/)?.[1]
      ?.trim() ?? "";
  const suggestion = getToolProgressSuggestion(rawArg);
  return suggestion
    ? `❓ Unknown tool progress mode: ${rawArg}. Did you mean ${suggestion}? Use ${TOOL_PROGRESS_OPTIONS.join(", ")}.`
    : `❓ Unknown tool progress mode: ${rawArg}. Use ${TOOL_PROGRESS_OPTIONS.join(", ")}.`;
}

export function getUnknownReasoningTextMessage(text: string | null | undefined): string {
  const rawArg =
    text
      ?.trim()
      .match(/^\/reasoningtext\s+(.+)$/)?.[1]
      ?.trim() ?? "";
  return `❓ Unknown reasoning text setting: ${rawArg}. Use ${REASONING_TEXT_OPTIONS.join(" or ")}.`;
}
