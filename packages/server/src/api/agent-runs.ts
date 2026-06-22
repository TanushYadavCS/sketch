import { basename } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Kysely } from "kysely";
import { z } from "zod";
import { type BufferedMessage, buildSketchContext } from "../agent/prompt";
import type { McpServerConfig, ProgressEvent, RunAgentParams, RunAgentResult } from "../agent/runner";
import { ensureChannelWorkspace, ensureGroupWorkspace, ensureWorkspace } from "../agent/workspace";
import type { Config } from "../config";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createChannelRepository } from "../db/repositories/channels";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { type createSettingsRepository, parseOrgContext } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { extensionToMime } from "../files";
import { appendIntegrationConnectionLinks } from "../integrations/connection-links";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import type { QueueManager } from "../queue";
import type { TaskScheduler } from "../scheduler/service";
import type { SlackBot } from "../slack/bot";
import { createSlackMessageHandler } from "../slack/message-handler";
import type { WhatsAppBot } from "../whatsapp/bot";
import { createWhatsAppMessageHandler } from "../whatsapp/message-handler";

type UserRepo = ReturnType<typeof createUserRepository>;
type ChannelRepo = ReturnType<typeof createChannelRepository>;
type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type WhatsAppGroupsRepo = ReturnType<typeof createWhatsAppGroupRepository>;
type InboxMessagesRepo = ReturnType<typeof createInboxMessagesRepository>;

const deliveryModeSchema = z.enum(["silent", "target"]).default("silent");
const userPlatformSchema = z.enum(["slack", "whatsapp"]).default("slack");

const invokeSchema = z.object({
  requesterUserId: z.string().min(1),
  message: z.string().trim().min(1),
  sessionId: z.string().min(1).optional(),
  deliveryMode: deliveryModeSchema,
  target: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("user"),
      userId: z.string().min(1),
      platform: userPlatformSchema,
    }),
    z.object({
      type: z.literal("slack_channel"),
      channelId: z.string().min(1),
      threadId: z.string().min(1).optional(),
    }),
    z.object({
      type: z.literal("whatsapp_group"),
      groupJid: z.string().min(1),
    }),
  ]),
});

interface AgentRunRouteDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  users: UserRepo;
  channels: ChannelRepo;
  settings: SettingsRepo;
  whatsappGroups: WhatsAppGroupsRepo;
  inboxMessagesRepo: InboxMessagesRepo;
  getSlack?: () => SlackBot | null;
  whatsapp?: WhatsAppBot;
  runAgent: (params: RunAgentParams) => Promise<RunAgentResult>;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  scheduler?: TaskScheduler;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  queueManager?: QueueManager;
  sendDm?: (params: { userId: string; platform: string; message: string }) => Promise<{
    channelId: string;
    messageRef: string;
  }>;
}

function badRequest(code: string, message: string) {
  return { error: { code, message } };
}

function runResultBody(result: RunAgentResult, extra: Record<string, unknown>, displayText?: string | null) {
  return {
    ok: true,
    status: "completed",
    messageSent: result.messageSent,
    sessionId: result.sessionId,
    finalText: result.trace.finalText,
    displayText: displayText ?? result.trace.finalText,
    pendingUploads: result.pendingUploads,
    pendingIntegrationConnections: result.pendingIntegrationConnections ?? [],
    usage: {
      costUsd: result.costUsd,
      auxCostUsd: result.auxCostUsd,
      totalCostUsd: result.costUsd + result.auxCostUsd,
      inputTokens: result.rawUsage.inputTokens,
      outputTokens: result.rawUsage.outputTokens,
      cacheReadTokens: result.rawUsage.cacheReadTokens,
      cacheCreationTokens: result.rawUsage.cacheCreationTokens,
      webSearchRequests: result.rawUsage.webSearchRequests,
      webFetchRequests: result.rawUsage.webFetchRequests,
      model: result.rawUsage.model,
    },
    ...extra,
  };
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "Agent run failed";
}

export function agentRunRoutes(deps: AgentRunRouteDeps) {
  const routes = new Hono();
  const toolConfig = { BASE_URL: deps.config.BASE_URL, PORT: deps.config.PORT };

  routes.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = invokeSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json(badRequest("VALIDATION_ERROR", message), 400);
    }

    const requester = await deps.users.findById(parsed.data.requesterUserId);
    if (!requester) {
      return c.json(badRequest("REQUESTER_NOT_FOUND", "Requester user not found"), 404);
    }

    const settingsRow = await deps.settings.get();
    const integrationMcpServers = deps.buildMcpServers ? await deps.buildMcpServers(requester.email) : {};

    return streamSSE(c, async (stream) => {
      const abortController = new AbortController();
      stream.onAbort(() => {
        abortController.abort();
      });

      const writeEvent = async (event: string, data: unknown) => {
        if (stream.aborted) return;
        await stream.writeSSE({ event, data: JSON.stringify(data) });
      };

      const baseRunParams = {
        db: deps.db,
        claudeConfigDir: deps.config.CLAUDE_CONFIG_DIR,
        userName: requester.name,
        userEmail: requester.email,
        logger: deps.logger,
        getSlack: deps.getSlack,
        onProgressEvent: async (event: ProgressEvent) => {
          await writeEvent("progress", event);
        },
        onSessionId: async (sessionId: string) => {
          await writeEvent("session", { sessionId });
        },
        abortController,
        resumeSessionId: parsed.data.sessionId,
        sessionMode: parsed.data.sessionId ? "persistent" : "fresh",
        persistSession: false,
        orgName: settingsRow?.org_name,
        orgDescription: parseOrgContext(settingsRow?.org_context)?.description ?? null,
        botName: settingsRow?.bot_name,
        integrationMcpServers,
        loadIntegrationProvider: deps.loadIntegrationProvider,
        scheduler: deps.scheduler,
        stepContentRepo: deps.stepContentRepo,
        automationRunsRepo: deps.automationRunsRepo,
        queueManager: deps.queueManager,
        toolConfig,
        inboxMessagesRepo: deps.inboxMessagesRepo,
        userRepo: deps.users,
        currentUserId: requester.id,
        sendDm: deps.sendDm,
      } satisfies Partial<RunAgentParams>;

      try {
        await writeEvent("run.started", { status: "running" });

        if (parsed.data.target.type === "user") {
          const target = await deps.users.findById(parsed.data.target.userId);
          if (!target) {
            await writeEvent("error", badRequest("TARGET_NOT_FOUND", "Target user not found"));
            return;
          }
          if (parsed.data.deliveryMode === "target" && !deps.sendDm) {
            await writeEvent("error", badRequest("NOT_CONNECTED", "Direct messaging is not configured"));
            return;
          }
          if (
            parsed.data.deliveryMode === "target" &&
            parsed.data.target.platform === "slack" &&
            !target.slack_user_id
          ) {
            await writeEvent("error", badRequest("TARGET_NOT_REACHABLE", "Target user does not have a Slack identity"));
            return;
          }
          if (
            parsed.data.deliveryMode === "target" &&
            parsed.data.target.platform === "whatsapp" &&
            !target.whatsapp_number
          ) {
            await writeEvent(
              "error",
              badRequest("TARGET_NOT_REACHABLE", "Target user does not have a WhatsApp identity"),
            );
            return;
          }

          const workspaceDir = await ensureWorkspace(deps.config, target.id);
          const delivery: Record<string, unknown> = {
            mode: parsed.data.deliveryMode,
            platform: parsed.data.target.platform,
          };
          if (parsed.data.deliveryMode === "target" && deps.sendDm) {
            delivery.request = await deps.sendDm({
              userId: target.id,
              platform: parsed.data.target.platform,
              message: parsed.data.message,
            });
          }
          const deliveryTarget =
            parsed.data.target.platform === "whatsapp" ? target.whatsapp_number : target.slack_user_id;

          const userMessage = buildSketchContext({
            messages: [],
            currentUserName: requester.name,
            currentMessage: parsed.data.message,
            currentUserEmail: requester.email,
            currentUserPhone: requester.whatsapp_number,
            workspaceDir,
            orgDir: deps.config.CLAUDE_CONFIG_DIR,
            isSharedContext: false,
          });

          const result = await deps.runAgent({
            ...baseRunParams,
            workspaceKey: target.id,
            userMessage,
            workspaceDir,
            platform: parsed.data.target.platform,
            contextType: "dm",
            taskContext: {
              platform: parsed.data.target.platform,
              contextType: "dm",
              deliveryTarget: deliveryTarget ?? target.id,
              createdBy: requester.id,
              creatorTimezone: requester.timezone,
            },
          } as RunAgentParams);

          const finalText = appendIntegrationConnectionLinks(
            result.trace.finalText,
            result.pendingIntegrationConnections,
            parsed.data.target.platform,
            toolConfig,
          );
          if (parsed.data.deliveryMode === "target" && finalText && deps.sendDm) {
            delivery.response = await deps.sendDm({
              userId: target.id,
              platform: parsed.data.target.platform,
              message: finalText,
            });
          }

          await writeEvent(
            "completed",
            runResultBody(
              result,
              {
                target: { type: "user", userId: target.id, platform: parsed.data.target.platform },
                delivery,
              },
              finalText,
            ),
          );
          return;
        }

        if (parsed.data.target.type === "slack_channel") {
          const slack = deps.getSlack?.() ?? null;
          if (!slack) {
            await writeEvent("error", badRequest("NOT_CONNECTED", "Slack is not connected"));
            return;
          }

          let channel = await deps.channels.findBySlackChannelId(parsed.data.target.channelId);
          if (!channel) {
            const channelInfo = await slack.getChannelInfo(parsed.data.target.channelId);
            channel = await deps.channels.create({
              slackChannelId: parsed.data.target.channelId,
              name: channelInfo.name,
              type: channelInfo.type,
            });
          }

          const workspaceDir = await ensureChannelWorkspace(deps.config, parsed.data.target.channelId);
          const channelWorkspaceKey = `channel-${parsed.data.target.channelId}`;
          let threadId = parsed.data.target.threadId;
          const contextMessages: BufferedMessage[] = [];
          let threadTag: "thread" | "channel_history" = "thread";
          const delivery: Record<string, unknown> = { mode: parsed.data.deliveryMode, platform: "slack" };

          if (parsed.data.deliveryMode === "target") {
            if (!threadId) {
              const history = await slack.getChannelHistory(
                parsed.data.target.channelId,
                deps.config.SLACK_CHANNEL_HISTORY_LIMIT,
              );
              for (const msg of history.reverse()) {
                contextMessages.push({ userName: msg.userId, text: msg.text, ts: msg.ts });
              }
              threadTag = "channel_history";
              threadId = await slack.postMessage(parsed.data.target.channelId, parsed.data.message);
              delivery.threadId = threadId;
            } else {
              const onRequestMessage = createSlackMessageHandler(slack, parsed.data.target.channelId, threadId);
              await onRequestMessage(parsed.data.message);
              delivery.threadId = threadId;
            }
          } else if (!parsed.data.sessionId) {
            const history = await slack.getChannelHistory(
              parsed.data.target.channelId,
              deps.config.SLACK_CHANNEL_HISTORY_LIMIT,
            );
            for (const msg of history.reverse()) {
              contextMessages.push({ userName: msg.userId, text: msg.text, ts: msg.ts });
            }
            threadTag = "channel_history";
          }

          const userMessage = buildSketchContext({
            messages: contextMessages,
            currentUserName: requester.name,
            currentMessage: parsed.data.message,
            currentUserEmail: requester.email,
            workspaceDir,
            orgDir: deps.config.CLAUDE_CONFIG_DIR,
            isSharedContext: true,
            threadTag,
            channelContext: { channelName: channel.name },
          });

          const result = await deps.runAgent({
            ...baseRunParams,
            workspaceKey: channelWorkspaceKey,
            userMessage,
            workspaceDir,
            platform: "slack",
            ...(threadId ? { threadTs: threadId } : {}),
            contextType: "channel_mention",
            taskContext: {
              platform: "slack",
              contextType: "channel",
              deliveryTarget: parsed.data.target.channelId,
              createdBy: requester.id,
              ...(threadId ? { threadTs: threadId } : {}),
            },
          } as RunAgentParams);

          const finalText = appendIntegrationConnectionLinks(
            result.trace.finalText,
            result.pendingIntegrationConnections,
            "slack",
            toolConfig,
          );
          if (parsed.data.deliveryMode === "target" && threadId && finalText) {
            const onFinalMessage = createSlackMessageHandler(slack, parsed.data.target.channelId, threadId);
            await onFinalMessage(finalText);
          }
          if (parsed.data.deliveryMode === "target" && threadId) {
            for (const filePath of result.pendingUploads) {
              await slack.uploadFile(parsed.data.target.channelId, filePath, threadId);
            }
          }

          await writeEvent(
            "completed",
            runResultBody(
              result,
              {
                target: { type: "slack_channel", channelId: parsed.data.target.channelId },
                delivery,
              },
              finalText,
            ),
          );
          return;
        }

        const whatsapp = deps.whatsapp;
        if (!whatsapp?.isConnected) {
          await writeEvent("error", badRequest("NOT_CONNECTED", "WhatsApp is not connected"));
          return;
        }

        const group = await deps.whatsappGroups.getByJid(parsed.data.target.groupJid);
        if (!group) {
          await writeEvent("error", badRequest("TARGET_NOT_FOUND", "WhatsApp group not found"));
          return;
        }
        const groupJid = group.jid;
        const workspaceDir = await ensureGroupWorkspace(deps.config, groupJid);

        const delivery: Record<string, unknown> = { mode: parsed.data.deliveryMode, platform: "whatsapp" };
        if (parsed.data.deliveryMode === "target") {
          await whatsapp.sendText(groupJid, parsed.data.message);
          delivery.target = groupJid;
        }

        const userMessage = buildSketchContext({
          messages: [],
          currentUserName: requester.name,
          currentMessage: parsed.data.message,
          currentUserEmail: requester.email,
          currentUserPhone: requester.whatsapp_number,
          workspaceDir,
          orgDir: deps.config.CLAUDE_CONFIG_DIR,
          isSharedContext: true,
          groupContext: { groupName: group.name, groupDescription: group.description ?? undefined },
        });

        const result = await deps.runAgent({
          ...baseRunParams,
          workspaceKey: `wa-group-${groupJid}`,
          userMessage,
          workspaceDir,
          platform: "whatsapp",
          contextType: "channel_mention",
          taskContext: {
            platform: "whatsapp",
            contextType: "group",
            deliveryTarget: groupJid,
            createdBy: requester.id,
          },
        } as RunAgentParams);

        const finalText = appendIntegrationConnectionLinks(
          result.trace.finalText,
          result.pendingIntegrationConnections,
          "whatsapp",
          toolConfig,
        );
        if (parsed.data.deliveryMode === "target" && finalText) {
          const onFinalMessage = createWhatsAppMessageHandler(whatsapp, groupJid);
          await onFinalMessage(finalText);
        }
        if (parsed.data.deliveryMode === "target") {
          for (const filePath of result.pendingUploads) {
            const ext = filePath.split(".").pop() ?? "";
            await whatsapp.sendFile(groupJid, filePath, extensionToMime(ext), basename(filePath));
          }
        }

        await writeEvent(
          "completed",
          runResultBody(
            result,
            {
              target: { type: "whatsapp_group", groupJid },
              delivery,
            },
            finalText,
          ),
        );
      } catch (err) {
        if (abortController.signal.aborted || stream.aborted) return;
        deps.logger.warn({ err }, "Agent invoke stream failed");
        await writeEvent("error", badRequest("RUN_FAILED", errorMessage(err)));
      }
    });
  });

  return routes;
}
