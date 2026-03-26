/**
 * Slack adapter — wires Slack event handlers (DM, thread, channel mention) onto a SlackBot.
 * Extracted from index.ts for testability. All handler logic lives here; index.ts only calls
 * createConfiguredSlackBot() and passes the result to the startup manager.
 */
import { join } from "node:path";
import type { Kysely } from "kysely";
import { buildSketchContext } from "../agent/prompt";
import type { AgentResult, McpServerConfig, RunAgentParams } from "../agent/runner";
import { getSessionId } from "../agent/sessions";
import { ensureChannelWorkspace, ensureWorkspace } from "../agent/workspace";
import type { Config } from "../config";
import type { createChannelRepository } from "../db/repositories/channels";
import type { createOutreachRepository } from "../db/repositories/outreach";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { type Attachment, downloadSlackFile } from "../files";
import type { Logger } from "../logger";
import type { QueueManager } from "../queue";
import type { TaskScheduler } from "../scheduler/service";
import { slackApiCall } from "./api";
import { SlackBot, type SlackFile } from "./bot";
import { createSlackMessageHandler } from "./message-handler";
import { resolveSlackUser } from "./resolve-user";
import type { BufferedMessage, ThreadBuffer } from "./thread-buffer";
import type { UserCache } from "./user-cache";

type UserRepository = ReturnType<typeof createUserRepository>;
type ChannelRepository = ReturnType<typeof createChannelRepository>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;
type OutreachRepository = ReturnType<typeof createOutreachRepository>;

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
  findIntegrationProvider: () => Promise<{ type: string; credentials: string } | null>;
  scheduler?: TaskScheduler;
  outreachRepo?: OutreachRepository;
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
    findIntegrationProvider,
    scheduler,
    outreachRepo,
  } = deps;
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

  /**
   * Sends a DM to a user via their Slack channel. Fetches fresh settings on each call so the
   * token is always current. Used both in normal DM handling and in outreach response runs.
   */
  const sendDmViaSlack = async ({
    userId,
    message: dmMessage,
  }: { userId: string; platform: string; message: string }) => {
    const settings = await repos.settings.get();
    const recipient = await repos.users.findById(userId);
    if (!recipient?.slack_user_id) throw new Error("No Slack ID for recipient");
    const channelId = await slackBot.openDmChannel(recipient.slack_user_id, settings?.slack_bot_token ?? undefined);
    if (!channelId) throw new Error("Failed to open DM channel");
    const messageRef = await slackBot.postMessage(channelId, dmMessage);
    return { channelId, messageRef };
  };

  /**
   * Enqueues a synthetic agent run in the requester's queue, delivering an outreach response
   * as a pre-formatted <context> message. The requester's agent resumes its session and can
   * continue the original task with the new information.
   *
   * Defined at adapter level (not inside the queue callback) so the requester's agent run
   * can reference the same function for any further outreach it initiates.
   */
  const enqueueMessageViaSlack = async ({ requesterUserId, message }: { requesterUserId: string; message: string }) => {
    const requester = await repos.users.findById(requesterUserId);
    if (!requester?.slack_user_id) {
      logger.warn({ requesterUserId }, "Cannot deliver outreach response: requester has no Slack ID");
      return;
    }

    const settings = await repos.settings.get();
    const dmChannelId = await slackBot.openDmChannel(requester.slack_user_id, settings?.slack_bot_token ?? undefined);
    if (!dmChannelId) {
      logger.warn({ requesterUserId }, "Cannot deliver outreach response: failed to open DM channel");
      return;
    }

    const requesterQueue = queue.getQueue(requesterUserId);
    requesterQueue.enqueue(async () => {
      const workspaceDir = await ensureWorkspace(config, requesterUserId);
      const currentSettings = await repos.settings.get();

      const thinkingTs = await slackBot.postMessage(dmChannelId, "_Thinking..._");
      const onMessage = createSlackMessageHandler(slackBot, dmChannelId, thinkingTs);

      const integrationMcpServers = await buildMcpServers(requester.email);

      try {
        const agentResult = await runAgent({
          db,
          workspaceKey: requesterUserId,
          userMessage: message,
          workspaceDir,
          userName: requester.name,
          userEmail: requester.email,
          logger,
          platform: "slack",
          onMessage,
          orgName: currentSettings?.org_name,
          botName: currentSettings?.bot_name,
          integrationMcpServers,
          findIntegrationProvider,
          contextType: "outreach",
          taskContext: {
            platform: "slack" as const,
            contextType: "dm" as const,
            deliveryTarget: dmChannelId,
            createdBy: requesterUserId,
          },
          scheduler,
          outreachRepo,
          userRepo: repos.users,
          currentUserId: requesterUserId,
          sendDm: sendDmViaSlack,
          enqueueMessage: enqueueMessageViaSlack,
        });

        for (const filePath of agentResult.pendingUploads) {
          try {
            await slackBot.uploadFile(dmChannelId, filePath);
          } catch (err) {
            logger.warn({ err, filePath }, "Failed to upload file");
          }
        }

        if (!agentResult.messageSent) {
          await slackBot.updateMessage(dmChannelId, thinkingTs, "_No response_");
        }
      } catch (err) {
        logger.error({ err, requesterUserId }, "Outreach response agent run failed");
        await slackBot.updateMessage(dmChannelId, thinkingTs, "_Something went wrong_");
      }
    });
  };

  // DM handler
  slackBot.onMessage(async (message) => {
    const user = await resolveUser(message.userId);
    const userQueue = queue.getQueue(user.id);

    userQueue.enqueue(async () => {
      logger.info({ slackUserId: message.userId, channelId: message.channelId }, "Processing message");

      const workspaceDir = await ensureWorkspace(config, user.id);
      const settingsRow = await repos.settings.get();

      // Download any attached files
      let attachments: Attachment[] = [];
      if (message.files?.length) {
        logger.debug(
          {
            fileCount: message.files.length,
            files: message.files.map((f) => ({
              name: f.name,
              mime: f.mimetype,
              size: f.size,
              url: f.urlPrivate?.slice(0, 80),
            })),
          },
          "Files received from Slack",
        );
        const attachDir = join(workspaceDir, "attachments");
        const maxBytes = maxFileBytes;
        attachments = await downloadSlackFiles(
          message.files,
          settingsRow?.slack_bot_token,
          attachDir,
          maxBytes,
          logger,
        );
        logger.debug(
          {
            attachmentCount: attachments.length,
            attachments: attachments.map((a) => ({ name: a.originalName, mime: a.mimeType, size: a.sizeBytes })),
          },
          "Files downloaded",
        );
      }

      // Post thinking indicator
      const thinkingTs = await slackBot.postMessage(message.channelId, "_Thinking..._");
      const onMessage = createSlackMessageHandler(slackBot, message.channelId, thinkingTs);

      const integrationMcpServers = await buildMcpServers(user.email);

      // Resolve outreach context: pending inbound (recipient) and pending outbound (requester)
      const pendingInbound = outreachRepo ? await outreachRepo.findPendingForRecipient(user.id) : [];
      const pendingOutbound = outreachRepo ? await outreachRepo.findPendingForRequester(user.id) : [];
      let userMessage = message.text || "See attached files.";
      if (pendingInbound.length > 0 || pendingOutbound.length > 0) {
        const allUsers = await repos.users.list();
        const usersById = new Map(allUsers.map((u) => [u.id, u]));
        userMessage = buildSketchContext({
          messages: [],
          currentUserName: user.name,
          currentMessage: userMessage,
          isSharedContext: false,
          pendingOutreach: pendingInbound.map((o) => ({
            id: o.id,
            message: o.message,
            taskContext: o.task_context,
            status: o.status,
            createdAt: o.created_at,
            respondedAt: o.responded_at,
            requesterName: usersById.get(o.requester_user_id)?.name ?? "Unknown",
          })),
          outreachResponses: pendingOutbound.map((o) => ({
            id: o.id,
            message: o.message,
            taskContext: o.task_context,
            status: o.status,
            response: o.response,
            createdAt: o.created_at,
            respondedAt: o.responded_at,
            recipientName: usersById.get(o.recipient_user_id)?.name ?? "Unknown",
          })),
        });
      }

      try {
        const result = await runAgent({
          db,
          workspaceKey: user.id,
          userMessage,
          workspaceDir,
          userName: user.name,
          userEmail: user.email,
          logger,
          platform: "slack",
          onMessage,
          orgName: settingsRow?.org_name,
          botName: settingsRow?.bot_name,
          attachments: attachments.length > 0 ? attachments : undefined,
          integrationMcpServers,
          findIntegrationProvider,
          contextType: "dm",
          taskContext: {
            platform: "slack" as const,
            contextType: "dm" as const,
            deliveryTarget: message.channelId,
            createdBy: user.id,
          },
          scheduler,
          outreachRepo,
          userRepo: repos.users,
          currentUserId: user.id,
          sendDm: sendDmViaSlack,
          enqueueMessage: enqueueMessageViaSlack,
        });

        for (const filePath of result.pendingUploads) {
          try {
            await slackBot.uploadFile(message.channelId, filePath);
          } catch (err) {
            logger.warn({ err, filePath }, "Failed to upload file to Slack");
          }
        }

        if (!result.messageSent) {
          await slackBot.updateMessage(message.channelId, thinkingTs, "_No response_");
        }
      } catch (err) {
        logger.error({ err, userId: user.id }, "Agent run failed");
        await slackBot.updateMessage(message.channelId, thinkingTs, "_Something went wrong, try again_");
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

      let user: Awaited<ReturnType<typeof resolveUser>>;
      let thinkingTs: string | undefined;

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

        const workspaceDir = await ensureChannelWorkspace(config, message.channelId);
        const settingsRow = await repos.settings.get();

        slackDeps.threadBuffer.register(message.channelId, threadTs);

        // Download any attached files
        let attachments: Attachment[] = [];
        if (message.files?.length) {
          logger.debug(
            {
              fileCount: message.files.length,
              files: message.files.map((f) => ({
                name: f.name,
                mime: f.mimetype,
                size: f.size,
                url: f.urlPrivate?.slice(0, 80),
              })),
            },
            "Files received from Slack",
          );
          const attachDir = join(workspaceDir, "attachments");
          const maxBytes = maxFileBytes;
          attachments = await downloadSlackFiles(
            message.files,
            settingsRow?.slack_bot_token,
            attachDir,
            maxBytes,
            logger,
          );
          logger.debug(
            {
              attachmentCount: attachments.length,
              attachments: attachments.map((a) => ({ name: a.originalName, mime: a.mimeType, size: a.sizeBytes })),
            },
            "Files downloaded",
          );
        }

        const channelWorkspaceKey = `channel-${message.channelId}`;
        const existingSession = await getSessionId(db, channelWorkspaceKey, threadTs);
        let userMessage = message.text || "See attached files.";

        if (existingSession) {
          const buffered = slackDeps.threadBuffer.drain(message.channelId, threadTs);
          logger.debug({ threadTs, bufferedCount: buffered.length }, "Draining thread buffer for subsequent mention");
          userMessage = buildSketchContext({
            messages: buffered,
            currentUserName: user.name,
            currentMessage: userMessage,
            currentUserEmail: user.email,
            isSharedContext: true,
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
          const header = message.threadTs
            ? "[Thread context before you joined]"
            : "[Recent channel messages for context]";
          userMessage = buildSketchContext({
            messages: bootstrapMessages,
            currentUserName: user.name,
            currentMessage: userMessage,
            currentUserEmail: user.email,
            header,
            isSharedContext: true,
          });
        }

        thinkingTs = await slackBot.postThreadReply(message.channelId, threadTs, "_Thinking..._");
        const onMessage = createSlackMessageHandler(slackBot, message.channelId, thinkingTs, threadTs);

        const integrationMcpServers = await buildMcpServers(user.email);

        const result = await runAgent({
          db,
          workspaceKey: channelWorkspaceKey,
          userMessage,
          workspaceDir,
          userName: user.name,
          userEmail: user.email,
          logger,
          platform: "slack",
          onMessage,
          threadTs,
          orgName: settingsRow?.org_name,
          botName: settingsRow?.bot_name,
          attachments: attachments.length > 0 ? attachments : undefined,
          channelContext: {
            channelName: channel.name,
          },
          integrationMcpServers,
          findIntegrationProvider,
          contextType: "channel_mention",
          currentUserId: user.id,
          taskContext: {
            platform: "slack" as const,
            contextType: "channel" as const,
            deliveryTarget: message.channelId,
            createdBy: user.id,
            threadTs: message.threadTs ? threadTs : undefined,
          },
          scheduler,
        });

        for (const filePath of result.pendingUploads) {
          try {
            await slackBot.uploadFile(message.channelId, filePath, threadTs);
          } catch (err) {
            logger.warn({ err, filePath }, "Failed to upload file to Slack");
          }
        }

        if (!result.messageSent) {
          await slackBot.updateMessage(message.channelId, thinkingTs, "_No response_");
        }
      } catch (err) {
        logger.error({ err, channelId: message.channelId }, "Channel mention handler failed");
        if (thinkingTs) {
          await slackBot.updateMessage(message.channelId, thinkingTs, "_Something went wrong, try again_");
        }
      }
    });
  });

  return slackBot;
}
