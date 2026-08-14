import type { ToolSet } from "ai";
import type { RunAgentParams } from "../runner";

/** Runtime persisted in chat_sessions.runtime. */
export type AgentRuntimeKind = "sdk" | "aisdk";

/** Provider families the in-process runtime must create without mutating process.env. */
export type AgentRuntimeProviderKind = "anthropic" | "bedrock" | "openrouter" | "vertex" | "openai-compatible";

/** Built-in workspace tools the runtime owns directly once the SDK loop is replaced. */
export type AgentRuntimeWorkspaceToolName = "Bash" | "Read" | "Write" | "Edit" | "Glob" | "Grep";

/** Workspace-scoped tools plus Skill, the user-visible tool set for chat turns. */
export type AgentRuntimeScopedToolName = AgentRuntimeWorkspaceToolName | "Skill";

/** Stop reasons normalized by the runtime boundary. */
export type AgentRuntimeStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "aborted"
  | "error"
  | "unknown";

/** Main chat run contract remains the public runner contract while runtime selection is flag-gated inside runner.ts. */
export type AgentRuntimeRunParams = RunAgentParams;

/**
 * Lightweight workflow steps are a first-class runtime entry point, but they do not inherit chat sessions,
 * MCP integrations, skills, or the main runner prompt stack.
 */
export interface WorkflowLightStepRuntimeParams {
  prompt: string;
  input: unknown;
  workspaceDir: string;
  outputPlatform: "slack" | "whatsapp";
  formattingOnlySystemPrompt: string;
  maxTurns: 10;
  model?: string | null;
  abortSignal?: AbortSignal;
  tools: readonly AgentRuntimeWorkspaceToolName[];
  persistSession: false;
  mcpServers?: never;
  skillsEnabled: false;
}

/** Tool lifecycle data captured before a tool handler runs. */
export interface AgentRuntimeToolStart {
  name: string;
  input: Record<string, unknown>;
}

/** Tool lifecycle data captured after a tool handler settles. */
export interface AgentRuntimeToolEnd {
  name: string;
  input: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  error?: { message: string; name?: string };
}

/**
 * Stream and side-effect hooks the runtime emits. onToolStart/onToolEnd are internal hooks for upload draining,
 * integration-card capture, skill-name attribution, and auxiliary LLM cost accounting.
 */
export interface AgentRuntimeEvents {
  onSessionId?: (sessionId: string) => void | Promise<void>;
  onTextDelta?: (text: string) => void | Promise<void>;
  onToolStart?: (event: AgentRuntimeToolStart) => void | Promise<void>;
  onToolEnd?: (event: AgentRuntimeToolEnd) => void | Promise<void>;
}

/** Token usage for one provider model id. */
export interface AgentRuntimeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Usage is keyed by exact provider model id because pricing and cache semantics are provider-specific. */
export interface AgentRuntimeUsage {
  byModel: Record<string, AgentRuntimeModelUsage>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

/** Pricing table entry owned by Sketch rather than provider-reported SDK totals. */
export interface AgentRuntimeModelPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cacheReadUsdPerMillionTokens: number;
  cacheWriteUsdPerMillionTokens: number;
}

/** Runtime cost table keyed by provider and model id. */
export type AgentRuntimeCostTable = Record<string, Record<string, AgentRuntimeModelPricing>>;

/** Cost result for one model after applying the configured pricing table. */
export interface AgentRuntimeModelCost {
  provider: AgentRuntimeProviderKind;
  model: string;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  totalUsd: number;
}

/** Fully computed cost payload returned with every runtime result. */
export interface AgentRuntimeCostSummary {
  totalUsd: number;
  byModel: Record<string, AgentRuntimeModelCost>;
  pricing: AgentRuntimeCostTable;
}

/** Runtime wall-clock and provider-call timing. */
export interface AgentRuntimeDurations {
  totalMs: number;
  providerMs: number;
}

/** Normalized result shape consumed by queues, telemetry, adapters, and workflow delivery. */
export interface AgentRuntimeResult {
  sessionId: string;
  finalText: string;
  stopReason: AgentRuntimeStopReason;
  num_turns: number;
  durations: AgentRuntimeDurations;
  usage: AgentRuntimeUsage;
  cost: AgentRuntimeCostSummary;
}

/** Message role persisted in agent_messages.role. */
export type AgentRuntimeMessageRole = "system" | "user" | "assistant" | "tool";

/** Persisted ModelMessage JSON before it is serialized into agent_messages.content. */
export interface AgentRuntimeMessage {
  seq: number;
  role: AgentRuntimeMessageRole;
  content: unknown;
}

export type AgentRuntimeMessageAppend = Omit<AgentRuntimeMessage, "seq">;

/** Session store contract for the in-process runtime. */
export interface AgentRuntimeSessionStore {
  load(sessionId: string): Promise<AgentRuntimeMessage[]>;
  appendTransactional(sessionId: string, messages: readonly AgentRuntimeMessageAppend[]): Promise<void>;
  archive(params: {
    sessionId?: string;
    workspaceKey?: string;
    threadKey?: string;
    runtime: AgentRuntimeKind;
  }): Promise<void>;
}

export interface AgentRuntimeCustomToolProvider {
  createTools(params: RunAgentParams): Promise<ToolSet>;
}

export interface AgentRuntimeMcpToolProvider {
  createTools(params: RunAgentParams): Promise<ToolSet>;
  close?(): Promise<void>;
}

export interface AgentRuntimeSkillsProvider {
  createSkillTool(params: RunAgentParams): Promise<ToolSet>;
}

export interface AgentRuntimeCompactionProvider {
  compact(params: { sessionId: string; messages: readonly AgentRuntimeMessage[] }): Promise<AgentRuntimeMessage[]>;
}

/** Phase 3b/4 additive capability seam; Phase 3a does not install silent placeholder tools. */
export interface AgentRuntimeHarnessExtensions {
  customTools?: AgentRuntimeCustomToolProvider;
  mcpTools?: AgentRuntimeMcpToolProvider;
  skills?: AgentRuntimeSkillsProvider;
  compaction?: AgentRuntimeCompactionProvider;
}

/** Explicit provider construction input resolved from settings/env before the runtime starts. */
export interface AgentRuntimeProviderFactoryConfig {
  provider: AgentRuntimeProviderKind;
  modelId: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  region?: string | null;
  awsAccessKeyId?: string | null;
  awsSecretAccessKey?: string | null;
  awsSessionToken?: string | null;
  vertexProject?: string | null;
  vertexLocation?: string | null;
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  costTable: AgentRuntimeCostTable;
  /** Wall-clock deadline applied to each model HTTP request. Unset falls back to the factory default. */
  modelRequestTimeoutMs?: number;
}

/** The two roots that can satisfy a realpath containment check for workspace-owned tools. */
export type AgentRuntimeAllowedRootKind = "workspace-root" | "org-claude-dir";

export interface AgentRuntimeAllowedRoot {
  kind: AgentRuntimeAllowedRootKind;
  path: string;
  realpath: string;
}

export interface AgentRuntimeWorkspaceToolScopePolicy {
  allowedRoots: {
    workspaceRoot: AgentRuntimeAllowedRoot;
    orgClaudeDir?: AgentRuntimeAllowedRoot | null;
  };
  blockedReadPaths: readonly string[];
  blockImageReads: boolean;
}

export type AgentRuntimeContainmentAllowReason = "inside_workspace_root" | "inside_org_claude_dir";

export type AgentRuntimeContainmentDenyReason =
  | "outside_allowed_roots"
  | "blocked_read_path"
  | "symlink_escape"
  | "invalid_path"
  | "read_requires_visual_analysis";

/**
 * The runtime records the resolved target and the root that authorized it so a
 * later tool implementation cannot accidentally fall back to string-prefix path checks.
 */
export type AgentRuntimeRealpathContainmentDecision =
  | {
      behavior: "allow";
      targetRealpath: string;
      root: AgentRuntimeAllowedRoot;
      reason: AgentRuntimeContainmentAllowReason;
    }
  | {
      behavior: "deny";
      targetRealpath?: string;
      reason: AgentRuntimeContainmentDenyReason;
      message: string;
    };

export interface AgentRuntimeCanvasCliBashCarveout {
  envVarName: "CANVAS_CLI";
  behavior: "allow_without_generic_absolute_path_scan";
  trustDecision: "sketch_brokered_launcher";
}

export interface AgentRuntimeBashScanPolicy {
  scanAbsolutePaths: true;
  scanChainedCommands: true;
  scanSubshellCommands: true;
  allowedRoots: readonly AgentRuntimeAllowedRootKind[];
  blockedReadPaths: readonly string[];
  canvasCliCarveout: AgentRuntimeCanvasCliBashCarveout;
  timeoutMs: number;
  outputLimitBytes: number;
  outputTruncationMarker: string;
  envPassthrough: "current_process_env_plus_agent_env";
}

/**
 * Null preserves the runner default tool set. An explicit array is authoritative:
 * an empty array denies every built-in and MCP tool, and MCP tools must be named
 * explicitly even though the global tool gate recognizes the `mcp__` prefix.
 */
export type AgentRuntimePersonaToolAllowlist =
  | {
      mode: "default";
      tools: null;
      defaultTools: readonly AgentRuntimeScopedToolName[];
      mcpPrefixRule: "prefix_allowed_by_global_gate";
    }
  | {
      mode: "explicit";
      tools: readonly string[];
      emptyListMeans: "deny_all_tools";
      mcpPrefixRule: "exact_tool_name_required";
    };

export interface AgentRuntimeWorkspaceToolSecurityContract {
  tools: readonly AgentRuntimeScopedToolName[];
  scope: AgentRuntimeWorkspaceToolScopePolicy;
  bash: AgentRuntimeBashScanPolicy;
  personaAllowlist: AgentRuntimePersonaToolAllowlist;
}

export type AgentRuntimeSkillScope = "org" | "workspace";

export interface AgentRuntimeSkillDescriptor {
  id: string;
  name: string;
  displayName?: string;
  description: string;
  dir: string;
  skillFilePath: string;
  scope: AgentRuntimeSkillScope;
  frontMatter: Readonly<Record<string, string>>;
  providerType?: string;
  requiresEnv: readonly string[];
  body: string;
}

export interface AgentRuntimeSkillCollision {
  name: string;
  chosen: AgentRuntimeSkillDescriptor & { scope: "workspace" };
  shadowed: AgentRuntimeSkillDescriptor & { scope: "org" };
  rule: "workspace_shadows_org";
}

/**
 * Discovery intentionally diverges from unspecified SDK internals: v1 product
 * semantics are org skills first, then workspace skills, with the workspace copy
 * replacing an org skill of the same name.
 */
export interface AgentRuntimeSkillDiscoveryResult {
  orgSkillsDir: string | null;
  workspaceSkillsDir: string;
  order: readonly ["org", "workspace"];
  collisionRule: "workspace_shadows_org";
  skills: readonly AgentRuntimeSkillDescriptor[];
  collisions: readonly AgentRuntimeSkillCollision[];
}

export interface AgentRuntimeSkillToolInvocationInput {
  skill: string;
}

export interface AgentRuntimeSkillToolInvocationOutput {
  skill: AgentRuntimeSkillDescriptor;
  injectedBody: string;
  grantedFileAccess: {
    dir: string;
    tools: readonly ["Read", "Glob", "Grep", "Bash"];
  };
}

export type AgentRuntimeClaudeMemoryScope = "org" | "workspace";

export interface AgentRuntimeClaudeMemorySource {
  scope: AgentRuntimeClaudeMemoryScope;
  path: string;
  exists: boolean;
  content: string | null;
}

export interface AgentRuntimeClaudeMdLoaderInput {
  orgClaudeDir?: string | null;
  workspaceDir: string;
  order: readonly ["org", "workspace"];
}

export interface AgentRuntimeClaudeMdLoaderOutput {
  order: readonly ["org", "workspace"];
  sources: readonly AgentRuntimeClaudeMemorySource[];
  appendedSystemContext: string;
}

export interface AgentRuntimeCompactionTriggerConfig {
  thresholdFraction: number;
  contextWindowTokens: number;
}

export type AgentRuntimeCompactionTrigger =
  | {
      behavior: "compact";
      estimatedInputTokens: number;
      thresholdTokens: number;
      config: AgentRuntimeCompactionTriggerConfig;
    }
  | {
      behavior: "skip";
      estimatedInputTokens: number;
      thresholdTokens: number;
      config: AgentRuntimeCompactionTriggerConfig;
    };

export interface AgentRuntimeCompactionSummaryMarker {
  marker: "sketch.agent_runtime.compaction_summary";
  version: 1;
  trigger: "auto" | "manual";
}

export type AgentRuntimeCompactionSummaryPayload =
  | {
      behavior: "summary";
      summary: string;
    }
  | {
      behavior: "empty_summary_pi_quirk";
      summary: "";
      testCoverage: "required";
    };

export interface AgentRuntimeToolCallResultPairBoundary {
  toolUseId: string;
  toolCallSeq: number;
  toolResultSeq: number;
  mustKeepTogether: true;
}

/**
 * A keep-recent tail starts at a persisted message boundary that has already
 * been checked against all open tool-call/result pairs.
 */
export interface AgentRuntimeKeepRecentTailBoundary {
  startSeq: number;
  checkedPairs: readonly AgentRuntimeToolCallResultPairBoundary[];
  splitsToolCallResultPair: false;
}

export interface AgentRuntimePersistedCompactionRow {
  id: string;
  session_id: string;
  seq: number;
  role: Extract<AgentRuntimeMessageRole, "system" | "user">;
  content: {
    marker: AgentRuntimeCompactionSummaryMarker;
    summary: AgentRuntimeCompactionSummaryPayload;
  };
  replacedPrefixStartSeq: number;
  replacedPrefixEndSeq: number;
  keepRecentTail: AgentRuntimeKeepRecentTailBoundary;
  created_at: string;
}

export type AgentRuntimeCacheBreakpointTarget = "system_prompt" | "last_message";

export interface AgentRuntimeCacheBreakpointReanchorDirective {
  behavior: "reanchor_after_compaction";
  targets: readonly AgentRuntimeCacheBreakpointTarget[];
  anchorAfterSeq: number;
  reason: "summary_replaces_truncated_prefix";
}

export interface AgentRuntimeCompactionResult {
  trigger: Extract<AgentRuntimeCompactionTrigger, { behavior: "compact" }>;
  persistedSummaryRow: AgentRuntimePersistedCompactionRow;
  cacheBreakpointReanchor: AgentRuntimeCacheBreakpointReanchorDirective;
  keepRecentTail: AgentRuntimeKeepRecentTailBoundary;
}
