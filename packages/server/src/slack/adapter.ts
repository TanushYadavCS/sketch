/**
 * Slack adapter — wires Slack event handlers (DM, thread, channel mention) onto a SlackBot.
 * Extracted from index.ts for testability. All handler logic lives here; index.ts only calls
 * createConfiguredSlackBot() and passes the result to the startup manager.
 */
import { join } from "node:path";
import { parseAllowedTools } from "@sketch/shared";
import type { Kysely } from "kysely";
import { type InboxMessageContext, buildSketchContext } from "../agent/prompt";
import type { AgentResult, McpServerConfig, RunAgentParams } from "../agent/runner";
import { deleteSessionId, getSessionId } from "../agent/sessions";
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
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { type Attachment, downloadSlackFile } from "../files";
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
import { slackApiCall } from "./api";
import { SlackBot, type SlackFile } from "./bot";
import { HOME_ACTION_REASONING_TEXT, HOME_ACTION_TOOL_PROGRESS, buildHomeView } from "./home";
import { createSlackMessageHandler } from "./message-handler";
import { SlackIdentityConflictError, resolveSlackUser } from "./resolve-user";
import type { BufferedMessage, ThreadBuffer } from "./thread-buffer";
import type { UserCache } from "./user-cache";

type UserRepository = ReturnType<typeof createUserRepository>;
type ChannelRepository = ReturnType<typeof createChannelRepository>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;
type InboxMessagesRepository = ReturnType<typeof createInboxMessagesRepository>;

function parseInboxMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface SlackAdapterDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  repos: {
    users: UserRepository;
    channels: ChannelRepository;
    settings: SettingsRepository;
  };
  queue: QueueManager;
  slack: {
    threadBuffer: ThreadBuffer;
    userCache: UserCache;
  };
  runAgent: (params: RunAgentParams) => Promise<AgentResult>;
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
    const userQueue = queue.getQueue(user.id);

    userQueue.enqueue(async () => {
      logger.info({ slackUserId: message.userId, channelId: message.channelId }, "Processing message");

      const command = parseSketchCommand(message.text);
      if (command === "new_session") {
        await deleteSessionId(db, user.id);
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

      const attachments = await downloadMessageAttachments({
        files: message.files,
        workspaceDir,
        botToken: settingsRow?.slack_bot_token,
        maxBytes: maxFileBytes,
        logger,
      });

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

        const userMessage = buildSketchContext({
          messages: [],
          currentUserName: user.name,
          currentMessage: message.text || "See attached files.",
          currentUserEmail: user.email,
          workspaceDir,
          orgDir: config.CLAUDE_CONFIG_DIR,
          timezone: user.timezone,
          isSharedContext: false,
          inboxMessages: pendingInbox.messages,
        });

        const result = await runAgent({
          db,
          workspaceKey: user.id,
          userMessage,
          workspaceDir,
          claudeConfigDir: config.CLAUDE_CONFIG_DIR,
          userName: user.name,
          userEmail: user.email,
          logger,
          platform: "slack",
          onProgressEvent,
          ...(assistantThreadTs ? { threadTs: assistantThreadTs } : {}),
          orgName: settingsRow?.org_name,
          botName: settingsRow?.bot_name,
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
          toolConfig,
          inboxMessagesRepo,
          userRepo: repos.users,
          currentUserId: user.id,
          sendDm,
        });

        if (result.trace.finalText) {
          await onFinalMessage(result.trace.finalText);
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
        if (!result.trace.finalText) {
          await replyToUser("_No response_");
        }
      } catch (err) {
        logger.error({ err, userId: user.id }, "Agent run failed");
        await clearAssistantStatus?.();
        await replyToUser("_Something went wrong, try again_");
      }
    });
  });

  // Passive thread message handler
  slackBot.onThreadMessage(async (message) => {
    if (!message.threadTs) return;
    if (!slackDeps.threadBuffer.hasThread(message.channelId, message.threadTs)) return;

    const userInfo = await slackDeps.userCache.resolve(message.userId, (id) => slackBot.getUserInfo(id));

    let downloadedAttachments: Attachment[] = [];
    if (message.files?.length) {
      const workspaceDir = await ensureChannelWorkspace(config, message.channelId);
      const attachDir = join(workspaceDir, "attachments");
      const maxBytes = maxFileBytes;
      const settingsRow = await repos.settings.get();
      downloadedAttachments = await downloadSlackFiles(
        message.files,
        settingsRow?.slack_bot_token,
        attachDir,
        maxBytes,
        logger,
        "Failed to download passive thread file",
      );
    }

    slackDeps.threadBuffer.append(message.channelId, message.threadTs, {
      userName: userInfo.realName,
      text: message.text,
      ts: message.ts,
      ...(downloadedAttachments.length > 0 && { attachments: downloadedAttachments }),
    });

    logger.debug(
      { channelId: message.channelId, threadTs: message.threadTs, user: userInfo.realName },
      "Buffered thread message",
    );
  });

  // Channel mention handler
  slackBot.onChannelMention(async (message) => {
    const threadTs = message.threadTs ?? message.ts;
    const mentionQueue = queue.getQueue(`${message.channelId}:${threadTs}`);

    mentionQueue.enqueue(async () => {
      logger.info({ slackUserId: message.userId, channelId: message.channelId }, "Processing channel mention");

      let user: Awaited<ReturnType<typeof resolveUser>> | undefined;
      let clearAssistantStatus: (() => Promise<void>) | null = null;

      try {
        user = await resolveUser(message.userId);

        let channel = await repos.channels.findBySlackChannelId(message.channelId);
        if (!channel) {
          const channelInfo = await slackBot.getChannelInfo(message.channelId);
          channel = await repos.channels.create({
            slackChannelId: message.channelId,
            name: channelInfo.name,
            type: channelInfo.type,
          });
          logger.info({ channelId: channel.id, name: channel.name }, "New channel created");
        }

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
        if (command === "new_session") {
          await deleteSessionId(db, channelWorkspaceKey, threadTs);
          slackDeps.threadBuffer.reset(message.channelId, threadTs);
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
        const hadRegisteredThread = slackDeps.threadBuffer.hasThread(message.channelId, threadTs);

        slackDeps.threadBuffer.register(message.channelId, threadTs);

        const attachments = await downloadMessageAttachments({
          files: message.files,
          workspaceDir,
          botToken: settingsRow?.slack_bot_token,
          maxBytes: maxFileBytes,
          logger,
        });

        const existingSession = await getSessionId(db, channelWorkspaceKey, threadTs);
        const rawText = message.text || "See attached files.";
        let userMessage: string;

        if (existingSession || hadRegisteredThread) {
          const buffered = slackDeps.threadBuffer.drain(message.channelId, threadTs);
          logger.debug({ threadTs, bufferedCount: buffered.length }, "Draining thread buffer for subsequent mention");
          userMessage = buildSketchContext({
            messages: buffered,
            currentUserName: user.name,
            currentMessage: rawText,
            currentUserEmail: user.email,
            workspaceDir,
            orgDir: config.CLAUDE_CONFIG_DIR,
            timezone: user.timezone,
            isSharedContext: true,
            threadTag: "thread",
            channelContext: { channelName: channel.name },
          });
        } else {
          const history = message.threadTs
            ? await slackBot.getThreadReplies(message.channelId, message.threadTs, config.SLACK_THREAD_HISTORY_LIMIT)
            : await slackBot.getChannelHistory(message.channelId, config.SLACK_CHANNEL_HISTORY_LIMIT);

          const filtered = history.filter((m) => m.ts !== message.ts);

          logger.debug(
            { source: message.threadTs ? "thread" : "channel", messageCount: filtered.length },
            "Bootstrap history fetched",
          );

          const bootstrapMessages: BufferedMessage[] = [];
          for (const msg of filtered.reverse()) {
            const info = await slackDeps.userCache.resolve(msg.userId, (id) => slackBot.getUserInfo(id));
            bootstrapMessages.push({ userName: info.realName, text: msg.text, ts: msg.ts });
          }
          const threadTag = message.threadTs ? "thread" : "channel_history";
          userMessage = buildSketchContext({
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
          });
        }

        const onFinalMessage = createSlackMessageHandler(slackBot, message.channelId, threadTs);
        const shimmer = createShimmer(slackBot, message.channelId, threadTs, resolveProgressDisplaySettings(channel));
        clearAssistantStatus = shimmer.clear;
        const onProgressEvent = shimmer.onProgressEvent;

        const integrationMcpServers = await buildMcpServers(user.email);

        const agentInstructions = boundAgent?.description ?? null;
        const agentAllowedTools = boundAgent ? parseAllowedTools(boundAgent.allowed_tools) : null;

        const result = await runAgent({
          db,
          workspaceKey: channelWorkspaceKey,
          userMessage,
          workspaceDir,
          claudeConfigDir: config.CLAUDE_CONFIG_DIR,
          userName: user.name,
          userEmail: user.email,
          logger,
          platform: "slack",
          onProgressEvent,
          threadTs,
          orgName: settingsRow?.org_name,
          botName: settingsRow?.bot_name,
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
          toolConfig,
          inboxMessagesRepo,
          userRepo: repos.users,
          sendDm,
          agentInstructions,
          agentAllowedTools,
        });

        if (result.trace.finalText) {
          await onFinalMessage(result.trace.finalText);
        }

        for (const filePath of result.pendingUploads) {
          try {
            await slackBot.uploadFile(message.channelId, filePath, threadTs);
          } catch (err) {
            logger.warn({ err, filePath }, "Failed to upload file to Slack");
          }
        }

        await clearAssistantStatus?.();
        if (!result.trace.finalText) {
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
        await slackBot.postThreadReply(message.channelId, threadTs, "_Something went wrong, try again_");
      }
    });
  });

  return slackBot;
}
