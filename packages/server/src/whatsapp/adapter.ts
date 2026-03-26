/**
 * WhatsApp adapter — wires WhatsApp event handlers (DM, group) onto a WhatsAppBot.
 * Extracted from index.ts for testability.
 */
import { basename, join } from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import type { Kysely } from "kysely";
import type { BufferedMessage } from "../agent/prompt";
import { buildSketchContext } from "../agent/prompt";
import type { AgentResult, McpServerConfig, RunAgentParams } from "../agent/runner";
import { ensureGroupWorkspace, ensureWorkspace } from "../agent/workspace";
import type { Config } from "../config";
import type { createOutreachRepository } from "../db/repositories/outreach";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { type Attachment, downloadWhatsAppMedia, extensionToMime } from "../files";
import type { Logger } from "../logger";
import type { QueueManager } from "../queue";
import type { TaskScheduler } from "../scheduler/service";
import type { WhatsAppBot } from "./bot";
import type { GroupBuffer } from "./group-buffer";
import { createWhatsAppMessageHandler } from "./message-handler";

type UserRepository = ReturnType<typeof createUserRepository>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;
type OutreachRepository = ReturnType<typeof createOutreachRepository>;

export interface WhatsAppAdapterDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  repos: {
    users: UserRepository;
    settings: SettingsRepository;
  };
  queue: QueueManager;
  groupBuffer: GroupBuffer;
  runAgent: (params: RunAgentParams) => Promise<AgentResult>;
  buildMcpServers: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  findIntegrationProvider: () => Promise<{ type: string; credentials: string } | null>;
  scheduler?: TaskScheduler;
  outreachRepo?: OutreachRepository;
}

export function wireWhatsAppHandlers(whatsapp: WhatsAppBot, deps: WhatsAppAdapterDeps): void {
  const {
    db,
    config,
    logger,
    repos,
    queue,
    groupBuffer,
    runAgent,
    buildMcpServers,
    findIntegrationProvider,
    scheduler,
    outreachRepo,
  } = deps;
  const maxFileBytes = config.MAX_FILE_SIZE_MB * 1024 * 1024;

  /**
   * Sends a DM to a user via their WhatsApp number. Used both in normal DM handling and in
   * outreach response runs so the same function is available at adapter level.
   */
  const sendDmViaWhatsApp = async ({
    userId,
    message: dmMessage,
  }: { userId: string; platform: string; message: string }) => {
    const recipient = await repos.users.findById(userId);
    if (!recipient?.whatsapp_number) throw new Error("No WhatsApp number for recipient");
    const jid = `${recipient.whatsapp_number.replace("+", "")}@s.whatsapp.net`;
    await whatsapp.sendText(jid, dmMessage);
    return { channelId: jid, messageRef: "" };
  };

  /**
   * Enqueues a synthetic agent run in the requester's queue, delivering an outreach response
   * as a pre-formatted <context> message. The requester's agent resumes its session and can
   * continue the original task with the new information.
   *
   * Defined at adapter level so the requester's agent run can reference the same function
   * for any further outreach it initiates.
   */
  const enqueueMessageViaWhatsApp = async ({
    requesterUserId,
    message,
  }: { requesterUserId: string; message: string }) => {
    const requester = await repos.users.findById(requesterUserId);
    if (!requester?.whatsapp_number) {
      logger.warn({ requesterUserId }, "Cannot deliver outreach response: requester has no WhatsApp number");
      return;
    }
    const jid = `${requester.whatsapp_number.replace("+", "")}@s.whatsapp.net`;

    const requesterQueue = queue.getQueue(requesterUserId);
    requesterQueue.enqueue(async () => {
      const workspaceDir = await ensureWorkspace(config, requesterUserId);
      const currentSettings = await repos.settings.get();

      whatsapp.startComposing(jid);

      try {
        const onMessage = createWhatsAppMessageHandler(whatsapp, jid);
        const integrationMcpServers = await buildMcpServers(requester.email);

        const agentResult = await runAgent({
          db,
          workspaceKey: requesterUserId,
          userMessage: message,
          workspaceDir,
          userName: requester.name,
          userEmail: requester.email,
          userPhone: requester.whatsapp_number,
          logger,
          platform: "whatsapp",
          onMessage,
          orgName: currentSettings?.org_name,
          botName: currentSettings?.bot_name,
          integrationMcpServers,
          findIntegrationProvider,
          contextType: "outreach",
          taskContext: {
            platform: "whatsapp" as const,
            contextType: "dm" as const,
            deliveryTarget: jid,
            createdBy: requesterUserId,
          },
          scheduler,
          outreachRepo,
          userRepo: repos.users,
          currentUserId: requesterUserId,
          sendDm: sendDmViaWhatsApp,
          enqueueMessage: enqueueMessageViaWhatsApp,
        });

        for (const filePath of agentResult.pendingUploads) {
          try {
            if (whatsapp.isConnected) {
              const ext = filePath.split(".").pop() ?? "";
              const mime = extensionToMime(ext);
              await whatsapp.sendFile(jid, filePath, mime, basename(filePath));
            }
          } catch (err) {
            logger.warn({ err, filePath }, "Failed to send file via WhatsApp");
          }
        }
      } catch (err) {
        logger.error({ err, requesterUserId }, "Outreach response agent run failed (WhatsApp)");
        if (whatsapp.isConnected) {
          await whatsapp.sendText(jid, "Something went wrong processing an outreach response.");
        }
      } finally {
        whatsapp.stopComposing(jid);
      }
    });
  };

  whatsapp.onMessage(async (message) => {
    if (message.type === "dm") {
      // --- DM handler ---
      const user = await repos.users.findByWhatsappNumber(message.phoneNumber);
      if (!user) {
        await whatsapp.sendText(
          message.jid,
          "Sorry, you're not authorized to use this bot. Contact your admin to get access.",
        );
        return;
      }

      const userQueue = queue.getQueue(user.id);

      userQueue.enqueue(async () => {
        const workspaceDir = await ensureWorkspace(config, user.id);
        const settingsRow = await repos.settings.get();

        whatsapp.startComposing(message.jid);

        try {
          const attachments: Attachment[] = [];
          if (message.mediaType && whatsapp.socket) {
            const attachDir = join(workspaceDir, "attachments");
            try {
              const attachment = await downloadWhatsAppMedia(
                message.rawMessage,
                whatsapp.socket,
                attachDir,
                maxFileBytes,
                logger,
              );
              attachments.push(attachment);
            } catch (err) {
              logger.warn({ err, mediaType: message.mediaType }, "Failed to download WhatsApp media");
            }
          }

          const onMessage = createWhatsAppMessageHandler(whatsapp, message.jid);

          const waIntegrationMcpServers = await buildMcpServers(user.email);

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

          const waTaskContext = {
            platform: "whatsapp" as const,
            contextType: "dm" as const,
            deliveryTarget: message.jid,
            createdBy: user.id,
          };

          const result = await runAgent({
            db,
            workspaceKey: user.id,
            userMessage,
            workspaceDir,
            userName: user.name,
            userEmail: user.email,
            userPhone: user.whatsapp_number ?? message.phoneNumber,
            logger,
            platform: "whatsapp",
            onMessage,
            orgName: settingsRow?.org_name,
            botName: settingsRow?.bot_name,
            attachments: attachments.length > 0 ? attachments : undefined,
            integrationMcpServers: waIntegrationMcpServers,
            findIntegrationProvider,
            contextType: "dm",
            taskContext: waTaskContext,
            scheduler,
            outreachRepo,
            userRepo: repos.users,
            currentUserId: user.id,
            sendDm: sendDmViaWhatsApp,
            enqueueMessage: enqueueMessageViaWhatsApp,
          });

          for (const filePath of result.pendingUploads) {
            try {
              if (whatsapp.isConnected) {
                const ext = filePath.split(".").pop() ?? "";
                const mime = extensionToMime(ext);
                await whatsapp.sendFile(message.jid, filePath, mime, basename(filePath));
              }
            } catch (err) {
              logger.warn({ err, filePath }, "Failed to send file via WhatsApp");
            }
          }
        } catch (err) {
          logger.error({ err, userId: user.id }, "Agent run failed (WhatsApp)");
          if (whatsapp.isConnected) {
            await whatsapp.sendText(message.jid, "Something went wrong, try again.");
          }
        } finally {
          whatsapp.stopComposing(message.jid);
        }
      });
      return;
    }

    // --- Group handler ---

    if (!message.isMentioned) {
      const user = message.senderPhone ? await repos.users.findByWhatsappNumber(message.senderPhone) : undefined;
      groupBuffer.append(message.jid, {
        senderName: user?.name ?? message.pushName,
        text: message.text,
        timestamp: Date.now(),
      });
      return;
    }

    const user = message.senderPhone ? await repos.users.findByWhatsappNumber(message.senderPhone) : undefined;
    const userName = user?.name ?? message.pushName;

    const groupJid = message.jid;
    const groupQueue = queue.getQueue(`wa-group-${groupJid}`);

    groupQueue.enqueue(async () => {
      const workspaceDir = await ensureGroupWorkspace(config, groupJid);
      const settingsRow = await repos.settings.get();
      const groupMeta = await whatsapp.getGroupMetadata(groupJid);
      const groupName = groupMeta?.subject ?? "Unknown Group";
      const groupDescription = groupMeta?.desc ?? undefined;

      whatsapp.startComposing(groupJid);

      try {
        const buffered = groupBuffer.drain(groupJid);
        const contextMessages: BufferedMessage[] = buffered.map((m) => ({
          userName: m.senderName,
          text: m.text,
          ts: String(m.timestamp),
        }));

        const attachments: Attachment[] = [];
        if (message.mediaType && whatsapp.socket) {
          const attachDir = join(workspaceDir, "attachments");
          try {
            const attachment = await downloadWhatsAppMedia(
              message.rawMessage,
              whatsapp.socket,
              attachDir,
              maxFileBytes,
              logger,
            );
            attachments.push(attachment);
          } catch (err) {
            logger.warn({ err, mediaType: message.mediaType }, "Failed to download WhatsApp media");
          }
        }

        const userMessage = buildSketchContext({
          messages: contextMessages,
          currentUserName: userName,
          currentMessage: message.text || "See attached files.",
          currentUserEmail: user?.email ?? null,
          currentUserPhone: user?.whatsapp_number ?? null,
          isSharedContext: true,
        });

        const onMessage = createWhatsAppMessageHandler(whatsapp, groupJid, message.rawMessage as WAMessage);

        const integrationMcpServers = await buildMcpServers(user?.email ?? null);

        const result = await runAgent({
          db,
          workspaceKey: `wa-group-${groupJid}`,
          userMessage,
          workspaceDir,
          userName,
          userEmail: user?.email,
          userPhone: user?.whatsapp_number ?? null,
          logger,
          platform: "whatsapp",
          onMessage,
          orgName: settingsRow?.org_name,
          botName: settingsRow?.bot_name,
          attachments: attachments.length > 0 ? attachments : undefined,
          groupContext: { groupName, groupDescription },
          integrationMcpServers,
          findIntegrationProvider,
          contextType: "channel_mention",
          currentUserId: user?.id ?? null,
          taskContext: {
            platform: "whatsapp" as const,
            contextType: "group" as const,
            deliveryTarget: groupJid,
            createdBy: user?.id ?? "unknown",
          },
          scheduler,
        });

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
      } catch (err) {
        logger.error({ err, groupJid }, "Agent run failed (WhatsApp group)");
        if (whatsapp.isConnected) {
          await whatsapp.sendText(groupJid, "Something went wrong, try again.");
        }
      } finally {
        whatsapp.stopComposing(groupJid);
      }
    });
  });
}
