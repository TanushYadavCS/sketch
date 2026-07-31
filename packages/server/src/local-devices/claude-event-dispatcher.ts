import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { Kysely } from "kysely";
import { buildSketchContext } from "../agent/prompt";
import type { McpServerConfig, RunAgentParams } from "../agent/runner";
import type { Config } from "../config";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { type createSettingsRepository, parseOrgContext } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { extensionToMime } from "../files";
import { appendIntegrationConnectionLinks } from "../integrations/connection-links";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import type { QueueManager } from "../queue";
import { providerTimestampFromSlackTs } from "../scheduler/delivery-capture";
import type { TaskScheduler } from "../scheduler/service";
import type { SlackBot } from "../slack/bot";
import { createSlackMessageHandler } from "../slack/message-handler";
import type { WhatsAppSocketFacade } from "../whatsapp/facade-contract";
import { createWhatsAppMessageHandler } from "../whatsapp/message-handler";
import { type WhatsAppSendResult, whatsappTargetFromDeliveryTarget } from "../whatsapp/provider";
import type { WhatsAppRuntime } from "../whatsapp/runtime";
import type { LocalClaudeEventDelivery } from "./claude-sessions";

export interface LocalClaudeEventDispatcherDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  settingsRepo: ReturnType<typeof createSettingsRepository>;
  users: ReturnType<typeof createUserRepository>;
  conversations: ReturnType<typeof createConversationRepository>;
  queueManager: QueueManager;
  runAgent: (params: RunAgentParams) => Promise<unknown>;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  scheduler?: TaskScheduler;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
  getSlack?: () => SlackBot | null;
  whatsapp?: WhatsAppSocketFacade;
  whatsappRuntime?: WhatsAppRuntime;
  sendDm?: RunAgentParams["sendDm"];
  sendTargetMessage?: RunAgentParams["sendTargetMessage"];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function parseAllowedTools(value: string | null): string[] | null {
  if (!value) return null;
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((tool): tool is string => typeof tool === "string");
}

function platform(value: string | null): "slack" | "whatsapp" | null {
  if (value === "slack" || value === "whatsapp") return value;
  return null;
}

function contextType(value: string | null): "dm" | "channel" | "group" | null {
  if (value === "dm" || value === "channel" || value === "group") return value;
  return null;
}

function workspaceDirFor(config: Config, workspaceKey: string, storedWorkspaceDir: string | null): string {
  return storedWorkspaceDir ?? join(config.DATA_DIR, "workspaces", workspaceKey);
}

function originOrgContextEnabled(session: LocalClaudeEventDelivery["session"]): boolean {
  return session.origin_org_context_enabled !== 0;
}

function runContextType(value: "dm" | "channel" | "group"): "dm" | "channel_mention" {
  if (value === "dm") return "dm";
  return "channel_mention";
}

function finalTextFromAgentResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  if (!("trace" in result)) return null;
  return (result as { trace?: { finalText?: string | null } }).trace?.finalText ?? null;
}

function pendingUploadsFromAgentResult(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  if (!("pendingUploads" in result)) return [];
  return (result as { pendingUploads?: string[] }).pendingUploads ?? [];
}

function pendingIntegrationConnectionsFromAgentResult(result: unknown) {
  if (!result || typeof result !== "object") return [];
  if (!("pendingIntegrationConnections" in result)) return [];
  return (result as { pendingIntegrationConnections?: Parameters<typeof appendIntegrationConnectionLinks>[1] })
    .pendingIntegrationConnections;
}

export function createLocalClaudeEventDispatcher(deps: LocalClaudeEventDispatcherDeps) {
  async function captureSlackBotReply(params: {
    conversationId: number;
    sent: Array<{ messageRef: string; text: string }>;
    threadTs?: string | null;
    botName?: string | null;
  }): Promise<void> {
    for (const sent of params.sent) {
      if (!sent.messageRef) continue;
      await deps.conversations.insertMessage({
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
  }

  async function captureWhatsAppReply(params: {
    conversationId: number;
    sent: WhatsAppSendResult | null;
    text: string;
    botName?: string | null;
  }): Promise<void> {
    const providerMessageId = params.sent?.providerMessageId;
    if (!providerMessageId) return;
    await deps.conversations.insertMessage({
      conversationId: params.conversationId,
      providerMessageId,
      senderJid: "bot",
      senderName: params.botName ?? "Sketch",
      isBot: true,
      addressedToSketch: false,
      text: params.text,
      providerTimestamp: params.sent?.providerTimestamp ?? null,
    });
  }

  async function deliverResult(delivery: LocalClaudeEventDelivery, result: unknown, botName?: string | null) {
    const pendingUploads = pendingUploadsFromAgentResult(result);
    const target = delivery.session.origin_delivery_target;
    const originPlatform = platform(delivery.session.origin_platform);
    const conversationId = delivery.session.origin_conversation_id;
    if (!originPlatform || !target) return;
    const finalText = appendIntegrationConnectionLinks(
      finalTextFromAgentResult(result),
      pendingIntegrationConnectionsFromAgentResult(result),
      originPlatform,
      { BASE_URL: deps.config.BASE_URL, PORT: deps.config.PORT },
    );

    if (originPlatform === "slack") {
      const slack = deps.getSlack?.();
      if (!slack) return;
      const onFinalMessage = createSlackMessageHandler(slack, target, delivery.session.origin_thread_ts ?? undefined);
      if (finalText) {
        const sent = await onFinalMessage(finalText);
        if (conversationId) {
          await captureSlackBotReply({
            conversationId,
            sent,
            threadTs: delivery.session.origin_provider_thread_id ?? delivery.session.origin_thread_ts,
            botName,
          });
        }
      }
      for (const filePath of pendingUploads) {
        await slack.uploadFile(target, filePath, delivery.session.origin_thread_ts ?? undefined);
      }
      return;
    }

    if (deps.whatsappRuntime?.isConnected) {
      const whatsAppTarget = whatsappTargetFromDeliveryTarget(target);
      const onFinalMessage = createWhatsAppMessageHandler(deps.whatsappRuntime, whatsAppTarget);
      if (finalText) {
        const sent = await onFinalMessage(finalText);
        if (conversationId) await captureWhatsAppReply({ conversationId, sent, text: finalText, botName });
      }
      for (const filePath of pendingUploads) {
        const ext = filePath.split(".").pop() ?? "";
        await deps.whatsappRuntime.sendFile(whatsAppTarget, filePath, extensionToMime(ext), basename(filePath));
      }
      return;
    }

    const whatsapp = deps.whatsapp;
    if (!whatsapp || !(await whatsapp.pairing.status()).connected) return;
    if (finalText) {
      const sent = await whatsapp.send(target, { kind: "text", text: finalText }, { idempotencyKey: randomUUID() });
      if (conversationId) await captureWhatsAppReply({ conversationId, sent, text: finalText, botName });
    }
    for (const filePath of pendingUploads) {
      const ext = filePath.split(".").pop() ?? "";
      await whatsapp.send(
        target,
        { kind: "file", filePath, mimeType: extensionToMime(ext), fileName: basename(filePath) },
        { idempotencyKey: randomUUID() },
      );
    }
  }

  async function runForEvent(delivery: LocalClaudeEventDelivery): Promise<void> {
    const session = delivery.session;
    const originPlatform = platform(session.origin_platform);
    const originContextType = contextType(session.origin_context_type);
    if (!originPlatform || !originContextType || !session.origin_delivery_target || !session.origin_workspace_key) {
      deps.logger.warn({ sessionId: session.id }, "Local Claude event missing origin metadata; skipping dispatch");
      return;
    }

    const user = await deps.users.findById(session.user_id);
    const settingsRow = await deps.settingsRepo.get();
    const workspaceDir = workspaceDirFor(deps.config, session.origin_workspace_key, session.origin_workspace_dir);
    let orgDir: string | undefined;
    let claudeConfigDir: string | undefined;
    if (originOrgContextEnabled(session)) {
      orgDir = deps.config.CLAUDE_CONFIG_DIR;
      claudeConfigDir = deps.config.CLAUDE_CONFIG_DIR;
    }
    const payload = parseJson(delivery.event.payload);
    const userMessage = buildSketchContext({
      messages: [],
      currentUserName: user?.name ?? "Sketch user",
      currentUserEmail: user?.email,
      currentUserPhone: user?.whatsapp_number ?? null,
      currentMessage: "Handle the local Claude Code event.",
      workspaceDir,
      orgDir,
      timezone: user?.timezone ?? null,
      isSharedContext: originContextType !== "dm",
      localClaudeSessionEvent: {
        sessionId: session.id,
        eventId: delivery.event.id,
        eventType: delivery.event.event_type,
        status: delivery.status,
        message: delivery.message,
        payload,
      },
    });
    let integrationMcpServers: Record<string, McpServerConfig> = {};
    if (deps.buildMcpServers) {
      integrationMcpServers = await deps.buildMcpServers(user?.email ?? null);
    }
    const result = await deps.runAgent({
      db: deps.db,
      workspaceKey: session.origin_workspace_key,
      userMessage,
      workspaceDir,
      claudeConfigDir,
      userName: user?.name ?? "Sketch user",
      userEmail: user?.email,
      userPhone: user?.whatsapp_number ?? null,
      logger: deps.logger,
      platform: originPlatform,
      onProgressEvent: async () => {},
      threadTs: session.origin_thread_ts ?? undefined,
      orgName: settingsRow?.org_name,
      orgDescription: parseOrgContext(settingsRow?.org_context)?.description ?? null,
      botName: settingsRow?.bot_name,
      integrationMcpServers,
      loadIntegrationProvider: deps.loadIntegrationProvider,
      contextType: runContextType(originContextType),
      currentUserId: session.user_id,
      taskContext: {
        platform: originPlatform,
        contextType: originContextType,
        deliveryTarget: session.origin_delivery_target,
        createdBy: session.user_id,
        canManageAnyTask: user?.auth_role === "admin",
        creatorTimezone: user?.timezone ?? null,
        threadTs: session.origin_thread_ts ?? undefined,
      },
      scheduler: deps.scheduler,
      stepContentRepo: deps.stepContentRepo,
      automationRunsRepo: deps.automationRunsRepo,
      queueManager: deps.queueManager,
      activeQueueKey: session.origin_active_queue_key ?? undefined,
      toolConfig: { BASE_URL: deps.config.BASE_URL, PORT: deps.config.PORT },
      inboxMessagesRepo: deps.inboxMessagesRepo,
      userRepo: deps.users,
      getSlack: deps.getSlack,
      sendDm: deps.sendDm,
      sendTargetMessage: deps.sendTargetMessage,
      conversationRepo: deps.conversations,
      conversationContext: session.origin_conversation_id
        ? {
            conversationId: session.origin_conversation_id,
            providerThreadId: session.origin_provider_thread_id,
          }
        : undefined,
      agentInstructions: session.origin_agent_instructions,
      agentAllowedTools: parseAllowedTools(session.origin_agent_allowed_tools),
    });
    await deliverResult(delivery, result, settingsRow?.bot_name);
  }

  return {
    enqueue(delivery: LocalClaudeEventDelivery): void {
      const queueKey =
        delivery.session.origin_active_queue_key ?? delivery.session.origin_workspace_key ?? delivery.session.id;
      deps.queueManager.getQueue(queueKey).enqueue(async () => {
        try {
          await runForEvent(delivery);
        } catch (err) {
          deps.logger.warn({ err, sessionId: delivery.session.id }, "Local Claude event dispatch failed");
        }
      });
    },
  };
}
