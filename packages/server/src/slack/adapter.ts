/**
 * Slack adapter — wires Slack event handlers (DM, thread, channel mention) onto a SlackBot.
 * Extracted from index.ts for testability. All handler logic lives here; index.ts only calls
 * createConfiguredSlackBot() and passes the result to the startup manager.
 */
import { join } from "node:path";
import { parseAllowedTools } from "@sketch/shared";
import type { Kysely } from "kysely";
import type { AuxLlmCall } from "../agent/aux-cost";
import { PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE, agentFailureMessage } from "../agent/errors";
import {
  type BufferedMessage,
  type InboxMessageContext,
  type SketchContextParams,
  buildSketchContext,
  getImageAttachmentPathsFromSketchContext,
} from "../agent/prompt";
import {
  type McpServerConfig,
  type RunAgentParams,
  type RunAgentResult,
  canUseVisualAnalysisTool,
} from "../agent/runner";
import { deleteSessionId } from "../agent/sessions";
import { createProgressRenderer } from "../agent/tool-progress";
import { ensureAgentSubWorkspace, ensureChannelWorkspace, ensureWorkspace } from "../agent/workspace";
import {
  REASONING_TEXT_OPTIONS,
  type ReasoningTextCommand,
  TOOL_PROGRESS_OPTIONS,
  type ToolProgressCommand,
  getNewSessionConfirmation,
  getReasoningTextConfirmation,
  getReasoningTextCurrent,
  getToolProgressConfirmation,
  getToolProgressCurrent,
  parseSketchCommand,
} from "../commands";
import type { Config } from "../config";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createChannelRepository } from "../db/repositories/channels";
import type { createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { type createSettingsRepository, parseOrgContext } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { type Attachment, downloadSlackFile } from "../files";
import { appendIntegrationConnectionLinks } from "../integrations/connection-links";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import {
  type ProgressDisplaySettings,
  getUnknownReasoningTextMessage,
  getUnknownToolProgressMessage,
  isReasoningTextCommand,
  isToolProgressCommand,
  resolveProgressDisplaySettings,
} from "../progress-settings";
import type { QueueManager } from "../queue";
import type { TaskScheduler } from "../scheduler/service";
import { transcribeEagerAttachments } from "../transcription/service";
import { resolveVisionConfigFromAppConfig } from "../vision/service";
import { slackApiCall } from "./api";
import { SlackBot, type SlackFile, type SlackMessageHandler } from "./bot";
import { HOME_ACTION_REASONING_TEXT, HOME_ACTION_TOOL_PROGRESS, buildHomeView } from "./home";
import { createSlackMessageHandler } from "./message-handler";
import { SlackIdentityConflictError, resolveSlackUser } from "./resolve-user";
import type { UserCache } from "./user-cache";

type UserRepository = ReturnType<typeof createUserRepository>;
type ChannelRepository = ReturnType<typeof createChannelRepository>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;
type InboxMessagesRepository = ReturnType<typeof createInboxMessagesRepository>;
type ConversationRepository = ReturnType<typeof createConversationRepository>;

const INLINE_BACKLOG_LIMIT = 10;
const SLACK_THREAD_CURSOR_SCOPE = "slack_thread";
const SLACK_AGENT_ERROR_MESSAGE = "_Something went wrong, try again_";

function parseInboxMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function providerTimestampFromSlackTs(ts: string | undefined): string | null {
  if (!ts) return null;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function isConversationControlMessage(text: string): boolean {
  const command = parseSketchCommand(text);
  if (command === "new_session" || command === "tool_progress_query" || command === "reasoning_text_query") {
    return true;
  }
  if (command?.startsWith("tool_progress_") || command?.startsWith("reasoning_text_")) return true;
  return isToolProgressCommand(text) || isReasoningTextCommand(text);
}

function slackConversationRefForMessage(message: { type: string; channelId: string }) {
  if (message.type === "dm") {
    return { platform: "slack", kind: "dm", providerConversationId: message.channelId };
  }
  return { platform: "slack", kind: "channel", providerConversationId: message.channelId };
}

function slackProviderThreadId(message: { type: string; ts: string; threadTs?: string }): string | null {
  if (message.type === "dm") return null;
  return message.threadTs ?? message.ts;
}

export interface SlackAdapterDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  repos: {
    users: UserRepository;
    channels: ChannelRepository;
    settings: SettingsRepository;
    conversations: ConversationRepository;
  };
  queue: QueueManager;
  slack: {
    userCache: UserCache;
  };
  runAgent: (params: RunAgentParams) => Promise<RunAgentResult>;
  buildMcpServers: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  scheduler?: TaskScheduler;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  inboxMessagesRepo?: InboxMessagesRepository;
  sendDm: (params: { userId: string; platform: string; message: string }) => Promise<{
    channelId: string;
    messageRef: string;
  }>;
}

export async function validateSlackTokens(botToken: string, appToken?: string) {
  void appToken;
  await slackApiCall(botToken, "auth.test");
}

async function downloadSlackFiles(
  files: SlackFile[],
  botToken: string | null | undefined,
  attachDir: string,
  maxBytes: number,
  logger: Logger,
  failureLogMessage = "Failed to download file",
): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  for (const file of files) {
    try {
      if (!botToken) {
        throw new Error("Slack bot token not configured");
      }
      const downloaded = await downloadSlackFile(file.urlPrivate, botToken, attachDir, maxBytes, logger);
      attachments.push(downloaded);
    } catch (err) {
      logger.warn({ err, fileName: file.name }, failureLogMessage);
    }
  }
  return attachments;
}

async function downloadMessageAttachments(params: {
  files: SlackFile[] | undefined;
  workspaceDir: string;
  botToken: string | null | undefined;
  maxBytes: number;
  logger: Logger;
}): Promise<Attachment[]> {
  const { files, workspaceDir, botToken, maxBytes, logger } = params;
  if (!files?.length) return [];

  logger.debug(
    {
      fileCount: files.length,
      files: files.map((f) => ({
        name: f.name,
        mime: f.mimetype,
        size: f.size,
        url: f.urlPrivate?.slice(0, 80),
      })),
    },
    "Files received from Slack",
  );

  const attachments = await downloadSlackFiles(files, botToken, join(workspaceDir, "attachments"), maxBytes, logger);

  logger.debug(
    {
      attachmentCount: attachments.length,
      attachments: attachments.map((a) => ({ name: a.originalName, mime: a.mimeType, size: a.sizeBytes })),
    },
    "Files downloaded",
  );

  return attachments;
}

const SHIMMER_HEARTBEAT_MS = 45_000;

function createShimmer(
  slackBot: SlackBot,
  channelId: string,
  threadTs: string,
  progressSettings: ProgressDisplaySettings,
) {
  const renderer = createProgressRenderer(progressSettings);
  let currentLine = "💭 Thinking…";
  let chain: Promise<unknown> = slackBot.setAssistantStatus(channelId, threadTs, currentLine);
  const setLine = (status: string) => {
    currentLine = status;
    chain = chain.catch(() => undefined).then(() => slackBot.setAssistantStatus(channelId, threadTs, status));
    return chain;
  };
  const heartbeat = setInterval(() => {
    if (currentLine) void setLine(currentLine);
  }, SHIMMER_HEARTBEAT_MS);
  const onProgressEvent: RunAgentParams["onProgressEvent"] = async (event) => {
    const previousLast = renderer.getLines().at(-1);
    renderer.renderEvent(event);
    const last = renderer.getLines().at(-1);
    if (last && last !== previousLast) void setLine(last);
  };
  const clear = async () => {
    clearInterval(heartbeat);
    currentLine = "";
    await chain.catch(() => undefined);
    await slackBot.setAssistantStatus(channelId, threadTs, "");
  };
  return { onProgressEvent, clear };
}

export function createConfiguredSlackBot(tokens: { botToken: string; appToken?: string }, deps: SlackAdapterDeps) {
  const {
    db,
    config,
    logger,
    repos,
    queue,
    slack: slackDeps,
    runAgent,
    buildMcpServers,
    loadIntegrationProvider,
    scheduler,
    stepContentRepo,
    automationRunsRepo,
    inboxMessagesRepo,
    sendDm,
  } = deps;
  const toolConfig = { BASE_URL: config.BASE_URL, PORT: config.PORT };
  const maxFileBytes = config.MAX_FILE_SIZE_MB * 1024 * 1024;

  const mode = config.SLACK_MODE ?? "socket";
  const slackBot = new SlackBot({
    mode,
    botToken: tokens.botToken,
    ...(mode === "socket" ? { appToken: tokens.appToken } : { signingSecret: config.SLACK_SIGNING_SECRET }),
    logger,
  });

  const resolveUser = (slackUserId: string) =>
    resolveSlackUser(slackUserId, {
      users: repos.users,
      getUserInfo: (id) => slackDeps.userCache.resolve(id, (uid) => slackBot.getUserInfo(uid)),
      logger,
    });

  const resolveCommandToolProgress = (command: ReturnType<typeof parseSketchCommand>): ToolProgressCommand | null => {
    if (!command?.startsWith("tool_progress_") || command === "tool_progress_query") return null;
    return command.slice("tool_progress_".length) as ToolProgressCommand;
  };

  const resolveCommandReasoningText = (command: ReturnType<typeof parseSketchCommand>): ReasoningTextCommand | null => {
    if (!command?.startsWith("reasoning_text_") || command === "reasoning_text_query") return null;
    return command.slice("reasoning_text_".length) as ReasoningTextCommand;
  };

  const loadPendingInboxMessages = async (
    recipientUserId: string,
  ): Promise<{ ids: string[]; messages: InboxMessageContext[] }> => {
    if (!inboxMessagesRepo) return { ids: [], messages: [] };

    const rows = await inboxMessagesRepo.listPendingForRecipient(recipientUserId);
    const messages = await Promise.all(
      rows.map(async (row) => {
        const sender = await repos.users.findById(row.sender_user_id);
        return {
          id: row.id,
          senderName: sender?.name ?? "Unknown",
          message: row.message,
          createdAt: row.created_at,
          kind: row.kind,
          metadata: parseInboxMetadata(row.metadata),
        };
      }),
    );

    return { ids: rows.map((row) => row.id), messages };
  };

  const publishHomeForUser = async (slackUserId: string): Promise<void> => {
    let user: Awaited<ReturnType<typeof resolveUser>>;
    try {
      user = await resolveUser(slackUserId);
    } catch (err) {
      logger.warn({ err, slackUserId }, "Home tab: failed to resolve user");
      return;
    }
    const settingsRow = await repos.settings.get();
    const progress = resolveProgressDisplaySettings(user);
    const view = buildHomeView({
      realName: user.name,
      email: user.email ?? null,
      workspaceName: settingsRow?.org_name ?? null,
      toolProgress: progress.toolProgress,
      reasoningText: progress.reasoningText,
    });
    await slackBot.publishHomeView(slackUserId, view);
  };

  const resolvePassiveSender = async (slackUserId: string) => {
    const [user, userInfo] = await Promise.all([
      repos.users.findBySlackId(slackUserId),
      slackDeps.userCache.resolve(slackUserId, (id) => slackBot.getUserInfo(id)),
    ]);
    return {
      senderName: user?.name ?? userInfo.realName,
      senderUserId: user?.id ?? null,
    };
  };

  const loadSlackBootstrapMessages = async (params: {
    channelId: string;
    currentMessageTs: string;
    threadTs?: string;
  }): Promise<BufferedMessage[]> => {
    try {
      const rows = params.threadTs
        ? await slackBot.getThreadReplies(params.channelId, params.threadTs, config.SLACK_THREAD_HISTORY_LIMIT)
        : await slackBot.getChannelHistory(params.channelId, config.SLACK_CHANNEL_HISTORY_LIMIT);
      const history = rows
        .filter((row) => row.ts !== params.currentMessageTs)
        .sort((a, b) => Number(a.ts) - Number(b.ts));

      return Promise.all(
        history.map(async (row) => {
          const userInfo = await slackDeps.userCache.resolve(row.userId, (id) => slackBot.getUserInfo(id));
          return {
            userName: userInfo.realName || userInfo.name || row.userId,
            text: row.text,
            ts: row.ts,
          };
        }),
      );
    } catch (err) {
      logger.warn(
        { err, channelId: params.channelId, hasThread: Boolean(params.threadTs) },
        "Slack bootstrap history fetch failed",
      );
      return [];
    }
  };

  const ensureChannelRow = async (channelId: string) => {
    let channel = await repos.channels.findBySlackChannelId(channelId);
    if (!channel) {
      const channelInfo = await slackBot.getChannelInfo(channelId);
      channel = await repos.channels.create({
        slackChannelId: channelId,
        name: channelInfo.name,
        type: channelInfo.type,
      });
      logger.info({ channelId: channel.id, name: channel.name }, "New channel created");
    }
    return channel;
  };

  const workspaceDirForChannel = async (channelId: string) => {
    const channel = await repos.channels.findBySlackChannelId(channelId);
    const boundAgent = channel?.agent_user_id ? await repos.users.findById(channel.agent_user_id) : null;
    return boundAgent
      ? ensureAgentSubWorkspace(config, boundAgent.id, `channel-${channelId}`)
      : ensureChannelWorkspace(config, channelId);
  };

  const captureSlackMessage = async (params: {
    message: Parameters<SlackMessageHandler>[0];
    senderName: string;
    senderUserId?: string | null;
    addressedToSketch: boolean;
    attachments?: Attachment[];
    displayName?: string | null;
  }) => {
    const { message } = params;
    const conversation = await repos.conversations.getOrCreate(
      slackConversationRefForMessage(message),
      params.displayName,
    );

    if (isConversationControlMessage(message.text)) {
      return { conversation, captured: null, inserted: false, omitted: true };
    }

    const captured = await repos.conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: message.ts,
      senderJid: message.userId,
      senderName: params.senderName,
      senderUserId: params.senderUserId ?? null,
      addressedToSketch: params.addressedToSketch,
      text: message.text || (params.attachments && params.attachments.length > 0 ? "See attached files." : ""),
      attachments: params.attachments,
      providerThreadId: slackProviderThreadId(message),
      providerParentMessageId: message.threadTs ?? null,
      isThreadReply: Boolean(message.threadTs),
      providerTimestamp: providerTimestampFromSlackTs(message.ts),
    });

    return { conversation, captured: captured.row, inserted: captured.inserted, omitted: false };
  };

  const captureSlackBotReplies = async (params: {
    conversationId: number;
    sent: Array<{ messageRef: string; text: string }>;
    channelId: string;
    threadTs?: string;
    botName?: string | null;
  }) => {
    for (const sent of params.sent) {
      if (!sent.messageRef) continue;
      await repos.conversations.insertMessage({
        conversationId: params.conversationId,
        providerMessageId: sent.messageRef,
        senderJid: "bot",
        senderName: params.botName ?? "Sketch",
        isBot: true,
        addressedToSketch: false,
        text: sent.text,
        providerThreadId: params.threadTs ?? null,
        providerParentMessageId: params.threadTs ?? null,
        isThreadReply: Boolean(params.threadTs),
        providerTimestamp: providerTimestampFromSlackTs(sent.messageRef),
      });
    }
  };

  slackBot.onAppHomeOpened(async (event) => {
    await publishHomeForUser(event.slackUserId);
  });

  slackBot.onHomeAction(async (event) => {
    let user: Awaited<ReturnType<typeof resolveUser>>;
    try {
      user = await resolveUser(event.slackUserId);
    } catch (err) {
      logger.warn({ err, slackUserId: event.slackUserId, actionId: event.actionId }, "Home action: resolve failed");
      return;
    }

    if (event.actionId === HOME_ACTION_TOOL_PROGRESS) {
      const value = event.value;
      if (TOOL_PROGRESS_OPTIONS.includes(value as ToolProgressCommand)) {
        await repos.users.update(user.id, { toolProgress: value });
      }
    } else if (event.actionId === HOME_ACTION_REASONING_TEXT) {
      const value = event.value;
      if (REASONING_TEXT_OPTIONS.includes(value as ReasoningTextCommand)) {
        await repos.users.update(user.id, { reasoningText: value === "on" });
      }
    }

    await publishHomeForUser(event.slackUserId);
  });

  // DM handler
  slackBot.onMessage(async (message) => {
    const replyToUser = (text: string): Promise<unknown> =>
      message.threadTs
        ? slackBot.postThreadReply(message.channelId, message.threadTs, text)
        : slackBot.postMessage(message.channelId, text);

    let user: Awaited<ReturnType<typeof resolveUser>>;
    try {
      user = await resolveUser(message.userId);
    } catch (err) {
      if (err instanceof SlackIdentityConflictError) {
        logger.warn(
          {
            slackUserId: message.userId,
            email: err.conflict.email,
            existingUserId: err.conflict.existingUserId,
            existingSlackUserId: err.conflict.existingSlackUserId,
          },
          "Skipping DM because Slack identity conflicts with an existing user",
        );
        await replyToUser(
          "I can't reply right now because your Slack account mapping conflicts with an existing Sketch identity. Please ask your admin to reconnect Slack for your workspace.",
        );
        return;
      }
      throw err;
    }
    const activeQueueKey = user.id;
    const userQueue = queue.getQueue(activeQueueKey);

    userQueue.enqueue(async () => {
      logger.info({ slackUserId: message.userId, channelId: message.channelId }, "Processing message");

      const command = parseSketchCommand(message.text);
      const dmConversation = await repos.conversations.getOrCreate(slackConversationRefForMessage(message), user.name);
      if (command === "new_session") {
        await deleteSessionId(db, user.id);
        await repos.conversations.advanceWatermarkToCurrentMax(dmConversation.id);
        await replyToUser(getNewSessionConfirmation());
        return;
      }

      if (!command && isToolProgressCommand(message.text)) {
        await replyToUser(getUnknownToolProgressMessage(message.text));
        return;
      }

      if (!command && isReasoningTextCommand(message.text)) {
        await replyToUser(getUnknownReasoningTextMessage(message.text));
        return;
      }

      const currentProgressSettings = resolveProgressDisplaySettings(user);
      if (command === "tool_progress_query") {
        await replyToUser(getToolProgressCurrent(currentProgressSettings));
        return;
      }

      if (command === "reasoning_text_query") {
        await replyToUser(getReasoningTextCurrent(currentProgressSettings));
        return;
      }

      const requestedToolProgress = resolveCommandToolProgress(command);
      if (requestedToolProgress) {
        await repos.users.update(user.id, { toolProgress: requestedToolProgress });
        await replyToUser(getToolProgressConfirmation(requestedToolProgress, currentProgressSettings.reasoningText));
        return;
      }

      const requestedReasoningText = resolveCommandReasoningText(command);
      if (requestedReasoningText) {
        const enabled = requestedReasoningText === "on";
        await repos.users.update(user.id, { reasoningText: enabled });
        await replyToUser(getReasoningTextConfirmation(enabled));
        return;
      }

      const workspaceDir = await ensureWorkspace(config, user.id);
      const settingsRow = await repos.settings.get();

      let attachments = await downloadMessageAttachments({
        files: message.files,
        workspaceDir,
        botToken: settingsRow?.slack_bot_token,
        maxBytes: maxFileBytes,
        logger,
      });
      const eagerAuxCalls: AuxLlmCall[] = [];
      attachments = await transcribeEagerAttachments(attachments, {
        loadSettings: () => repos.settings.get(),
        logger,
        onUsage: (call) => eagerAuxCalls.push(call),
      });
      const capture = await captureSlackMessage({
        message,
        senderName: user.name,
        senderUserId: user.id,
        addressedToSketch: true,
        attachments,
        displayName: user.name,
      });
      if (!capture.captured) return;

      const backlog = await repos.conversations.listBacklog({
        conversationId: capture.conversation.id,
        afterMessageId: dmConversation.last_seen_message_id,
        beforeMessageId: capture.captured.id,
        limit: INLINE_BACKLOG_LIMIT,
      });
      const conversationBacklog =
        backlog.messages.length > 0 || backlog.hasMore
          ? {
              messages: backlog.messages,
              afterMessageId: dmConversation.last_seen_message_id,
              beforeMessageId: capture.captured.id,
              hasMore: backlog.hasMore,
              nextCursor: backlog.nextCursor,
            }
          : undefined;

      const assistantThreadTs = message.threadTs;
      const shimmerThreadTs = message.threadTs ?? message.ts;

      const onFinalMessage = createSlackMessageHandler(slackBot, message.channelId, assistantThreadTs);
      let clearAssistantStatus: (() => Promise<void>) | null = null;
      let pendingInbox: Awaited<ReturnType<typeof loadPendingInboxMessages>> | null = null;

      try {
        const shimmer = createShimmer(
          slackBot,
          message.channelId,
          shimmerThreadTs,
          resolveProgressDisplaySettings(user),
        );
        clearAssistantStatus = shimmer.clear;
        const { onProgressEvent } = shimmer;

        const integrationMcpServers = await buildMcpServers(user.email);
        pendingInbox = await loadPendingInboxMessages(user.id);

        const visionConfig = resolveVisionConfigFromAppConfig(config, settingsRow);
        const visualAnalysisAllowed = canUseVisualAnalysisTool(visionConfig, null);
        const sketchContext: SketchContextParams = {
          messages: [],
          currentUserName: user.name,
          currentMessage: message.text || "See attached files.",
          currentUserEmail: user.email,
          workspaceDir,
          orgDir: config.CLAUDE_CONFIG_DIR,
          timezone: user.timezone,
          isSharedContext: false,
          inboxMessages: pendingInbox.messages,
          conversationBacklog,
          visionAnalysisEnabled: visualAnalysisAllowed,
        };
        const userMessage = buildSketchContext(sketchContext);

        const result = await runAgent({
          db,
          workspaceKey: user.id,
          seedAuxCalls: eagerAuxCalls,
          userMessage,
          workspaceDir,
          claudeConfigDir: config.CLAUDE_CONFIG_DIR,
          userName: user.name,
          userEmail: user.email,
          logger,
          platform: "slack",
          getSlack: () => slackBot,
          onProgressEvent,
          ...(assistantThreadTs ? { threadTs: assistantThreadTs } : {}),
          orgName: settingsRow?.org_name,
          orgDescription: parseOrgContext(settingsRow?.org_context)?.description ?? null,
          botName: settingsRow?.bot_name,
          visionConfig,
          blockedReadPaths: getImageAttachmentPathsFromSketchContext(sketchContext),
          attachments: attachments.length > 0 ? attachments : undefined,
          integrationMcpServers,
          loadIntegrationProvider,
          contextType: "dm",
          taskContext: {
            platform: "slack" as const,
            contextType: "dm" as const,
            deliveryTarget: message.channelId,
            createdBy: user.id,
            creatorTimezone: user.timezone,
          },
          scheduler,
          stepContentRepo,
          automationRunsRepo,
          queueManager: queue,
          activeQueueKey,
          toolConfig,
          inboxMessagesRepo,
          userRepo: repos.users,
          currentUserId: user.id,
          sendDm,
          conversationRepo: repos.conversations,
          conversationContext: { conversationId: capture.conversation.id, currentMessageId: capture.captured.id },
        });

        const finalText = appendIntegrationConnectionLinks(
          result.trace.finalText,
          result.pendingIntegrationConnections,
          "slack",
          toolConfig,
        );
        if (finalText) {
          const sent = await onFinalMessage(finalText);
          await captureSlackBotReplies({
            conversationId: capture.conversation.id,
            sent,
            channelId: message.channelId,
            threadTs: assistantThreadTs,
            botName: settingsRow?.bot_name,
          });
        }

        for (const filePath of result.pendingUploads) {
          try {
            await slackBot.uploadFile(message.channelId, filePath, assistantThreadTs);
          } catch (err) {
            logger.warn({ err, filePath }, "Failed to upload file to Slack");
          }
        }

        await clearAssistantStatus();
        if (pendingInbox && pendingInbox.ids.length > 0 && inboxMessagesRepo) {
          await inboxMessagesRepo.markConsumed(pendingInbox.ids);
        }
        if (result.messageSent || result.pendingUploads.length > 0) {
          await repos.conversations.updateWatermark(capture.conversation.id, capture.captured.id);
        }
        if (!finalText) {
          await replyToUser("_No response_");
        }
      } catch (err) {
        logger.error({ err, userId: user.id }, "Agent run failed");
        await clearAssistantStatus?.();
        await replyToUser(agentFailureMessage(err, SLACK_AGENT_ERROR_MESSAGE));
      }
    });
  });

  // Passive top-level channel message handler
  slackBot.onChannelMessage(async (message) => {
    try {
      const channel = await ensureChannelRow(message.channelId);
      const workspaceDir = await workspaceDirForChannel(message.channelId);
      const settingsRow = await repos.settings.get();
      const attachments = await downloadMessageAttachments({
        files: message.files,
        workspaceDir,
        botToken: settingsRow?.slack_bot_token,
        maxBytes: maxFileBytes,
        logger,
      });
      const sender = await resolvePassiveSender(message.userId);
      await captureSlackMessage({
        message,
        senderName: sender.senderName,
        senderUserId: sender.senderUserId,
        addressedToSketch: false,
        attachments,
        displayName: channel.name,
      });
    } catch (err) {
      logger.warn({ err, channelId: message.channelId }, "Failed to capture passive Slack channel message");
    }
  });

  // Passive thread message handler
  slackBot.onThreadMessage(async (message) => {
    if (!message.threadTs) return;
    try {
      const channel = await ensureChannelRow(message.channelId);
      const workspaceDir = await workspaceDirForChannel(message.channelId);
      const settingsRow = await repos.settings.get();
      const attachments = await downloadMessageAttachments({
        files: message.files,
        workspaceDir,
        botToken: settingsRow?.slack_bot_token,
        maxBytes: maxFileBytes,
        logger,
      });
      const sender = await resolvePassiveSender(message.userId);
      await captureSlackMessage({
        message,
        senderName: sender.senderName,
        senderUserId: sender.senderUserId,
        addressedToSketch: false,
        attachments,
        displayName: channel.name,
      });

      logger.debug(
        { channelId: message.channelId, threadTs: message.threadTs, user: sender.senderName },
        "Captured passive Slack thread message",
      );
    } catch (err) {
      logger.warn(
        { err, channelId: message.channelId, threadTs: message.threadTs },
        "Failed to capture passive Slack thread message",
      );
    }
  });

  // Channel mention handler
  slackBot.onChannelMention(async (message) => {
    const threadTs = message.threadTs ?? message.ts;
    const activeQueueKey = `${message.channelId}:${threadTs}`;
    const mentionQueue = queue.getQueue(activeQueueKey);

    mentionQueue.enqueue(async () => {
      logger.info({ slackUserId: message.userId, channelId: message.channelId }, "Processing channel mention");

      let user: Awaited<ReturnType<typeof resolveUser>> | undefined;
      let clearAssistantStatus: (() => Promise<void>) | null = null;

      try {
        user = await resolveUser(message.userId);

        let channel = await ensureChannelRow(message.channelId);

        const boundAgent = channel.agent_user_id ? await repos.users.findById(channel.agent_user_id) : null;
        if (channel.agent_user_id && !boundAgent) {
          logger.warn(
            { channelId: channel.id, agentUserId: channel.agent_user_id },
            "Channel binding references missing agent; running with default behaviour",
          );
        }

        /**
         * Workspace key must include the agent prefix when the channel is
         * bound to an agent — otherwise /new clears the wrong session and
         * the next mention resumes stale context.
         */
        const channelWorkspaceKey = boundAgent
          ? `agent-${boundAgent.id}/channel-${message.channelId}`
          : `channel-${message.channelId}`;

        const command = parseSketchCommand(message.text);
        const channelConversation = await repos.conversations.getOrCreate(
          slackConversationRefForMessage(message),
          channel.name,
        );
        if (command === "new_session") {
          await deleteSessionId(db, channelWorkspaceKey, threadTs);
          await repos.conversations.advanceCursorToCurrentMax({
            conversationId: channelConversation.id,
            scopeType: SLACK_THREAD_CURSOR_SCOPE,
            scopeKey: threadTs,
            providerThreadId: threadTs,
          });
          await slackBot.postThreadReply(message.channelId, threadTs, getNewSessionConfirmation());
          return;
        }

        if (!command && isToolProgressCommand(message.text)) {
          await slackBot.postThreadReply(message.channelId, threadTs, getUnknownToolProgressMessage(message.text));
          return;
        }

        if (!command && isReasoningTextCommand(message.text)) {
          await slackBot.postThreadReply(message.channelId, threadTs, getUnknownReasoningTextMessage(message.text));
          return;
        }

        const currentProgressSettings = resolveProgressDisplaySettings(channel);
        if (command === "tool_progress_query") {
          await slackBot.postThreadReply(message.channelId, threadTs, getToolProgressCurrent(currentProgressSettings));
          return;
        }

        if (command === "reasoning_text_query") {
          await slackBot.postThreadReply(message.channelId, threadTs, getReasoningTextCurrent(currentProgressSettings));
          return;
        }

        const requestedToolProgress = resolveCommandToolProgress(command);
        if (requestedToolProgress) {
          channel = await repos.channels.update(channel.id, { toolProgress: requestedToolProgress });
          await slackBot.postThreadReply(
            message.channelId,
            threadTs,
            getToolProgressConfirmation(requestedToolProgress, currentProgressSettings.reasoningText),
          );
          return;
        }

        const requestedReasoningText = resolveCommandReasoningText(command);
        if (requestedReasoningText) {
          const enabled = requestedReasoningText === "on";
          channel = await repos.channels.update(channel.id, { reasoningText: enabled });
          await slackBot.postThreadReply(message.channelId, threadTs, getReasoningTextConfirmation(enabled));
          return;
        }

        const workspaceDir = boundAgent
          ? await ensureAgentSubWorkspace(config, boundAgent.id, `channel-${message.channelId}`)
          : await ensureChannelWorkspace(config, message.channelId);
        const settingsRow = await repos.settings.get();

        let attachments = await downloadMessageAttachments({
          files: message.files,
          workspaceDir,
          botToken: settingsRow?.slack_bot_token,
          maxBytes: maxFileBytes,
          logger,
        });
        const eagerAuxCalls: AuxLlmCall[] = [];
        attachments = await transcribeEagerAttachments(attachments, {
          loadSettings: () => repos.settings.get(),
          logger,
          onUsage: (call) => eagerAuxCalls.push(call),
        });
        const capture = await captureSlackMessage({
          message,
          senderName: user.name,
          senderUserId: user.id,
          addressedToSketch: true,
          attachments,
          displayName: channel.name,
        });
        if (!capture.captured) return;

        const cursor = await repos.conversations.getCursor({
          conversationId: capture.conversation.id,
          scopeType: SLACK_THREAD_CURSOR_SCOPE,
          scopeKey: threadTs,
        });
        const backlog = await repos.conversations.listBacklog({
          conversationId: capture.conversation.id,
          afterMessageId: cursor?.last_seen_message_id,
          beforeMessageId: capture.captured.id,
          limit: INLINE_BACKLOG_LIMIT,
          providerThreadId: message.threadTs ? threadTs : undefined,
        });
        const conversationBacklog =
          backlog.messages.length > 0 || backlog.hasMore
            ? {
                messages: backlog.messages,
                afterMessageId: cursor?.last_seen_message_id,
                beforeMessageId: capture.captured.id,
                hasMore: backlog.hasMore,
                nextCursor: backlog.nextCursor,
              }
            : undefined;
        const bootstrapMessages = !conversationBacklog
          ? await loadSlackBootstrapMessages({
              channelId: message.channelId,
              currentMessageTs: message.ts,
              ...(message.threadTs ? { threadTs } : {}),
            })
          : [];
        const threadTag = message.threadTs ? "thread" : "channel_history";

        const rawText = message.text || "See attached files.";
        const visionConfig = resolveVisionConfigFromAppConfig(config, settingsRow);
        const agentInstructions = boundAgent?.description ?? null;
        const agentAllowedTools = boundAgent ? parseAllowedTools(boundAgent.allowed_tools) : null;
        const visualAnalysisAllowed = canUseVisualAnalysisTool(visionConfig, agentAllowedTools);
        const sketchContext: SketchContextParams = {
          messages: bootstrapMessages,
          currentUserName: user.name,
          currentMessage: rawText,
          currentUserEmail: user.email,
          workspaceDir,
          orgDir: config.CLAUDE_CONFIG_DIR,
          timezone: user.timezone,
          isSharedContext: true,
          threadTag,
          channelContext: { channelName: channel.name },
          conversationBacklog,
          visionAnalysisEnabled: visualAnalysisAllowed,
        };
        const userMessage = buildSketchContext(sketchContext);

        const onFinalMessage = createSlackMessageHandler(slackBot, message.channelId, threadTs);
        const shimmer = createShimmer(slackBot, message.channelId, threadTs, resolveProgressDisplaySettings(channel));
        clearAssistantStatus = shimmer.clear;
        const onProgressEvent = shimmer.onProgressEvent;

        const integrationMcpServers = await buildMcpServers(user.email);

        const result = await runAgent({
          db,
          workspaceKey: channelWorkspaceKey,
          seedAuxCalls: eagerAuxCalls,
          userMessage,
          workspaceDir,
          claudeConfigDir: config.CLAUDE_CONFIG_DIR,
          userName: user.name,
          userEmail: user.email,
          logger,
          platform: "slack",
          getSlack: () => slackBot,
          onProgressEvent,
          threadTs,
          orgName: settingsRow?.org_name,
          orgDescription: parseOrgContext(settingsRow?.org_context)?.description ?? null,
          botName: settingsRow?.bot_name,
          visionConfig,
          blockedReadPaths: getImageAttachmentPathsFromSketchContext(sketchContext),
          attachments: attachments.length > 0 ? attachments : undefined,
          integrationMcpServers,
          loadIntegrationProvider,
          contextType: "channel_mention",
          currentUserId: user.id,
          taskContext: {
            platform: "slack" as const,
            contextType: "channel" as const,
            deliveryTarget: message.channelId,
            createdBy: user.id,
            creatorTimezone: user.timezone,
            threadTs: message.threadTs ? threadTs : undefined,
          },
          scheduler,
          stepContentRepo,
          automationRunsRepo,
          queueManager: queue,
          activeQueueKey,
          toolConfig,
          inboxMessagesRepo,
          userRepo: repos.users,
          sendDm,
          agentInstructions,
          agentAllowedTools,
          conversationRepo: repos.conversations,
          conversationContext: {
            conversationId: capture.conversation.id,
            currentMessageId: capture.captured.id,
            providerThreadId: message.threadTs ? threadTs : undefined,
          },
        });

        const finalText = appendIntegrationConnectionLinks(
          result.trace.finalText,
          result.pendingIntegrationConnections,
          "slack",
          toolConfig,
        );
        if (finalText) {
          const sent = await onFinalMessage(finalText);
          await captureSlackBotReplies({
            conversationId: capture.conversation.id,
            sent,
            channelId: message.channelId,
            threadTs,
            botName: settingsRow?.bot_name,
          });
        }

        for (const filePath of result.pendingUploads) {
          try {
            await slackBot.uploadFile(message.channelId, filePath, threadTs);
          } catch (err) {
            logger.warn({ err, filePath }, "Failed to upload file to Slack");
          }
        }

        await clearAssistantStatus?.();
        if (result.messageSent || result.pendingUploads.length > 0) {
          await repos.conversations.updateCursor({
            conversationId: capture.conversation.id,
            scopeType: SLACK_THREAD_CURSOR_SCOPE,
            scopeKey: threadTs,
            messageId: capture.captured.id,
          });
        }
        if (!finalText) {
          await slackBot.postThreadReply(message.channelId, threadTs, "_No response_");
        }
      } catch (err) {
        if (err instanceof SlackIdentityConflictError) {
          logger.warn(
            {
              slackUserId: message.userId,
              channelId: message.channelId,
              email: err.conflict.email,
              existingUserId: err.conflict.existingUserId,
              existingSlackUserId: err.conflict.existingSlackUserId,
            },
            "Skipping channel mention because Slack identity conflicts with an existing user",
          );
          await slackBot.postThreadReply(
            message.channelId,
            threadTs,
            "I can't reply right now because your Slack account mapping conflicts with an existing Sketch identity. Please ask your admin to reconnect Slack for your workspace.",
          );
          return;
        }
        logger.error({ err, channelId: message.channelId }, "Channel mention handler failed");
        await clearAssistantStatus?.();
        await slackBot.postThreadReply(
          message.channelId,
          threadTs,
          agentFailureMessage(err, SLACK_AGENT_ERROR_MESSAGE, PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE),
        );
      }
    });
  });

  return slackBot;
}
