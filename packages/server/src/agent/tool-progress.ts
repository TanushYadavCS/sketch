import type { ProgressDisplaySettings } from "../progress-settings";
import type { ProgressEvent } from "./runner";

export interface ProgressRenderer {
  renderEvent(event: ProgressEvent): void;
  getLines(): string[];
}

interface FriendlyTargetLine {
  prefix: string;
  keys: string[];
  fallback: string;
}

interface CanvasInvocation {
  subcommand: string | null;
  target: string | null;
}

const TOOL_EMOJI: Record<string, string> = {
  Read: "📖",
  Write: "✍️",
  Edit: "🔧",
  Bash: "💻",
  Glob: "📂",
  Grep: "🔎",
  WebSearch: "🌐",
  WebFetch: "🌐",
  Skill: "📚",
  SendFileToChat: "📎",
  TranscribeAudio: "🎙️",
  VisualAnalysis: "🖼️",
  ManageScheduledTasks: "⏰",
  SearchDeliveryTargets: "📍",
  SearchEntities: "🔍",
  GetEntityContext: "📊",
  ReadChatHistory: "💬",
  SearchChatHistory: "🔎",
  local_run_command: "💻",
  local_claude_session: "💻",
};

const FALLBACK_EMOJI = "⚙️";

const PRIMARY_ARG: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Bash: "command",
  Glob: "pattern",
  Grep: "pattern",
  WebSearch: "query",
  WebFetch: "url",
  Skill: "skill",
  SendFileToChat: "file_path",
  TranscribeAudio: "file_path",
  VisualAnalysis: "file_path",
  ManageScheduledTasks: "action",
  SearchDeliveryTargets: "query",
  SearchEntities: "queries",
  local_claude_session: "action",
  SearchChatHistory: "query",
};

const EXTRA_FALLBACK_ARG_KEYS = ["path", "folder"];
const SAFE_FALLBACK_ARG_KEYS = [
  ...new Set([...Object.values(PRIMARY_ARG).filter((key) => key !== "command"), ...EXTRA_FALLBACK_ARG_KEYS]),
];
const MAX_ARG_LENGTH = 40;

const FRIENDLY_TARGET_LINES: Record<string, FriendlyTargetLine> = {
  Read: { prefix: "Reading", keys: ["file_path"], fallback: "Reading a file" },
  Write: { prefix: "Creating", keys: ["file_path"], fallback: "Creating a file" },
  Edit: { prefix: "Editing", keys: ["file_path"], fallback: "Editing a file" },
  Glob: { prefix: "Finding files matching", keys: ["pattern"], fallback: "Finding files" },
  Grep: { prefix: "Searching for", keys: ["pattern"], fallback: "Searching files" },
  WebSearch: { prefix: "Searching the web for", keys: ["query"], fallback: "Searching the web" },
  WebFetch: { prefix: "Fetching", keys: ["url"], fallback: "Fetching a web page" },
  Skill: { prefix: "Loading skill", keys: ["skill", "name"], fallback: "Loading a skill" },
  SendFileToChat: { prefix: "Sending file", keys: ["file_path"], fallback: "Sending a file" },
  TranscribeAudio: { prefix: "Transcribing audio", keys: ["file_path"], fallback: "Transcribing audio" },
  VisualAnalysis: { prefix: "Analyzing image", keys: ["file_path"], fallback: "Analyzing image" },
  ManageScheduledTasks: {
    prefix: "Managing scheduled tasks:",
    keys: ["action"],
    fallback: "Managing scheduled tasks",
  },
  SearchDeliveryTargets: {
    prefix: "Searching delivery targets for",
    keys: ["query"],
    fallback: "Listing delivery targets",
  },
  SearchEntities: { prefix: "Searching entities for", keys: ["queries"], fallback: "Searching entities" },
  SearchChatHistory: {
    prefix: "Searching chat history for",
    keys: ["query"],
    fallback: "Searching chat history",
  },
};

const FRIENDLY_STATIC_LINES: Record<string, string> = {
  GetEntityContext: "Getting entity context",
  ReadChatHistory: "Reading Chat History",
  local_run_command: "Running local Mac command",
  local_claude_session: "Supervising local Claude Code",
};

const CANVAS_FRIENDLY_TARGET_PREFIX: Record<string, string> = {
  "direct-execute-action": "Canvas action:",
  "direct-execute-web-search": "Canvas web search:",
  "direct-execute-web-scrape": "Canvas web scrape:",
};

const CANVAS_FRIENDLY_FALLBACK: Record<string, string> = {
  "direct-execute-action": "Running Canvas action",
  "direct-execute-web-search": "Searching the web with Canvas",
  "direct-execute-web-scrape": "Scraping a web page with Canvas",
};

function stripMcpPrefix(toolName: string): string {
  return toolName.replace(/^mcp__.+?__/, "");
}

function stringifyValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((entry) => stringifyValue(entry)).filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join(", ") : null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function quoteValue(value: string): string {
  const chars = Array.from(value);
  const clipped = chars.length > MAX_ARG_LENGTH ? `${chars.slice(0, MAX_ARG_LENGTH).join("")}...` : value;
  return JSON.stringify(clipped);
}

function findInputValue(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = stringifyValue(input[key]);
    if (value) return value;
  }
  return null;
}

function findFallbackInputValue(input: Record<string, unknown>): string | null {
  return findInputValue(input, SAFE_FALLBACK_ARG_KEYS);
}

function findCanvasFlag(command: string, flags: string[]): string | null {
  for (const flag of flags) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = command.match(new RegExp(`${escaped}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s|;&]+))`));
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    if (value) return value;
  }
  return null;
}

function parseCanvasInvocation(command: string): CanvasInvocation | null {
  if (!/\$\{?CANVAS_CLI\}?/.test(command)) return null;

  const normalized = command.replace(/["']?\$\{?CANVAS_CLI\}?["']?/g, "$CANVAS_CLI");
  const afterCli = normalized.match(/\$CANVAS_CLI\s+([\s\S]+)/)?.[1] ?? "";
  const segment = afterCli.split(/[|;&\n]/)[0]?.trim() ?? "";
  const subcommand = segment.match(/^([^\s]+)/)?.[1] ?? null;
  const target = findCanvasFlag(segment, [
    "--component-key",
    "--componentKey",
    "--query",
    "--queries",
    "--q",
    "--url",
    "--apps",
    "--key",
    "--field-name",
    "--fieldName",
    "--search-query",
    "--searchQuery",
  ]);

  return subcommand || target ? { subcommand, target } : { subcommand: null, target: null };
}

function getCanvasFriendlyLine(invocation: CanvasInvocation): string {
  const target = invocation.target ? quoteValue(invocation.target) : null;
  if (!invocation.subcommand) return "🧩 Running Canvas";

  const prefix = CANVAS_FRIENDLY_TARGET_PREFIX[invocation.subcommand] ?? `Canvas ${invocation.subcommand}:`;
  const fallback = CANVAS_FRIENDLY_FALLBACK[invocation.subcommand] ?? `Canvas ${invocation.subcommand}`;
  return target ? `🧩 ${prefix} ${target}` : `🧩 ${fallback}`;
}

function getCanvasTechnicalLine(invocation: CanvasInvocation): string {
  if (!invocation.subcommand) return "🧩 Canvas...";
  const target = invocation.target ? `${invocation.subcommand} ${invocation.target}` : invocation.subcommand;
  return `🧩 Canvas: ${quoteValue(target)}`;
}

function buildTechnicalLine(toolName: string, input: Record<string, unknown>): string {
  const display = stripMcpPrefix(toolName);
  const emoji = TOOL_EMOJI[display] ?? FALLBACK_EMOJI;

  if (display === "Bash") {
    const command = findInputValue(input, ["command"]);
    const canvasInvocation = command ? parseCanvasInvocation(command) : null;
    if (canvasInvocation) return getCanvasTechnicalLine(canvasInvocation);
  }

  const argKey = PRIMARY_ARG[display];
  const rawValue = argKey ? stringifyValue(input[argKey]) : findFallbackInputValue(input);
  return rawValue ? `${emoji} ${display}: ${quoteValue(rawValue)}` : `${emoji} ${display}...`;
}

function getFriendlyLine(toolName: string, input: Record<string, unknown>): string {
  const display = stripMcpPrefix(toolName);
  const emoji = TOOL_EMOJI[display] ?? FALLBACK_EMOJI;

  if (display === "Bash") {
    const command = findInputValue(input, ["command"]);
    const canvasInvocation = command ? parseCanvasInvocation(command) : null;
    if (canvasInvocation) return getCanvasFriendlyLine(canvasInvocation);
    return command ? `${emoji} Running ${quoteValue(command)}` : `${emoji} Running a shell command`;
  }

  const targetLine = FRIENDLY_TARGET_LINES[display];
  if (targetLine) {
    const value = findInputValue(input, targetLine.keys);
    return value ? `${emoji} ${targetLine.prefix} ${quoteValue(value)}` : `${emoji} ${targetLine.fallback}`;
  }

  const staticLine = FRIENDLY_STATIC_LINES[display];
  if (staticLine) {
    return `${emoji} ${staticLine}`;
  }

  const fallback = findFallbackInputValue(input);
  return fallback ? `${emoji} Using ${display}: ${quoteValue(fallback)}` : `${emoji} Using ${display}`;
}

export function getProgressTransportStrategy(settings: ProgressDisplaySettings): "accumulate" | "replace" | "none" {
  if (settings.toolProgress === "off" && !settings.reasoningText) return "none";
  return "replace";
}

export function createProgressRenderer(settings: ProgressDisplaySettings): ProgressRenderer {
  const lines: string[] = [];
  let lastLine: string | null = null;
  let repeatCount = 0;

  const replaceLine = (line: string) => {
    lines.splice(0, lines.length, line);
  };

  const appendAccumulateLine = (line: string) => {
    repeatCount = line === lastLine ? repeatCount + 1 : 1;
    lastLine = line;
    replaceLine(repeatCount > 1 ? `${line} (x${repeatCount})` : line);
  };

  return {
    renderEvent(event) {
      if (event.kind === "intermediate_text") {
        if (!settings.reasoningText) return;
        const line = `💬 ${event.text}`;
        appendAccumulateLine(line);
        return;
      }

      if (settings.toolProgress === "off") return;

      if (settings.toolProgress === "technical") {
        appendAccumulateLine(buildTechnicalLine(event.toolName, event.input));
        return;
      }

      const friendlyLine = getFriendlyLine(event.toolName, event.input);
      appendAccumulateLine(friendlyLine);
    },

    getLines() {
      return [...lines];
    },
  };
}
