const TOOL_EMOJI: Record<string, string> = {
  Read: "📖",
  Write: "✍️",
  Edit: "🔧",
  Bash: "💻",
  Glob: "📂",
  Grep: "🔎",
  Skill: "📚",
  SendFileToChat: "📎",
  ManageScheduledTasks: "⏰",
  SearchEntities: "🔍",
  GetEntityContext: "📊",
};

const FALLBACK_EMOJI = "⚙️";

const PRIMARY_ARG: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Bash: "command",
  Glob: "pattern",
  Grep: "pattern",
  Skill: "skill",
  SendFileToChat: "file_path",
  ManageScheduledTasks: "action",
  SearchEntities: "queries",
};

const MAX_ARG_LENGTH = 40;

/**
 * Builds a single progress line for a tool call.
 * Format: `emoji ToolName: "clipped args"` or `emoji ToolName...` if no preview available.
 */
export function buildToolProgressLine(toolName: string, input: Record<string, unknown>): string {
  const emoji = TOOL_EMOJI[toolName] ?? FALLBACK_EMOJI;
  const argKey = PRIMARY_ARG[toolName];

  if (argKey) {
    const rawValue = input[argKey];
    if (rawValue != null) {
      const display = typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
      const clipped = display.length > MAX_ARG_LENGTH ? `${display.slice(0, MAX_ARG_LENGTH)}...` : display;
      return `${emoji} ${toolName}: "${clipped}"`;
    }
  }

  return `${emoji} ${toolName}...`;
}

/**
 * Collapses consecutive identical lines at the end of the array.
 * Returns a new array with the trailing run of duplicates replaced by a single
 * entry with a counter suffix like (x3).
 */
export function dedup(lines: string[]): string[] {
  if (lines.length < 2) return [...lines];

  const result = [...lines];
  const last = result[result.length - 1];

  let runStart = result.length - 2;
  while (runStart >= 0) {
    const entry = result[runStart];
    const counterMatch = entry.match(/^(.*) \(x(\d+)\)$/);
    const base = counterMatch ? counterMatch[1] : entry;
    if (base === last) {
      runStart--;
    } else {
      break;
    }
  }
  runStart++;

  const runLength = result.length - runStart;
  if (runLength < 2) return result;

  let totalCount = 0;
  for (let i = runStart; i < result.length; i++) {
    const counterMatch = result[i].match(/^(.*) \(x(\d+)\)$/);
    totalCount += counterMatch ? Number(counterMatch[2]) : 1;
  }

  result.splice(runStart, runLength, `${last} (x${totalCount})`);
  return result;
}
