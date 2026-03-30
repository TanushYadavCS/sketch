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
import type { Kysely, Selectable } from "kysely";
import type { createOutreachRepository } from "../db/repositories/outreach";
import type { DB, UsersTable } from "../db/schema";
import type { Attachment } from "../files";
import { buildMultimodalContent, formatAttachmentsForPrompt, isImageAttachment } from "../files";
import type { Logger } from "../logger";
import type { TaskScheduler } from "../scheduler/service";
import type { TaskContext } from "../scheduler/types";
import { createCanUseTool } from "./permissions";
import { buildSystemContext } from "./prompt";
import { getSessionId, saveSessionId } from "./sessions";
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
  userName: string;
  userEmail?: string | null;
  userPhone?: string | null;
  logger: Logger;
  platform: "slack" | "whatsapp";
  onMessage: (text: string) => Promise<void>;
  attachments?: Attachment[];
  threadTs?: string;
  orgName?: string | null;
  botName?: string | null;
  channelContext?: {
    channelName: string;
  };
  groupContext?: {
    groupName: string;
    groupDescription?: string;
  };
  integrationMcpServers?: Record<string, McpServerConfig>;
  findIntegrationProvider?: () => Promise<{ type: string; credentials: string } | null>;
  /**
   * Controls session behaviour for scheduled tasks.
   * - "fresh": skip session resume and skip session save (fully ephemeral run)
   * - "persistent" or "chat": normal get+save behaviour (same as undefined)
   * When omitted, behaves exactly as before (always get + save).
   */
  sessionMode?: "fresh" | "persistent" | "chat";
  taskContext?: TaskContext;
  scheduler?: TaskScheduler;
  outreachRepo?: ReturnType<typeof createOutreachRepository>;
  userRepo?: {
    list: () => Promise<Selectable<UsersTable>[]>;
    findById: (id: string) => Promise<Selectable<UsersTable> | undefined>;
  };
  contextType?: "dm" | "channel_mention" | "scheduled_task" | "outreach";
  currentUserId?: string | null;
  sendDm?: (params: { userId: string; platform: string; message: string }) => Promise<{
    channelId: string;
    messageRef: string;
  }>;
  enqueueMessage?: (params: { requesterUserId: string; message: string }) => Promise<void>;
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
  const existingSessionId = isFresh ? undefined : await getSessionId(params.db, params.workspaceKey, params.threadTs);
  const absWorkspace = resolve(workspaceDir);

  const systemAppend = buildSystemContext({
    platform: params.platform,
    userName,
    userEmail: params.userEmail,
    userPhone: params.userPhone,
    workspaceDir: absWorkspace,
    orgName: params.orgName,
    botName: params.botName,
    channelContext: params.channelContext,
    groupContext: params.groupContext,
  });

  let sessionId = "";
  let messageSent = false;
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

  const attachments = params.attachments ?? [];
  const hasImages = attachments.some((a) => isImageAttachment(a));

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
      promptMode: hasImages ? "multimodal" : "text",
    },
    "Prompt mode selected",
  );

  if (hasImages) {
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
    prompt = userMessage + formatAttachmentsForPrompt(attachments);
  }

  const uploadCollector = new UploadCollector();
  const sketchServer = createSketchMcpServer({
    uploadCollector,
    workspaceDir: absWorkspace,
    db: params.db,
    findIntegrationProvider: params.findIntegrationProvider,
    taskContext: params.taskContext,
    scheduler: params.scheduler,
    outreachRepo: params.outreachRepo,
    userRepo: params.userRepo,
    currentUserId: params.currentUserId ?? undefined,
    sendDm: params.sendDm,
    enqueueMessage: params.enqueueMessage,
  });

  const baseCanUseTool = createCanUseTool(absWorkspace, logger);
  const canUseToolTimings: CanUseToolTiming[] = [];
  const timedCanUseTool = async (toolName: string, input: Record<string, unknown>) => {
    canUseToolTimings.push({ toolName, calledAt: Date.now() });
    return baseCanUseTool(toolName, input);
  };

  const run = query({
    prompt,
    options: {
      maxTurns: 100,
      cwd: workspaceDir,
      resume: existingSessionId,
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
        append: systemAppend,
      },
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

  let pendingToolCalls: ToolCallRecord[] = [];

  for await (const message of run) {
    // When a new message arrives, any pending tool calls from the previous
    // iteration have finished executing (the SDK blocks until tool completion).
    const now = Date.now();
    for (const tc of pendingToolCalls) {
      tc.endedAt = now;
    }
    pendingToolCalls = [];

    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }

    const text = extractAssistantText(message);
    if (text) {
      try {
        await params.onMessage(text);
        messageSent = true;
      } catch (err) {
        logger.warn({ err }, "Failed to deliver assistant message");
      }
    }

    if (message.type === "assistant") {
      const inner = (message as Record<string, unknown>).message as Record<string, unknown> | undefined;
      const content = inner?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && "type" in block && block.type === "tool_use") {
            const name = (block as { name: string }).name;
            const input = (block as { input?: Record<string, unknown> }).input;
            const tc: ToolCallRecord = {
              toolName: name,
              skillName: name === "Skill" && typeof input?.skill === "string" ? input.skill : null,
              startedAt: now,
              endedAt: 0,
            };
            toolCalls.push(tc);
            pendingToolCalls.push(tc);
          }
        }
      }
    }

    if (message.type === "result") {
      sessionId = message.session_id;
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

  // Close out any tool calls still pending when the stream ends
  const endNow = Date.now();
  for (const tc of pendingToolCalls) {
    tc.endedAt = endNow;
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

  if (sessionId && !isFresh) {
    await saveSessionId(params.db, params.workspaceKey, sessionId, params.threadTs);
  }

  const pendingUploads = uploadCollector.drain();
  logger.info({ userId: userName, sessionId, costUsd, pendingUploads: pendingUploads.length }, "Agent run completed");

  return {
    messageSent,
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
    isResumedSession: existingSessionId !== undefined,
    totalAttachments: attachments.length,
    imageCount: images.length,
    nonImageCount: nonImages.length,
    mimeTypes: attachments.map((a) => a.mimeType),
    fileSizes: attachments.map((a) => a.sizeBytes),
    promptMode: hasImages ? "multimodal" : "text",
    toolCalls,
  };
}
