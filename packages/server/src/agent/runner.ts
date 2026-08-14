/**
 * Core agent execution — invokes the Claude Agent SDK's query() in a user's
 * isolated workspace with file access restrictions via canUseTool.
 *
 * Skills support: the SDK discovers skills from ~/.claude/skills/ (org-wide via
 * "user" settingSource) and {workspace}/.claude/skills/ (per-user via "project").
 * canUseTool grants read-only file access and Bash execution for ~/.claude paths
 * so skills can be loaded and their companion CLIs executed.
 */
import { resolve } from "node:path";
import { type SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { AGENT_BUILT_IN_TOOL_NAMES, VISUAL_ANALYSIS_AGENT_TOOL_NAME } from "@sketch/shared";
import type {
  AutomationArtifact,
  AutomationRunMode,
  WebChatIntegrationConnectionData,
  WebChatQuestion,
  WebChatQuestionInteraction,
} from "@sketch/shared";
import type { Kysely, Selectable } from "kysely";
import type { ChatAutomationAuthoring } from "../automation/chat-authoring";
import { listIndexedSourcesForPrompt } from "../connectors/search";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import type { DB, UsersTable } from "../db/schema";
import type { Attachment } from "../files";
import { buildMultimodalContent, formatAttachmentsForPrompt, isImageAttachment } from "../files";
import {
  type CliIntegrationCardResolver,
  type IntegrationProgressEventLike,
  collectIntegrationCardsFromProgressEvents,
  projectToolResultForProgressLog,
} from "../integrations/cards";
import type { IntegrationProvider } from "../integrations/types";
import {
  type IntegrationAccessResult,
  cleanupIntegrationAccess,
  startIntegrationAccess,
} from "../integrations/wrapper";
import { heapStats, heapUsedMb } from "../lib/heap";
import type { LocalClaudeSessionService } from "../local-devices/claude-sessions";
import type { LocalDeviceGateway } from "../local-devices/gateway";
import type { Logger } from "../logger";
import type { TaskScheduler } from "../scheduler/service";
import type { CurrentAutomation, TaskContext } from "../scheduler/types";
import type { SlackBot } from "../slack/bot";
import type { TranscriptionSettings } from "../transcription/service";
import { resolveTranscriptionConfig } from "../transcription/service";
import type { VisionConfig } from "../vision/service";
import { resolveVisionConfig } from "../vision/service";
import type { WhatsAppTemplateRequest } from "../whatsapp/templates";
import { AuxCostCollector, type AuxLlmCall, sumAuxCost } from "./aux-cost";
import type { QuestionInteractionCapabilities } from "./interactions/types";
import { createCanUseTool } from "./permissions";
import { type ResponseSurface, buildRuntimeCapabilitiesContext, buildSystemContext } from "./prompt";
import { createDefaultAgentRuntimeCompactionProvider } from "./runtime/compaction";
import type {
  AgentRuntimeHarnessExtensions,
  AgentRuntimeKind,
  AgentRuntimeProviderFactoryConfig,
  AgentRuntimeWorkspaceToolName,
} from "./runtime/contracts";
import { runAgentRuntimeCore } from "./runtime/core";
import {
  createAgentRuntimeCustomToolEffects,
  createDefaultAgentRuntimeCustomToolProvider,
} from "./runtime/custom-tools";
import { createAgentRuntimeSessionId } from "./runtime/ids";
import { createDefaultAgentRuntimeMcpToolProvider } from "./runtime/mcp-tools";
import { buildAgentRuntimeUserContent } from "./runtime/messages";
import { createAgentRuntimeWorkspaceToolScopePolicy } from "./runtime/path-guard";
import { type AgentRuntimeProvider, createAgentRuntimeProvider } from "./runtime/provider";
import { createDbAgentRuntimeSessionStore } from "./runtime/session-store";
import {
  createDefaultAgentRuntimeSkillsProvider,
  loadAgentRuntimeClaudeMdContext,
  prependClaudeMdContext,
} from "./runtime/skills";
import { createAgentRuntimeWorkspaceTools } from "./runtime/workspace-tools";
import {
  archiveSdkSessionId,
  assertSessionIdBelongsToRuntimeWorkspace,
  getSessionId,
  getSessionIdForRuntime,
  isArchivedRuntimeSessionId,
  saveSessionId,
  saveSessionIdForRuntime,
} from "./sessions";
import { createSketchMcpServer } from "./sketch-tools";
import { type AgentOutputWriter, recordRejectedWriteAgentOutputCall } from "./tools/agent-output";
import { ASK_USER_QUESTIONS_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME } from "./tools/questions";
import {
  AutomationArtifactCollector,
  IntegrationConnectionCollector,
  QuestionCollector,
  UploadCollector,
} from "./tools/types";

/**
 * A single tool invocation with timing. `startedAt`/`endedAt` are epoch ms:
 * start comes from canUseTool (falling back to message arrival), end from the
 * next canUseTool call (falling back to run end).
 */
export interface ToolCallRecord {
  toolName: string;
  skillName: string | null;
  startedAt: number;
  endedAt: number;
  success?: boolean;
  errorMessage?: string;
}

interface CanUseToolTiming {
  toolName: string;
  calledAt: number;
}

export interface ToolUseProgressEvent {
  kind: "tool_use";
  toolName: string;
  input: Record<string, unknown>;
}

function isSkillToolName(toolName: string): boolean {
  return toolName === "Skill" || toolName === "mcp__sketch__Skill";
}

function buildAgentChildEnv(
  integrationEnv: Record<string, string>,
  agentEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...integrationEnv, ...agentEnv };
  if (!agentEnv?.GH_TOKEN) env.GH_TOKEN = undefined;
  if (!agentEnv?.LINEAR_API_KEY) env.LINEAR_API_KEY = undefined;
  return env;
}

export function isCreateAutomationSkillName(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "create-automation";
}

export function isCreateAutomationSkillInvocation(toolName: string, input: unknown): boolean {
  if (!isSkillToolName(toolName) || !input || typeof input !== "object" || Array.isArray(input)) return false;
  return isCreateAutomationSkillName((input as { skill?: unknown }).skill);
}

function skillNameFromToolCall(toolName: string, input: Record<string, unknown>): string | null {
  if (!isSkillToolName(toolName) || typeof input.skill !== "string") return null;
  return input.skill;
}

export function recordSdkAgentOutputToolStarts(
  writer: AgentOutputWriter | undefined,
  toolStarts: Array<{ toolName: string; input: Record<string, unknown> }>,
): void {
  for (const toolStart of toolStarts) {
    recordRejectedWriteAgentOutputCall(writer, toolStart.toolName, toolStart.input);
  }
}

export interface IntermediateTextProgressEvent {
  kind: "intermediate_text";
  text: string;
}

export type ProgressEvent = ToolUseProgressEvent | IntermediateTextProgressEvent;

export interface RunTrace {
  progressEvents: ProgressEvent[];
  finalText: string | null;
  automationArtifacts: AutomationArtifact[];
}

export interface SdkToolStartMapping {
  toolUseId: string | null;
  toolName: string;
  skillName: string | null;
  input: Record<string, unknown>;
  startedAt: number;
}

export interface SdkToolEndMapping {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  isError: boolean;
  endedAt: number;
}

export interface SdkResultUsageMapping {
  sessionId: string;
  sdkCostUsd: number;
  durationApiMs: number;
  numTurns: number;
  stopReason: string | null;
  errorSubtype: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
  model: string | null;
}

export interface SdkStreamMessageEffects {
  sessionIds: string[];
  textDeltas: string[];
  progressEvents: ProgressEvent[];
  toolStarts: SdkToolStartMapping[];
  toolEnds: SdkToolEndMapping[];
  resultUsage: SdkResultUsageMapping | null;
}

export interface SdkStreamMappingState {
  sessionId: string;
  sdkCostUsd: number;
  durationApiMs: number;
  numTurns: number;
  stopReason: string | null;
  errorSubtype: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
  model: string | null;
  toolCalls: ToolCallRecord[];
  progressEvents: ProgressEvent[];
  integrationProgressEvents: IntegrationProgressEventLike[];
  currentTextSuffix: string[];
  pendingToolCalls: ToolCallRecord[];
  toolUsesById: Map<string, { toolName: string; input: Record<string, unknown>; toolCall: ToolCallRecord }>;
}

export interface SdkStreamReplayResult {
  sessionIds: string[];
  textDeltas: string[];
  toolStarts: SdkToolStartMapping[];
  toolEnds: SdkToolEndMapping[];
  progressEvents: ProgressEvent[];
  integrationProgressEvents: IntegrationProgressEventLike[];
  finalText: string | null;
  usage: SdkResultUsageMapping | null;
  toolCalls: ToolCallRecord[];
}

/**
 * Business result of an agent run. `costUsd` is the authoritative agent-model
 * USD cost: the runner defaults it to the SDK's own figure
 * (`rawUsage.sdkCostUsd`), and the telemetry boundary overwrites it with the
 * provider-aware repriced value (correct for OpenRouter). `auxCostUsd` is the
 * separate, additive sum of transcription/vision sub-call costs for this run
 * (OpenRouter's own figures); total turn cost is `costUsd + auxCostUsd`.
 */
export interface AgentResult {
  messageSent: boolean;
  sessionId: string;
  costUsd: number;
  auxCostUsd: number;
  pendingUploads: string[];
  pendingIntegrationConnections?: WebChatIntegrationConnectionData[];
  pendingInteraction?: WebChatQuestionInteraction;
  pendingQuestion?: WebChatQuestion;
  trace: RunTrace;
}

/**
 * Raw, un-priced usage facts captured from the SDK message stream and the
 * request params. Consumed by the telemetry boundary (OTel span attributes)
 * and the pricing service. The runner produces these but does not interpret
 * them (no cost decision, no telemetry mapping). `sdkCostUsd` is the SDK's own
 * total_cost_usd, unreliable for non-Anthropic providers.
 */
export interface RawRunUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
  durationApiMs: number;
  numTurns: number;
  stopReason: string | null;
  errorSubtype: string | null;
  isResumedSession: boolean;
  totalAttachments: number;
  imageCount: number;
  nonImageCount: number;
  mimeTypes: string[];
  fileSizes: number[];
  promptMode: "text" | "multimodal";
  toolCalls: ToolCallRecord[];
  auxLlmCalls: AuxLlmCall[];
  sdkCostUsd: number;
}

/** Business result plus the raw usage payload for the telemetry/pricing boundary. */
export type RunAgentResult = AgentResult & { rawUsage: RawRunUsage };

export type { AutomationRunMode };

export interface McpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Inputs to a single agent run. A few fields carry non-obvious behaviour:
 * `sessionMode` controls session persistence ("fresh" skips both resume and
 * save for a fully ephemeral run; "persistent"/"chat"/undefined do the normal
 * get+save); `agentInstructions` is a /team persona's system-prompt append; and
 * `agentAllowedTools`, when set, restricts the exposed and permitted toolset to
 * that persona's allowlist (undefined keeps the runner default).
 */
export interface RunAgentParams {
  db: Kysely<DB>;
  workspaceKey: string;
  userMessage: string;
  workspaceDir: string;
  claudeConfigDir?: string;
  userName: string;
  userEmail?: string | null;
  slackEntitySyncEnabled?: boolean;
  userPhone?: string | null;
  logger: Logger;
  platform: "slack" | "whatsapp";
  responseSurface?: ResponseSurface;
  questionInteractionCapabilities?: QuestionInteractionCapabilities;
  onProgressEvent: (event: ProgressEvent) => Promise<void>;
  onTextDelta?: (delta: string) => Promise<void>;
  onSessionId?: (sessionId: string) => Promise<void>;
  attachments?: Attachment[];
  /**
   * Per-message aggregate cap (bytes) on image attachments embedded inline as
   * base64. Injected from config.MAX_ATTACHMENT_TOTAL_MB in bootstrap; when
   * omitted the content builders fall back to DEFAULT_MAX_ATTACHMENT_TOTAL_BYTES.
   */
  maxAttachmentTotalBytes?: number;
  threadTs?: string;
  resumeSessionId?: string;
  abortController?: AbortController;
  orgName?: string | null;
  orgDescription?: string | null;
  botName?: string | null;
  integrationMcpServers?: Record<string, McpServerConfig>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  model?: string;
  maxTurns?: number;
  sessionMode?: "fresh" | "persistent" | "chat";
  persistSession?: boolean;
  taskContext?: TaskContext;
  currentAutomation?: CurrentAutomation;
  getSlack?: () => SlackBot | null;
  scheduler?: TaskScheduler;
  chatAutomationAuthoring?: ChatAutomationAuthoring;
  automationAuthoringEnabled?: boolean;
  automationBuilderChat?: boolean;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  queueManager?: { getQueue: (key: string) => { enqueue: (fn: () => Promise<void>) => void } };
  activeQueueKey?: string;
  toolConfig?: { BASE_URL?: string; PORT: number };
  geminiConfig?: { maxRpm?: number; maxRetries?: number };
  openRouterApiKey?: string;
  settingsEncryptionKey?: string;
  inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
  userRepo?: {
    list: () => Promise<Selectable<UsersTable>[]>;
    findById: (id: string) => Promise<Selectable<UsersTable> | undefined>;
    getAllEmailsForUser: (id: string) => Promise<string[]>;
  };
  contextType?: "dm" | "channel_mention" | "scheduled_task";
  currentUserId?: string | null;
  localDeviceInvoker?: Pick<LocalDeviceGateway, "invoke">;
  localClaudeSessionService?: LocalClaudeSessionService;
  sendDm?: (params: {
    userId: string;
    platform: string;
    message: string;
    template?: WhatsAppTemplateRequest;
    senderUserId?: string;
    storeInInbox?: boolean;
    inboxKind?: string;
    inboxMetadata?: Record<string, unknown> | null;
  }) => Promise<{
    channelId: string;
    messageRef: string;
    inboxMessageId?: string;
  }>;
  channelContext?: {
    channelName: string;
  };
  groupContext?: {
    groupName: string;
    groupDescription?: string;
  };
  enqueueMessage?: (params: { requesterUserId: string; message: string }) => Promise<void>;
  agentEnv?: Record<string, string>;
  cliIntegrations?: CliIntegrationCardResolver;
  loadTranscriptionSettings?: () => Promise<TranscriptionSettings | null>;
  visionConfig?: VisionConfig | null;
  blockedReadPaths?: string[] | null;
  /**
   * Aux LLM costs incurred before the run (eager transcription of voice-message
   * attachments in the adapters) to fold into this run's aux total, since they
   * happen outside the run's own tool-call collector.
   */
  seedAuxCalls?: AuxLlmCall[];
  agentInstructions?: string | null;
  agentAllowedTools?: string[] | null;
  agentSkillIds?: string[] | null;
  validateAgentSkills?: (
    ownerUserId: string,
    skillIds: string[],
    taskContext?: Pick<TaskContext, "platform" | "contextType" | "deliveryTarget" | "createdBy">,
  ) => Promise<string[]>;
  agentOutputWriter?: AgentOutputWriter;
  conversationRepo?: ReturnType<typeof createConversationRepository>;
  conversationContext?: {
    conversationId: number;
    currentMessageId?: number;
    providerThreadId?: string | null;
    isThreadReply?: boolean;
  };
  agentRuntime?: AgentRuntimeKind;
  stopAfterCreateAutomationSkill?: boolean;
  loadAgentRuntimeProviderConfig?: () => Promise<AgentRuntimeProviderFactoryConfig | null>;
  agentRuntimeProvider?: AgentRuntimeProvider;
  agentRuntimeExtensions?: AgentRuntimeHarnessExtensions;
}

const DEFAULT_RUN_TOOLS: readonly string[] = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill"];
const AGENT_RUNTIME_WORKSPACE_TOOL_NAMES: readonly AgentRuntimeWorkspaceToolName[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
];

function resolveSdkBuiltInTools(agentAllowedTools?: string[] | null): readonly string[] {
  return agentAllowedTools
    ? AGENT_BUILT_IN_TOOL_NAMES.filter((name) => agentAllowedTools.includes(name))
    : DEFAULT_RUN_TOOLS;
}

/**
 * The AI SDK runtime owns only workspace tools directly. WebSearch/WebFetch are intentionally excluded from the
 * aisdk allowlist; web access is delivered through Canvas CLI/MCP rather than native runtime tools.
 */
function resolveAgentRuntimeWorkspaceToolNames(
  agentAllowedTools?: string[] | null,
): readonly AgentRuntimeWorkspaceToolName[] {
  const sdkTools = new Set(resolveSdkBuiltInTools(agentAllowedTools));
  return AGENT_RUNTIME_WORKSPACE_TOOL_NAMES.filter((name) => sdkTools.has(name));
}

export function canUseVisualAnalysisTool(
  visionConfig: VisionConfig | null,
  agentAllowedTools?: string[] | null,
): boolean {
  if (!visionConfig) return false;
  return agentAllowedTools == null || agentAllowedTools.includes(VISUAL_ANALYSIS_AGENT_TOOL_NAME);
}

/**
 * Extracts text content from an SDK assistant message. Returns null if the
 * message isn't an assistant message, has no text blocks, or text is only
 * whitespace. Multiple text blocks (rare) are concatenated with newlines.
 */
export function extractAssistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const msg = message as Record<string, unknown>;
  if (msg.type !== "assistant") return null;

  const inner = msg.message as Record<string, unknown> | undefined;
  const content = inner?.content;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }

  const joined = texts.join("\n");
  return joined.trim() ? joined : null;
}

export function extractAssistantTextDelta(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const msg = message as Record<string, unknown>;
  if (msg.type !== "stream_event") return null;

  const event = msg.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "content_block_delta") return null;

  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") return null;
  return delta.text ? delta.text : null;
}

export function createSdkStreamMappingState(): SdkStreamMappingState {
  return {
    sessionId: "",
    sdkCostUsd: 0,
    durationApiMs: 0,
    numTurns: 0,
    stopReason: null,
    errorSubtype: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: null,
    toolCalls: [],
    progressEvents: [],
    integrationProgressEvents: [],
    currentTextSuffix: [],
    pendingToolCalls: [],
    toolUsesById: new Map(),
  };
}

function emptySdkStreamMessageEffects(): SdkStreamMessageEffects {
  return {
    sessionIds: [],
    textDeltas: [],
    progressEvents: [],
    toolStarts: [],
    toolEnds: [],
    resultUsage: null,
  };
}

export function finishPendingSdkToolCalls(state: SdkStreamMappingState, endedAt: number): void {
  for (const tc of state.pendingToolCalls) {
    tc.endedAt = endedAt;
  }
  state.pendingToolCalls = [];
}

function pushIntermediateText(state: SdkStreamMappingState, effects: SdkStreamMessageEffects, text: string): void {
  const event: IntermediateTextProgressEvent = { kind: "intermediate_text", text };
  state.progressEvents.push(event);
  effects.progressEvents.push(event);
}

function flushSdkIntermediateText(state: SdkStreamMappingState, effects: SdkStreamMessageEffects): void {
  if (state.currentTextSuffix.length === 0) return;
  const text = state.currentTextSuffix.join("\n\n");
  state.currentTextSuffix.length = 0;
  pushIntermediateText(state, effects, text);
}

function stringifyToolErrorContent(content: unknown): string | undefined {
  if (typeof content === "string") return content.slice(0, 500);
  if (content === undefined || content === null) return undefined;

  try {
    return JSON.stringify(content).slice(0, 500);
  } catch {
    return String(content).slice(0, 500);
  }
}

export function extractSdkResultUsage(message: unknown): SdkResultUsageMapping | null {
  if (!message || typeof message !== "object") return null;
  const resultMsg = message as Record<string, unknown>;
  if (resultMsg.type !== "result") return null;

  const usage = resultMsg.usage as Record<string, unknown> | undefined;
  const serverToolUse = usage?.server_tool_use as Record<string, number> | undefined;
  const modelKeys = Object.keys((resultMsg as Record<string, unknown>).modelUsage ?? {});

  return {
    sessionId: typeof resultMsg.session_id === "string" ? resultMsg.session_id : "",
    sdkCostUsd: (resultMsg.total_cost_usd as number) ?? 0,
    durationApiMs: (resultMsg.duration_api_ms as number) ?? 0,
    numTurns: (resultMsg.num_turns as number) ?? 0,
    stopReason: (resultMsg.stop_reason as string) ?? null,
    errorSubtype: resultMsg.subtype !== "success" ? ((resultMsg.subtype as string) ?? null) : null,
    inputTokens: (usage?.input_tokens as number) ?? 0,
    outputTokens: (usage?.output_tokens as number) ?? 0,
    cacheReadTokens: (usage?.cache_read_input_tokens as number) ?? 0,
    cacheCreationTokens: (usage?.cache_creation_input_tokens as number) ?? 0,
    webSearchRequests: serverToolUse?.web_search_requests ?? 0,
    webFetchRequests: serverToolUse?.web_fetch_requests ?? 0,
    model: modelKeys.length > 0 ? modelKeys[0] : null,
  };
}

/**
 * Pure SDK-message mapping shared by the live runner and golden fixture tests.
 * Callback delivery stays outside this function so replay tests can assert the
 * exact event sequence without spawning the Claude Agent SDK.
 */
export function applySdkStreamMessageMapping(
  state: SdkStreamMappingState,
  message: unknown,
  now = Date.now(),
): SdkStreamMessageEffects {
  const effects = emptySdkStreamMessageEffects();
  finishPendingSdkToolCalls(state, now);

  if (!message || typeof message !== "object") return effects;
  const msg = message as Record<string, unknown>;

  if (msg.type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
    state.sessionId = msg.session_id;
    effects.sessionIds.push(msg.session_id);
  }

  const delta = extractAssistantTextDelta(message);
  if (delta) {
    effects.textDeltas.push(delta);
  }

  if (msg.type === "assistant") {
    const inner = msg.message as Record<string, unknown> | undefined;
    const content = inner?.content;
    if (Array.isArray(content)) {
      const hasToolUse = content.some(
        (block) => block && typeof block === "object" && "type" in block && block.type === "tool_use",
      );

      if (hasToolUse) {
        flushSdkIntermediateText(state, effects);
        const inlineText = extractAssistantText(message);
        if (inlineText) {
          pushIntermediateText(state, effects, inlineText);
        }

        for (const block of content) {
          if (!block || typeof block !== "object" || !("type" in block) || block.type !== "tool_use") continue;

          const toolBlock = block as { id?: unknown; name: string; input?: Record<string, unknown> };
          const name = toolBlock.name;
          const input = toolBlock.input ?? {};
          const skillName = skillNameFromToolCall(name, input);
          const toolUseId = typeof toolBlock.id === "string" ? toolBlock.id : null;
          const tc: ToolCallRecord = {
            toolName: name,
            skillName,
            startedAt: now,
            endedAt: 0,
          };
          state.toolCalls.push(tc);
          state.pendingToolCalls.push(tc);

          const event: ToolUseProgressEvent = { kind: "tool_use", toolName: name, input };
          state.integrationProgressEvents.push(event);
          state.progressEvents.push(event);
          effects.progressEvents.push(event);
          effects.toolStarts.push({ toolUseId, toolName: name, skillName, input, startedAt: now });

          if (toolUseId) {
            state.toolUsesById.set(toolUseId, { toolName: name, input, toolCall: tc });
          }
        }
      } else {
        const text = extractAssistantText(message);
        if (text) {
          state.currentTextSuffix.push(text);
        }
      }
    }
  }

  if (msg.type === "user") {
    const inner = msg.message as Record<string, unknown> | undefined;
    const content = inner?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object" || !("type" in block) || block.type !== "tool_result") continue;

        const toolResult = block as { tool_use_id?: unknown; content?: unknown; is_error?: unknown };
        const toolUseId = typeof toolResult.tool_use_id === "string" ? toolResult.tool_use_id : null;
        const toolUse = toolUseId ? state.toolUsesById.get(toolUseId) : null;
        if (!toolUse || !toolUseId) continue;
        toolUse.toolCall.success = toolResult.is_error !== true;
        if (toolResult.is_error === true) {
          toolUse.toolCall.errorMessage = stringifyToolErrorContent(toolResult.content);
        }

        const resultEvent = {
          kind: "tool_result",
          toolName: toolUse.toolName,
          input: toolUse.input,
          output: projectToolResultForProgressLog(toolResult.content),
          isError: toolResult.is_error === true,
        };
        state.integrationProgressEvents.push(resultEvent);
        effects.toolEnds.push({
          toolUseId,
          toolName: toolUse.toolName,
          input: toolUse.input,
          output: toolResult.content,
          isError: toolResult.is_error === true,
          endedAt: now,
        });
      }
    }
  }

  const resultUsage = extractSdkResultUsage(message);
  if (resultUsage) {
    state.sessionId = resultUsage.sessionId;
    state.sdkCostUsd = resultUsage.sdkCostUsd;
    state.durationApiMs = resultUsage.durationApiMs;
    state.numTurns = resultUsage.numTurns;
    state.stopReason = resultUsage.stopReason;
    state.errorSubtype = resultUsage.errorSubtype;
    state.inputTokens = resultUsage.inputTokens;
    state.outputTokens = resultUsage.outputTokens;
    state.cacheReadTokens = resultUsage.cacheReadTokens;
    state.cacheCreationTokens = resultUsage.cacheCreationTokens;
    state.webSearchRequests = resultUsage.webSearchRequests;
    state.webFetchRequests = resultUsage.webFetchRequests;
    state.model = resultUsage.model;
    effects.sessionIds.push(resultUsage.sessionId);
    effects.resultUsage = resultUsage;
  }

  return effects;
}

export function getSdkStreamFinalText(state: SdkStreamMappingState): string | null {
  return state.currentTextSuffix.length > 0 ? state.currentTextSuffix.join("\n\n") : null;
}

export function replaySdkStreamMessages(messages: readonly unknown[]): SdkStreamReplayResult {
  const state = createSdkStreamMappingState();
  const sessionIds: string[] = [];
  const textDeltas: string[] = [];
  const toolStarts: SdkToolStartMapping[] = [];
  const toolEnds: SdkToolEndMapping[] = [];
  let notifiedSessionId = "";
  let usage: SdkResultUsageMapping | null = null;

  messages.forEach((message, index) => {
    const effects = applySdkStreamMessageMapping(state, message, index + 1);
    for (const sessionId of effects.sessionIds) {
      if (!sessionId || sessionId === notifiedSessionId) continue;
      notifiedSessionId = sessionId;
      sessionIds.push(sessionId);
    }
    textDeltas.push(...effects.textDeltas);
    toolStarts.push(...effects.toolStarts);
    toolEnds.push(...effects.toolEnds);
    if (effects.resultUsage) {
      usage = effects.resultUsage;
    }
  });

  finishPendingSdkToolCalls(state, messages.length + 1);

  return {
    sessionIds,
    textDeltas,
    toolStarts,
    toolEnds,
    progressEvents: state.progressEvents,
    integrationProgressEvents: state.integrationProgressEvents,
    finalText: getSdkStreamFinalText(state),
    usage,
    toolCalls: state.toolCalls,
  };
}

async function runAgentWithAiSdk(params: RunAgentParams): Promise<RunAgentResult> {
  const { userMessage, workspaceDir, userName, logger } = params;
  const startHeapMb = heapUsedMb();
  const isFresh = params.sessionMode === "fresh";
  const shouldPersistSession = params.persistSession ?? !isFresh;
  const persistTranscript = shouldPersistSession || Boolean(params.resumeSessionId);
  const absWorkspace = resolve(workspaceDir);
  const requestedResumeSessionId = params.resumeSessionId;
  let sessionId = requestedResumeSessionId;
  let usedExistingSession = sessionId !== undefined;
  let requestedArchivedSession = false;

  if (requestedResumeSessionId) {
    await assertSessionIdBelongsToRuntimeWorkspace(params.db, params.workspaceKey, requestedResumeSessionId, "aisdk");
    if (await isArchivedRuntimeSessionId(params.db, params.workspaceKey, requestedResumeSessionId, "aisdk")) {
      sessionId = undefined;
      usedExistingSession = false;
      requestedArchivedSession = true;
    }
  }

  if (!isFresh && !sessionId && !requestedArchivedSession) {
    sessionId = await getSessionIdForRuntime(params.db, params.workspaceKey, params.threadTs, "aisdk");
    usedExistingSession = sessionId !== undefined;
  }

  if (!sessionId) {
    sessionId = createAgentRuntimeSessionId();
  }

  if (persistTranscript && !requestedArchivedSession) {
    await saveSessionIdForRuntime(params.db, params.workspaceKey, sessionId, params.threadTs, "aisdk");
    /**
     * Re-assert AFTER the save, not only before the run: two workspaces racing the same explicit session id
     * can both pass the pre-run assert before either saves. The post-save check catches the loser so a
     * cross-workspace mapping never survives to mix transcripts.
     */
    if (sessionId === requestedResumeSessionId) {
      await assertSessionIdBelongsToRuntimeWorkspace(params.db, params.workspaceKey, sessionId, "aisdk");
    }
  }

  const indexedSources = await listIndexedSourcesForPrompt(params.db).catch((err) => {
    logger.warn({ err }, "Failed to list indexed sources for prompt");
    return [];
  });
  const transcriptionSettings = params.loadTranscriptionSettings
    ? await params.loadTranscriptionSettings().catch((err) => {
        logger.warn({ err }, "Failed to load transcription settings");
        return null;
      })
    : null;
  const transcriptionConfig = resolveTranscriptionConfig(transcriptionSettings);
  const visionConfig = params.visionConfig ?? resolveVisionConfig(process.env, transcriptionSettings);
  const visualAnalysisAllowed = canUseVisualAnalysisTool(visionConfig, params.agentAllowedTools);
  const attachments = params.attachments ?? [];
  const images = attachments.filter(isImageAttachment);
  const nonImages = attachments.filter((attachment) => !isImageAttachment(attachment));
  const baseSystemAppend = buildSystemContext({
    platform: params.responseSurface ?? params.platform,
    deliveryPlatform: params.responseSurface === "web" && params.taskContext ? params.platform : undefined,
    orgName: params.orgName,
    orgDescription: params.orgDescription,
    botName: params.botName,
    indexedSources,
    agentInstructions: params.agentInstructions,
    visionAnalysisEnabled: visualAnalysisAllowed,
    automationAuthoringEnabled: params.automationAuthoringEnabled,
    automationBuilderChat: params.automationBuilderChat,
  });
  const claudeMdContext = await loadAgentRuntimeClaudeMdContext({
    orgClaudeDir: params.claudeConfigDir,
    workspaceDir: absWorkspace,
    order: ["org", "workspace"],
    logger: params.logger,
  });
  const systemAppend = `${prependClaudeMdContext({
    claudeMdContext: claudeMdContext.appendedSystemContext,
    systemContext: baseSystemAppend,
  })}\n\n${buildRuntimeCapabilitiesContext(params.agentEnv)}`;

  const promptContent =
    images.length > 0 && visionConfig
      ? userMessage + formatAttachmentsForPrompt(attachments, { visionAnalysisEnabled: visualAnalysisAllowed })
      : await buildAgentRuntimeUserContent(userMessage, attachments, params.maxAttachmentTotalBytes);
  const promptMode = Array.isArray(promptContent) ? "multimodal" : "text";

  logger.debug(
    {
      totalAttachments: attachments.length,
      imageCount: images.length,
      nonImageCount: nonImages.length,
      images: images.map((attachment) => ({ name: attachment.originalName, mime: attachment.mimeType })),
      promptMode,
      runtime: "aisdk",
    },
    "Prompt mode selected",
  );

  let provider = params.agentRuntimeProvider;
  if (!provider) {
    const providerConfig = await params.loadAgentRuntimeProviderConfig?.();
    if (!providerConfig) {
      throw new Error("AI SDK agent runtime is enabled but no LLM provider configuration is available");
    }
    provider = createAgentRuntimeProvider({
      ...providerConfig,
      modelId: params.model ?? providerConfig.modelId,
    });
  }
  const blockedReadPaths = new Set<string>();
  if (images.length > 0 && visionConfig && visualAnalysisAllowed) {
    for (const image of images) {
      blockedReadPaths.add(image.localPath);
    }
  }
  if (visualAnalysisAllowed) {
    for (const path of params.blockedReadPaths ?? []) {
      blockedReadPaths.add(path);
    }
  }

  const scope = await createAgentRuntimeWorkspaceToolScopePolicy({
    workspaceRoot: absWorkspace,
    orgClaudeDir: params.claudeConfigDir,
    blockedReadPaths: blockedReadPaths.size > 0 ? Array.from(blockedReadPaths) : undefined,
    blockImageReads: visualAnalysisAllowed,
  });

  let integrationAccess: IntegrationAccessResult = { envVars: {}, runtimePaths: [], cleanup: async () => {} };
  if (params.loadIntegrationProvider && params.claudeConfigDir) {
    integrationAccess = await startIntegrationAccess({
      userEmail: params.userEmail ?? null,
      claudeConfigDir: params.claudeConfigDir,
      workspaceDir,
      loadIntegrationProvider: params.loadIntegrationProvider,
      logger,
    });
    logger.info(
      {
        integrationEnvKeys: Object.keys(integrationAccess.envVars),
        runtimePaths: integrationAccess.runtimePaths,
      },
      "Integration access resolved",
    );
    logger.debug({ userEmail: params.userEmail }, "Integration access resolved (user context)");
  }

  try {
    const workspaceTools = createAgentRuntimeWorkspaceTools({
      scope,
      env: buildAgentChildEnv(integrationAccess.envVars, params.agentEnv),
      toolNames: resolveAgentRuntimeWorkspaceToolNames(params.agentAllowedTools),
      logger,
    });
    const customToolEffects = createAgentRuntimeCustomToolEffects();
    const customToolsProvider =
      params.agentRuntimeExtensions?.customTools ??
      createDefaultAgentRuntimeCustomToolProvider({
        effects: customToolEffects,
        transcriptionEnabled: Boolean(transcriptionConfig),
        visionAnalysisEnabled: visualAnalysisAllowed,
        visionConfig,
      });
    const customTools = await customToolsProvider.createTools(params);
    const questionToolNames = [
      `mcp__sketch__${ASK_USER_QUESTION_TOOL_NAME}`,
      `mcp__sketch__${ASK_USER_QUESTIONS_TOOL_NAME}`,
    ];
    const mcpToolsProvider = params.agentRuntimeExtensions?.mcpTools ?? createDefaultAgentRuntimeMcpToolProvider();
    const mcpTools = await mcpToolsProvider.createTools(params);
    const skillsProvider = params.agentRuntimeExtensions?.skills ?? createDefaultAgentRuntimeSkillsProvider();
    const skillTools = await skillsProvider.createSkillTool(params);
    const tools = { ...workspaceTools, ...customTools, ...mcpTools, ...skillTools };
    const shouldStopAfterCreateAutomationSkill =
      params.stopAfterCreateAutomationSkill ??
      (params.responseSurface === "web" && params.taskContext?.conversationKind !== "builder");
    const baseSessionStore = createDbAgentRuntimeSessionStore(params.db);
    const sessionStore = {
      ...baseSessionStore,
      load: async (id: string) => {
        try {
          return await baseSessionStore.load(id);
        } catch (err) {
          logger.warn({ err, sessionId: id }, "AI SDK runtime session load failed; starting with fresh history");
          return [];
        }
      },
    };
    const currentUserMessage = { role: "user" as const, content: promptContent };
    const compactionProvider =
      params.agentRuntimeExtensions?.compaction ??
      (persistTranscript
        ? createDefaultAgentRuntimeCompactionProvider({
            provider,
            sessionStore,
            systemPrompt: systemAppend,
            currentUserMessage,
            tools,
            abortSignal: params.abortController?.signal,
          })
        : undefined);

    const toolCalls: ToolCallRecord[] = [];
    const progressEvents: ProgressEvent[] = [];
    let trailingText = "";
    let notifiedSessionId = "";

    const notifySessionId = async (nextSessionId: string) => {
      if (!nextSessionId || nextSessionId === notifiedSessionId) return;
      notifiedSessionId = nextSessionId;
      try {
        await params.onSessionId?.(nextSessionId);
      } catch (err) {
        logger.warn({ err }, "Failed to deliver session id notification");
      }
    };

    const flushIntermediateText = async () => {
      if (!trailingText.trim()) return;
      const event: IntermediateTextProgressEvent = { kind: "intermediate_text", text: trailingText };
      progressEvents.push(event);
      trailingText = "";
      try {
        await params.onProgressEvent(event);
      } catch (err) {
        logger.warn({ err }, "Failed to deliver agent progress event");
      }
    };

    const runtimeResult = await (async () => {
      try {
        return await runAgentRuntimeCore({
          provider,
          prompt: promptContent,
          systemPrompt: systemAppend,
          tools,
          maxTurns: params.maxTurns ?? 100,
          stopAfterToolNames: questionToolNames.filter((name) => customTools[name]),
          stopAfterToolCall: shouldStopAfterCreateAutomationSkill
            ? ({ name, input }) => isCreateAutomationSkillInvocation(name, input)
            : undefined,
          persistSession: persistTranscript,
          sessionId,
          sessionStore,
          compaction: compactionProvider,
          abortSignal: params.abortController?.signal,
          logger,
          events: {
            onSessionId: async (nextSessionId) => {
              sessionId = nextSessionId;
              await notifySessionId(nextSessionId);
            },
            onTextDelta: async (delta) => {
              trailingText += delta;
              if (params.onTextDelta) {
                try {
                  await params.onTextDelta(delta);
                } catch (err) {
                  logger.warn({ err }, "Failed to deliver assistant text delta");
                }
              }
            },
            onToolStart: async (event) => {
              customToolEffects.onToolStart(event);
              await flushIntermediateText();
              const startedAt = Date.now();
              const toolCall: ToolCallRecord = {
                toolName: event.name,
                skillName: skillNameFromToolCall(event.name, event.input),
                startedAt,
                endedAt: 0,
              };
              toolCalls.push(toolCall);
              const progressEvent: ToolUseProgressEvent = {
                kind: "tool_use",
                toolName: event.name,
                input: event.input,
              };
              progressEvents.push(progressEvent);
              try {
                await params.onProgressEvent(progressEvent);
              } catch (err) {
                logger.warn({ err }, "Failed to deliver agent progress event");
              }
            },
            onToolEnd: async (event) => {
              customToolEffects.onToolEnd(event);
              for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
                const toolCall = toolCalls[index];
                if (toolCall.toolName !== event.name || toolCall.endedAt !== 0) continue;
                toolCall.endedAt = Date.now();
                toolCall.success = event.error === undefined;
                if (event.error) toolCall.errorMessage = event.error.message;
                break;
              }
            },
          },
        });
      } finally {
        try {
          await mcpToolsProvider.close?.();
        } catch (err) {
          logger.warn({ err }, "Failed to close integration MCP tools");
        }
      }
    })();

    for (const toolCall of toolCalls) {
      if (toolCall.endedAt === 0) toolCall.endedAt = Date.now();
    }

    const finalText = trailingText.trim() ? trailingText : null;
    try {
      await customToolEffects.collectIntegrationCards(params);
    } catch (err) {
      logger.warn({ err }, "Failed to resolve integration cards from agent progress");
    }
    const drainedToolEffects = customToolEffects.drain(params);
    const auxLlmCalls = [...(params.seedAuxCalls ?? []), ...drainedToolEffects.auxLlmCalls];
    const auxCostUsd = sumAuxCost(auxLlmCalls);
    const firstModel = Object.keys(runtimeResult.usage.byModel)[0] ?? provider.modelId;

    logger.info(
      {
        userId: userName,
        sessionId,
        sdkCostUsd: runtimeResult.cost.totalUsd,
        auxCostUsd,
        pendingUploads: drainedToolEffects.pendingUploads.length,
        pendingIntegrationConnections: drainedToolEffects.pendingIntegrationConnections.length,
        automationArtifacts: drainedToolEffects.automationArtifacts.length,
        pendingQuestion: drainedToolEffects.pendingInteraction !== null,
        runtime: "aisdk",
        ...heapStats(startHeapMb),
      },
      "Agent run completed",
    );

    return {
      messageSent:
        finalText !== null ||
        drainedToolEffects.pendingIntegrationConnections.length > 0 ||
        drainedToolEffects.automationArtifacts.length > 0 ||
        drainedToolEffects.pendingInteraction !== null,
      sessionId,
      costUsd: runtimeResult.cost.totalUsd,
      auxCostUsd,
      pendingUploads: drainedToolEffects.pendingUploads,
      pendingIntegrationConnections: drainedToolEffects.pendingIntegrationConnections,
      ...(drainedToolEffects.pendingInteraction ? { pendingInteraction: drainedToolEffects.pendingInteraction } : {}),
      ...(drainedToolEffects.pendingQuestion ? { pendingQuestion: drainedToolEffects.pendingQuestion } : {}),
      trace: {
        progressEvents,
        finalText,
        automationArtifacts: drainedToolEffects.automationArtifacts,
      },
      rawUsage: {
        model: firstModel,
        inputTokens: runtimeResult.usage.totalInputTokens,
        outputTokens: runtimeResult.usage.totalOutputTokens,
        cacheReadTokens: runtimeResult.usage.totalCacheReadTokens,
        cacheCreationTokens: runtimeResult.usage.totalCacheWriteTokens,
        webSearchRequests: 0,
        webFetchRequests: 0,
        durationApiMs: runtimeResult.durations.providerMs,
        numTurns: runtimeResult.num_turns,
        stopReason: runtimeResult.stopReason,
        errorSubtype: runtimeResult.stopReason === "error" ? "runtime_error" : null,
        isResumedSession: usedExistingSession,
        totalAttachments: attachments.length,
        imageCount: images.length,
        nonImageCount: nonImages.length,
        mimeTypes: attachments.map((attachment) => attachment.mimeType),
        fileSizes: attachments.map((attachment) => attachment.sizeBytes),
        promptMode,
        toolCalls,
        auxLlmCalls,
        sdkCostUsd: runtimeResult.cost.totalUsd,
      },
    };
  } finally {
    await cleanupIntegrationAccess(integrationAccess);
  }
}

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  if (params.agentRuntime === "aisdk") {
    return runAgentWithAiSdk(params);
  }

  return runAgentWithClaudeSdk(params);
}

async function runAgentWithClaudeSdk(params: RunAgentParams): Promise<RunAgentResult> {
  const { userMessage, workspaceDir, userName, logger } = params;
  const startHeapMb = heapUsedMb();
  const isFresh = params.sessionMode === "fresh";
  const shouldPersistSession = params.persistSession ?? !isFresh;
  let shouldArchiveStoredSessionOnResumeFailure = false;
  let existingSessionId: string | undefined;
  if (!isFresh) {
    if (params.resumeSessionId) {
      existingSessionId = params.resumeSessionId;
    } else {
      existingSessionId = await getSessionId(params.db, params.workspaceKey, params.threadTs);
      shouldArchiveStoredSessionOnResumeFailure = existingSessionId !== undefined;
    }
  }
  const absWorkspace = resolve(workspaceDir);

  const indexedSources = await listIndexedSourcesForPrompt(params.db).catch((err) => {
    logger.warn({ err }, "Failed to list indexed sources for prompt");
    return [];
  });

  const transcriptionSettings = params.loadTranscriptionSettings
    ? await params.loadTranscriptionSettings().catch((err) => {
        logger.warn({ err }, "Failed to load transcription settings");
        return null;
      })
    : null;
  const transcriptionConfig = resolveTranscriptionConfig(transcriptionSettings);
  const visionConfig = params.visionConfig ?? resolveVisionConfig(process.env, transcriptionSettings);
  const visualAnalysisAllowed = canUseVisualAnalysisTool(visionConfig, params.agentAllowedTools);

  const systemAppend = `${buildSystemContext({
    platform: params.responseSurface ?? params.platform,
    deliveryPlatform: params.responseSurface === "web" && params.taskContext ? params.platform : undefined,
    orgName: params.orgName,
    orgDescription: params.orgDescription,
    botName: params.botName,
    indexedSources,
    agentInstructions: params.agentInstructions,
    visionAnalysisEnabled: visualAnalysisAllowed,
    automationAuthoringEnabled: params.automationAuthoringEnabled,
    automationBuilderChat: params.automationBuilderChat,
  })}\n\n${buildRuntimeCapabilitiesContext(params.agentEnv)}`;

  const sdkBuiltInTools = resolveSdkBuiltInTools(params.agentAllowedTools);

  const sdkStreamState = createSdkStreamMappingState();
  let sessionId = "";
  const toolCalls = sdkStreamState.toolCalls;
  const progressEvents = sdkStreamState.progressEvents;
  const currentTextSuffix = sdkStreamState.currentTextSuffix;
  let notifiedSessionId = "";

  const attachments = params.attachments ?? [];
  const hasImages = attachments.some((a) => isImageAttachment(a));
  const useVisionToolForImages = hasImages && Boolean(visionConfig);
  let usedExistingSession = existingSessionId !== undefined;

  let prompt: string | AsyncIterable<SDKUserMessage>;

  const { images, nonImages } = hasImages
    ? { images: attachments.filter(isImageAttachment), nonImages: attachments.filter((a) => !isImageAttachment(a)) }
    : { images: [], nonImages: attachments };
  logger.debug(
    {
      totalAttachments: attachments.length,
      imageCount: images.length,
      nonImageCount: nonImages.length,
      images: images.map((a) => ({ name: a.originalName, mime: a.mimeType })),
      promptMode: hasImages && !useVisionToolForImages ? "multimodal" : "text",
    },
    "Prompt mode selected",
  );

  if (hasImages && !useVisionToolForImages) {
    const content = await buildMultimodalContent(userMessage, attachments, params.maxAttachmentTotalBytes);
    prompt = (async function* () {
      yield {
        type: "user" as const,
        session_id: "",
        message: { role: "user" as const, content },
        parent_tool_use_id: null,
      };
    })();
  } else {
    prompt = userMessage + formatAttachmentsForPrompt(attachments, { visionAnalysisEnabled: visualAnalysisAllowed });
  }

  const uploadCollector = new UploadCollector();
  const integrationConnectionCollector = new IntegrationConnectionCollector();
  const automationArtifactCollector = new AutomationArtifactCollector();
  const questionCollector = new QuestionCollector();
  const shouldStopAfterCreateAutomationSkill =
    params.stopAfterCreateAutomationSkill ??
    (params.responseSurface === "web" && params.taskContext?.conversationKind !== "builder");
  const auxCostCollector = new AuxCostCollector();
  const sketchServer = createSketchMcpServer({
    uploadCollector,
    integrationConnectionCollector,
    automationArtifactCollector,
    questionCollector,
    responseSurface: params.responseSurface ?? params.platform,
    questionInteractionCapabilities: params.questionInteractionCapabilities,
    auxCostCollector,
    workspaceDir: absWorkspace,
    db: params.db,
    getSlack: params.getSlack,
    loadIntegrationProvider: params.loadIntegrationProvider,
    validateAgentSkills: params.validateAgentSkills,
    taskContext: params.taskContext,
    currentAutomation: params.currentAutomation ?? params.taskContext?.currentAutomation,
    scheduler: params.scheduler,
    chatAuthoring: params.chatAutomationAuthoring,
    stepContentRepo: params.stepContentRepo,
    automationRunsRepo: params.automationRunsRepo,
    queueManager: params.queueManager,
    activeQueueKey: params.activeQueueKey,
    toolConfig: params.toolConfig,
    geminiConfig: params.geminiConfig,
    openRouterApiKey: params.openRouterApiKey,
    settingsEncryptionKey: params.settingsEncryptionKey,
    inboxMessagesRepo: params.inboxMessagesRepo,
    userRepo: params.userRepo,
    currentUserId: params.currentUserId ?? undefined,
    currentUserEmail: params.userEmail ?? null,
    currentUserName: params.userName,
    slackEntitySyncEnabled: params.slackEntitySyncEnabled,
    localDeviceInvoker: params.localDeviceInvoker,
    localClaudeSessionService: params.localClaudeSessionService,
    workspaceKey: params.workspaceKey,
    originThreadTs: params.threadTs,
    sendDm: params.sendDm,
    enqueueMessage: params.enqueueMessage,
    loadTranscriptionSettings: params.loadTranscriptionSettings,
    transcriptionEnabled: Boolean(transcriptionConfig),
    visionConfig,
    visionAnalysisEnabled: visualAnalysisAllowed,
    logger,
    conversationRepo: params.conversationRepo,
    conversationContext: params.conversationContext,
    agentInstructions: params.agentInstructions,
    agentAllowedTools: params.agentAllowedTools,
    agentOutputWriter: params.agentOutputWriter,
    originOrgContextEnabled: params.claudeConfigDir !== undefined,
  });

  const blockedReadPaths = new Set<string>();
  if (useVisionToolForImages && visualAnalysisAllowed) {
    for (const image of images) {
      blockedReadPaths.add(image.localPath);
    }
  }
  if (visualAnalysisAllowed) {
    for (const path of params.blockedReadPaths ?? []) {
      blockedReadPaths.add(path);
    }
  }

  const baseCanUseTool = createCanUseTool(absWorkspace, logger, params.claudeConfigDir, {
    agentAllowedTools: params.agentAllowedTools,
    agentEnv: params.agentEnv,
    blockedReadPaths: blockedReadPaths.size > 0 ? Array.from(blockedReadPaths) : undefined,
    blockImageReads: visualAnalysisAllowed,
  });
  const canUseToolTimings: CanUseToolTiming[] = [];
  const timedCanUseTool = async (toolName: string, input: Record<string, unknown>) => {
    canUseToolTimings.push({ toolName, calledAt: Date.now() });
    return baseCanUseTool(toolName, input);
  };

  // Start per-run brokered access for skill-mode integrations.
  // The agent sees only harmless launcher paths and broker metadata; the
  // credential env vars stay inside the trusted broker and are injected only
  // into the real CLI child process.
  let integrationAccess: IntegrationAccessResult = { envVars: {}, runtimePaths: [], cleanup: async () => {} };
  if (params.loadIntegrationProvider && params.claudeConfigDir) {
    integrationAccess = await startIntegrationAccess({
      userEmail: params.userEmail ?? null,
      claudeConfigDir: params.claudeConfigDir,
      workspaceDir,
      loadIntegrationProvider: params.loadIntegrationProvider,
      logger,
    });
    logger.info(
      {
        integrationEnvKeys: Object.keys(integrationAccess.envVars),
        runtimePaths: integrationAccess.runtimePaths,
      },
      "Integration access resolved",
    );
    logger.debug({ userEmail: params.userEmail }, "Integration access resolved (user context)");
  }

  /**
   * Runs a single SDK query() pass and processes its message stream. When the
   * caller skips the org config dir (e.g. the WhatsApp fallback agent for
   * external users), the SDK is pointed at the workspace itself so it does not
   * inherit the org's CLAUDE.md.
   */
  const executeSdkRun = async (resumeSessionId: string | undefined) => {
    const notifySessionId = async (nextSessionId: string) => {
      if (!nextSessionId || nextSessionId === notifiedSessionId) return;
      notifiedSessionId = nextSessionId;
      try {
        await params.onSessionId?.(nextSessionId);
      } catch (err) {
        logger.warn({ err }, "Failed to deliver session id notification");
      }
    };

    const run = query({
      prompt,
      options: {
        maxTurns: params.maxTurns ?? 100,
        ...(params.model ? { model: params.model } : {}),
        cwd: workspaceDir,
        resume: resumeSessionId,
        env: {
          ...process.env,
          ...(params.claudeConfigDir === undefined ? { CLAUDE_CONFIG_DIR: workspaceDir } : {}),
          ...buildAgentChildEnv(integrationAccess.envVars, params.agentEnv),
        },
        systemPrompt: systemAppend,
        abortController: params.abortController,
        includePartialMessages: Boolean(params.onTextDelta),
        tools: sdkBuiltInTools as string[],
        permissionMode: "default" as const,
        allowDangerouslySkipPermissions: false,
        settingSources: ["project", "user"],
        mcpServers: { sketch: sketchServer, ...params.integrationMcpServers },
        stderr: (data) => {
          logger.debug({ stderr: data.trim() }, "Agent subprocess");
        },
        canUseTool: timedCanUseTool,
      },
    });

    for await (const message of run) {
      const effects = applySdkStreamMessageMapping(sdkStreamState, message, Date.now());
      recordSdkAgentOutputToolStarts(params.agentOutputWriter, effects.toolStarts);

      for (const nextSessionId of effects.sessionIds) {
        sessionId = nextSessionId;
        await notifySessionId(nextSessionId);
      }

      if (params.onTextDelta) {
        for (const delta of effects.textDeltas) {
          try {
            await params.onTextDelta(delta);
          } catch (err) {
            logger.warn({ err }, "Failed to deliver assistant text delta");
          }
        }
      }

      for (const event of effects.progressEvents) {
        try {
          await params.onProgressEvent(event);
        } catch (err) {
          logger.warn({ err }, "Failed to deliver agent progress event");
        }
      }

      const completedCreateAutomationSkill =
        shouldStopAfterCreateAutomationSkill &&
        effects.toolEnds.some(
          (toolEnd) => !toolEnd.isError && isCreateAutomationSkillInvocation(toolEnd.toolName, toolEnd.input),
        );
      if (completedCreateAutomationSkill || questionCollector.hasPending()) break;
    }
  };

  try {
    let resumeSessionId = existingSessionId;
    let retriedFreshAfterResumeFailure = false;
    while (true) {
      try {
        await executeSdkRun(resumeSessionId);
        break;
      } catch (err) {
        if (
          !resumeSessionId ||
          retriedFreshAfterResumeFailure ||
          toolCalls.length > 0 ||
          progressEvents.length > 0 ||
          currentTextSuffix.length > 0 ||
          typeof prompt !== "string" ||
          !isRecoverableResumeFailure(err)
        ) {
          throw err;
        }

        logger.warn(
          { err, workspaceKey: params.workspaceKey, threadKey: params.threadTs },
          "Agent resumed session failed before producing output; retrying with a fresh session",
        );
        if (shouldArchiveStoredSessionOnResumeFailure) {
          await archiveSdkSessionId(params.db, params.workspaceKey, params.threadTs);
          shouldArchiveStoredSessionOnResumeFailure = false;
        }
        resumeSessionId = undefined;
        usedExistingSession = false;
        sessionId = "";
        sdkStreamState.sessionId = "";
        retriedFreshAfterResumeFailure = true;
      }
    }

    if (sessionId && shouldPersistSession) {
      await saveSessionId(params.db, params.workspaceKey, sessionId, params.threadTs);
    }
  } finally {
    finishPendingSdkToolCalls(sdkStreamState, Date.now());
    await cleanupIntegrationAccess(integrationAccess);
  }

  // Merge canUseTool timing: override only startedAt with canUseTool's calledAt
  // (accurate tool execution start). Keep message-arrival endedAt — it captures when
  // the next message was yielded after tool execution, which is tighter than
  // next-canUseTool or run-end timing (those include Claude's thinking time).
  let timingIdx = 0;
  for (const tc of toolCalls) {
    if (timingIdx < canUseToolTimings.length && canUseToolTimings[timingIdx].toolName === tc.toolName) {
      tc.startedAt = canUseToolTimings[timingIdx].calledAt;
      timingIdx++;
    }
  }

  if (params.contextType !== "scheduled_task") {
    try {
      await collectIntegrationCardsFromProgressEvents({
        events: sdkStreamState.integrationProgressEvents,
        loadIntegrationProvider: params.loadIntegrationProvider,
        cliIntegrations: params.cliIntegrations,
        currentUserId: params.currentUserId,
        runtimeContext:
          params.taskContext?.contextType === "channel" && params.platform === "slack"
            ? { platform: "slack", deliveryTarget: params.taskContext.deliveryTarget }
            : params.taskContext?.contextType === "group" && params.platform === "whatsapp"
              ? { platform: "whatsapp", deliveryTarget: params.taskContext.deliveryTarget }
              : undefined,
        collector: integrationConnectionCollector,
        userEmail: params.userEmail ?? null,
        userName: params.userName,
      });
    } catch (err) {
      logger.warn({ err }, "Failed to resolve integration cards from agent progress");
    }
  }

  const pendingUploads = uploadCollector.drain();
  const drainedIntegrationConnections = integrationConnectionCollector.drain();
  const responseSurface = params.responseSurface ?? params.platform;
  const pendingIntegrationConnections =
    responseSurface === "web"
      ? drainedIntegrationConnections
      : drainedIntegrationConnections.filter((card) => (card.state ?? "connect") === "connect");
  const automationArtifacts = automationArtifactCollector.drain();
  const pendingInteraction = questionCollector.drain();
  const pendingQuestion = pendingInteraction && !("batchId" in pendingInteraction) ? pendingInteraction : null;
  const auxLlmCalls = [...(params.seedAuxCalls ?? []), ...auxCostCollector.drain()];
  const auxCostUsd = sumAuxCost(auxLlmCalls);
  logger.info(
    {
      userId: userName,
      sessionId,
      sdkCostUsd: sdkStreamState.sdkCostUsd,
      auxCostUsd,
      pendingUploads: pendingUploads.length,
      pendingIntegrationConnections: pendingIntegrationConnections.length,
      automationArtifacts: automationArtifacts.length,
      pendingQuestion: pendingQuestion !== null,
      ...heapStats(startHeapMb),
    },
    "Agent run completed",
  );
  const finalText = getSdkStreamFinalText(sdkStreamState);

  return {
    messageSent:
      finalText !== null ||
      pendingIntegrationConnections.length > 0 ||
      automationArtifacts.length > 0 ||
      pendingInteraction !== null,
    sessionId,
    costUsd: sdkStreamState.sdkCostUsd,
    auxCostUsd,
    pendingUploads,
    pendingIntegrationConnections,
    ...(pendingInteraction && { pendingInteraction }),
    ...(pendingQuestion && { pendingQuestion }),
    trace: {
      progressEvents,
      finalText,
      automationArtifacts,
    },
    rawUsage: {
      model: sdkStreamState.model,
      inputTokens: sdkStreamState.inputTokens,
      outputTokens: sdkStreamState.outputTokens,
      cacheReadTokens: sdkStreamState.cacheReadTokens,
      cacheCreationTokens: sdkStreamState.cacheCreationTokens,
      webSearchRequests: sdkStreamState.webSearchRequests,
      webFetchRequests: sdkStreamState.webFetchRequests,
      durationApiMs: sdkStreamState.durationApiMs,
      numTurns: sdkStreamState.numTurns,
      stopReason: sdkStreamState.stopReason,
      errorSubtype: sdkStreamState.errorSubtype,
      isResumedSession: usedExistingSession,
      totalAttachments: attachments.length,
      imageCount: images.length,
      nonImageCount: nonImages.length,
      mimeTypes: attachments.map((a) => a.mimeType),
      fileSizes: attachments.map((a) => a.sizeBytes),
      promptMode: hasImages && !useVisionToolForImages ? "multimodal" : "text",
      toolCalls,
      auxLlmCalls,
      sdkCostUsd: sdkStreamState.sdkCostUsd,
    },
  };
}

function isRecoverableResumeFailure(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Claude Code process exited with code");
}
