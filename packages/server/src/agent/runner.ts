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
import type { Kysely, Selectable } from "kysely";
import { listIndexedSourcesForPrompt } from "../connectors/search";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import type { DB, UsersTable } from "../db/schema";
import type { Attachment } from "../files";
import { buildMultimodalContent, formatAttachmentsForPrompt, isImageAttachment } from "../files";
import type { IntegrationProvider } from "../integrations/types";
import {
  type IntegrationAccessResult,
  cleanupIntegrationAccess,
  startIntegrationAccess,
} from "../integrations/wrapper";
import type { LocalClaudeSessionService } from "../local-devices/claude-sessions";
import type { LocalDeviceGateway } from "../local-devices/gateway";
import type { Logger } from "../logger";
import type { TaskScheduler } from "../scheduler/service";
import type { TaskContext } from "../scheduler/types";
import type { SlackBot } from "../slack/bot";
import type { TranscriptionSettings } from "../transcription/service";
import { resolveTranscriptionConfig } from "../transcription/service";
import type { VisionConfig } from "../vision/service";
import { resolveVisionConfig } from "../vision/service";
import { createCanUseTool } from "./permissions";
import { type ResponseSurface, buildSystemContext } from "./prompt";
import { deleteSessionId, getSessionId, saveSessionId } from "./sessions";
import { UploadCollector, createSketchMcpServer } from "./sketch-tools";

export interface ToolCallRecord {
  toolName: string;
  skillName: string | null;
  /** Epoch ms when tool execution started (from canUseTool, or message arrival fallback) */
  startedAt: number;
  /** Epoch ms when tool execution ended (next canUseTool call, or run end) */
  endedAt: number;
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

export interface IntermediateTextProgressEvent {
  kind: "intermediate_text";
  text: string;
}

export type ProgressEvent = ToolUseProgressEvent | IntermediateTextProgressEvent;

export interface RunTrace {
  progressEvents: ProgressEvent[];
  finalText: string | null;
}

export interface AgentResult {
  messageSent: boolean;
  sessionId: string;
  costUsd: number;
  pendingUploads: string[];
  durationMs: number;
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
  isResumedSession: boolean;
  totalAttachments: number;
  imageCount: number;
  nonImageCount: number;
  mimeTypes: string[];
  fileSizes: number[];
  promptMode: "text" | "multimodal";
  toolCalls: ToolCallRecord[];
  trace: RunTrace;
}

export interface McpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface RunAgentParams {
  db: Kysely<DB>;
  workspaceKey: string;
  userMessage: string;
  workspaceDir: string;
  claudeConfigDir?: string;
  userName: string;
  userEmail?: string | null;
  userPhone?: string | null;
  logger: Logger;
  platform: "slack" | "whatsapp";
  responseSurface?: ResponseSurface;
  onProgressEvent: (event: ProgressEvent) => Promise<void>;
  onSessionId?: (sessionId: string) => Promise<void>;
  attachments?: Attachment[];
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
  /**
   * Controls session behaviour for scheduled tasks.
   * - "fresh": skip session resume and skip session save (fully ephemeral run)
   * - "persistent" or "chat": normal get+save behaviour (same as undefined)
   * When omitted, behaves exactly as before (always get + save).
   */
  sessionMode?: "fresh" | "persistent" | "chat";
  persistSession?: boolean;
  taskContext?: TaskContext;
  getSlack?: () => SlackBot | null;
  scheduler?: TaskScheduler;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  queueManager?: { getQueue: (key: string) => { enqueue: (fn: () => Promise<void>) => void } };
  activeQueueKey?: string;
  toolConfig?: { BASE_URL?: string; PORT: number };
  geminiConfig?: { maxRpm?: number; maxRetries?: number };
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
  sendDm?: (params: { userId: string; platform: string; message: string }) => Promise<{
    channelId: string;
    messageRef: string;
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
  loadTranscriptionSettings?: () => Promise<TranscriptionSettings | null>;
  visionConfig?: VisionConfig | null;
  blockedReadPaths?: string[] | null;
  /**
   * Free-form instruction set for an agent persona, appended to the system
   * prompt. Set when the run is associated with a /team agent (channel-bound,
   * group-bound, or fallback). Null/undefined for runs that are not under an
   * agent persona.
   */
  agentInstructions?: string | null;
  /**
   * Canonical tool-name allowlist for an agent persona. When provided, only
   * tools in this list are exposed to the SDK and permitted by canUseTool.
   * Null/undefined preserves the runner's default toolset.
   */
  agentAllowedTools?: string[] | null;
  conversationRepo?: ReturnType<typeof createConversationRepository>;
  conversationContext?: {
    conversationId: number;
    currentMessageId?: number;
    providerThreadId?: string | null;
  };
}

const DEFAULT_RUN_TOOLS: readonly string[] = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill"];

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

export async function runAgent(params: RunAgentParams): Promise<AgentResult> {
  const { userMessage, workspaceDir, userName, logger } = params;
  const isFresh = params.sessionMode === "fresh";
  const shouldPersistSession = params.persistSession ?? !isFresh;
  let shouldDeleteStoredSessionOnResumeFailure = false;
  let existingSessionId: string | undefined;
  if (!isFresh) {
    if (params.resumeSessionId) {
      existingSessionId = params.resumeSessionId;
    } else {
      existingSessionId = await getSessionId(params.db, params.workspaceKey, params.threadTs);
      shouldDeleteStoredSessionOnResumeFailure = existingSessionId !== undefined;
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

  const systemAppend = buildSystemContext({
    platform: params.responseSurface ?? params.platform,
    deliveryPlatform: params.responseSurface === "web" && params.taskContext ? params.platform : undefined,
    orgName: params.orgName,
    orgDescription: params.orgDescription,
    botName: params.botName,
    indexedSources,
    agentInstructions: params.agentInstructions,
    visionAnalysisEnabled: visualAnalysisAllowed,
  });

  const sdkBuiltInTools = params.agentAllowedTools
    ? AGENT_BUILT_IN_TOOL_NAMES.filter((name) => params.agentAllowedTools?.includes(name))
    : DEFAULT_RUN_TOOLS;

  let sessionId = "";
  let costUsd = 0;
  let durationMs = 0;
  let durationApiMs = 0;
  let numTurns = 0;
  let stopReason: string | null = null;
  let errorSubtype: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let webSearchRequests = 0;
  let webFetchRequests = 0;
  let model: string | null = null;
  const toolCalls: ToolCallRecord[] = [];
  const progressEvents: ProgressEvent[] = [];
  const currentTextSuffix: string[] = [];
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
    const content = await buildMultimodalContent(userMessage, attachments);
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
  const sketchServer = createSketchMcpServer({
    uploadCollector,
    workspaceDir: absWorkspace,
    db: params.db,
    getSlack: params.getSlack,
    loadIntegrationProvider: params.loadIntegrationProvider,
    taskContext: params.taskContext,
    scheduler: params.scheduler,
    stepContentRepo: params.stepContentRepo,
    automationRunsRepo: params.automationRunsRepo,
    queueManager: params.queueManager,
    activeQueueKey: params.activeQueueKey,
    toolConfig: params.toolConfig,
    geminiConfig: params.geminiConfig,
    inboxMessagesRepo: params.inboxMessagesRepo,
    userRepo: params.userRepo,
    currentUserId: params.currentUserId ?? undefined,
    localDeviceInvoker: params.localDeviceInvoker,
    localClaudeSessionService: params.localClaudeSessionService,
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
    blockedReadPaths: blockedReadPaths.size > 0 ? Array.from(blockedReadPaths) : undefined,
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

  let pendingToolCalls: ToolCallRecord[] = [];

  const flushIntermediateText = async () => {
    if (currentTextSuffix.length === 0) return;
    const text = currentTextSuffix.join("\n\n");
    currentTextSuffix.length = 0;
    const event: IntermediateTextProgressEvent = { kind: "intermediate_text", text };
    progressEvents.push(event);
    try {
      await params.onProgressEvent(event);
    } catch (err) {
      logger.warn({ err }, "Failed to deliver intermediate progress text");
    }
  };

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
          // When the caller intentionally skips the org config dir (e.g. the
          // WhatsApp fallback agent for external users), point the SDK at the
          // workspace itself so it does not pick up the org's CLAUDE.md.
          ...(params.claudeConfigDir === undefined ? { CLAUDE_CONFIG_DIR: workspaceDir } : {}),
          ...integrationAccess.envVars,
          ...params.agentEnv,
        },
        systemPrompt: systemAppend,
        abortController: params.abortController,
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
      const now = Date.now();
      for (const tc of pendingToolCalls) {
        tc.endedAt = now;
      }
      pendingToolCalls = [];

      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        await notifySessionId(sessionId);
      }

      if (message.type === "assistant") {
        const inner = (message as Record<string, unknown>).message as Record<string, unknown> | undefined;
        const content = inner?.content;
        if (Array.isArray(content)) {
          const hasToolUse = content.some(
            (block) => block && typeof block === "object" && "type" in block && block.type === "tool_use",
          );

          if (hasToolUse) {
            await flushIntermediateText();
            const inlineText = extractAssistantText(message);
            if (inlineText) {
              const textEvent: IntermediateTextProgressEvent = { kind: "intermediate_text", text: inlineText };
              progressEvents.push(textEvent);
              try {
                await params.onProgressEvent(textEvent);
              } catch (err) {
                logger.warn({ err }, "Failed to deliver inline intermediate progress text");
              }
            }
            for (const block of content) {
              if (block && typeof block === "object" && "type" in block && block.type === "tool_use") {
                const name = (block as { name: string }).name;
                const input = (block as { input?: Record<string, unknown> }).input ?? {};
                const tc: ToolCallRecord = {
                  toolName: name,
                  skillName: name === "Skill" && typeof input?.skill === "string" ? input.skill : null,
                  startedAt: now,
                  endedAt: 0,
                };
                toolCalls.push(tc);
                pendingToolCalls.push(tc);
                const event: ToolUseProgressEvent = { kind: "tool_use", toolName: name, input };
                progressEvents.push(event);
                try {
                  await params.onProgressEvent(event);
                } catch (err) {
                  logger.warn({ err }, "Failed to deliver tool progress");
                }
              }
            }
          } else {
            const text = extractAssistantText(message);
            if (text) {
              currentTextSuffix.push(text);
            }
          }
        }
      }

      if (message.type === "result") {
        sessionId = message.session_id;
        await notifySessionId(sessionId);
        costUsd = message.total_cost_usd;
        const resultMsg = message as Record<string, unknown>;
        durationMs = (resultMsg.duration_ms as number) ?? 0;
        durationApiMs = (resultMsg.duration_api_ms as number) ?? 0;
        numTurns = (resultMsg.num_turns as number) ?? 0;
        stopReason = (resultMsg.stop_reason as string) ?? null;
        errorSubtype = message.subtype !== "success" ? message.subtype : null;
        const usage = message.usage as Record<string, unknown> | undefined;
        inputTokens = (usage?.input_tokens as number) ?? 0;
        outputTokens = (usage?.output_tokens as number) ?? 0;
        cacheReadTokens = (usage?.cache_read_input_tokens as number) ?? 0;
        cacheCreationTokens = (usage?.cache_creation_input_tokens as number) ?? 0;
        const serverToolUse = usage?.server_tool_use as Record<string, number> | undefined;
        webSearchRequests = serverToolUse?.web_search_requests ?? 0;
        webFetchRequests = serverToolUse?.web_fetch_requests ?? 0;
        const modelKeys = Object.keys((message as Record<string, unknown>).modelUsage ?? {});
        model = modelKeys.length > 0 ? modelKeys[0] : null;
      }
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
        if (shouldDeleteStoredSessionOnResumeFailure) {
          await deleteSessionId(params.db, params.workspaceKey, params.threadTs);
          shouldDeleteStoredSessionOnResumeFailure = false;
        }
        resumeSessionId = undefined;
        usedExistingSession = false;
        sessionId = "";
        retriedFreshAfterResumeFailure = true;
      }
    }

    if (sessionId && shouldPersistSession) {
      await saveSessionId(params.db, params.workspaceKey, sessionId, params.threadTs);
    }
  } finally {
    const endNow = Date.now();
    for (const tc of pendingToolCalls) {
      tc.endedAt = endNow;
    }
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

  const pendingUploads = uploadCollector.drain();
  logger.info({ userId: userName, sessionId, costUsd, pendingUploads: pendingUploads.length }, "Agent run completed");
  const finalText = currentTextSuffix.length > 0 ? currentTextSuffix.join("\n\n") : null;

  return {
    messageSent: finalText !== null,
    sessionId,
    costUsd,
    pendingUploads,
    durationMs,
    durationApiMs,
    numTurns,
    stopReason,
    errorSubtype,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    webSearchRequests,
    webFetchRequests,
    model,
    isResumedSession: usedExistingSession,
    totalAttachments: attachments.length,
    imageCount: images.length,
    nonImageCount: nonImages.length,
    mimeTypes: attachments.map((a) => a.mimeType),
    fileSizes: attachments.map((a) => a.sizeBytes),
    promptMode: hasImages && !useVisionToolForImages ? "multimodal" : "text",
    toolCalls,
    trace: {
      progressEvents,
      finalText,
    },
  };
}

function isRecoverableResumeFailure(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Claude Code process exited with code");
}
