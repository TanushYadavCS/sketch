/**
 * Slack adapter — wires Slack event handlers (DM, thread, channel mention) onto a SlackBot.
 * Extracted from index.ts for testability. All handler logic lives here; index.ts only calls
 * createConfiguredSlackBot() and passes the result to the startup manager.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseAllowedTools } from "@sketch/shared";
import type { Kysely } from "kysely";
import { abortActiveRuns, withActiveRun } from "../agent/active-runs";
import type { AuxLlmCall } from "../agent/aux-cost";
import { PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE, agentFailureMessage } from "../agent/errors";
import type { QuestionInteractionService } from "../agent/interactions/service";
import { parseNumberedQuestionAnswer, renderNumberedQuestionStep } from "../agent/interactions/text";
import type { QuestionInteractionAnswerOutcome, QuestionInteractionCapabilities } from "../agent/interactions/types";
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
import { isRuntimeAbortError } from "../agent/runtime/errors";
import { archiveRuntimeSessions } from "../agent/sessions";
import { createProgressRenderer } from "../agent/tool-progress";
import { ensureAgentSubWorkspace, ensureChannelWorkspace, ensureWorkspace } from "../agent/workspace";
import {
  type FollowupReviewCommandHandler,
  createFollowupReviewCommandHandler,
} from "../agents/followup-review-command";
import { appendAutomationBuilderLinks } from "../automation/artifact-links";
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
import { refreshSlackChannelName } from "../connectors/slack-salience";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createChannelRepository } from "../db/repositories/channels";
import type { createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { type createSettingsRepository, parseOrgContext } from "../db/repositories/settings";
import { createSlackChannelParticipantsRepository } from "../db/repositories/slack-channel-participants";
import { isInternalSlackUser } from "../db/repositories/slack-entity-sync";
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
import { handleStealResponse, renderStealResponseConfirmation } from "../whatsapp/lock-confirmations";
import { slackApiCall } from "./api";
import {
  SlackBot,
  type SlackFile,
  type SlackMessage,
  type SlackMessageHandler,
  parseSlackLockStealAction,
} from "./bot";
import type { SlackEntitySyncService } from "./entity-sync";
import { HOME_ACTION_REASONING_TEXT, HOME_ACTION_TOOL_PROGRESS, buildHomeView } from "./home";
import { createSlackMessageHandler } from "./message-handler";
import { createSlackQuestionTransport, decodeSlackQuestionActionValue } from "./question-interactions";
import { SlackExternalUserError, SlackIdentityConflictError, resolveSlackUser } from "./resolve-user";
import { isSlackStopCommand } from "./stop";
import type { UserCache } from "./user-cache";

const SLACK_TEXT_QUESTION_CAPABILITIES: QuestionInteractionCapabilities = {
  available: true,
  interactiveSingleSelect: false,
  interactiveBatch: false,
  nativeCustomResponse: true,
  textFallback: true,
  cancelControl: false,
};

type UserRepository = ReturnType<typeof createUserRepository>;
type ChannelRepository = ReturnType<typeof createChannelRepository>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;
type InboxMessagesRepository = ReturnType<typeof createInboxMessagesRepository>;
type ConversationRepository = ReturnType<typeof createConversationRepository>;
type SlackChannelParticipantsRepository = ReturnType<typeof createSlackChannelParticipantsRepository>;

const INLINE_BACKLOG_LIMIT = 10;
const SLACK_THREAD_CURSOR_SCOPE = "slack_thread";
const SLACK_AGENT_ERROR_MESSAGE = "_Something went wrong, try again_";
const SLACK_STOP_REACTION = "white_check_mark";

function isAbortedRunResult(result: RunAgentResult): boolean {
  const legacyResult = result as RunAgentResult & { stopReason?: string | null };
  return result.rawUsage?.stopReason === "aborted" || legacyResult.stopReason === "aborted";
}

function abortSlackRunsForScope(channelId: string, threadTs: string | null, isDm: boolean): number {
  return abortActiveRuns((entry) => {
    const metadata = entry.metadata;
    return (
      metadata?.platform === "slack" && metadata.channelId === channelId && (isDm || metadata.threadTs === threadTs)
    );
  });
}

function isBotAuthoredSlackMessage(message: SlackMessage): boolean {
  return Boolean(message.botId) || message.subtype === "bot_message";
}

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

/**
 * Group DMs (channel_type "mpim") are recorded under their own kind so the
 * indexing pipeline, which operates on kind "channel" only, never chunks or
 * indexes them — the feature's scope excludes DMs of every arity. Capture
 * still runs so mention context keeps working inside group DMs.
 */
function slackConversationRefForMessage(message: { type: string; channelId: string; channelType?: string }) {
  if (message.type === "dm") {
    return { platform: "slack", kind: "dm", providerConversationId: message.channelId };
  }
  if (message.channelType === "mpim") {
    return { platform: "slack", kind: "mpim", providerConversationId: message.channelId };
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
    slackChannelParticipants?: SlackChannelParticipantsRepository;
  };
  queue: QueueManager;
  slack: {
    userCache: UserCache;
  };
  runAgent: (params: RunAgentParams) => Promise<RunAgentResult>;
  buildMcpServers: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  cliIntegrations?: RunAgentParams["cliIntegrations"];
  listAgentEnvForRuntime?: (context: {
    currentUserId?: string | null;
    contextType?: "dm" | "channel_mention" | "scheduled_task";
    allowOrgSharedEnv?: boolean;
    taskContext?: RunAgentParams["taskContext"];
  }) => Promise<Record<string, string>>;
  scheduler?: TaskScheduler;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  inboxMessagesRepo?: InboxMessagesRepository;
  slackEntitySync?: SlackEntitySyncService;
  isInternalSlackUser?: (slackUserId: string, email: string | null) => Promise<boolean>;
  onSlackChannelDiscovered?: () => void;
  recordSlackChannelParticipantJoined?: (channelId: string, slackUserId: string) => Promise<void>;
  recordSlackChannelParticipantObserved?: (channelId: string, slackUserId: string) => Promise<void>;
  recordSlackChannelParticipantLeft?: (channelId: string, slackUserId: string) => Promise<void>;
  sendDm: (params: { userId: string; platform: string; message: string }) => Promise<{
    channelId: string;
    messageRef: string;
  }>;
  sendTargetMessage?: RunAgentParams["sendTargetMessage"];
  followupReviewHandler?: FollowupReviewCommandHandler;
  questionInteractions?: QuestionInteractionService;
}

export async function validateSlackTokens(botToken: string, appToken?: string): Promise<{ teamId: string }> {
  void appToken;
  const auth = await slackApiCall(botToken, "auth.test");
  if (!auth.team_id) throw new Error("Slack auth.test did not return a team id");
  return { teamId: auth.team_id };
}

interface DownloadedSlackAttachment extends Attachment {
  slackFileIndex: number;
}

async function downloadSlackFiles(
  files: SlackFile[],
  botToken: string | null | undefined,
  attachDir: string,
  maxBytes: number,
  logger: Logger,
  failureLogMessage = "Failed to download file",
): Promise<DownloadedSlackAttachment[]> {
  const attachments: DownloadedSlackAttachment[] = [];
  for (const [slackFileIndex, file] of files.entries()) {
    try {
      if (!botToken) {
        throw new Error("Slack bot token not configured");
      }
      const downloaded = await downloadSlackFile(file.urlPrivate, botToken, attachDir, maxBytes, logger);
      attachments.push({ ...downloaded, slackFileIndex });
    } catch (err) {
      logger.warn({ err, fileName: file.name }, failureLogMessage);
    }
  }
  return attachments;
}

function filesForAutomationTrigger(files: SlackFile[] | undefined, attachments: Attachment[]) {
  return (files ?? []).map((file, slackFileIndex) => {
    const attachment = attachments.find(
      (candidate) => (candidate as Partial<DownloadedSlackAttachment>).slackFileIndex === slackFileIndex,
    );
    return attachment ? { ...file, localPath: attachment.localPath } : file;
  });
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
    sendTargetMessage,
  } = deps;
  const toolConfig = { BASE_URL: config.BASE_URL, PORT: config.PORT };
  const maxFileBytes = config.MAX_FILE_SIZE_MB * 1024 * 1024;
  const handleFollowupReviewCommand = deps.followupReviewHandler ?? createFollowupReviewCommandHandler(db);

  const mode = config.SLACK_MODE ?? "socket";
  const slackBot = new SlackBot({
    mode,
    botToken: tokens.botToken,
    ...(mode === "socket" ? { appToken: tokens.appToken } : { signingSecret: config.SLACK_SIGNING_SECRET }),
    logger,
    eventSilenceThresholdMs: config.SLACK_ENTITY_SYNC
      ? config.SLACK_ENTITY_EVENT_SILENCE_THRESHOLD_MS
      : Number.MAX_SAFE_INTEGER,
    lifecycleEventsEnabled: config.SLACK_ENTITY_SYNC,
    onTeamIdResolved: async (teamId) => {
      await deps.repos.settings.update({ slackTeamId: teamId });
    },
  });
  const slackChannelParticipants = repos.slackChannelParticipants ?? createSlackChannelParticipantsRepository(db);
  const recordSlackChannelParticipantJoined =
    deps.recordSlackChannelParticipantJoined ??
    ((channelId: string, slackUserId: string) => slackChannelParticipants.upsert(channelId, slackUserId));
  const recordSlackChannelParticipantObserved =
    deps.recordSlackChannelParticipantObserved ??
    ((channelId: string, slackUserId: string) => slackChannelParticipants.upsert(channelId, slackUserId));
  const recordSlackChannelParticipantLeft =
    deps.recordSlackChannelParticipantLeft ??
    ((channelId: string, slackUserId: string) => slackChannelParticipants.remove(channelId, slackUserId));

  slackBot.onMemberJoinedChannel(async ({ channelId, slackUserId, isBot, teamId }) => {
    await recordSlackChannelParticipantJoined(channelId, slackUserId);
    if (deps.slackEntitySync) {
      const refresh = isBot
        ? deps.slackEntitySync.handleBotJoinedChannel({
            channelId,
            ...(teamId ? { teamId } : {}),
          })
        : deps.slackEntitySync.handleMemberJoinedChannel({
            channelId,
            slackUserId,
            ...(teamId ? { teamId } : {}),
          });
      void refresh.catch((error) => {
        logger.warn({ error, teamId, channelId }, "Slack channel member entity sync failed");
      });
    }
  });
  slackBot.onMemberLeftChannel(async ({ channelId, slackUserId, teamId }) => {
    await recordSlackChannelParticipantLeft(channelId, slackUserId);
    await deps.slackEntitySync?.handleMemberLeftChannel({
      channelId,
      slackUserId,
      ...(teamId ? { teamId } : {}),
    });
  });
  slackBot.onTeamJoin?.(async ({ teamId, slackUserId }) => {
    await deps.slackEntitySync?.handleUserEvent({
      eventType: "team_join",
      slackUserId,
      ...(teamId ? { teamId } : {}),
    });
  });
  slackBot.onUserChange?.(async ({ teamId, slackUserId }) => {
    await deps.slackEntitySync?.handleUserEvent({
      eventType: "user_change",
      slackUserId,
      ...(teamId ? { teamId } : {}),
    });
  });
  const recordObservedChannelParticipant = async (message: SlackMessage) => {
    if (message.userId && message.channelType !== "mpim") {
      await recordSlackChannelParticipantObserved(message.channelId, message.userId);
    }
    if (message.userId && deps.slackEntitySync) {
      try {
        await deps.slackEntitySync.observeMessage({
          channelId: message.channelId,
          slackUserId: message.userId,
          ...(message.teamId ? { teamId: message.teamId } : {}),
        });
      } catch (err) {
        logger.warn({ err, slackUserId: message.userId }, "Slack observe-on-message entity sync failed");
      }
    }
  };

  const resolveUser = (slackUserId: string) =>
    resolveSlackUser(slackUserId, {
      users: repos.users,
      getUserInfo: (id) => slackDeps.userCache.resolve(id, (uid) => slackBot.getUserInfo(uid)),
      isInternalSender: (id, userInfo) =>
        deps.isInternalSlackUser
          ? deps.isInternalSlackUser(id, userInfo.email)
          : isInternalSlackUser(db, id, userInfo.email, userInfo),
      logger,
    });

  if (deps.questionInteractions) {
    slackBot.onQuestionAction(async (event) => {
      const service = deps.questionInteractions;
      if (!service) return;
      const value = decodeSlackQuestionActionValue(event.value);
      if (!value) return;
      let user: Awaited<ReturnType<typeof resolveUser>>;
      try {
        user = await resolveUser(event.slackUserId);
      } catch (err) {
        logger.warn({ err, slackUserId: event.slackUserId }, "Ignoring question action from unresolved Slack user");
        return;
      }
      const pending = await service.getPending(value.interactionId);
      if (pending.kind !== "found") return;
      const interaction = pending.interaction;
      if (
        interaction.target.platform !== "slack" ||
        interaction.target.conversationId !== event.channelId ||
        interaction.target.threadId !== event.threadTs
      ) {
        return;
      }
      if (!interaction.target.eligibleResponderPrincipalIds.includes(user.id)) {
        await slackBot.postInteractiveMessage({
          channelId: event.channelId,
          threadTs: event.threadTs,
          text: "That question is no longer available.",
        });
        return;
      }
      if (event.actionId !== "question_option" || !value.questionId || !value.optionId) return;
      const interactionId = value.interactionId;
      const questionId = value.questionId;
      const optionId = value.optionId;
      const activeQueueKey =
        interaction.target.conversationKind === "dm" ? user.id : `${event.channelId}:${event.threadTs ?? ""}`;
      queue.getQueue(activeQueueKey).enqueue(async () => {
        const outcome = await service.submitAnswer({
          interactionId,
          questionId,
          optionId,
          responderPrincipalId: user.id,
          inboundEventId: event.eventId,
          receivedAt: new Date().toISOString(),
        });
        if (outcome.kind === "accepted_pending") {
          const next = await service.findPendingForTarget({
            platform: "slack",
            conversationId: event.channelId,
            threadId: event.threadTs,
            responderPrincipalId: user.id,
          });
          await slackBot.postInteractiveMessage({
            channelId: event.channelId,
            threadTs: event.threadTs,
            text:
              next.kind === "found"
                ? renderNumberedQuestionStep(next)
                : "Your answer was saved, but I couldn't load the next question. Please try again.",
          });
        } else if (outcome.kind === "completed") {
          await service.resumeQuestionInteraction(outcome.resumeWork, async (claimedResumeWork) => {
            await executeSlackQuestionResume(claimedResumeWork);
          });
        } else if (outcome.kind !== "duplicate") {
          await slackBot.postInteractiveMessage({
            channelId: event.channelId,
            threadTs: event.threadTs,
            text: "That response could not be accepted. Please use the current question.",
          });
        }
      });
    });
  }

  slackBot.onLockStealAction(async (event) => {
    const parsed = parseSlackLockStealAction(event.actionId);
    if (!parsed) return;
    let user: Awaited<ReturnType<typeof resolveUser>>;
    try {
      user = await resolveUser(event.slackUserId);
    } catch (err) {
      logger.warn({ err, slackUserId: event.slackUserId }, "Ignoring lock steal action from unresolved Slack user");
      return;
    }
    const outcome = await handleStealResponse({
      db,
      logger,
      taskId: parsed.taskId,
      responderUserId: user.id,
      responderName: user.name,
      approve: parsed.action === "approve",
      senders: {
        slack: {
          postLockStealRequest: (params) => slackBot.postLockStealRequestMessage(params.channelId, params),
          sendText: (channelId, text) => slackBot.postMessage(channelId, text),
        },
      },
    });
    await slackBot.postMessage(event.channelId, renderStealResponseConfirmation(outcome));
  });

  const processSlackTextQuestionAnswer = async (
    message: SlackMessage,
    user: Awaited<ReturnType<typeof resolveUser>>,
  ): Promise<boolean> => {
    const service = deps.questionInteractions;
    if (
      !service ||
      (message.type !== "dm" && message.type !== "channel_mention") ||
      isConversationControlMessage(message.text) ||
      isSlackStopCommand(message.text) ||
      message.text.trim().startsWith("/")
    ) {
      return false;
    }
    const threadId = message.type === "dm" ? (message.threadTs ?? null) : (message.threadTs ?? message.ts);
    const currentStep = await service.findPendingForTarget({
      platform: "slack",
      conversationId: message.channelId,
      threadId,
      responderPrincipalId: user.id,
    });
    if (currentStep.kind !== "found") return false;
    const parsed = parseNumberedQuestionAnswer(message.text, currentStep.question);
    if (parsed.kind === "invalid") {
      await slackBot.postInteractiveMessage({
        channelId: message.channelId,
        threadTs: threadId,
        text: renderNumberedQuestionStep(currentStep),
      });
      return true;
    }
    const outcome = await service.submitAnswer({
      interactionId: currentStep.interaction.id,
      ...parsed.answer,
      responderPrincipalId: user.id,
      inboundEventId: `slack-message:${message.ts}`,
      receivedAt: new Date().toISOString(),
    });
    if (outcome.kind === "accepted_pending") {
      const next = await service.findPendingForTarget({
        platform: "slack",
        conversationId: message.channelId,
        threadId,
        responderPrincipalId: user.id,
      });
      await slackBot.postInteractiveMessage({
        channelId: message.channelId,
        threadTs: threadId,
        text:
          next.kind === "found"
            ? renderNumberedQuestionStep(next)
            : "Your answer was saved, but I couldn't load the next question. Please try again.",
      });
    } else if (outcome.kind === "completed") {
      const shimmer = createShimmer(
        slackBot,
        message.channelId,
        message.threadTs ?? message.ts,
        resolveProgressDisplaySettings(user),
      );
      try {
        await service.resumeQuestionInteraction(outcome.resumeWork, async (claimedResumeWork) => {
          await executeSlackQuestionResume(claimedResumeWork, shimmer.onProgressEvent);
        });
      } finally {
        await shimmer.clear();
      }
    } else if (outcome.kind !== "duplicate") {
      const current = await service.findPendingForTarget({
        platform: "slack",
        conversationId: message.channelId,
        threadId,
        responderPrincipalId: user.id,
      });
      await slackBot.postInteractiveMessage({
        channelId: message.channelId,
        threadTs: threadId,
        text: current.kind === "found" ? renderNumberedQuestionStep(current) : "That question is no longer available.",
      });
    }
    return true;
  };

  const claimSlackTextQuestionAnswer = async (
    message: SlackMessage,
    user: Awaited<ReturnType<typeof resolveUser>>,
  ): Promise<boolean> => {
    const service = deps.questionInteractions;
    if (
      !service ||
      (message.type !== "dm" && message.type !== "channel_mention") ||
      isConversationControlMessage(message.text) ||
      isSlackStopCommand(message.text) ||
      message.text.trim().startsWith("/")
    ) {
      return false;
    }
    const threadId = message.type === "dm" ? (message.threadTs ?? null) : (message.threadTs ?? message.ts);
    const pending = await service.findPendingForTarget({
      platform: "slack",
      conversationId: message.channelId,
      threadId,
      responderPrincipalId: user.id,
    });
    if (pending.kind !== "found") return false;
    const activeQueueKey = message.type === "dm" ? user.id : `${message.channelId}:${threadId ?? ""}`;
    queue.getQueue(activeQueueKey).enqueue(async () => {
      await processSlackTextQuestionAnswer(message, user);
    });
    return true;
  };

  const deliverSlackPendingInteraction = async (input: {
    result: RunAgentResult;
    userId: string;
    channelId: string;
    threadId: string | null;
    conversationKind: "dm" | "channel";
    workspaceKey: string;
    sourceConversationId: string;
    requestKey: string;
  }): Promise<boolean> => {
    const interaction = input.result.pendingInteraction;
    const service = deps.questionInteractions;
    if (!interaction) return false;
    const reportDeliveryFailure = async () => {
      await slackBot.postInteractiveMessage({
        channelId: input.channelId,
        threadTs: input.threadId,
        text: "I couldn't ask the next question right now. Please try again.",
      });
    };
    if (!service) {
      await reportDeliveryFailure();
      return true;
    }
    try {
      const pending = await service.createFromInteraction({
        interaction,
        target: {
          platform: "slack",
          conversationKind: input.conversationKind,
          conversationId: input.channelId,
          threadId: input.threadId,
          requesterPrincipalId: input.userId,
          eligibleResponderPrincipalIds: [input.userId],
        },
        resumeContext: {
          sessionId: input.result.sessionId,
          taskId: null,
          agentRunId: null,
          workspaceId: input.workspaceKey,
          sourceConversationId: input.sourceConversationId,
          requesterPrincipalId: input.userId,
          platform: "slack",
          conversationId: input.channelId,
          threadId: input.threadId,
        },
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      if (!pending) {
        await reportDeliveryFailure();
        return true;
      }
      const receipt = await service.deliver({
        interactionId: pending.id,
        requestKey: input.requestKey,
        transportName: "slack",
        capabilityName: "plain_text",
        capabilities: SLACK_TEXT_QUESTION_CAPABILITIES,
        transport: createSlackQuestionTransport({ post: (message) => slackBot.postInteractiveMessage(message) }),
      });
      if (receipt.status !== "sent" && receipt.status !== "already_sent") await reportDeliveryFailure();
      return true;
    } catch (err) {
      logger.warn({ err, channelId: input.channelId }, "Failed to deliver Slack question interaction");
      await reportDeliveryFailure();
      return true;
    }
  };

  const executeSlackQuestionResume = async (
    resumeWork: Extract<QuestionInteractionAnswerOutcome, { kind: "completed" }>["resumeWork"],
    onProgressEvent: RunAgentParams["onProgressEvent"] = async () => {},
  ): Promise<void> => {
    const requester = await repos.users.findById(resumeWork.context.requesterPrincipalId);
    if (!requester) throw new Error("Question interaction requester is unavailable");
    const isDm =
      resumeWork.context.conversationKind === "dm" ||
      (resumeWork.context.conversationKind === undefined && resumeWork.context.threadId === null);
    const channel = isDm ? null : await ensureChannelRow(resumeWork.context.conversationId);
    const boundAgent = channel?.agent_user_id ? await repos.users.findById(channel.agent_user_id) : null;
    const workspaceKey =
      resumeWork.context.workspaceId ?? (isDm ? requester.id : `channel-${resumeWork.context.conversationId}`);
    const workspaceDir = isDm
      ? await ensureWorkspace(config, workspaceKey)
      : boundAgent
        ? await ensureAgentSubWorkspace(config, boundAgent.id, `channel-${resumeWork.context.conversationId}`)
        : await ensureChannelWorkspace(config, resumeWork.context.conversationId);
    const settingsRow = await repos.settings.get();
    const threadTs = resumeWork.context.threadId ?? undefined;
    const onFinalMessage = createSlackMessageHandler(slackBot, resumeWork.context.conversationId, threadTs);
    const result = await runAgent({
      db,
      workspaceKey,
      workspaceDir,
      claudeConfigDir: config.CLAUDE_CONFIG_DIR,
      userName: requester.name,
      userEmail: requester.email,
      logger,
      platform: "slack",
      responseSurface: "slack",
      questionInteractionCapabilities: deps.questionInteractions ? SLACK_TEXT_QUESTION_CAPABILITIES : undefined,
      userMessage: resumeWork.continuationText,
      resumeSessionId: resumeWork.context.sessionId,
      onProgressEvent,
      getSlack: () => slackBot,
      ...(threadTs ? { threadTs } : {}),
      orgName: settingsRow?.org_name,
      orgDescription: parseOrgContext(settingsRow?.org_context)?.description ?? null,
      botName: settingsRow?.bot_name,
      integrationMcpServers: await buildMcpServers(requester.email),
      loadIntegrationProvider,
      cliIntegrations: deps.cliIntegrations,
      agentEnv: await (deps.listAgentEnvForRuntime?.({
        currentUserId: requester.id,
        contextType: isDm ? "dm" : "channel_mention",
        allowOrgSharedEnv: true,
        taskContext: {
          platform: "slack",
          contextType: isDm ? "dm" : "channel",
          deliveryTarget: resumeWork.context.conversationId,
          createdBy: requester.id,
        },
      }) ?? Promise.resolve(undefined)),
      contextType: isDm ? "dm" : "channel_mention",
      currentUserId: requester.id,
      ...(boundAgent?.description ? { agentInstructions: boundAgent.description } : {}),
      ...(boundAgent ? { agentAllowedTools: parseAllowedTools(boundAgent.allowed_tools) } : {}),
      taskContext: {
        platform: "slack",
        contextType: isDm ? "dm" : "channel",
        deliveryTarget: resumeWork.context.conversationId,
        createdBy: requester.id,
        canManageAnyTask: requester.auth_role === "admin",
        creatorTimezone: requester.timezone,
        ...(threadTs ? { threadTs } : {}),
        origin: {
          platform: "slack",
          conversationId: resumeWork.context.sourceConversationId ?? resumeWork.context.conversationId,
          providerThreadId: threadTs ?? null,
          currentMessageId: null,
        },
      },
      scheduler,
      stepContentRepo,
      automationRunsRepo,
      queueManager: queue,
      activeQueueKey: isDm ? requester.id : `${resumeWork.context.conversationId}:${threadTs ?? ""}`,
      toolConfig,
      inboxMessagesRepo,
      userRepo: repos.users,
      sendDm,
    });
    const deliveredQuestion = await deliverSlackPendingInteraction({
      result,
      userId: requester.id,
      channelId: resumeWork.context.conversationId,
      threadId: resumeWork.context.threadId,
      conversationKind: isDm ? "dm" : "channel",
      workspaceKey,
      sourceConversationId: resumeWork.context.sourceConversationId ?? resumeWork.context.conversationId,
      requestKey: `slack-resume:${resumeWork.interactionId}:${result.sessionId}`,
    });
    if (deliveredQuestion) return;
    const finalText = appendIntegrationConnectionLinks(
      appendAutomationBuilderLinks(result.trace.finalText, result.trace.automationArtifacts ?? []),
      result.pendingIntegrationConnections,
      "slack",
      toolConfig,
    );
    if (finalText) await onFinalMessage(finalText);
    else
      await slackBot.postInteractiveMessage({
        channelId: resumeWork.context.conversationId,
        threadTs: resumeWork.context.threadId,
        text: "Your answer was saved, but I could not continue right now. Please try again shortly.",
      });
  };

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

  const resolvePassiveSender = async (message: Parameters<SlackMessageHandler>[0]) => {
    if (!message.userId) {
      return { senderName: "Slack bot", senderUserId: null };
    }
    const [user, userInfo] = await Promise.all([
      repos.users.findBySlackId(message.userId),
      slackDeps.userCache.resolve(message.userId, (id) => slackBot.getUserInfo(id)),
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
    const conversationRef = slackConversationRefForMessage(message);
    const existingConversation = await repos.conversations.find(conversationRef);
    const conversation =
      existingConversation &&
      (params.displayName === undefined || params.displayName === existingConversation.display_name)
        ? existingConversation
        : await repos.conversations.getOrCreate(conversationRef, params.displayName);
    if (!existingConversation && conversation.platform === "slack" && conversation.kind === "channel") {
      deps.onSlackChannelDiscovered?.();
    }

    if (isConversationControlMessage(message.text)) {
      return { conversation, captured: null, inserted: false, omitted: true };
    }

    const captured = await repos.conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: message.ts,
      senderJid: message.userId ?? message.botId ?? "unknown",
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
    if (!message.userId) return;
    const replyToUser = (text: string): Promise<unknown> =>
      message.threadTs
        ? slackBot.postThreadReply(message.channelId, message.threadTs, text)
        : slackBot.postMessage(message.channelId, text);

    let user: Awaited<ReturnType<typeof resolveUser>>;
    try {
      user = await resolveUser(message.userId);
    } catch (err) {
      if (err instanceof SlackExternalUserError) {
        await replyToUser("Sketch is only available to internal workspace members.");
        return;
      }
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
    if (await claimSlackTextQuestionAnswer(message, user)) return;
    const activeQueueKey = user.id;
    if (!isBotAuthoredSlackMessage(message) && isSlackStopCommand(message.text)) {
      abortSlackRunsForScope(message.channelId, null, true);
      queue.clear(activeQueueKey);
      await slackBot.addReaction(message.channelId, message.ts, SLACK_STOP_REACTION);
      return;
    }
    const userQueue = queue.getQueue(activeQueueKey);

    userQueue.enqueue(async () => {
      const abortController = new AbortController();
      let capture: Awaited<ReturnType<typeof captureSlackMessage>> | undefined;
      let clearAssistantStatus: (() => Promise<void>) | null = null;
      let pendingInbox: Awaited<ReturnType<typeof loadPendingInboxMessages>> | null = null;
      await withActiveRun(
        `slack:${randomUUID()}`,
        abortController,
        async () => {
          logger.info({ slackUserId: message.userId, channelId: message.channelId }, "Processing message");

          const command = parseSketchCommand(message.text);
          const dmConversation = await repos.conversations.getOrCreate(
            slackConversationRefForMessage(message),
            user.name,
          );
          const followupReview = await handleFollowupReviewCommand({
            text: message.text,
            userId: user.id,
            surface: "slack",
          });
          if (followupReview.handled) {
            await captureSlackMessage({
              message,
              senderName: user.name,
              senderUserId: user.id,
              addressedToSketch: true,
              attachments: [],
              displayName: user.name,
            });
            await replyToUser(followupReview.message);
            return;
          }
          if (command === "new_session") {
            await deps.questionInteractions?.cancelPendingForTarget({
              target: { platform: "slack", conversationId: message.channelId, threadId: null },
              requesterPrincipalId: user.id,
            });
            await archiveRuntimeSessions(db, user.id);
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
            await replyToUser(
              getToolProgressConfirmation(requestedToolProgress, currentProgressSettings.reasoningText),
            );
            return;
          }

          const requestedReasoningText = resolveCommandReasoningText(command);
          if (requestedReasoningText) {
            const enabled = requestedReasoningText === "on";
            await repos.users.update(user.id, { reasoningText: enabled });
            await replyToUser(getReasoningTextConfirmation(enabled));
            return;
          }

          if (await processSlackTextQuestionAnswer(message, user)) return;

          try {
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
            capture = await captureSlackMessage({
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

            if (abortController.signal.aborted) {
              await repos.conversations.updateWatermark(capture.conversation.id, capture.captured.id);
              return;
            }

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
              questionInteractionCapabilities: deps.questionInteractions ? SLACK_TEXT_QUESTION_CAPABILITIES : undefined,
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
              cliIntegrations: deps.cliIntegrations,
              agentEnv: await (deps.listAgentEnvForRuntime?.({
                currentUserId: user.id,
                contextType: "dm",
                allowOrgSharedEnv: true,
                taskContext: {
                  platform: "slack",
                  contextType: "dm",
                  deliveryTarget: message.channelId,
                  createdBy: user.id,
                },
              }) ?? Promise.resolve(undefined)),
              contextType: "dm",
              taskContext: {
                platform: "slack" as const,
                contextType: "dm" as const,
                deliveryTarget: message.channelId,
                createdBy: user.id,
                canManageAnyTask: user.auth_role === "admin",
                creatorTimezone: user.timezone,
                origin: {
                  platform: "slack" as const,
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
              abortController,
              toolConfig,
              inboxMessagesRepo,
              userRepo: repos.users,
              currentUserId: user.id,
              sendDm,
              sendTargetMessage,
              conversationRepo: repos.conversations,
              conversationContext: { conversationId: capture.conversation.id, currentMessageId: capture.captured.id },
            });

            if (isAbortedRunResult(result)) {
              await clearAssistantStatus();
              await repos.conversations.updateWatermark(capture.conversation.id, capture.captured.id);
              return;
            }

            const finalText = appendIntegrationConnectionLinks(
              appendAutomationBuilderLinks(result.trace.finalText, result.trace.automationArtifacts ?? []),
              result.pendingIntegrationConnections,
              "slack",
              toolConfig,
            );
            const deliveredQuestion = await deliverSlackPendingInteraction({
              result,
              userId: user.id,
              channelId: message.channelId,
              threadId: assistantThreadTs ?? null,
              conversationKind: "dm",
              workspaceKey: user.id,
              sourceConversationId: String(capture.conversation.id),
              requestKey: `slack:${message.channelId}:${assistantThreadTs ?? "root"}:${result.sessionId}`,
            });
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
            if (!finalText && !deliveredQuestion) {
              await replyToUser("_No response_");
            }
          } catch (err) {
            if (isRuntimeAbortError(err, abortController.signal)) {
              await clearAssistantStatus?.();
              if (capture?.captured) {
                await repos.conversations.updateWatermark(capture.conversation.id, capture.captured.id);
              }
              return;
            }
            logger.error({ err, userId: user.id }, "Agent run failed");
            await clearAssistantStatus?.();
            await replyToUser(agentFailureMessage(err, SLACK_AGENT_ERROR_MESSAGE));
          }
        },
        { platform: "slack", channelId: message.channelId, threadTs: message.threadTs ?? null },
      );
    });
  });

  /**
   * Channel renames arrive as excluded system messages, so this is the only
   * signal that refreshes stored metadata: the channels row feeds agent
   * context and the conversations display name feeds Slack slice rendering
   * and indexed file names.
   */
  slackBot.onChannelRenamed(async (channelId) => {
    const channelInfo = await slackBot.getChannelInfo(channelId);
    const channel = await repos.channels.findBySlackChannelId(channelId);
    if (channel && channel.name !== channelInfo.name) {
      await repos.channels.update(channel.id, { name: channelInfo.name });
    }
    await refreshSlackChannelName({ db, logger, channelId, channelName: channelInfo.name });
    logger.info({ channelId, name: channelInfo.name }, "Refreshed channel metadata after rename");
  });

  // Passive top-level channel message handler
  slackBot.onChannelMessage(async (message) => {
    try {
      await recordObservedChannelParticipant(message);
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
      const sender = await resolvePassiveSender(message);
      const capture = await captureSlackMessage({
        message,
        senderName: sender.senderName,
        senderUserId: sender.senderUserId,
        addressedToSketch: false,
        attachments,
        displayName: channel.name,
      });
      let followupReviewHandled = false;
      if (sender.senderUserId) {
        const followupReview = await handleFollowupReviewCommand({
          text: message.text,
          userId: sender.senderUserId,
          surface: "slack",
        });
        if (followupReview.handled) {
          followupReviewHandled = true;
          await slackBot.postThreadReply(message.channelId, message.ts, followupReview.message);
        }
      }
      if (capture.inserted && !followupReviewHandled && message.channelType !== "mpim" && scheduler) {
        await scheduler.dispatchSlackChannelMessage(
          message.channelId,
          {
            type: "slack_channel_message",
            channelId: message.channelId,
            messageTs: message.ts,
            text: message.text,
            userId: message.userId ?? null,
            botId: message.botId ?? null,
            appId: message.appId ?? null,
            subtype: message.subtype ?? null,
            files: filesForAutomationTrigger(message.files, attachments),
            capturedMessageId: capture.captured?.id ?? null,
            conversationId: capture.conversation.id,
          },
          { sourceWorkspaceDir: workspaceDir },
        );
      }
    } catch (err) {
      logger.warn({ err, channelId: message.channelId }, "Failed to capture passive Slack channel message");
    }
  });

  // Passive thread message handler
  slackBot.onThreadMessage(async (message) => {
    if (!message.threadTs) return;
    try {
      await recordObservedChannelParticipant(message);
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
      const sender = await resolvePassiveSender(message);
      await captureSlackMessage({
        message,
        senderName: sender.senderName,
        senderUserId: sender.senderUserId,
        addressedToSketch: false,
        attachments,
        displayName: channel.name,
      });
      if (sender.senderUserId) {
        const followupReview = await handleFollowupReviewCommand({
          text: message.text,
          userId: sender.senderUserId,
          surface: "slack",
        });
        if (followupReview.handled) {
          await slackBot.postThreadReply(message.channelId, message.threadTs, followupReview.message);
          return;
        }
      }

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
    const userId = message.userId;
    if (!userId) return;
    const participantObservation = recordObservedChannelParticipant(message);
    void participantObservation.catch(() => undefined);
    const threadTs = message.threadTs ?? message.ts;
    const activeQueueKey = `${message.channelId}:${threadTs}`;
    if (!isBotAuthoredSlackMessage(message) && isSlackStopCommand(message.text)) {
      abortSlackRunsForScope(message.channelId, threadTs, false);
      queue.clear(activeQueueKey);
      await slackBot.addReaction(message.channelId, message.ts, SLACK_STOP_REACTION);
      return;
    }
    const mentionQueue = queue.getQueue(activeQueueKey);

    mentionQueue.enqueue(async () => {
      const abortController = new AbortController();
      let consumedMessageId: number | undefined;
      let consumedConversationId: number | undefined;
      await withActiveRun(
        `slack:${randomUUID()}`,
        abortController,
        async () => {
          logger.info({ slackUserId: message.userId, channelId: message.channelId }, "Processing channel mention");

          let user: Awaited<ReturnType<typeof resolveUser>> | undefined;
          let clearAssistantStatus: (() => Promise<void>) | null = null;

          try {
            await participantObservation;
            user = await resolveUser(userId);

            if (await processSlackTextQuestionAnswer(message, user)) return;

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
            const followupReview = await handleFollowupReviewCommand({
              text: message.text,
              userId: user.id,
              surface: "slack",
            });
            if (followupReview.handled) {
              await captureSlackMessage({
                message,
                senderName: user.name,
                senderUserId: user.id,
                addressedToSketch: true,
                attachments: [],
                displayName: channel.name,
              });
              await slackBot.postThreadReply(message.channelId, threadTs, followupReview.message);
              return;
            }
            if (command === "new_session") {
              await deps.questionInteractions?.cancelPendingForTarget({
                target: { platform: "slack", conversationId: message.channelId, threadId: threadTs },
                requesterPrincipalId: user.id,
              });
              await archiveRuntimeSessions(db, channelWorkspaceKey, threadTs);
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
              await slackBot.postThreadReply(
                message.channelId,
                threadTs,
                getToolProgressCurrent(currentProgressSettings),
              );
              return;
            }

            if (command === "reasoning_text_query") {
              await slackBot.postThreadReply(
                message.channelId,
                threadTs,
                getReasoningTextCurrent(currentProgressSettings),
              );
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
              message: channel.type === "mpim" ? { ...message, channelType: "mpim" } : message,
              senderName: user.name,
              senderUserId: user.id,
              addressedToSketch: true,
              attachments,
              displayName: channel.name,
            });
            consumedMessageId = capture.captured?.id;
            consumedConversationId = capture.conversation.id;
            if (!capture.captured) return;
            if (capture.inserted && !message.threadTs && channel.type !== "mpim" && scheduler) {
              await scheduler.dispatchSlackChannelMessage(
                message.channelId,
                {
                  type: "slack_channel_message",
                  channelId: message.channelId,
                  messageTs: message.ts,
                  text: message.text,
                  userId: message.userId ?? null,
                  botId: message.botId ?? null,
                  appId: message.appId ?? null,
                  subtype: message.subtype ?? null,
                  files: filesForAutomationTrigger(message.files, attachments),
                  capturedMessageId: capture.captured.id,
                  conversationId: capture.conversation.id,
                },
                { sourceWorkspaceDir: workspaceDir },
              );
            }

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
              isThreadReply: message.threadTs ? undefined : false,
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
            const shimmer = createShimmer(
              slackBot,
              message.channelId,
              threadTs,
              resolveProgressDisplaySettings(channel),
            );
            clearAssistantStatus = shimmer.clear;
            const onProgressEvent = shimmer.onProgressEvent;

            const integrationMcpServers = await buildMcpServers(user.email);
            const activeUser = user;

            if (abortController.signal.aborted) {
              if (consumedConversationId !== undefined && consumedMessageId !== undefined) {
                await repos.conversations.updateCursor({
                  conversationId: consumedConversationId,
                  scopeType: SLACK_THREAD_CURSOR_SCOPE,
                  scopeKey: threadTs,
                  messageId: consumedMessageId,
                });
              }
              return;
            }

            const result = await runAgent({
              db,
              workspaceKey: channelWorkspaceKey,
              seedAuxCalls: eagerAuxCalls,
              userMessage,
              workspaceDir,
              claudeConfigDir: config.CLAUDE_CONFIG_DIR,
              userName: activeUser.name,
              userEmail: activeUser.email,
              logger,
              platform: "slack",
              questionInteractionCapabilities: deps.questionInteractions ? SLACK_TEXT_QUESTION_CAPABILITIES : undefined,
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
              cliIntegrations: deps.cliIntegrations,
              agentEnv: await (deps.listAgentEnvForRuntime?.({
                currentUserId: activeUser.id,
                contextType: "channel_mention",
                allowOrgSharedEnv: true,
                taskContext: {
                  platform: "slack",
                  contextType: "channel",
                  deliveryTarget: message.channelId,
                  createdBy: activeUser.id,
                },
              }) ?? Promise.resolve(undefined)),
              contextType: "channel_mention",
              currentUserId: activeUser.id,
              taskContext: {
                platform: "slack" as const,
                contextType: "channel" as const,
                deliveryTarget: message.channelId,
                createdBy: activeUser.id,
                canManageAnyTask: activeUser.auth_role === "admin",
                creatorTimezone: activeUser.timezone,
                threadTs: message.threadTs ? threadTs : undefined,
                origin: {
                  platform: "slack" as const,
                  conversationId: String(capture.conversation.id),
                  providerThreadId: threadTs,
                  currentMessageId: capture.captured.id,
                },
              },
              scheduler,
              stepContentRepo,
              automationRunsRepo,
              queueManager: queue,
              activeQueueKey,
              abortController,
              toolConfig,
              inboxMessagesRepo,
              userRepo: repos.users,
              sendDm,
              sendTargetMessage,
              agentInstructions,
              agentAllowedTools,
              conversationRepo: repos.conversations,
              conversationContext: {
                conversationId: capture.conversation.id,
                currentMessageId: capture.captured.id,
                providerThreadId: message.threadTs ? threadTs : undefined,
                ...(message.threadTs ? {} : { isThreadReply: false }),
              },
            });

            if (isAbortedRunResult(result)) {
              await clearAssistantStatus?.();
              if (consumedConversationId !== undefined && consumedMessageId !== undefined) {
                await repos.conversations.updateCursor({
                  conversationId: consumedConversationId,
                  scopeType: SLACK_THREAD_CURSOR_SCOPE,
                  scopeKey: threadTs,
                  messageId: consumedMessageId,
                });
              }
              return;
            }

            const finalText = appendIntegrationConnectionLinks(
              appendAutomationBuilderLinks(result.trace.finalText, result.trace.automationArtifacts ?? []),
              result.pendingIntegrationConnections,
              "slack",
              toolConfig,
            );
            const deliveredQuestion = await deliverSlackPendingInteraction({
              result,
              userId: activeUser.id,
              channelId: message.channelId,
              threadId: threadTs,
              conversationKind: "channel",
              workspaceKey: channelWorkspaceKey,
              sourceConversationId: String(capture.conversation.id),
              requestKey: `slack:${message.channelId}:${threadTs}:${result.sessionId}`,
            });
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
            if (!finalText && !deliveredQuestion) {
              await slackBot.postThreadReply(message.channelId, threadTs, "_No response_");
            }
          } catch (err) {
            if (isRuntimeAbortError(err, abortController.signal)) {
              await clearAssistantStatus?.();
              if (consumedConversationId !== undefined && consumedMessageId !== undefined) {
                await repos.conversations.updateCursor({
                  conversationId: consumedConversationId,
                  scopeType: SLACK_THREAD_CURSOR_SCOPE,
                  scopeKey: threadTs,
                  messageId: consumedMessageId,
                });
              }
              return;
            }
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
            if (err instanceof SlackExternalUserError) {
              await slackBot.postThreadReply(
                message.channelId,
                threadTs,
                "Sketch is only available to internal workspace members.",
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
        },
        { platform: "slack", channelId: message.channelId, threadTs },
      );
    });
  });

  return slackBot;
}
