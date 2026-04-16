import { OUTPUT_STYLE_OPTIONS, type OutputStyleCommand, getOutputStyleSuggestion } from "./commands";

export function resolveOutputStyle(value: string | null | undefined): OutputStyleCommand {
  return OUTPUT_STYLE_OPTIONS.includes(value as OutputStyleCommand) ? (value as OutputStyleCommand) : "friendly";
}

export function isOutputStyleCommand(text: string | null | undefined): boolean {
  return /^\/outputstyle(?:\s|$)/.test(text?.trim() ?? "");
}

export function getUnknownOutputStyleMessage(text: string | null | undefined): string {
  const rawArg =
    text
      ?.trim()
      .match(/^\/outputstyle\s+(.+)$/)?.[1]
      ?.trim() ?? "";
  const suggestion = getOutputStyleSuggestion(rawArg);
  return suggestion
    ? `Unknown output style: ${rawArg}. Did you mean ${suggestion}? Available: ${OUTPUT_STYLE_OPTIONS.join(", ")}.`
    : `Unknown output style: ${rawArg}. Available: ${OUTPUT_STYLE_OPTIONS.join(", ")}.`;
}
