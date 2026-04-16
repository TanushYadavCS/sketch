import {
  type ProgressSettingsSummary,
  REASONING_TEXT_OPTIONS,
  TOOL_PROGRESS_OPTIONS,
  type ToolProgressCommand,
  getToolProgressSuggestion,
} from "./commands";

export interface ProgressDisplaySettings extends ProgressSettingsSummary {}

export function resolveToolProgress(value: string | null | undefined): ToolProgressCommand {
  return TOOL_PROGRESS_OPTIONS.includes(value as ToolProgressCommand) ? (value as ToolProgressCommand) : "friendly";
}

export function resolveReasoningText(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return value === "1" || value.toLowerCase() === "true";
  }
  return false;
}

export function resolveProgressDisplaySettings(input: {
  tool_progress?: string | null;
  reasoning_text?: unknown;
}): ProgressDisplaySettings {
  return {
    toolProgress: resolveToolProgress(input.tool_progress),
    reasoningText: resolveReasoningText(input.reasoning_text),
  };
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
