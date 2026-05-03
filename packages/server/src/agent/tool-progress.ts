import type { ProgressDisplaySettings } from "../progress-settings";
import type { ProgressEvent } from "./runner";

export interface ProgressRenderer {
  renderEvent(event: ProgressEvent): void;
  getLines(): string[];
}

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

const FRIENDLY_MESSAGES: Record<string, string[]> = {
  Read: ["📖 Flipping through some pages", "📖 Digging into the files", "📖 Scanning the code", "📖 Having a read"],
  Write: ["✨ Creating something new", "📝 Drafting a new file", "🛠️ Building from scratch"],
  Edit: [
    "🔧 Tweaking things",
    "✂️ Making some cuts",
    "🪚 Fixing things up",
    "🎯 Nailing the fix",
    "🧩 Putting pieces together",
  ],
  Bash: ["🚀 Running commands", "⚡ Crunching away", "🖥️ Talking to the machine", "🔥 Firing things up"],
  Glob: ["🔍 Hunting for files", "🗺️ Exploring the codebase", "📂 Sifting through folders"],
  Grep: ["🕵️ On the hunt", "🔎 Searching high and low", "🎪 Looking for clues"],
  Skill: ["📚 Loading a new trick", "🎓 Brushing up on skills", "🎒 Packing the toolkit"],
  SendFileToChat: ["📦 Wrapping up a file for you", "🎁 Sending something your way", "📎 Getting that ready for you"],
  ManageScheduledTasks: ["⏰ Setting up schedules", "📅 Marking the calendar", "🕰️ Planning ahead"],
  SearchEntities: ["🕵️ Looking things up", "🌐 Scanning the knowledge base", "🔭 Searching far and wide"],
  GetEntityContext: ["🧠 Gathering some context", "📋 Getting the full picture", "🪞 Pulling up the details"],
  Fallback: [
    "⚙️ Working on it",
    "🧙 Cooking something up",
    "🔮 Consulting the magic ball",
    "🤖 Beep boop, working on it",
  ],
};

function stripMcpPrefix(toolName: string): string {
  return toolName.replace(/^mcp__.+?__/, "");
}

function buildTechnicalLine(toolName: string, input: Record<string, unknown>): string {
  const display = stripMcpPrefix(toolName);
  const emoji = TOOL_EMOJI[display] ?? FALLBACK_EMOJI;
  const argKey = PRIMARY_ARG[display];

  if (argKey) {
    const rawValue = input[argKey];
    if (rawValue != null) {
      const raw = typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
      const clipped = raw.length > MAX_ARG_LENGTH ? `${raw.slice(0, MAX_ARG_LENGTH)}...` : raw;
      return `${emoji} ${display}: "${clipped}"`;
    }
  }

  return `${emoji} ${display}...`;
}

function buildVerboseLine(toolName: string, input: Record<string, unknown>): string {
  const display = stripMcpPrefix(toolName);
  const emoji = TOOL_EMOJI[display] ?? FALLBACK_EMOJI;
  return Object.keys(input).length > 0 ? `${emoji} ${display}: ${JSON.stringify(input)}` : `${emoji} ${display}`;
}

function dedup(lines: string[]): string[] {
  if (lines.length < 2) return [...lines];

  const result = [...lines];
  const last = result[result.length - 1];
  if (!last) return result;

  let runStart = result.length - 2;
  while (runStart >= 0) {
    const entry = result[runStart];
    if (!entry) break;
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
    const entry = result[i];
    if (!entry) continue;
    const counterMatch = entry.match(/^(.*) \(x(\d+)\)$/);
    totalCount += counterMatch ? Number(counterMatch[2]) : 1;
  }

  result.splice(runStart, runLength, `${last} (x${totalCount})`);
  return result;
}

function getFriendlyPool(toolName: string): string[] {
  return FRIENDLY_MESSAGES[stripMcpPrefix(toolName)] ?? FRIENDLY_MESSAGES.Fallback;
}

function pickFriendlyLine(toolName: string, random: () => number): string {
  const pool = getFriendlyPool(toolName);
  const index = Math.floor(random() * pool.length);
  return pool[index] ?? pool[0] ?? `${FALLBACK_EMOJI} Working on it`;
}

export function getProgressTransportStrategy(settings: ProgressDisplaySettings): "accumulate" | "replace" | "none" {
  if (settings.toolProgress === "concise") return "replace";
  if (settings.toolProgress === "off" && !settings.reasoningText) return "none";
  return "accumulate";
}

export function createProgressRenderer(
  settings: ProgressDisplaySettings,
  random: () => number = Math.random,
): ProgressRenderer {
  const lines: string[] = [];
  let lastFriendlyToolName: string | null = null;
  let lastFriendlyLine: string | null = null;

  const getFriendlyLine = (toolName: string) => {
    if (toolName === lastFriendlyToolName && lastFriendlyLine) {
      return lastFriendlyLine;
    }

    const line = pickFriendlyLine(toolName, random);
    lastFriendlyToolName = toolName;
    lastFriendlyLine = line;
    return line;
  };

  const appendAccumulateLine = (line: string) => {
    lines.push(line);
    const deduped = dedup(lines);
    lines.splice(0, lines.length, ...deduped);
  };

  const replaceLine = (line: string) => {
    lines.splice(0, lines.length, line);
  };

  return {
    renderEvent(event) {
      if (event.kind === "intermediate_text") {
        if (!settings.reasoningText) return;
        const line = `💬 ${event.text}`;
        if (settings.toolProgress === "concise") {
          replaceLine(line);
          return;
        }
        appendAccumulateLine(line);
        return;
      }

      if (settings.toolProgress === "off") return;

      if (settings.toolProgress === "technical") {
        appendAccumulateLine(buildTechnicalLine(event.toolName, event.input));
        return;
      }

      if (settings.toolProgress === "verbose") {
        appendAccumulateLine(buildVerboseLine(event.toolName, event.input));
        return;
      }

      const friendlyLine = getFriendlyLine(event.toolName);
      if (settings.toolProgress === "concise") {
        replaceLine(friendlyLine);
        return;
      }

      appendAccumulateLine(friendlyLine);
    },

    getLines() {
      return [...lines];
    },
  };
}
