export type OutputStyleCommand = "friendly" | "concise" | "technical" | "verbose";

export type SketchCommand =
  | "new_session"
  | "output_style_friendly"
  | "output_style_concise"
  | "output_style_technical"
  | "output_style_verbose"
  | "output_style_query";

export const NEW_SESSION_CONFIRMATIONS = [
  "Started a new session. ✨",
  "Session reset. Ready for a fresh start. 🌱",
  "Fresh session ready. 🚀",
  "Context cleared. Starting fresh. 🧹",
  "New conversation started. 💬",
] as const;

export const OUTPUT_STYLE_OPTIONS = ["friendly", "concise", "technical", "verbose"] as const;

const OUTPUT_STYLE_ALIASES: Record<string, OutputStyleCommand> = {
  friendly: "friendly",
  f: "friendly",
  concise: "concise",
  c: "concise",
  technical: "technical",
  t: "technical",
  verbose: "verbose",
  v: "verbose",
};

export function parseSketchCommand(text: string | null | undefined): SketchCommand | null {
  const normalized = text?.trim();
  if (!normalized) return null;
  if (/^\/new(?:\s|$)/.test(normalized)) return "new_session";
  const outputStyleMatch = normalized.match(/^\/outputstyle(?:\s+(.+))?$/);
  if (outputStyleMatch) {
    const rawArg = outputStyleMatch[1]?.trim().toLowerCase();
    if (!rawArg) return "output_style_query";
    const resolved = OUTPUT_STYLE_ALIASES[rawArg];
    if (!resolved) return null;
    return `output_style_${resolved}` as SketchCommand;
  }
  return null;
}

export function getNewSessionConfirmation(randomValue = Math.random()): string {
  const index = Math.floor(randomValue * NEW_SESSION_CONFIRMATIONS.length);
  return NEW_SESSION_CONFIRMATIONS[index] ?? NEW_SESSION_CONFIRMATIONS[0];
}

export function getOutputStyleConfirmation(style: OutputStyleCommand): string {
  return `Output style set to ${style}.`;
}

export function getOutputStyleCurrent(style: OutputStyleCommand): string {
  return `Current output style: ${style}. Available: ${OUTPUT_STYLE_OPTIONS.join(", ")}.`;
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

export function getOutputStyleSuggestion(input: string): string | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  let best: OutputStyleCommand | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of OUTPUT_STYLE_OPTIONS) {
    const distance = levenshtein(normalized, option);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = option;
    }
  }
  return bestDistance <= 3 ? best : null;
}
