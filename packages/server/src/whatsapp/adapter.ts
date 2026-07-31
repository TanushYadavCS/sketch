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
import {
  type FollowupReviewCommandHandler,
  createFollowupReviewCommandHandler,
} from "../agents/followup-review-command";
import { appendAutomationBuilderLinks } from "../automation/artifact-links";
import { getNewSessionConfirmation, parseSketchCommand } from "../commands";
import type { Config } from "../config";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import type { ConversationMessageSource, createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { type createSettingsRepository, parseOrgContext } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import { createWhatsAppEventKey } from "../db/repositories/whatsapp-inbound-events";
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
import {
  checkpointMessageFromInbound,
  compareWhatsAppBackfillCheckpointKeys,
  encodeWhatsAppBackfillCheckpointKey,
  oldestWhatsAppBackfillCheckpointKey,
} from "./backfill-checkpoint";
import { stableWhatsAppParticipantJidRef } from "./identity-resolution";
import { createWhatsAppMessageHandler } from "./message-handler";
import { maskPersonalNumberIdentifier } from "./privacy";
import {
  type WhatsAppHistoryBatchMetadata,
  type WhatsAppHistorySyncResult,
  type WhatsAppInboundMessage,
  type WhatsAppSendResult,
  type WhatsAppTarget,
  phoneE164ToWhatsAppJid,
  whatsappDeliveryTargetFromTarget,
} from "./provider";
import { validWhatsAppProviderTimestamp } from "./provider-timestamp";
import type { WhatsAppRuntime } from "./runtime";
import type { WhatsAppTemplateRequest } from "./templates";
import { phoneToTimezone } from "./timezone";

type UserRepository = ReturnType<typeof createUserRepository>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;
type InboxMessagesRepository = ReturnType<typeof createInboxMessagesRepository>;
type WhatsAppGroupsRepository = ReturnType<typeof createWhatsAppGroupRepository>;
type ConversationRepository = ReturnType<typeof createConversationRepository>;
export type WhatsAppConversationRepository = ConversationRepository;

export interface WhatsAppQueuedCapture {
  conversation: Awaited<ReturnType<ConversationRepository["getOrCreate"]>>;
  captured: NonNullable<Awaited<ReturnType<ConversationRepository["findMessageByEventKey"]>>>;
  attachments: Attachment[];
  inserted: true;
  omitted: false;
}

export interface WhatsAppDispatchHooks {
  onRunStart: () => Promise<void>;
}

export interface WhatsAppAdapterHandlers {
  captureQueuedMessage(
    message: WhatsAppInboundMessage,
    params: {
      eventKey: string | null;
      source: ConversationMessageSource;
      connectionKey: string | null;
      fromMe?: boolean;
      attachments?: Attachment[];
      attachmentsForWorkspace?: (workspaceDir: string) => Promise<Attachment[]>;
      commitCapture?: (
        capture: (conversationRepository: WhatsAppConversationRepository) => Promise<WhatsAppQueuedCapture | null>,
      ) => Promise<WhatsAppQueuedCapture | null>;
    },
  ): Promise<WhatsAppQueuedCapture | null>;
  dispatchCapturedMessage(
    message: WhatsAppInboundMessage,
    capture: WhatsAppQueuedCapture | null,
    hooks: WhatsAppDispatchHooks,
  ): Promise<boolean>;
  handleHistoryMessages(
    messages: WhatsAppInboundMessage[],
    metadata?: WhatsAppHistoryBatchMetadata,
    options?: {
      checkpoint?: boolean;
      captureMetadataForMessage?: (message: WhatsAppInboundMessage) => {
        eventKey: string | null;
        connectionKey: string | null;
        fromMe?: boolean;
      };
      range?: { id: string; lowerBoundAt: string; upperBoundAt: string };
    },
  ): Promise<WhatsAppHistorySyncResult>;
}

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

function providerConversationIdForLog(message: WhatsAppInboundMessage): string {
  if (message.kind !== "dm") return message.providerConversationId;
  return maskPersonalNumberIdentifier(message.providerConversationId);
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
    conversationSlices?: ReturnType<typeof createConversationSlicesRepository>;
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
  followupReviewHandler?: FollowupReviewCommandHandler;
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

export function wireWhatsAppHandlers(whatsapp: WhatsAppRuntime, deps: WhatsAppAdapterDeps): WhatsAppAdapterHandlers {
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
  const backfillCheckpoints = repos.conversationSlices ?? createConversationSlicesRepository(db);
  const handleFollowupReviewCommand = deps.followupReviewHandler ?? createFollowupReviewCommandHandler(db);
  const queuedCaptures = new WeakMap<WhatsAppInboundMessage, WhatsAppQueuedCapture>();

  const getOrCreateConversationForMessage = async (
    message: WhatsAppInboundMessage,
    displayName?: string | null,
    conversationRepository: ConversationRepository = repos.conversations,
  ) => {
    const ref = conversationRefForMessage(message);
    if (message.kind === "dm") {
      let canonicalConversation: Awaited<ReturnType<ConversationRepository["getOrCreate"]>> | undefined;
      for (const legacyId of legacyDmConversationIds(message)) {
        const legacyConversation = await conversationRepository.find({
          platform: ref.platform,
          kind: ref.kind,
          providerConversationId: legacyId,
        });
        if (legacyConversation) {
          canonicalConversation = await conversationRepository.claimProviderConversationId(
            legacyConversation.id,
            ref,
            displayName,
          );
        }
      }
      if (canonicalConversation) return canonicalConversation;
    }
    return conversationRepository.getOrCreate(ref, displayName);
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
        { err, providerConversationId: providerConversationIdForLog(message), emoji },
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
    eventKey?: string | null;
    source?: ConversationMessageSource;
    connectionKey?: string | null;
    backfillRangeId?: string | null;
    providerFromMe?: boolean;
    attachments?: Attachment[];
    conversationRepository?: ConversationRepository;
    queued?: boolean;
  }) => {
    const conversation = await getOrCreateConversationForMessage(
      params.message,
      params.message.kind === "group" ? params.message.target.groupId : params.senderName,
      params.conversationRepository,
    );

    if ((params.skipControlMessages ?? true) && isConversationControlMessage(params.message.text)) {
      return { conversation, captured: null, attachments: [] as Attachment[], inserted: false, omitted: true };
    }

    const queuedCapture = queuedCaptures.get(params.message);
    if (queuedCapture) {
      queuedCaptures.delete(params.message);
      return queuedCapture;
    }

    const attachments = params.attachments ?? (await downloadMessageAttachments(params.message, params.workspaceDir));
    const providerTimestamp = validWhatsAppProviderTimestamp(params.message.providerTimestamp);
    const receivedAt = params.receivedAt
      ? validWhatsAppProviderTimestamp(params.receivedAt)
      : (providerTimestamp ?? undefined);
    const conversationRepository = params.conversationRepository ?? repos.conversations;
    const messageInsert = {
      conversationId: conversation.id,
      providerMessageId: params.message.providerMessageId,
      eventKey: params.eventKey,
      senderJid: senderJidForMessage(params.message),
      senderName: params.senderName,
      senderUserId: params.senderUserId ?? null,
      addressedToSketch: params.addressedToSketch,
      text: params.message.text || (attachments.length > 0 ? "See attached files." : ""),
      attachments,
      providerParentMessageId: params.message.quotedMessage?.providerMessageId ?? null,
      isThreadReply: Boolean(params.message.quotedMessage?.providerMessageId),
      providerTimestamp: providerTimestamp ?? null,
      providerFromMe: params.providerFromMe ?? false,
      receivedAt: receivedAt ?? undefined,
      source: params.source ?? "live",
      connectionKey: params.connectionKey ?? params.message.connectionKey ?? null,
      backfillRangeId: params.backfillRangeId ?? null,
    };
    const captured = params.queued
      ? { row: await conversationRepository.captureOrGet(messageInsert), inserted: true }
      : await conversationRepository.insertMessage(messageInsert);

    return { conversation, captured: captured.row, attachments, inserted: captured.inserted, omitted: false };
  };

  const captureBotReply = async (params: {
    conversationId: number;
    sent: WhatsAppSendResult | null;
    text: string;
    botName?: string | null;
    connectionKey?: string | null;
  }) => {
    const sent = params.sent;
    const providerMessageId = sent?.providerMessageId;
    if (!providerMessageId) return;
    const providerTimestamp = validWhatsAppProviderTimestamp(sent.providerTimestamp);

    await repos.conversations.insertMessage({
      conversationId: params.conversationId,
      providerMessageId,
      eventKey: createWhatsAppEventKey(sent.providerConversationId, providerMessageId, true),
      senderJid: "bot",
      senderName: params.botName ?? "Sketch",
      isBot: true,
      addressedToSketch: false,
      text: params.text,
      providerTimestamp: providerTimestamp ?? null,
      providerFromMe: true,
      source: "live",
      connectionKey: params.connectionKey ?? null,
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

  const emptyHistoryResult = (): WhatsAppHistorySyncResult => ({
    persisted: 0,
    skippedOld: 0,
    skippedDup: 0,
  });

  const addHistoryResult = (target: WhatsAppHistorySyncResult, source: WhatsAppHistorySyncResult): void => {
    target.persisted += source.persisted;
    target.skippedOld += source.skippedOld;
    target.skippedDup += source.skippedDup;
  };

  /**
   * Baileys `isLatest` means "first processed history notification" in v7,
   * not end-of-transfer. The only completion-like signal on
   * `messaging-history.set` is the proto progress value reaching 100.
   */
  const isHistorySyncComplete = (metadata: WhatsAppHistoryBatchMetadata | undefined): boolean => {
    return typeof metadata?.progress === "number" && metadata.progress >= 100;
  };

  /**
   * Writes checkpoint progress only after eligible rows reach insert/dedup. An
   * eligible row is provider-authored group history with a valid provider
   * timestamp inside the configured lookback window. Both fresh inserts and
   * unique-key dedup hits are durable progress; the checkpoint is ops
   * observability, not a fetch cursor or correctness gate.
   */
  const processHistoryGroupBatch = async (
    groupJid: string,
    groupMessages: WhatsAppInboundMessage[],
    metadata: WhatsAppHistoryBatchMetadata | undefined,
    options: {
      checkpoint: boolean;
      captureMetadataForMessage?: (message: WhatsAppInboundMessage) => {
        eventKey: string | null;
        connectionKey: string | null;
        fromMe?: boolean;
      };
      range?: { id: string; lowerBoundAt: string; upperBoundAt: string };
    },
  ): Promise<WhatsAppHistorySyncResult> => {
    const result = emptyHistoryResult();
    const cutoffMs = options.range
      ? Date.parse(options.range.lowerBoundAt)
      : Date.now() - config.WHATSAPP_HISTORY_LOOKBACK_DAYS * DAY_MS;
    const upperBoundMs = options.range ? Date.parse(options.range.upperBoundAt) : Number.POSITIVE_INFINITY;
    let candidateCount = 0;
    let candidateBeforeCutoff = 0;
    let candidateAtOrAfterCutoff = 0;
    let minProviderTimestampMs: number | null = null;
    let maxProviderTimestampMs: number | null = null;
    let lastDurableKey: string | null = null;
    const groupRef = stableWhatsAppParticipantJidRef(groupJid);
    const candidateMessages = groupMessages.filter(
      (message) =>
        Boolean(message.providerMessageId) && Boolean(validWhatsAppProviderTimestamp(message.providerTimestamp)),
    );
    const candidateCheckpointMessages = candidateMessages.map(checkpointMessageFromInbound);
    const existingCheckpoint = await backfillCheckpoints.getBackfillCheckpoint(groupJid);
    const completeCheckpointKey =
      existingCheckpoint?.status === "complete" ? existingCheckpoint.last_fetched_key : null;
    const usersByPhone = new Map<string, { id: string; name: string } | undefined>();
    let workspaceDirPromise: Promise<string> | null = null;

    const resolveUserByPhone = async (phoneE164: string | null) => {
      if (!phoneE164) return undefined;
      if (usersByPhone.has(phoneE164)) return usersByPhone.get(phoneE164);
      const user = await repos.users.findByWhatsappNumber(phoneE164);
      const resolved = user ? { id: user.id, name: user.name } : undefined;
      usersByPhone.set(phoneE164, resolved);
      return resolved;
    };

    const resolveWorkspaceDir = () => {
      workspaceDirPromise ??= (async () => {
        const existingGroup = await repos.whatsappGroups.getByJid(groupJid);
        const boundAgent = existingGroup?.agent_user_id
          ? await repos.users.findById(existingGroup.agent_user_id)
          : null;
        return boundAgent
          ? ensureAgentSubWorkspace(config, boundAgent.id, `whatsappgroup-${groupJid}`)
          : ensureGroupWorkspace(config, groupJid);
      })();
      return workspaceDirPromise;
    };

    if (
      completeCheckpointKey &&
      candidateCheckpointMessages.length > 0 &&
      candidateCheckpointMessages.every((message) => {
        const key = encodeWhatsAppBackfillCheckpointKey(message);
        return Boolean(key && compareWhatsAppBackfillCheckpointKeys(key, completeCheckpointKey) <= 0);
      })
    ) {
      logger.info(
        {
          groupRef,
          batchSize: groupMessages.length,
          candidates: candidateMessages.length,
          checkpointKey: completeCheckpointKey,
          isLatest: metadata?.isLatest,
          progress: metadata?.progress,
          syncType: metadata?.syncType,
        },
        "WhatsApp history group batch arrived at or before complete checkpoint",
      );
    }

    for (const message of candidateMessages) {
      candidateCount += 1;
      const receivedAt = validWhatsAppProviderTimestamp(message.providerTimestamp);
      if (!message.providerMessageId || !receivedAt) continue;
      const receivedAtMs = Date.parse(receivedAt);
      const messageKey = encodeWhatsAppBackfillCheckpointKey(checkpointMessageFromInbound(message));
      minProviderTimestampMs =
        minProviderTimestampMs === null ? receivedAtMs : Math.min(minProviderTimestampMs, receivedAtMs);
      maxProviderTimestampMs =
        maxProviderTimestampMs === null ? receivedAtMs : Math.max(maxProviderTimestampMs, receivedAtMs);
      if (receivedAtMs < cutoffMs) {
        candidateBeforeCutoff += 1;
      } else {
        candidateAtOrAfterCutoff += 1;
      }

      if (receivedAtMs < cutoffMs || receivedAtMs >= upperBoundMs) {
        result.skippedOld += 1;
        continue;
      }

      const user = await resolveUserByPhone(message.senderPhoneE164);
      const workspaceDir = await resolveWorkspaceDir();
      try {
        const captureMetadata = options.captureMetadataForMessage?.(message);
        const capture = await captureUserMessage({
          message,
          workspaceDir,
          senderName: user?.name ?? message.senderName,
          senderUserId: user?.id ?? null,
          addressedToSketch: false,
          eventKey: captureMetadata?.eventKey ?? null,
          source: "history",
          connectionKey: captureMetadata?.connectionKey ?? message.connectionKey ?? null,
          backfillRangeId: options.range?.id ?? null,
          providerFromMe: captureMetadata?.fromMe ?? false,
          receivedAt,
          skipControlMessages: false,
          attachments: [],
        });
        if (messageKey) {
          lastDurableKey = oldestWhatsAppBackfillCheckpointKey(lastDurableKey, messageKey);
        }
        if (capture.inserted) {
          result.persisted += 1;
        } else {
          result.skippedDup += 1;
        }
      } catch (err) {
        if (options.checkpoint) {
          try {
            await backfillCheckpoints.setBackfillCheckpoint({
              groupJid,
              lastFetchedKey: lastDurableKey,
              status: "failed",
            });
          } catch (checkpointErr) {
            logger.warn(
              { err: checkpointErr, groupRef, checkpointKey: lastDurableKey },
              "Failed to mark WhatsApp history checkpoint failed",
            );
          }
        }
        throw err;
      }
    }

    const checkpointStatus = isHistorySyncComplete(metadata) ? "complete" : "in_progress";
    const checkpoint =
      options.checkpoint && lastDurableKey
        ? await backfillCheckpoints.setBackfillCheckpoint({
            groupJid,
            lastFetchedKey: lastDurableKey,
            status: checkpointStatus,
          })
        : null;

    logger.info(
      {
        groupRef,
        batchSize: groupMessages.length,
        candidates: candidateCount,
        cutoff: new Date(cutoffMs).toISOString(),
        minProviderTimestamp: minProviderTimestampMs === null ? null : new Date(minProviderTimestampMs).toISOString(),
        maxProviderTimestamp: maxProviderTimestampMs === null ? null : new Date(maxProviderTimestampMs).toISOString(),
        candidateBeforeCutoff,
        candidateAtOrAfterCutoff,
        persisted: result.persisted,
        skippedOld: result.skippedOld,
        skippedDup: result.skippedDup,
        checkpointKey: checkpoint?.last_fetched_key ?? lastDurableKey,
        checkpointStatus: checkpoint?.status ?? "deferred",
        isLatest: metadata?.isLatest,
        progress: metadata?.progress,
        syncType: metadata?.syncType,
      },
      "WhatsApp history group batch processed",
    );

    return result;
  };

  const handleHistoryMessages = async (
    messages: WhatsAppInboundMessage[],
    metadata?: WhatsAppHistoryBatchMetadata,
    options?: {
      checkpoint?: boolean;
      captureMetadataForMessage?: (message: WhatsAppInboundMessage) => {
        eventKey: string | null;
        connectionKey: string | null;
        fromMe?: boolean;
      };
      range?: { id: string; lowerBoundAt: string; upperBoundAt: string };
    },
  ) => {
    const result = emptyHistoryResult();
    const messagesByGroup = new Map<string, WhatsAppInboundMessage[]>();

    for (const message of messages) {
      if (message.kind !== "group") continue;
      const existing = messagesByGroup.get(message.target.groupId) ?? [];
      existing.push(message);
      messagesByGroup.set(message.target.groupId, existing);
    }

    for (const [groupJid, groupMessages] of messagesByGroup) {
      addHistoryResult(
        result,
        await processHistoryGroupBatch(groupJid, groupMessages, metadata, {
          checkpoint: options?.checkpoint ?? true,
          captureMetadataForMessage: options?.captureMetadataForMessage,
          range: options?.range,
        }),
      );
    }

    return result;
  };

  whatsapp.onHistoryMessages(handleHistoryMessages);

  const handleMessage = async (message: WhatsAppInboundMessage, hooks?: WhatsAppDispatchHooks): Promise<boolean> => {
    if (message.kind === "dm") {
      const replyTarget = message.target;
      let user = await repos.users.findByWhatsappNumber(message.senderPhoneE164);
      if (!user) {
        const settingsRow = await repos.settings.get();
        const fallbackAgentId = settingsRow?.whatsapp_fallback_agent_id ?? null;
        if (!fallbackAgentId) {
          await hooks?.onRunStart();
          await whatsapp.sendText(
            replyTarget,
            "Sorry, you're not authorized to use this bot. Contact your admin to get access.",
          );
          return true;
        }
        const fallbackAgent = await repos.users.findById(fallbackAgentId);
        if (!fallbackAgent || fallbackAgent.type !== "agent") {
          await hooks?.onRunStart();
          logger.warn(
            { fallbackAgentId },
            "WhatsApp fallback agent is missing or not an agent; dropping unknown-sender DM",
          );
          return true;
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

      const accepted = userQueue.enqueue(async () => {
        await hooks?.onRunStart();
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
        const followupReview = await handleFollowupReviewCommand({
          text: message.text,
          userId: user.id,
          surface: "whatsapp",
        });
        if (followupReview.handled) {
          const capture = await captureUserMessage({
            message,
            workspaceDir,
            senderName: user.name,
            senderUserId: user.id,
            addressedToSketch: true,
          });
          const sent = await whatsapp.sendText(replyTarget, followupReview.message);
          await captureBotReply({
            conversationId: capture.conversation.id,
            sent,
            text: followupReview.message,
            botName: settingsRow?.bot_name,
          });
          return;
        }
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
            connectionKey: message.connectionKey,
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
            canManageAnyTask: user.auth_role === "admin",
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
              connectionKey: message.connectionKey,
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
      return accepted;
    }

    // --- Group handler ---

    if (!message.isMentioned) {
      await hooks?.onRunStart();
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
      });
      if (user) {
        const followupReview = await handleFollowupReviewCommand({
          text: message.text,
          userId: user.id,
          surface: "whatsapp",
        });
        if (followupReview.handled) {
          const onFinalMessage = createWhatsAppMessageHandler(whatsapp, message.target, message);
          const sent = await onFinalMessage(followupReview.message);
          const settingsRow = await repos.settings.get();
          await captureBotReply({
            conversationId: capture.conversation.id,
            sent,
            text: followupReview.message,
            botName: settingsRow?.bot_name,
          });
          return true;
        }
      }
      return true;
    }

    const user = message.senderPhoneE164 ? await repos.users.findByWhatsappNumber(message.senderPhoneE164) : undefined;
    const userName = user?.name ?? message.senderName;

    const groupTarget = message.target;
    const groupJid = groupTarget.groupId;
    const activeQueueKey = `wa-group-${groupJid}`;
    const groupQueue = queue.getQueue(activeQueueKey);

    return groupQueue.enqueue(async () => {
      await hooks?.onRunStart();
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
      if (user) {
        const followupReview = await handleFollowupReviewCommand({
          text: message.text,
          userId: user.id,
          surface: "whatsapp",
        });
        if (followupReview.handled) {
          const onFinalMessage = createWhatsAppMessageHandler(whatsapp, groupTarget, message);
          const sent = await onFinalMessage(followupReview.message);
          await captureBotReply({
            conversationId: capture.conversation.id,
            sent,
            text: followupReview.message,
            botName: settingsRow?.bot_name,
          });
          return;
        }
      }
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
          connectionKey: message.connectionKey,
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
            canManageAnyTask: user?.auth_role === "admin",
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
            connectionKey: message.connectionKey,
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
  };

  whatsapp.onMessage(async (message) => {
    await handleMessage(message);
  });

  const captureQueuedMessage = async (
    message: WhatsAppInboundMessage,
    params: {
      eventKey: string | null;
      source: ConversationMessageSource;
      connectionKey: string | null;
      fromMe?: boolean;
      attachments?: Attachment[];
      attachmentsForWorkspace?: (workspaceDir: string) => Promise<Attachment[]>;
      commitCapture?: (
        capture: (conversationRepository: WhatsAppConversationRepository) => Promise<WhatsAppQueuedCapture | null>,
      ) => Promise<WhatsAppQueuedCapture | null>;
    },
  ): Promise<WhatsAppQueuedCapture | null> => {
    if (message.kind === "dm") {
      let user = await repos.users.findByWhatsappNumber(message.senderPhoneE164);
      if (!user) {
        const fallbackAgentId = (await repos.settings.get())?.whatsapp_fallback_agent_id ?? null;
        const fallbackAgent = fallbackAgentId ? await repos.users.findById(fallbackAgentId) : null;
        if (!fallbackAgent || fallbackAgent.type !== "agent") return null;
        user = await repos.users.create({
          name: "External user",
          type: "external",
          whatsappNumber: message.senderPhoneE164,
        });
      }
      const settingsRow = await repos.settings.get();
      const fallbackAgent =
        user.type === "external" && settingsRow?.whatsapp_fallback_agent_id
          ? await repos.users.findById(settingsRow.whatsapp_fallback_agent_id)
          : null;
      const workspaceDir = fallbackAgent
        ? await ensureAgentSubWorkspace(config, fallbackAgent.id, user.id)
        : await ensureWorkspace(config, user.id);
      const attachments = params.attachments ?? (await params.attachmentsForWorkspace?.(workspaceDir));
      const capture = async (conversationRepository: ConversationRepository) => {
        const captured = await captureUserMessage({
          message,
          workspaceDir,
          senderName: user.name,
          senderUserId: user.id,
          addressedToSketch: true,
          eventKey: params.eventKey,
          source: params.source,
          connectionKey: params.connectionKey,
          providerFromMe: params.fromMe ?? false,
          attachments,
          conversationRepository,
          queued: true,
        });
        if (!captured.captured || captured.omitted) return null;
        return { ...captured, inserted: true as const, omitted: false as const };
      };
      return params.commitCapture ? params.commitCapture(capture) : capture(repos.conversations);
    }

    const groupJid = message.target.groupId;
    const user = message.senderPhoneE164 ? await repos.users.findByWhatsappNumber(message.senderPhoneE164) : undefined;
    const existingGroup = await repos.whatsappGroups.getByJid(groupJid);
    const boundAgent = existingGroup?.agent_user_id ? await repos.users.findById(existingGroup.agent_user_id) : null;
    const workspaceDir = boundAgent
      ? await ensureAgentSubWorkspace(config, boundAgent.id, `whatsappgroup-${groupJid}`)
      : await ensureGroupWorkspace(config, groupJid);
    const attachments = params.attachments ?? (await params.attachmentsForWorkspace?.(workspaceDir));
    const capture = async (conversationRepository: ConversationRepository) => {
      const captured = await captureUserMessage({
        message,
        workspaceDir,
        senderName: user?.name ?? message.senderName,
        senderUserId: user?.id ?? null,
        addressedToSketch: Boolean(message.isMentioned),
        eventKey: params.eventKey,
        source: params.source,
        connectionKey: params.connectionKey,
        providerFromMe: params.fromMe ?? false,
        attachments,
        conversationRepository,
        queued: true,
      });
      if (!captured.captured || captured.omitted) return null;
      return { ...captured, inserted: true as const, omitted: false as const };
    };
    return params.commitCapture ? params.commitCapture(capture) : capture(repos.conversations);
  };

  return {
    captureQueuedMessage,
    async dispatchCapturedMessage(message, capture, hooks) {
      if (capture) queuedCaptures.set(message, capture);
      return handleMessage(message, hooks);
    },
    handleHistoryMessages,
  };
}
