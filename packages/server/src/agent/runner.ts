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
import { AuxCostCollector, type AuxLlmCall, sumAuxCost } from "./aux-cost";
import { createCanUseTool } from "./permissions";
import { type ResponseSurface, buildSystemContext } from "./prompt";
import { deleteSessionId, getSessionId, saveSessionId } from "./sessions";
import { UploadCollector, createSketchMcpServer } from "./sketch-tools";
import type { DailyBriefWriter } from "./tools/daily-brief";

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
   * Aux LLM costs incurred before the run (eager transcription of voice-message
   * attachments in the adapters) to fold into this run's aux total, since they
   * happen outside the run's own tool-call collector.
   */
  seedAuxCalls?: AuxLlmCall[];
  agentInstructions?: string | null;
  agentAllowedTools?: string[] | null;
  dailyBriefWriter?: DailyBriefWriter;
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

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
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
  let sdkCostUsd = 0;
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
  const auxCostCollector = new AuxCostCollector();
  const sketchServer = createSketchMcpServer({
    uploadCollector,
    auxCostCollector,
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
    openRouterApiKey: params.openRouterApiKey,
    settingsEncryptionKey: params.settingsEncryptionKey,
    inboxMessagesRepo: params.inboxMessagesRepo,
    userRepo: params.userRepo,
    currentUserId: params.currentUserId ?? undefined,
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
    dailyBriefWriter: params.dailyBriefWriter,
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
        sdkCostUsd = message.total_cost_usd;
        const resultMsg = message as Record<string, unknown>;
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
  const auxLlmCalls = [...(params.seedAuxCalls ?? []), ...auxCostCollector.drain()];
  const auxCostUsd = sumAuxCost(auxLlmCalls);
  logger.info(
    { userId: userName, sessionId, sdkCostUsd, auxCostUsd, pendingUploads: pendingUploads.length },
    "Agent run completed",
  );
  const finalText = currentTextSuffix.length > 0 ? currentTextSuffix.join("\n\n") : null;

  return {
    messageSent: finalText !== null,
    sessionId,
    costUsd: sdkCostUsd,
    auxCostUsd,
    pendingUploads,
    trace: {
      progressEvents,
      finalText,
    },
    rawUsage: {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      webSearchRequests,
      webFetchRequests,
      durationApiMs,
      numTurns,
      stopReason,
      errorSubtype,
      isResumedSession: usedExistingSession,
      totalAttachments: attachments.length,
      imageCount: images.length,
      nonImageCount: nonImages.length,
      mimeTypes: attachments.map((a) => a.mimeType),
      fileSizes: attachments.map((a) => a.sizeBytes),
      promptMode: hasImages && !useVisionToolForImages ? "multimodal" : "text",
      toolCalls,
      auxLlmCalls,
      sdkCostUsd,
    },
  };
}

function isRecoverableResumeFailure(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Claude Code process exited with code");
}
