/**
 * WhatsApp adapter — wires WhatsApp event handlers (DM, group) onto a WhatsAppBot.
 * Extracted from index.ts for testability.
 */
import { basename, join } from "node:path";
import { parseAllowedTools } from "@sketch/shared";
import type { WAMessage } from "@whiskeysockets/baileys";
import type { Kysely } from "kysely";
import { PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE, agentFailureMessage } from "../agent/errors";
import type { InboxMessageContext } from "../agent/prompt";
import { buildSketchContext } from "../agent/prompt";
import type { AgentResult, McpServerConfig, RunAgentParams } from "../agent/runner";
import { deleteSessionId } from "../agent/sessions";
import { createProgressRenderer, getProgressTransportStrategy } from "../agent/tool-progress";
import { ensureAgentSubWorkspace, ensureGroupWorkspace, ensureWorkspace } from "../agent/workspace";
import {
  type ReasoningTextCommand,
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
import type { createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { type createSettingsRepository, parseOrgContext } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { type Attachment, downloadWhatsAppMedia, extensionToMime } from "../files";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import {
  getUnknownReasoningTextMessage,
  getUnknownToolProgressMessage,
  isReasoningTextCommand,
  isToolProgressCommand,
  resolveProgressDisplaySettings,
} from "../progress-settings";
import type { QueueManager } from "../queue";
import type { TaskScheduler } from "../scheduler/service";
import { transcribeEagerAttachments } from "../transcription/service";
import type { WhatsAppBot, WhatsAppMessage } from "./bot";
import { createWhatsAppMessageHandler } from "./message-handler";
import { createWhatsAppProgressTransport } from "./progress-transport";
import { phoneToTimezone } from "./timezone";

type UserRepository = ReturnType<typeof createUserRepository>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;
type InboxMessagesRepository = ReturnType<typeof createInboxMessagesRepository>;
type WhatsAppGroupsRepository = ReturnType<typeof createWhatsAppGroupRepository>;
type ConversationRepository = ReturnType<typeof createConversationRepository>;

const INLINE_BACKLOG_LIMIT = 10;
const WHATSAPP_AGENT_ERROR_MESSAGE = "Something went wrong, try again.";

function parseInboxMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface WhatsAppAdapterDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  repos: {
    users: UserRepository;
    settings: SettingsRepository;
    whatsappGroups: WhatsAppGroupsRepository;
    conversations: ConversationRepository;
  };
  queue: QueueManager;
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

async function flushWhatsAppProgressTransport(
  progressTransport: { flush(): Promise<void> } | null,
  logger: Logger,
  context: { userId?: string; jid?: string; groupJid?: string },
) {
  if (!progressTransport) return;

  try {
    await progressTransport.flush();
  } catch (err) {
    logger.warn({ err, ...context }, "Failed to flush WhatsApp progress updates");
  }
}

function toPhoneJid(phoneNumber: string): string {
  return `${phoneNumber.replace("+", "")}@s.whatsapp.net`;
}

function providerTimestamp(message: WAMessage | undefined): string | null {
  const timestamp = message?.messageTimestamp;
  if (timestamp == null) return null;
  const seconds = Number(timestamp);
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

function conversationRefForMessage(message: WhatsAppMessage): {
  platform: string;
  kind: string;
  providerConversationId: string;
} {
  if (message.type === "dm") {
    return { platform: "whatsapp", kind: "dm", providerConversationId: toPhoneJid(message.phoneNumber) };
  }
  return { platform: "whatsapp", kind: "group", providerConversationId: message.jid };
}

function senderJidForMessage(message: WhatsAppMessage): string {
  return message.type === "dm" ? toPhoneJid(message.phoneNumber) : message.senderJid;
}

export function wireWhatsAppHandlers(whatsapp: WhatsAppBot, deps: WhatsAppAdapterDeps): void {
  const {
    db,
    config,
    logger,
    repos,
    queue,
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

  const resolveCommandToolProgress = (command: ReturnType<typeof parseSketchCommand>): ToolProgressCommand | null => {
    if (!command?.startsWith("tool_progress_") || command === "tool_progress_query") return null;
    return command.slice("tool_progress_".length) as ToolProgressCommand;
  };
  const resolveCommandReasoningText = (command: ReturnType<typeof parseSketchCommand>): ReasoningTextCommand | null => {
    if (!command?.startsWith("reasoning_text_") || command === "reasoning_text_query") return null;
    return command.slice("reasoning_text_".length) as ReasoningTextCommand;
  };
  const updateReaction = async (jid: string, rawMessage: WAMessage, emoji: string | null) => {
    if (!whatsapp.isConnected || !rawMessage.key) return;

    try {
      if (emoji === null) {
        await whatsapp.removeReaction(jid, rawMessage.key);
      } else {
        await whatsapp.addReaction(jid, rawMessage.key, emoji);
      }
    } catch (err) {
      logger.debug({ err, jid, emoji }, "Failed to update WhatsApp reaction");
    }
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

  const downloadMessageAttachments = async (message: WhatsAppMessage, workspaceDir: string): Promise<Attachment[]> => {
    if (!message.mediaType || !whatsapp.socket) return [];

    const attachDir = join(workspaceDir, "attachments");
    try {
      const attachment = await downloadWhatsAppMedia(
        message.rawMessage,
        whatsapp.socket,
        attachDir,
        maxFileBytes,
        logger,
      );
      return [attachment];
    } catch (err) {
      logger.warn({ err, mediaType: message.mediaType }, "Failed to download WhatsApp media");
      return [];
    }
  };

  const captureUserMessage = async (params: {
    message: WhatsAppMessage;
    workspaceDir: string;
    senderName: string;
    senderUserId?: string | null;
    addressedToSketch: boolean;
  }) => {
    const conversation = await repos.conversations.getOrCreate(
      conversationRefForMessage(params.message),
      params.message.type === "group" ? params.message.jid : params.senderName,
    );

    if (isConversationControlMessage(params.message.text)) {
      return { conversation, captured: null, attachments: [] as Attachment[], inserted: false, omitted: true };
    }

    const attachments = await downloadMessageAttachments(params.message, params.workspaceDir);
    const captured = await repos.conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: params.message.messageId,
      senderJid: senderJidForMessage(params.message),
      senderName: params.senderName,
      senderUserId: params.senderUserId ?? null,
      addressedToSketch: params.addressedToSketch,
      text: params.message.text || (attachments.length > 0 ? "See attached files." : ""),
      attachments,
      providerTimestamp: providerTimestamp(params.message.rawMessage as WAMessage),
    });

    return { conversation, captured: captured.row, attachments, inserted: captured.inserted, omitted: false };
  };

  const captureBotReply = async (params: {
    conversationId: number;
    sent: WAMessage | null;
    text: string;
    botName?: string | null;
  }) => {
    const providerMessageId = params.sent?.key?.id;
    if (!providerMessageId) return;

    await repos.conversations.insertMessage({
      conversationId: params.conversationId,
      providerMessageId,
      senderJid: "bot",
      senderName: params.botName ?? "Sketch",
      isBot: true,
      addressedToSketch: false,
      text: params.text,
      providerTimestamp: providerTimestamp(params.sent ?? undefined),
    });
  };

  whatsapp.onMessage(async (message) => {
    if (message.type === "dm") {
      // --- DM handler ---
      const replyJid = toPhoneJid(message.phoneNumber);
      let user = await repos.users.findByWhatsappNumber(message.phoneNumber);
      if (!user) {
        const settingsRow = await repos.settings.get();
        const fallbackAgentId = settingsRow?.whatsapp_fallback_agent_id ?? null;
        if (!fallbackAgentId) {
          await whatsapp.sendText(
            replyJid,
            "Sorry, you're not authorized to use this bot. Contact your admin to get access.",
          );
          return;
        }
        const fallbackAgent = await repos.users.findById(fallbackAgentId);
        if (!fallbackAgent || fallbackAgent.type !== "agent") {
          logger.warn(
            { fallbackAgentId },
            "WhatsApp fallback agent is missing or not an agent; dropping unknown-sender DM",
          );
          return;
        }
        user = await repos.users.create({
          name: "External user",
          type: "external",
          whatsappNumber: message.phoneNumber,
        });
        logger.info(
          { externalUserId: user.id, fallbackAgentId },
          "Auto-created external user for unknown WhatsApp sender",
        );
      }

      if (!user.timezone) {
        const derivedTz = phoneToTimezone(user.whatsapp_number ?? message.phoneNumber);
        if (derivedTz) {
          user = await repos.users.update(user.id, { timezone: derivedTz });
          logger.debug({ userId: user.id, timezone: derivedTz }, "wa adapter: hydrated timezone from phone number");
        }
      }

      const activeQueueKey = user.id;
      const userQueue = queue.getQueue(activeQueueKey);

      userQueue.enqueue(async () => {
        const command = parseSketchCommand(message.text);
        const settingsRowEarly = await repos.settings.get();
        const fallbackAgentEarly =
          user.type === "external" && settingsRowEarly?.whatsapp_fallback_agent_id
            ? await repos.users.findById(settingsRowEarly.whatsapp_fallback_agent_id)
            : null;
        const dmWorkspaceKeyEarly = fallbackAgentEarly ? `agent-${fallbackAgentEarly.id}/${user.id}` : user.id;
        const dmConversation = await repos.conversations.getOrCreate(conversationRefForMessage(message), user.name);
        if (command === "new_session") {
          await deleteSessionId(db, dmWorkspaceKeyEarly);
          await repos.conversations.advanceWatermarkToCurrentMax(dmConversation.id);
          await whatsapp.sendText(replyJid, getNewSessionConfirmation());
          return;
        }

        if (!command && isToolProgressCommand(message.text)) {
          await whatsapp.sendText(replyJid, getUnknownToolProgressMessage(message.text));
          return;
        }

        if (!command && isReasoningTextCommand(message.text)) {
          await whatsapp.sendText(replyJid, getUnknownReasoningTextMessage(message.text));
          return;
        }

        const currentProgressSettings = resolveProgressDisplaySettings(user);
        if (command === "tool_progress_query") {
          await whatsapp.sendText(replyJid, getToolProgressCurrent(currentProgressSettings));
          return;
        }

        if (command === "reasoning_text_query") {
          await whatsapp.sendText(replyJid, getReasoningTextCurrent(currentProgressSettings));
          return;
        }

        const requestedToolProgress = resolveCommandToolProgress(command);
        if (requestedToolProgress) {
          await repos.users.update(user.id, { toolProgress: requestedToolProgress });
          await whatsapp.sendText(
            replyJid,
            getToolProgressConfirmation(requestedToolProgress, currentProgressSettings.reasoningText),
          );
          return;
        }

        const requestedReasoningText = resolveCommandReasoningText(command);
        if (requestedReasoningText) {
          const enabled = requestedReasoningText === "on";
          await repos.users.update(user.id, { reasoningText: enabled });
          await whatsapp.sendText(replyJid, getReasoningTextConfirmation(enabled));
          return;
        }

        const settingsRow = settingsRowEarly;
        const fallbackAgent = fallbackAgentEarly;
        const workspaceDir = fallbackAgent
          ? await ensureAgentSubWorkspace(config, fallbackAgent.id, user.id)
          : await ensureWorkspace(config, user.id);
        const dmWorkspaceKey = dmWorkspaceKeyEarly;
        const deliveryJid = toPhoneJid(user.whatsapp_number ?? message.phoneNumber);
        const reactionJid = (message.rawMessage as WAMessage).key?.remoteJid ?? message.jid;
        const capture = await captureUserMessage({
          message,
          workspaceDir,
          senderName: user.name,
          senderUserId: user.id,
          addressedToSketch: true,
        });
        if (!capture.inserted || !capture.captured) return;

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

        whatsapp.startComposing(deliveryJid);
        await updateReaction(reactionJid, message.rawMessage as WAMessage, "👀");
        let progressTransport: ReturnType<typeof createWhatsAppProgressTransport> | null = null;

        try {
          let attachments: Attachment[] = capture.attachments;
          attachments = await transcribeEagerAttachments(attachments, {
            loadSettings: () => repos.settings.get(),
            logger,
          });

          const onFinalMessage = createWhatsAppMessageHandler(whatsapp, deliveryJid);
          const progressSettings = resolveProgressDisplaySettings(user);
          const progressRenderer = createProgressRenderer(progressSettings);
          const progressStrategy = getProgressTransportStrategy(progressSettings);
          progressTransport =
            progressStrategy === "none"
              ? null
              : createWhatsAppProgressTransport(whatsapp, deliveryJid, progressStrategy);
          const onProgressEvent: RunAgentParams["onProgressEvent"] = async (event) => {
            if (!progressTransport) return;
            progressRenderer.renderEvent(event);
            await progressTransport.syncLines(progressRenderer.getLines());
          };

          const waIntegrationMcpServers = await buildMcpServers(user.email);
          const pendingInbox = await loadPendingInboxMessages(user.id);

          const userMessage = buildSketchContext({
            messages: [],
            currentUserName: user.name,
            currentMessage: message.text || "See attached files.",
            currentUserEmail: user.email,
            currentUserPhone: user.whatsapp_number ?? message.phoneNumber,
            workspaceDir,
            orgDir: fallbackAgent ? undefined : config.CLAUDE_CONFIG_DIR,
            timezone: user.timezone,
            isSharedContext: false,
            inboxMessages: pendingInbox.messages,
            conversationBacklog,
          });

          const waTaskContext = {
            platform: "whatsapp" as const,
            contextType: "dm" as const,
            deliveryTarget: deliveryJid,
            createdBy: user.id,
            creatorTimezone: user.timezone,
          };

          const agentInstructions = fallbackAgent?.description ?? null;
          const agentAllowedTools = fallbackAgent ? parseAllowedTools(fallbackAgent.allowed_tools) : null;

          const result = await runAgent({
            db,
            workspaceKey: dmWorkspaceKey,
            userMessage,
            workspaceDir,
            // Skip ~/.claude org context for fallback runs so external users
            // do not see the organisation's preset.
            claudeConfigDir: fallbackAgent ? undefined : config.CLAUDE_CONFIG_DIR,
            userName: user.name,
            userEmail: user.email,
            userPhone: user.whatsapp_number ?? message.phoneNumber,
            logger,
            platform: "whatsapp",
            onProgressEvent,
            orgName: settingsRow?.org_name,
            orgDescription: parseOrgContext(settingsRow?.org_context)?.description ?? null,
            botName: settingsRow?.bot_name,
            attachments: attachments.length > 0 ? attachments : undefined,
            integrationMcpServers: waIntegrationMcpServers,
            loadIntegrationProvider,
            contextType: "dm",
            taskContext: waTaskContext,
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
            agentInstructions,
            agentAllowedTools,
            conversationRepo: repos.conversations,
            conversationContext: { conversationId: capture.conversation.id, currentMessageId: capture.captured.id },
          });

          await flushWhatsAppProgressTransport(progressTransport, logger, { userId: user.id, jid: deliveryJid });
          if (result.trace.finalText) {
            const sent = await onFinalMessage(result.trace.finalText);
            await captureBotReply({
              conversationId: capture.conversation.id,
              sent,
              text: result.trace.finalText,
              botName: settingsRow?.bot_name,
            });
          }

          for (const filePath of result.pendingUploads) {
            try {
              if (whatsapp.isConnected) {
                const ext = filePath.split(".").pop() ?? "";
                const mime = extensionToMime(ext);
                await whatsapp.sendFile(deliveryJid, filePath, mime, basename(filePath));
              }
            } catch (err) {
              logger.warn({ err, filePath }, "Failed to send file via WhatsApp");
            }
          }

          if (pendingInbox.ids.length > 0 && inboxMessagesRepo) {
            await inboxMessagesRepo.markConsumed(pendingInbox.ids);
          }
          if (result.messageSent || result.pendingUploads.length > 0) {
            await repos.conversations.updateWatermark(capture.conversation.id, capture.captured.id);
          }
          await updateReaction(reactionJid, message.rawMessage as WAMessage, null);
          await updateReaction(reactionJid, message.rawMessage as WAMessage, "✅");
        } catch (err) {
          logger.error({ err, userId: user.id }, "Agent run failed (WhatsApp)");
          await flushWhatsAppProgressTransport(progressTransport, logger, { userId: user.id, jid: deliveryJid });
          await updateReaction(reactionJid, message.rawMessage as WAMessage, null);
          if (whatsapp.isConnected) {
            await whatsapp.sendText(deliveryJid, agentFailureMessage(err, WHATSAPP_AGENT_ERROR_MESSAGE));
          }
        } finally {
          whatsapp.stopComposing(deliveryJid);
        }
      });
      return;
    }

    // --- Group handler ---

    if (!message.isMentioned) {
      const user = message.senderPhone ? await repos.users.findByWhatsappNumber(message.senderPhone) : undefined;
      const existingGroup = await repos.whatsappGroups.getByJid(message.jid);
      const boundAgent = existingGroup?.agent_user_id ? await repos.users.findById(existingGroup.agent_user_id) : null;
      const workspaceDir = boundAgent
        ? await ensureAgentSubWorkspace(config, boundAgent.id, `whatsappgroup-${message.jid}`)
        : await ensureGroupWorkspace(config, message.jid);
      await captureUserMessage({
        message,
        workspaceDir,
        senderName: user?.name ?? message.pushName,
        senderUserId: user?.id ?? null,
        addressedToSketch: false,
      });
      return;
    }

    const user = message.senderPhone ? await repos.users.findByWhatsappNumber(message.senderPhone) : undefined;
    const userName = user?.name ?? message.pushName;

    const groupJid = message.jid;
    const activeQueueKey = `wa-group-${groupJid}`;
    const groupQueue = queue.getQueue(activeQueueKey);

    groupQueue.enqueue(async () => {
      const command = parseSketchCommand(message.text);
      const existingGroupForBinding = await repos.whatsappGroups.getByJid(groupJid);
      const boundAgent = existingGroupForBinding?.agent_user_id
        ? await repos.users.findById(existingGroupForBinding.agent_user_id)
        : null;
      if (existingGroupForBinding?.agent_user_id && !boundAgent) {
        logger.warn(
          { groupJid, agentUserId: existingGroupForBinding.agent_user_id },
          "Group binding references missing agent; running with default behaviour",
        );
      }
      const groupWorkspaceKey = boundAgent
        ? `agent-${boundAgent.id}/whatsappgroup-${groupJid}`
        : `wa-group-${groupJid}`;
      const groupConversation = await repos.conversations.getOrCreate(conversationRefForMessage(message));
      if (command === "new_session") {
        await deleteSessionId(db, groupWorkspaceKey);
        await repos.conversations.advanceWatermarkToCurrentMax(groupConversation.id);
        const onFinalMessage = createWhatsAppMessageHandler(whatsapp, groupJid, message.rawMessage as WAMessage);
        await onFinalMessage(getNewSessionConfirmation());
        return;
      }

      const workspaceDir = boundAgent
        ? await ensureAgentSubWorkspace(config, boundAgent.id, `whatsappgroup-${groupJid}`)
        : await ensureGroupWorkspace(config, groupJid);
      const settingsRow = await repos.settings.get();
      const groupMeta = await whatsapp.getGroupMetadata(groupJid);
      const groupName = groupMeta?.subject ?? "Unknown Group";
      const groupDescription = groupMeta?.desc ?? undefined;
      const existingGroup = existingGroupForBinding;
      await repos.conversations.getOrCreate(conversationRefForMessage(message), groupName);

      if (!command && isToolProgressCommand(message.text)) {
        await whatsapp.sendText(groupJid, getUnknownToolProgressMessage(message.text), {
          quoted: message.rawMessage as WAMessage,
        });
        return;
      }

      if (!command && isReasoningTextCommand(message.text)) {
        await whatsapp.sendText(groupJid, getUnknownReasoningTextMessage(message.text), {
          quoted: message.rawMessage as WAMessage,
        });
        return;
      }

      const currentProgressSettings = resolveProgressDisplaySettings(existingGroup ?? {});
      if (command === "tool_progress_query") {
        await whatsapp.sendText(groupJid, getToolProgressCurrent(currentProgressSettings), {
          quoted: message.rawMessage as WAMessage,
        });
        return;
      }

      if (command === "reasoning_text_query") {
        await whatsapp.sendText(groupJid, getReasoningTextCurrent(currentProgressSettings), {
          quoted: message.rawMessage as WAMessage,
        });
        return;
      }

      const requestedToolProgress = resolveCommandToolProgress(command);
      if (requestedToolProgress) {
        await repos.whatsappGroups.upsert({
          jid: groupJid,
          name: groupName,
          description: groupDescription ?? null,
          tool_progress: requestedToolProgress,
          reasoning_text: currentProgressSettings.reasoningText ? 1 : 0,
          updated_at: new Date().toISOString(),
        });
        await whatsapp.sendText(
          groupJid,
          getToolProgressConfirmation(requestedToolProgress, currentProgressSettings.reasoningText),
          {
            quoted: message.rawMessage as WAMessage,
          },
        );
        return;
      }

      const requestedReasoningText = resolveCommandReasoningText(command);
      if (requestedReasoningText) {
        const enabled = requestedReasoningText === "on";
        await repos.whatsappGroups.upsert({
          jid: groupJid,
          name: groupName,
          description: groupDescription ?? null,
          tool_progress: currentProgressSettings.toolProgress,
          reasoning_text: enabled ? 1 : 0,
          updated_at: new Date().toISOString(),
        });
        await whatsapp.sendText(groupJid, getReasoningTextConfirmation(enabled), {
          quoted: message.rawMessage as WAMessage,
        });
        return;
      }

      const capture = await captureUserMessage({
        message,
        workspaceDir,
        senderName: userName,
        senderUserId: user?.id ?? null,
        addressedToSketch: true,
      });
      if (!capture.inserted || !capture.captured) return;

      const backlog = await repos.conversations.listBacklog({
        conversationId: capture.conversation.id,
        afterMessageId: groupConversation.last_seen_message_id,
        beforeMessageId: capture.captured.id,
        limit: INLINE_BACKLOG_LIMIT,
      });
      const conversationBacklog =
        backlog.messages.length > 0 || backlog.hasMore
          ? {
              messages: backlog.messages,
              afterMessageId: groupConversation.last_seen_message_id,
              beforeMessageId: capture.captured.id,
              hasMore: backlog.hasMore,
              nextCursor: backlog.nextCursor,
            }
          : undefined;

      whatsapp.startComposing(groupJid);
      await updateReaction(groupJid, message.rawMessage as WAMessage, "👀");
      let progressTransport: ReturnType<typeof createWhatsAppProgressTransport> | null = null;

      try {
        let attachments: Attachment[] = capture.attachments;
        attachments = await transcribeEagerAttachments(attachments, {
          loadSettings: () => repos.settings.get(),
          logger,
        });

        const userMessage = buildSketchContext({
          messages: [],
          currentUserName: userName,
          currentMessage: message.text || "See attached files.",
          currentUserEmail: user?.email ?? null,
          currentUserPhone: user?.whatsapp_number ?? null,
          workspaceDir,
          orgDir: config.CLAUDE_CONFIG_DIR,
          timezone: user?.timezone ?? null,
          isSharedContext: true,
          threadTag: "thread",
          groupContext: { groupName, groupDescription },
          conversationBacklog,
        });

        const onFinalMessage = createWhatsAppMessageHandler(whatsapp, groupJid, message.rawMessage as WAMessage);
        const progressSettings = resolveProgressDisplaySettings(existingGroup ?? {});
        const progressRenderer = createProgressRenderer(progressSettings);
        const progressStrategy = getProgressTransportStrategy(progressSettings);
        progressTransport =
          progressStrategy === "none"
            ? null
            : createWhatsAppProgressTransport(whatsapp, groupJid, progressStrategy, message.rawMessage as WAMessage);
        const onProgressEvent: RunAgentParams["onProgressEvent"] = async (event) => {
          if (!progressTransport) return;
          progressRenderer.renderEvent(event);
          await progressTransport.syncLines(progressRenderer.getLines());
        };

        const integrationMcpServers = await buildMcpServers(user?.email ?? null);

        const agentInstructions = boundAgent?.description ?? null;
        const agentAllowedTools = boundAgent ? parseAllowedTools(boundAgent.allowed_tools) : null;

        const result = await runAgent({
          db,
          workspaceKey: groupWorkspaceKey,
          userMessage,
          workspaceDir,
          claudeConfigDir: config.CLAUDE_CONFIG_DIR,
          userName,
          userEmail: user?.email,
          userPhone: user?.whatsapp_number ?? null,
          logger,
          platform: "whatsapp",
          onProgressEvent,
          orgName: settingsRow?.org_name,
          orgDescription: parseOrgContext(settingsRow?.org_context)?.description ?? null,
          botName: settingsRow?.bot_name,
          attachments: attachments.length > 0 ? attachments : undefined,
          integrationMcpServers,
          loadIntegrationProvider,
          contextType: "channel_mention",
          currentUserId: user?.id ?? null,
          taskContext: {
            platform: "whatsapp" as const,
            contextType: "group" as const,
            deliveryTarget: groupJid,
            createdBy: user?.id ?? "unknown",
            creatorTimezone: user?.timezone ?? null,
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
          conversationContext: { conversationId: capture.conversation.id, currentMessageId: capture.captured.id },
        });

        await flushWhatsAppProgressTransport(progressTransport, logger, { userId: user?.id, groupJid });
        if (result.trace.finalText) {
          const sent = await onFinalMessage(result.trace.finalText);
          await captureBotReply({
            conversationId: capture.conversation.id,
            sent,
            text: result.trace.finalText,
            botName: settingsRow?.bot_name,
          });
        }

        for (const filePath of result.pendingUploads) {
          try {
            if (whatsapp.isConnected) {
              const ext = filePath.split(".").pop() ?? "";
              const mime = extensionToMime(ext);
              await whatsapp.sendFile(groupJid, filePath, mime, basename(filePath));
            }
          } catch (err) {
            logger.warn({ err, filePath }, "Failed to send file via WhatsApp");
          }
        }
        if (result.messageSent || result.pendingUploads.length > 0) {
          await repos.conversations.updateWatermark(capture.conversation.id, capture.captured.id);
        }
        await updateReaction(groupJid, message.rawMessage as WAMessage, null);
        await updateReaction(groupJid, message.rawMessage as WAMessage, "✅");
      } catch (err) {
        logger.error({ err, groupJid }, "Agent run failed (WhatsApp group)");
        await flushWhatsAppProgressTransport(progressTransport, logger, { userId: user?.id, groupJid });
        await updateReaction(groupJid, message.rawMessage as WAMessage, null);
        if (whatsapp.isConnected) {
          await whatsapp.sendText(
            groupJid,
            agentFailureMessage(err, WHATSAPP_AGENT_ERROR_MESSAGE, PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE),
          );
        }
      } finally {
        whatsapp.stopComposing(groupJid);
      }
    });
  });
}
