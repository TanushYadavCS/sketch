export interface AgentEnvironmentVariableRecord {
  id: string;
  name: string;
  value: string | null;
  isSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

const RESERVED_AGENT_ENV_EXACT = new Set([
  "NODE_OPTIONS",
  "HOME",
  "PATH",
  "PWD",
  "SHELL",
  "DATA_DIR",
  "SQLITE_PATH",
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "SYSTEM_SECRET",
  "MANAGED_AUTH_SECRET",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]);

const RESERVED_AGENT_ENV_PREFIXES = [
  "ANTHROPIC_",
  "AWS_",
  "CANVAS_",
  "CLAUDE_",
  "GOOGLE_",
  "OPENAI_",
  "SKETCH_",
  "VERTEX_",
];

export function isReservedAgentEnvName(name: string): boolean {
  return RESERVED_AGENT_ENV_EXACT.has(name) || RESERVED_AGENT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}
