/**
 * WhatsApp adapter — wires WhatsApp event handlers (DM, group) onto a WhatsApp runtime.
 * Extracted from index.ts for testability.
 */
import { basename } from "node:path";
import { parseAllowedTools } from "@sketch/shared";
import type { Kysely } from "kysely";
import type { AuxLlmCall } from "../agent/aux-cost";
import { PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE, agentFailureMessage } from "../agent/errors";
import type { InboxMessageContext, QuotedMessageContext, SketchContextParams } from "../agent/prompt";
import { buildSketchContext, getImageAttachmentPathsFromSketchContext } from "../agent/prompt";
import {
  type McpServerConfig,
  type RunAgentParams,
  type RunAgentResult,
  canUseVisualAnalysisTool,
} from "../agent/runner";
import { archiveRuntimeSessions } from "../agent/sessions";
import { ensureAgentSubWorkspace, ensureGroupWorkspace, ensureWorkspace } from "../agent/workspace";
import { appendAutomationBuilderLinks } from "../automation/artifact-links";
import { getNewSessionConfirmation, parseSketchCommand } from "../commands";
import type { Config } from "../config";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { type createSettingsRepository, parseOrgContext } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { type Attachment, extensionToMime } from "../files";
import { appendIntegrationConnectionLinks } from "../integrations/connection-links";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import { isReasoningTextCommand, isToolProgressCommand } from "../progress-settings";
import type { QueueManager } from "../queue";
import type { TaskScheduler } from "../scheduler/service";
import { transcribeEagerAttachments } from "../transcription/service";
import { resolveVisionConfigFromAppConfig } from "../vision/service";
import { createWhatsAppMessageHandler } from "./message-handler";
import {
  type WhatsAppInboundMessage,
  type WhatsAppSendResult,
  type WhatsAppTarget,
  phoneE164ToWhatsAppJid,
  whatsappDeliveryTargetFromTarget,
} from "./provider";
import type { WhatsAppRuntime } from "./runtime";
import type { WhatsAppTemplateRequest } from "./templates";
import { phoneToTimezone } from "./timezone";

type UserRepository = ReturnType<typeof createUserRepository>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;
type InboxMessagesRepository = ReturnType<typeof createInboxMessagesRepository>;
type WhatsAppGroupsRepository = ReturnType<typeof createWhatsAppGroupRepository>;
type ConversationRepository = ReturnType<typeof createConversationRepository>;

const INLINE_BACKLOG_LIMIT = 10;
const WHATSAPP_AGENT_ERROR_MESSAGE = "Something went wrong, try again.";
const DAY_MS = 24 * 60 * 60 * 1000;

function parseInboxMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFromMeHistoryMessage(message: WhatsAppInboundMessage): boolean {
  const raw = message.rawProviderPayload;
  if (!isRecord(raw) || !isRecord(raw.key)) return false;
  return raw.key.fromMe === true;
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
  runAgent: (params: RunAgentParams) => Promise<RunAgentResult>;
  buildMcpServers: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  scheduler?: TaskScheduler;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  inboxMessagesRepo?: InboxMessagesRepository;
  sendDm: (params: {
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
}

function isConversationControlMessage(text: string): boolean {
  const command = parseSketchCommand(text);
  if (command === "new_session" || command === "tool_progress_query" || command === "reasoning_text_query") {
    return true;
  }
  if (command?.startsWith("tool_progress_") || command?.startsWith("reasoning_text_")) return true;
  return isToolProgressCommand(text) || isReasoningTextCommand(text);
}

function isWhatsAppProgressControlMessage(text: string, command: ReturnType<typeof parseSketchCommand>): boolean {
  if (command === "tool_progress_query" || command === "reasoning_text_query") return true;
  if (command?.startsWith("tool_progress_") || command?.startsWith("reasoning_text_")) return true;
  return isToolProgressCommand(text) || isReasoningTextCommand(text);
}

function referencesQuotedMessage(text: string): boolean {
  return /\b(this|that|it|above|same|ye|yeh|yea|isse|isko|iska|iski|iske|iss)\b/i.test(text);
}

function isAmbiguousQuotedAction(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
  if (!normalized) return true;
  if (/^(please\s+)?(summari[sz]e|explain|translate|reply|respond)$/u.test(normalized)) return true;
  return /^(please\s+)?(create|make|file|open|log)(\s+(a|an))?\s+(ticket|task|issue|bug)$/u.test(normalized);
}

function needsQuotedMessageContext(text: string, currentAttachments: Attachment[]): boolean {
  if (referencesQuotedMessage(text)) return true;
  return currentAttachments.length === 0 && isAmbiguousQuotedAction(text);
}

function hasQuotedMessageContent(quotedMessage: QuotedMessageContext | undefined): boolean {
  return Boolean(quotedMessage && (quotedMessage.text.trim().length > 0 || quotedMessage.attachments.length > 0));
}

function conversationRefForMessage(message: WhatsAppInboundMessage): {
  platform: string;
  kind: string;
  providerConversationId: string;
} {
  if (message.kind === "dm") {
    return { platform: "whatsapp", kind: "dm", providerConversationId: message.canonicalConversationId };
  }
  return { platform: "whatsapp", kind: "group", providerConversationId: message.target.groupId };
}

function senderJidForMessage(message: WhatsAppInboundMessage): string {
  return message.senderProviderId ?? message.providerConversationId;
}

function legacyDmConversationIds(message: WhatsAppInboundMessage): string[] {
  if (message.kind !== "dm") return [];
  const phoneDigits = message.senderPhoneE164.replace(/\D/gu, "");
  return [
    message.providerConversationId,
    message.senderProviderId,
    phoneE164ToWhatsAppJid(message.senderPhoneE164),
    phoneDigits,
    `wati:${message.senderPhoneE164}`,
  ].filter(
    (value, index, values): value is string =>
      Boolean(value) && value !== message.canonicalConversationId && values.indexOf(value) === index,
  );
}

export function wireWhatsAppHandlers(whatsapp: WhatsAppRuntime, deps: WhatsAppAdapterDeps): void {
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

  const getOrCreateConversationForMessage = async (message: WhatsAppInboundMessage, displayName?: string | null) => {
    const ref = conversationRefForMessage(message);
    if (message.kind === "dm") {
      let canonicalConversation: Awaited<ReturnType<ConversationRepository["getOrCreate"]>> | undefined;
      for (const legacyId of legacyDmConversationIds(message)) {
        const legacyConversation = await repos.conversations.find({
          platform: ref.platform,
          kind: ref.kind,
          providerConversationId: legacyId,
        });
        if (legacyConversation) {
          canonicalConversation = await repos.conversations.claimProviderConversationId(
            legacyConversation.id,
            ref,
            displayName,
          );
        }
      }
      if (canonicalConversation) return canonicalConversation;
    }
    return repos.conversations.getOrCreate(ref, displayName);
  };

  const updateReaction = async (message: WhatsAppInboundMessage, emoji: string | null) => {
    if (!whatsapp.isConnected) return;

    try {
      if (emoji === null) {
        await whatsapp.removeReaction(message);
      } else {
        await whatsapp.addReaction(message, emoji);
      }
    } catch (err) {
      logger.debug(
        { err, providerConversationId: message.providerConversationId, emoji },
        "Failed to update WhatsApp reaction",
      );
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

  const downloadMessageAttachments = async (
    message: WhatsAppInboundMessage,
    workspaceDir: string,
  ): Promise<Attachment[]> => {
    return whatsapp.downloadMedia(message, workspaceDir, { maxFileBytes });
  };

  const captureUserMessage = async (params: {
    message: WhatsAppInboundMessage;
    workspaceDir: string;
    senderName: string;
    senderUserId?: string | null;
    addressedToSketch: boolean;
    receivedAt?: string;
    skipControlMessages?: boolean;
  }) => {
    const conversation = await getOrCreateConversationForMessage(
      params.message,
      params.message.kind === "group" ? params.message.target.groupId : params.senderName,
    );

    if ((params.skipControlMessages ?? true) && isConversationControlMessage(params.message.text)) {
      return { conversation, captured: null, attachments: [] as Attachment[], inserted: false, omitted: true };
    }

    const attachments = await downloadMessageAttachments(params.message, params.workspaceDir);
    const captured = await repos.conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: params.message.providerMessageId,
      senderJid: senderJidForMessage(params.message),
      senderName: params.senderName,
      senderUserId: params.senderUserId ?? null,
      addressedToSketch: params.addressedToSketch,
      text: params.message.text || (attachments.length > 0 ? "See attached files." : ""),
      attachments,
      providerParentMessageId: params.message.quotedMessage?.providerMessageId ?? null,
      isThreadReply: Boolean(params.message.quotedMessage?.providerMessageId),
      providerTimestamp: params.message.providerTimestamp,
      receivedAt: params.receivedAt,
    });

    return { conversation, captured: captured.row, attachments, inserted: captured.inserted, omitted: false };
  };

  const captureBotReply = async (params: {
    conversationId: number;
    sent: WhatsAppSendResult | null;
    text: string;
    botName?: string | null;
  }) => {
    const providerMessageId = params.sent?.providerMessageId;
    if (!providerMessageId) return;

    await repos.conversations.insertMessage({
      conversationId: params.conversationId,
      providerMessageId,
      senderJid: "bot",
      senderName: params.botName ?? "Sketch",
      isBot: true,
      addressedToSketch: false,
      text: params.text,
      providerTimestamp: params.sent?.providerTimestamp ?? null,
    });
  };

  const resolveQuotedMessageContext = async (
    message: WhatsAppInboundMessage,
    conversationId: number,
  ): Promise<QuotedMessageContext | undefined> => {
    const quoted = message.quotedMessage;
    if (!quoted) return undefined;

    const stored = await repos.conversations.findMessageByProviderMessageId(conversationId, quoted.providerMessageId);
    if (stored) {
      return {
        id: stored.id,
        providerMessageId: stored.providerMessageId,
        senderName: stored.senderName,
        senderJid: stored.senderJid || null,
        text: stored.text,
        attachments: stored.attachments,
        providerTimestamp: stored.providerTimestamp,
        receivedAt: stored.receivedAt,
      };
    }

    if (!quoted.text.trim()) return undefined;

    return {
      providerMessageId: quoted.providerMessageId,
      senderJid: quoted.participantJid,
      text: quoted.text,
      attachments: [],
      providerTimestamp: null,
      receivedAt: null,
    };
  };

  const buildMissingQuotedContextMessage = () =>
    "I can see you're replying to a message, but I couldn't read the replied-to content. Please resend the issue text or quote a text message and I'll act on that.";

  whatsapp.onHistoryMessages(async (messages) => {
    const result = { persisted: 0, skippedOld: 0, skippedDup: 0 };
    const cutoffMs = Date.now() - config.WHATSAPP_HISTORY_LOOKBACK_DAYS * DAY_MS;
    let candidateCount = 0;
    let candidateBeforeCutoff = 0;
    let candidateAtOrAfterCutoff = 0;
    let candidateMissingTimestamp = 0;
    let minProviderTimestampMs: number | null = null;
    let maxProviderTimestampMs: number | null = null;

    for (const message of messages) {
      if (message.kind !== "group") continue;
      if (isFromMeHistoryMessage(message)) continue;

      candidateCount += 1;
      const receivedAt = message.providerTimestamp;
      const receivedAtMs = receivedAt ? Date.parse(receivedAt) : Number.NaN;
      if (receivedAt && Number.isFinite(receivedAtMs)) {
        minProviderTimestampMs =
          minProviderTimestampMs === null ? receivedAtMs : Math.min(minProviderTimestampMs, receivedAtMs);
        maxProviderTimestampMs =
          maxProviderTimestampMs === null ? receivedAtMs : Math.max(maxProviderTimestampMs, receivedAtMs);
        if (receivedAtMs < cutoffMs) {
          candidateBeforeCutoff += 1;
        } else {
          candidateAtOrAfterCutoff += 1;
        }
      } else {
        candidateMissingTimestamp += 1;
      }

      if (!receivedAt || !Number.isFinite(receivedAtMs) || receivedAtMs < cutoffMs) {
        result.skippedOld += 1;
        continue;
      }

      const groupJid = message.target.groupId;
      const user = message.senderPhoneE164
        ? await repos.users.findByWhatsappNumber(message.senderPhoneE164)
        : undefined;
      const existingGroup = await repos.whatsappGroups.getByJid(groupJid);
      const boundAgent = existingGroup?.agent_user_id ? await repos.users.findById(existingGroup.agent_user_id) : null;
      const workspaceDir = boundAgent
        ? await ensureAgentSubWorkspace(config, boundAgent.id, `whatsappgroup-${groupJid}`)
        : await ensureGroupWorkspace(config, groupJid);
      const capture = await captureUserMessage({
        message,
        workspaceDir,
        senderName: user?.name ?? message.senderName,
        senderUserId: user?.id ?? null,
        addressedToSketch: false,
        receivedAt,
        skipControlMessages: false,
      });
      if (capture.inserted) {
        result.persisted += 1;
      } else {
        result.skippedDup += 1;
      }
    }

    logger.info(
      {
        total: messages.length,
        candidates: candidateCount,
        cutoff: new Date(cutoffMs).toISOString(),
        minProviderTimestamp: minProviderTimestampMs === null ? null : new Date(minProviderTimestampMs).toISOString(),
        maxProviderTimestamp: maxProviderTimestampMs === null ? null : new Date(maxProviderTimestampMs).toISOString(),
        candidateBeforeCutoff,
        candidateAtOrAfterCutoff,
        candidateMissingTimestamp,
      },
      "WhatsApp history candidate timestamp diagnostics",
    );

    return result;
  });

  whatsapp.onMessage(async (message) => {
    if (message.kind === "dm") {
      const replyTarget = message.target;
      let user = await repos.users.findByWhatsappNumber(message.senderPhoneE164);
      if (!user) {
        const settingsRow = await repos.settings.get();
        const fallbackAgentId = settingsRow?.whatsapp_fallback_agent_id ?? null;
        if (!fallbackAgentId) {
          await whatsapp.sendText(
            replyTarget,
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
          whatsappNumber: message.senderPhoneE164,
        });
        logger.info(
          { externalUserId: user.id, fallbackAgentId },
          "Auto-created external user for unknown WhatsApp sender",
        );
      }

      if (!user.timezone) {
        const derivedTz = phoneToTimezone(user.whatsapp_number ?? message.senderPhoneE164);
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
        const dmConversation = await getOrCreateConversationForMessage(message, user.name);
        if (command === "new_session") {
          await archiveRuntimeSessions(db, dmWorkspaceKeyEarly);
          await repos.conversations.advanceWatermarkToCurrentMax(dmConversation.id);
          await whatsapp.sendText(replyTarget, getNewSessionConfirmation());
          return;
        }

        if (isWhatsAppProgressControlMessage(message.text, command)) {
          return;
        }

        const settingsRow = settingsRowEarly;
        const fallbackAgent = fallbackAgentEarly;
        const workspaceDir = fallbackAgent
          ? await ensureAgentSubWorkspace(config, fallbackAgent.id, user.id)
          : await ensureWorkspace(config, user.id);
        const dmWorkspaceKey = dmWorkspaceKeyEarly;
        const deliveryTarget = message.target;
        const deliveryTargetId = whatsappDeliveryTargetFromTarget(deliveryTarget);
        const capture = await captureUserMessage({
          message,
          workspaceDir,
          senderName: user.name,
          senderUserId: user.id,
          addressedToSketch: true,
        });
        if (!capture.inserted || !capture.captured) return;
        const quotedMessage = await resolveQuotedMessageContext(message, capture.conversation.id);
        if (
          message.quotedMessage &&
          !hasQuotedMessageContent(quotedMessage) &&
          needsQuotedMessageContext(message.text, capture.captured.attachments)
        ) {
          const finalText = buildMissingQuotedContextMessage();
          const sent = await whatsapp.sendText(deliveryTarget, finalText);
          await captureBotReply({
            conversationId: capture.conversation.id,
            sent,
            text: finalText,
            botName: settingsRow?.bot_name,
          });
          await repos.conversations.updateWatermark(capture.conversation.id, capture.captured.id);
          return;
        }

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

        whatsapp.startComposing(deliveryTarget);
        await updateReaction(message, "👀");

        try {
          let attachments: Attachment[] = capture.attachments;
          const eagerAuxCalls: AuxLlmCall[] = [];
          attachments = await transcribeEagerAttachments(attachments, {
            loadSettings: () => repos.settings.get(),
            logger,
            onUsage: (call) => eagerAuxCalls.push(call),
          });

          const onFinalMessage = createWhatsAppMessageHandler(whatsapp, deliveryTarget);
          const onProgressEvent: RunAgentParams["onProgressEvent"] = async () => {};

          const waIntegrationMcpServers = await buildMcpServers(user.email);
          const pendingInbox = await loadPendingInboxMessages(user.id);

          const visionConfig = resolveVisionConfigFromAppConfig(config, settingsRow);
          const agentInstructions = fallbackAgent?.description ?? null;
          const agentAllowedTools = fallbackAgent ? parseAllowedTools(fallbackAgent.allowed_tools) : null;
          const visualAnalysisAllowed = canUseVisualAnalysisTool(visionConfig, agentAllowedTools);
          const sketchContext: SketchContextParams = {
            messages: [],
            currentUserName: user.name,
            currentMessage: message.text || "See attached files.",
            currentUserEmail: user.email,
            currentUserPhone: user.whatsapp_number ?? message.senderPhoneE164,
            workspaceDir,
            orgDir: fallbackAgent ? undefined : config.CLAUDE_CONFIG_DIR,
            timezone: user.timezone,
            isSharedContext: false,
            inboxMessages: pendingInbox.messages,
            conversationBacklog,
            quotedMessage,
            visionAnalysisEnabled: visualAnalysisAllowed,
          };
          const userMessage = buildSketchContext(sketchContext);
          const agentAttachments = [...attachments, ...(quotedMessage?.attachments ?? [])];

          const waTaskContext = {
            platform: "whatsapp" as const,
            contextType: "dm" as const,
            deliveryTarget: deliveryTargetId,
            createdBy: user.id,
            creatorTimezone: user.timezone,
            origin: {
              platform: "whatsapp" as const,
              conversationId: String(capture.conversation.id),
              providerThreadId: null,
              currentMessageId: capture.captured.id,
            },
          };

          const result = await runAgent({
            db,
            workspaceKey: dmWorkspaceKey,
            seedAuxCalls: eagerAuxCalls,
            userMessage,
            workspaceDir,
            // Skip ~/.claude org context for fallback runs so external users
            // do not see the organisation's preset.
            claudeConfigDir: fallbackAgent ? undefined : config.CLAUDE_CONFIG_DIR,
            userName: user.name,
            userEmail: user.email,
            userPhone: user.whatsapp_number ?? message.senderPhoneE164,
            logger,
            platform: "whatsapp",
            onProgressEvent,
            orgName: settingsRow?.org_name,
            orgDescription: parseOrgContext(settingsRow?.org_context)?.description ?? null,
            botName: settingsRow?.bot_name,
            visionConfig,
            blockedReadPaths: getImageAttachmentPathsFromSketchContext(sketchContext),
            attachments: agentAttachments.length > 0 ? agentAttachments : undefined,
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

          const finalText = appendIntegrationConnectionLinks(
            appendAutomationBuilderLinks(result.trace.finalText, result.trace.automationArtifacts ?? []),
            result.pendingIntegrationConnections,
            "whatsapp",
            toolConfig,
          );
          if (finalText) {
            const sent = await onFinalMessage(finalText);
            await captureBotReply({
              conversationId: capture.conversation.id,
              sent,
              text: finalText,
              botName: settingsRow?.bot_name,
            });
          }

          for (const filePath of result.pendingUploads) {
            try {
              if (whatsapp.isConnected) {
                const ext = filePath.split(".").pop() ?? "";
                const mime = extensionToMime(ext);
                await whatsapp.sendFile(deliveryTarget, filePath, mime, basename(filePath));
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
          await updateReaction(message, null);
          await updateReaction(message, "✅");
        } catch (err) {
          logger.error({ err, userId: user.id }, "Agent run failed (WhatsApp)");
          await updateReaction(message, null);
          if (whatsapp.isConnected) {
            await whatsapp.sendText(deliveryTarget, agentFailureMessage(err, WHATSAPP_AGENT_ERROR_MESSAGE));
          }
        } finally {
          whatsapp.stopComposing(deliveryTarget);
        }
      });
      return;
    }

    // --- Group handler ---

    if (!message.isMentioned) {
      const groupJid = message.target.groupId;
      const user = message.senderPhoneE164
        ? await repos.users.findByWhatsappNumber(message.senderPhoneE164)
        : undefined;
      const existingGroup = await repos.whatsappGroups.getByJid(groupJid);
      const boundAgent = existingGroup?.agent_user_id ? await repos.users.findById(existingGroup.agent_user_id) : null;
      const workspaceDir = boundAgent
        ? await ensureAgentSubWorkspace(config, boundAgent.id, `whatsappgroup-${groupJid}`)
        : await ensureGroupWorkspace(config, groupJid);
      await captureUserMessage({
        message,
        workspaceDir,
        senderName: user?.name ?? message.senderName,
        senderUserId: user?.id ?? null,
        addressedToSketch: false,
      });
      return;
    }

    const user = message.senderPhoneE164 ? await repos.users.findByWhatsappNumber(message.senderPhoneE164) : undefined;
    const userName = user?.name ?? message.senderName;

    const groupTarget = message.target;
    const groupJid = groupTarget.groupId;
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
      const groupConversation = await getOrCreateConversationForMessage(message);
      if (command === "new_session") {
        await archiveRuntimeSessions(db, groupWorkspaceKey);
        await repos.conversations.advanceWatermarkToCurrentMax(groupConversation.id);
        const onFinalMessage = createWhatsAppMessageHandler(whatsapp, groupTarget, message);
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
      await getOrCreateConversationForMessage(message, groupName);

      if (isWhatsAppProgressControlMessage(message.text, command)) {
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
      const quotedMessage = await resolveQuotedMessageContext(message, capture.conversation.id);
      if (
        message.quotedMessage &&
        !hasQuotedMessageContent(quotedMessage) &&
        needsQuotedMessageContext(message.text, capture.captured.attachments)
      ) {
        const onFinalMessage = createWhatsAppMessageHandler(whatsapp, groupTarget, message);
        const finalText = buildMissingQuotedContextMessage();
        const sent = await onFinalMessage(finalText);
        await captureBotReply({
          conversationId: capture.conversation.id,
          sent,
          text: finalText,
          botName: settingsRow?.bot_name,
        });
        await repos.conversations.updateWatermark(capture.conversation.id, capture.captured.id);
        return;
      }

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

      whatsapp.startComposing(groupTarget);
      await updateReaction(message, "👀");

      try {
        let attachments: Attachment[] = capture.attachments;
        const eagerAuxCalls: AuxLlmCall[] = [];
        attachments = await transcribeEagerAttachments(attachments, {
          loadSettings: () => repos.settings.get(),
          logger,
          onUsage: (call) => eagerAuxCalls.push(call),
        });

        const visionConfig = resolveVisionConfigFromAppConfig(config, settingsRow);
        const agentInstructions = boundAgent?.description ?? null;
        const agentAllowedTools = boundAgent ? parseAllowedTools(boundAgent.allowed_tools) : null;
        const visualAnalysisAllowed = canUseVisualAnalysisTool(visionConfig, agentAllowedTools);
        const sketchContext: SketchContextParams = {
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
          quotedMessage,
          visionAnalysisEnabled: visualAnalysisAllowed,
        };
        const userMessage = buildSketchContext(sketchContext);
        const agentAttachments = [...attachments, ...(quotedMessage?.attachments ?? [])];

        const onFinalMessage = createWhatsAppMessageHandler(whatsapp, groupTarget, message);
        const onProgressEvent: RunAgentParams["onProgressEvent"] = async () => {};

        const integrationMcpServers = await buildMcpServers(user?.email ?? null);

        const result = await runAgent({
          db,
          workspaceKey: groupWorkspaceKey,
          seedAuxCalls: eagerAuxCalls,
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
          visionConfig,
          blockedReadPaths: getImageAttachmentPathsFromSketchContext(sketchContext),
          attachments: agentAttachments.length > 0 ? agentAttachments : undefined,
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
            origin: {
              platform: "whatsapp" as const,
              conversationId: String(capture.conversation.id),
              providerThreadId: null,
              currentMessageId: capture.captured.id,
            },
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

        const textWithAutomationLinks = user
          ? appendAutomationBuilderLinks(result.trace.finalText, result.trace.automationArtifacts ?? [])
          : result.trace.finalText;
        const finalText = appendIntegrationConnectionLinks(
          textWithAutomationLinks,
          result.pendingIntegrationConnections,
          "whatsapp",
          toolConfig,
        );
        if (finalText) {
          const sent = await onFinalMessage(finalText);
          await captureBotReply({
            conversationId: capture.conversation.id,
            sent,
            text: finalText,
            botName: settingsRow?.bot_name,
          });
        }

        for (const filePath of result.pendingUploads) {
          try {
            if (whatsapp.isConnected) {
              const ext = filePath.split(".").pop() ?? "";
              const mime = extensionToMime(ext);
              await whatsapp.sendFile(groupTarget, filePath, mime, basename(filePath));
            }
          } catch (err) {
            logger.warn({ err, filePath }, "Failed to send file via WhatsApp");
          }
        }
        if (result.messageSent || result.pendingUploads.length > 0) {
          await repos.conversations.updateWatermark(capture.conversation.id, capture.captured.id);
        }
        await updateReaction(message, null);
        await updateReaction(message, "✅");
      } catch (err) {
        logger.error({ err, groupJid }, "Agent run failed (WhatsApp group)");
        await updateReaction(message, null);
        if (whatsapp.isConnected) {
          await whatsapp.sendText(
            groupTarget,
            agentFailureMessage(err, WHATSAPP_AGENT_ERROR_MESSAGE, PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE),
          );
        }
      } finally {
        whatsapp.stopComposing(groupTarget);
      }
    });
  });
}
