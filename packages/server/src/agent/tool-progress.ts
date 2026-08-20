import type {
  WebChatProgressData,
  WebChatProgressRendererMode,
  WebProgressIcon,
  WebProgressItem,
  WebProgressItemKind,
} from "@sketch/shared";
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
  componentKey: string | null;
}

interface McpToolName {
  serverName: string;
  toolName: string;
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
  GetTeamDirectory: "👥",
  SearchUsers: "🔎",
  SendMessage: "💬",
  SendMessageToTarget: "💬",
  SendMessageToUsers: "💬",
  UpdateInboxWorkflow: "📥",
  ResolveInboxWorkflow: "📥",
  getProviderConfig: "🔌",
};

const FALLBACK_EMOJI = "⚙️";

const TOOL_KIND: Record<string, WebProgressItemKind> = {
  Read: "file",
  Write: "file",
  Edit: "file",
  Bash: "shell",
  Glob: "search",
  Grep: "search",
  WebSearch: "web",
  WebFetch: "web",
  Skill: "skill",
  SendFileToChat: "attachment",
  TranscribeAudio: "audio",
  VisualAnalysis: "image",
  ManageScheduledTasks: "schedule",
  SearchDeliveryTargets: "delivery",
  SearchEntities: "entity",
  GetEntityContext: "entity",
  ReadChatHistory: "chat",
  SearchChatHistory: "chat",
  local_run_command: "local",
  local_claude_session: "local",
  GetTeamDirectory: "chat",
  SearchUsers: "search",
  SendMessage: "delivery",
  SendMessageToTarget: "delivery",
  SendMessageToUsers: "delivery",
  UpdateInboxWorkflow: "tool",
  ResolveInboxWorkflow: "tool",
  getProviderConfig: "integration",
};

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
  SearchUsers: "query",
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
  GetTeamDirectory: "Reading team directory",
  SearchUsers: "Finding teammates",
  SendMessage: "Sending a message",
  SendMessageToTarget: "Sending a message to a channel or group",
  SendMessageToUsers: "Sending messages",
  UpdateInboxWorkflow: "Updating inbox item",
  ResolveInboxWorkflow: "Resolving inbox item",
  getProviderConfig: "Checking integration",
};

const FRIENDLY_WEB_LABELS: Record<string, string> = {
  SendFileToChat: "Sending file",
  TranscribeAudio: "Transcribing audio",
  VisualAnalysis: "Analyzing image",
  ManageScheduledTasks: "Managing scheduled tasks",
  SearchDeliveryTargets: "Finding recipients",
  SearchEntities: "Searching connected knowledge",
  GetEntityContext: "Reading connected knowledge",
  ReadChatHistory: "Reading chat history",
  SearchChatHistory: "Searching chat history",
  local_run_command: "Using local device",
  local_claude_session: "Using local Claude Code",
  GetTeamDirectory: "Reading team directory",
  SearchUsers: "Finding teammates",
  SendMessage: "Sending message",
  SendMessageToTarget: "Sending message to a channel or group",
  SendMessageToUsers: "Sending messages",
  UpdateInboxWorkflow: "Updating inbox item",
  ResolveInboxWorkflow: "Resolving inbox item",
  getProviderConfig: "Checking integration",
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
  return parseMcpToolName(toolName)?.toolName ?? toolName;
}

function parseMcpToolName(toolName: string): McpToolName | null {
  const match = toolName.match(/^mcp__(.+?)__(.+)$/);
  const serverName = match?.[1];
  const name = match?.[2];
  return serverName && name ? { serverName, toolName: name } : null;
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/^plugin_/, "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function isInternalIntegrationName(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^plugin[_-]/, "");
  return normalized === "canvas" || normalized === "sketch";
}

function friendlyIntegrationLabel(serverName?: string): string {
  if (!serverName || isInternalIntegrationName(serverName)) return "Running integration";
  const integrationName = humanizeIdentifier(serverName);
  return integrationName ? `Running ${integrationName} integration` : "Running integration";
}

function isIntegrationSkillName(value: string): boolean {
  return /\bintegration\b/i.test(value.replace(/[-_]+/g, " "));
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

function clipValue(value: string): string {
  const chars = Array.from(value);
  return chars.length > MAX_ARG_LENGTH ? `${chars.slice(0, MAX_ARG_LENGTH).join("")}...` : value;
}

function quoteValue(value: string): string {
  return JSON.stringify(clipValue(value));
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
  const componentKey = findCanvasFlag(segment, ["--component-key", "--componentKey"]);
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

  return subcommand || target || componentKey
    ? { subcommand, target: target ?? null, componentKey }
    : { subcommand: null, target: null, componentKey: null };
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

function progressItem(
  kind: WebProgressItemKind,
  label: string,
  icon: WebProgressIcon,
  detail: string | null,
  toolName?: string,
): WebProgressItem {
  return {
    kind,
    label,
    icon,
    ...(detail ? { detail: clipValue(detail) } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

function toolIcon(toolName: string): WebProgressIcon {
  return {
    type: toolName === "Skill" ? "skill" : "tool",
    name: toolName,
  };
}

function genericIcon(name: string): WebProgressIcon {
  return { type: "generic", name };
}

function canvasIcon(_invocation: CanvasInvocation): WebProgressIcon {
  return { type: "canvas", name: "Canvas" };
}

function genericThinkingItem(): WebProgressItem {
  return progressItem("reasoning", "Thinking…", { type: "generic", name: "reasoning" }, null);
}

function friendlyLabelFromPrefix(prefix: string): string {
  return prefix.replace(/:\s*$/, "").replace(/\s+(for|matching)$/, "");
}

function getCanvasStructuredItem(invocation: CanvasInvocation, technical: boolean): WebProgressItem {
  const target = invocation.target ?? null;
  const detail =
    technical && invocation.subcommand ? [invocation.subcommand, target].filter(Boolean).join(" ") : target;

  if (technical) {
    return progressItem("canvas", "Canvas", canvasIcon(invocation), detail || invocation.subcommand, "Bash");
  }

  if (!invocation.subcommand) {
    return progressItem("canvas", "Running Canvas", canvasIcon(invocation), null, "Bash");
  }

  const prefix = CANVAS_FRIENDLY_TARGET_PREFIX[invocation.subcommand] ?? `Canvas ${invocation.subcommand}:`;
  const fallback = CANVAS_FRIENDLY_FALLBACK[invocation.subcommand] ?? `Canvas ${invocation.subcommand}`;
  return progressItem(
    "canvas",
    target ? prefix.replace(/:\s*$/, "") : fallback,
    canvasIcon(invocation),
    target,
    "Bash",
  );
}

function getFriendlyWebCanvasItem(invocation: CanvasInvocation): WebProgressItem {
  const label = invocation.subcommand
    ? (CANVAS_FRIENDLY_FALLBACK[invocation.subcommand] ?? `Running Canvas ${humanizeIdentifier(invocation.subcommand)}`)
    : "Running Canvas";
  return progressItem("canvas", label, canvasIcon(invocation), null, "Bash");
}

function getTechnicalProgressItem(toolName: string, input: Record<string, unknown>): WebProgressItem {
  const display = stripMcpPrefix(toolName);

  if (display === "Bash") {
    const command = findInputValue(input, ["command"]);
    const canvasInvocation = command ? parseCanvasInvocation(command) : null;
    if (canvasInvocation) return getCanvasStructuredItem(canvasInvocation, true);
  }

  const argKey = PRIMARY_ARG[display];
  const rawValue = argKey ? stringifyValue(input[argKey]) : findFallbackInputValue(input);
  return progressItem(
    TOOL_KIND[display] ?? "tool",
    display,
    TOOL_EMOJI[display] ? toolIcon(display) : genericIcon(display),
    rawValue,
    display,
  );
}

function getFriendlyProgressItem(toolName: string, input: Record<string, unknown>): WebProgressItem {
  const display = stripMcpPrefix(toolName);

  if (display === "Bash") {
    const command = findInputValue(input, ["command"]);
    const canvasInvocation = command ? parseCanvasInvocation(command) : null;
    if (canvasInvocation) return getCanvasStructuredItem(canvasInvocation, false);
    return progressItem("shell", command ? "Running" : "Running a shell command", toolIcon(display), command, display);
  }

  const targetLine = FRIENDLY_TARGET_LINES[display];
  if (targetLine) {
    const value = findInputValue(input, targetLine.keys);
    return progressItem(
      TOOL_KIND[display] ?? "tool",
      value ? friendlyLabelFromPrefix(targetLine.prefix) : targetLine.fallback,
      TOOL_EMOJI[display] ? toolIcon(display) : genericIcon(display),
      value,
      display,
    );
  }

  const staticLine = FRIENDLY_STATIC_LINES[display];
  if (staticLine) {
    return progressItem(
      TOOL_KIND[display] ?? "tool",
      staticLine,
      TOOL_EMOJI[display] ? toolIcon(display) : genericIcon(display),
      null,
      display,
    );
  }

  const fallback = findFallbackInputValue(input);
  return progressItem(TOOL_KIND[display] ?? "tool", display, genericIcon(display), fallback, display);
}

function isDetailedWebProgressMode(mode: WebChatProgressRendererMode): boolean {
  return mode === "technical";
}

function webProgressModeFromSettings(settings: ProgressDisplaySettings): WebChatProgressRendererMode {
  return settings.toolProgress;
}

function getFriendlyWebProgressItem(toolName: string, input: Record<string, unknown>): WebProgressItem {
  const mcpTool = parseMcpToolName(toolName);
  const display = mcpTool?.toolName ?? toolName;
  const safeToolName = clipValue((mcpTool ? display : toolName).trim()) || "tool";

  if (display === "Skill") {
    const skillName = findInputValue(input, ["skill", "name"]);
    if (skillName && isIntegrationSkillName(skillName)) {
      return progressItem("integration", "Running integration", genericIcon("integration"), null, safeToolName);
    }
    return progressItem("skill", "Running skill", { type: "skill", name: "Skill" }, null, safeToolName);
  }

  if (display === "Bash") {
    const command = findInputValue(input, ["command"]);
    const canvasInvocation = command ? parseCanvasInvocation(command) : null;
    if (canvasInvocation) return getFriendlyWebCanvasItem(canvasInvocation);
    return progressItem("shell", "Running command", toolIcon(display), null, safeToolName);
  }

  const targetLine = FRIENDLY_TARGET_LINES[display];
  if (targetLine) {
    return progressItem(
      TOOL_KIND[display] ?? "tool",
      friendlyLabelFromPrefix(targetLine.prefix),
      TOOL_EMOJI[display] ? toolIcon(display) : genericIcon(display),
      null,
      safeToolName,
    );
  }

  const label = FRIENDLY_WEB_LABELS[display];
  if (label) {
    return progressItem(
      TOOL_KIND[display] ?? "tool",
      label,
      TOOL_EMOJI[display] ? toolIcon(display) : genericIcon(display),
      null,
      safeToolName,
    );
  }

  if (mcpTool) {
    return progressItem(
      "integration",
      friendlyIntegrationLabel(mcpTool.serverName),
      genericIcon("integration"),
      null,
      safeToolName,
    );
  }

  return progressItem(
    TOOL_KIND[display] ?? "tool",
    humanizeIdentifier(display),
    genericIcon(display),
    null,
    safeToolName,
  );
}

function progressLineFromItem(item: WebProgressItem): string {
  return item.detail ? `${item.label} ${item.detail}` : item.label;
}

export function createWebProgressItem(
  event: ProgressEvent,
  settings: ProgressDisplaySettings,
  mode: WebChatProgressRendererMode = webProgressModeFromSettings(settings),
): WebProgressItem | null {
  if (event.kind === "intermediate_text") {
    if (!settings.reasoningText && mode !== "off") return null;
    if (!isDetailedWebProgressMode(mode)) return genericThinkingItem();
    return progressItem("reasoning", "Thinking", { type: "generic", name: "reasoning" }, event.text);
  }

  if (mode === "off") return genericThinkingItem();
  if (isDetailedWebProgressMode(mode)) return getTechnicalProgressItem(event.toolName, event.input);
  return getFriendlyWebProgressItem(event.toolName, event.input);
}

export function createWebProgressData(
  event: ProgressEvent,
  settings: ProgressDisplaySettings,
  mode: WebChatProgressRendererMode,
  renderedLines: string[] = [],
): WebChatProgressData | null {
  const item = createWebProgressItem(event, settings, mode);
  if (!item) return null;
  const lines =
    isDetailedWebProgressMode(mode) && renderedLines.length > 0 ? renderedLines : [progressLineFromItem(item)];
  return { lines, items: [item] };
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
  return fallback ? `${emoji} ${display}: ${quoteValue(fallback)}` : `${emoji} ${display}`;
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
