/**
 * Catalog of tools an agent can be granted in /team. Single source of truth
 * for both the API validation (canonical names persisted in users.allowed_tools)
 * and the UI multiselect (friendly labels). Skills are intentionally excluded
 * from the catalog; agent-scoped skill access will land in a follow-up issue.
 */

export type AgentToolCategory = "builtin" | "sketch";

export interface AgentToolCatalogEntry {
  /** Canonical name as the Claude Agent SDK passes it to canUseTool. */
  name: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Short description shown next to the label. */
  description: string;
  /** Category for grouping in the UI. */
  category: AgentToolCategory;
}

export const VISUAL_ANALYSIS_AGENT_TOOL_NAME = "mcp__sketch__VisualAnalysis";

export const AGENT_TOOL_CATALOG: AgentToolCatalogEntry[] = [
  {
    name: "Read",
    label: "Read files",
    description: "Read file contents inside the agent's workspace.",
    category: "builtin",
  },
  {
    name: "Write",
    label: "Write files",
    description: "Create files inside the agent's workspace.",
    category: "builtin",
  },
  {
    name: "Edit",
    label: "Edit files",
    description: "Modify files inside the agent's workspace.",
    category: "builtin",
  },
  {
    name: "Bash",
    label: "Run shell commands",
    description: "Execute shell commands inside the agent's workspace.",
    category: "builtin",
  },
  {
    name: "Grep",
    label: "Search file contents",
    description: "Search across files in the workspace.",
    category: "builtin",
  },
  {
    name: "Glob",
    label: "Find files by pattern",
    description: "Locate files matching a glob pattern.",
    category: "builtin",
  },
  {
    name: "WebSearch",
    label: "Web search",
    description: "Search the public web for information.",
    category: "builtin",
  },
  {
    name: "WebFetch",
    label: "Fetch URL",
    description: "Fetch the contents of a public URL.",
    category: "builtin",
  },
  {
    name: "mcp__sketch__SendFileToChat",
    label: "Send file to chat",
    description: "Upload a file from the workspace to the conversation.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__ReadChatHistory",
    label: "Read chat history",
    description: "Read persisted messages from the current chat conversation.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__SearchChatHistory",
    label: "Search chat history",
    description: "Search persisted messages in the current chat conversation.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__TranscribeAudio",
    label: "Transcribe audio",
    description: "Convert an audio attachment in the workspace into text.",
    category: "sketch",
  },
  {
    name: VISUAL_ANALYSIS_AGENT_TOOL_NAME,
    label: "Visual analysis",
    description:
      "Inspect visual attachments in the workspace for tasks such as OCR, screenshots, diagrams, or animations using the configured vision model.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__getProviderConfig",
    label: "Check integration provider",
    description: "Check whether an integration provider is configured.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__local_run_command",
    label: "Run local Mac command",
    description: "Run shell commands on a paired local Mac through Sketch Local.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__local_claude_session",
    label: "Run local Claude Code",
    description: "Start and supervise Claude Code in a Sketch-managed tmux session on a paired local Mac.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__ManageScheduledTasks",
    label: "Manage scheduled tasks",
    description: "Create, list, update, pause, and run scheduled tasks.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__GetTeamDirectory",
    label: "Get team directory",
    description: "List team members and their roles.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__SearchUsers",
    label: "Search users",
    description: "Resolve names, emails, or Slack mentions into team users.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__SearchDeliveryTargets",
    label: "Search delivery targets",
    description: "Find Slack channels, Slack DMs, and WhatsApp groups that messages can be delivered to.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__SendMessage",
    label: "Send message",
    description: "Send a DM to a team member, or post in a Slack channel or WhatsApp group.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__SendMessageToUsers",
    label: "Send message to users",
    description: "Send the same DM to multiple team members.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__UpdateInboxWorkflow",
    label: "Update inbox workflow",
    description: "Update metadata on an explicit inbox workflow item.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__ResolveInboxWorkflow",
    label: "Resolve inbox workflow",
    description: "Mark an explicit inbox workflow item as resolved.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__Search",
    label: "Search indexed content",
    description: "Hybrid search across indexed docs, tasks, meetings, and conversations.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__SearchEntities",
    label: "Search entities",
    description: "Find projects, people, teams, companies, and products across connected sources.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__GetEntityContext",
    label: "Get entity context",
    description: "Get cross-source context and recent mentions for an entity.",
    category: "sketch",
  },
  {
    name: "mcp__sketch__GetFileContent",
    label: "Get file content",
    description: "Retrieve the full content of an indexed file by id.",
    category: "sketch",
  },
];

const CATALOG_BY_NAME: ReadonlyMap<string, AgentToolCatalogEntry> = new Map(
  AGENT_TOOL_CATALOG.map((entry) => [entry.name, entry]),
);

export const AGENT_TOOL_NAMES: readonly string[] = AGENT_TOOL_CATALOG.map((entry) => entry.name);

export const AGENT_BUILT_IN_TOOL_NAMES: readonly string[] = AGENT_TOOL_CATALOG.filter(
  (entry) => entry.category === "builtin",
).map((entry) => entry.name);

/**
 * Tools that were renamed after admins had already saved allowlists. Stored
 * names are mapped forward on read so a rename never silently removes a
 * capability from an existing agent.
 */
const RENAMED_AGENT_TOOL_NAMES: Readonly<Record<string, string>> = {
  mcp__sketch__SendMessageToUser: "mcp__sketch__SendMessage",
};

export function canonicalAgentToolName(name: string): string {
  return RENAMED_AGENT_TOOL_NAMES[name] ?? name;
}

export function isKnownAgentToolName(name: string): boolean {
  return CATALOG_BY_NAME.has(canonicalAgentToolName(name));
}

/**
 * Maximum number of characters allowed in an agent's instruction set
 * (persisted in users.description). Larger than the human bio cap because
 * an instruction set is a prompt, not a tagline.
 */
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 5000;

/**
 * Parse the JSON-encoded allowed_tools column from the users table. Returns
 * null when the column is empty or malformed; otherwise an array of tool
 * names (entries that are not strings are dropped).
 */
export function parseAllowedTools(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return [
      ...new Set(parsed.filter((entry): entry is string => typeof entry === "string").map(canonicalAgentToolName)),
    ];
  } catch {
    return null;
  }
}
