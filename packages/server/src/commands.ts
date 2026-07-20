export type ToolProgressCommand = "off" | "friendly" | "technical";
export type ReasoningTextCommand = "on" | "off";

export type FollowupReviewCommand =
  | { action: "confirm_done"; code: string }
  | { action: "keep_open"; code: string }
  | { action: "track"; code: string }
  | { action: "dismiss"; code: string };

export type SketchCommand =
  | "new_session"
  | "tool_progress_off"
  | "tool_progress_friendly"
  | "tool_progress_technical"
  | "tool_progress_query"
  | "reasoning_text_on"
  | "reasoning_text_off"
  | "reasoning_text_query";

export const NEW_SESSION_CONFIRMATIONS = [
  "Started a new session. ✨",
  "Session reset. Ready for a fresh start. 🌱",
  "Fresh session ready. 🚀",
  "Context cleared. Starting fresh. 🧹",
  "New conversation started. 💬",
] as const;

export const TOOL_PROGRESS_OPTIONS = ["off", "friendly", "technical"] as const;
export const REASONING_TEXT_OPTIONS = ["on", "off"] as const;

export const TOOL_PROGRESS_LABELS: Record<ToolProgressCommand, string> = {
  off: "Off",
  friendly: "Friendly",
  technical: "Technical",
};

export const REASONING_TEXT_LABELS: Record<ReasoningTextCommand, string> = {
  on: "On",
  off: "Off",
};

export interface ProgressSettingsSummary {
  toolProgress: ToolProgressCommand;
  reasoningText: boolean;
}

export function parseFollowupReviewCommand(text: string | null | undefined): FollowupReviewCommand | null {
  const normalized = text?.trim();
  if (!normalized) return null;

  const match = normalized.match(/^(confirm[ \t]+done|keep[ \t]+open|track|dismiss)[ \t]+([a-z0-9]{4,12})$/i);
  if (!match) return null;

  const rawAction = match[1]?.toLowerCase().replace(/[ \t]+/g, " ");
  const code = match[2]?.toUpperCase();
  if (!code) return null;

  switch (rawAction) {
    case "confirm done":
      return { action: "confirm_done", code };
    case "keep open":
      return { action: "keep_open", code };
    case "track":
      return { action: "track", code };
    case "dismiss":
      return { action: "dismiss", code };
    default:
      return null;
  }
}

export function parseSketchCommand(text: string | null | undefined): SketchCommand | null {
  const normalized = text?.trim();
  if (!normalized) return null;
  if (/^\/new(?:\s|$)/.test(normalized)) return "new_session";

  const toolProgressMatch = normalized.match(/^\/toolprogress(?:\s+(.+))?$/);
  if (toolProgressMatch) {
    const rawArg = toolProgressMatch[1]?.trim().toLowerCase();
    if (!rawArg) return "tool_progress_query";
    if (TOOL_PROGRESS_OPTIONS.includes(rawArg as ToolProgressCommand)) {
      return `tool_progress_${rawArg}` as SketchCommand;
    }
    return null;
  }

  const reasoningTextMatch = normalized.match(/^\/reasoningtext(?:\s+(.+))?$/);
  if (reasoningTextMatch) {
    const rawArg = reasoningTextMatch[1]?.trim().toLowerCase();
    if (!rawArg) return "reasoning_text_query";
    if (rawArg === "on" || rawArg === "true" || rawArg === "yes") return "reasoning_text_on";
    if (rawArg === "off" || rawArg === "false" || rawArg === "no") return "reasoning_text_off";
    return null;
  }

  return null;
}

export function getNewSessionConfirmation(randomValue = Math.random()): string {
  const index = Math.floor(randomValue * NEW_SESSION_CONFIRMATIONS.length);
  return NEW_SESSION_CONFIRMATIONS[index] ?? NEW_SESSION_CONFIRMATIONS[0];
}

export function getToolProgressConfirmation(style: ToolProgressCommand, reasoningText: boolean): string {
  switch (style) {
    case "off":
      return reasoningText
        ? "🛑 Tool progress turned off. 🧠 Reasoning text is still on, so you may still see live updates."
        : "🛑 Tool progress turned off.";
    case "friendly":
      return "🪄 Tool progress set to friendly.";
    case "technical":
      return "🛠️ Tool progress set to technical.";
  }
}

export function getReasoningTextConfirmation(enabled: boolean): string {
  return enabled ? "🧠 Reasoning text turned on." : "🔕 Reasoning text turned off.";
}

export function getToolProgressCurrent(settings: ProgressSettingsSummary): string {
  return [
    `🛠️ Tool progress: ${settings.toolProgress}. 🧠 Reasoning text: ${settings.reasoningText ? "on" : "off"}.`,
    `Use /toolprogress ${TOOL_PROGRESS_OPTIONS.join("|")}`,
  ].join("\n");
}

export function getReasoningTextCurrent(settings: ProgressSettingsSummary): string {
  return [
    `🧠 Reasoning text: ${settings.reasoningText ? "on" : "off"}. 🛠️ Tool progress: ${settings.toolProgress}.`,
    "Use /reasoningtext on|off",
  ].join("\n");
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length] ?? Number.POSITIVE_INFINITY;
}

export function getToolProgressSuggestion(input: string): ToolProgressCommand | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  let best: ToolProgressCommand | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of TOOL_PROGRESS_OPTIONS) {
    const distance = levenshtein(normalized, option);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = option;
    }
  }
  return bestDistance <= 3 ? best : null;
}
