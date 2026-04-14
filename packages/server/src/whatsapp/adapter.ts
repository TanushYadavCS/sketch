/**
 * WhatsApp adapter — wires WhatsApp event handlers (DM, group) onto a WhatsAppBot.
 * Extracted from index.ts for testability.
 */
import { basename, join } from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import type { Kysely } from "kysely";
import type { BufferedMessage, InboxMessageContext } from "../agent/prompt";
import { buildSketchContext } from "../agent/prompt";
import type { AgentResult, McpServerConfig, RunAgentParams } from "../agent/runner";
import { deleteSessionId } from "../agent/sessions";
import { ensureGroupWorkspace, ensureWorkspace } from "../agent/workspace";
import { getNewSessionConfirmation, parseSketchCommand } from "../commands";
import type { Config } from "../config";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
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
type InboxMessagesRepository = ReturnType<typeof createInboxMessagesRepository>;

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
  inboxMessagesRepo?: InboxMessagesRepository;
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
    inboxMessagesRepo,
  } = deps;
  const maxFileBytes = config.MAX_FILE_SIZE_MB * 1024 * 1024;

  const toPhoneJid = (phoneNumber: string) => `${phoneNumber.replace("+", "")}@s.whatsapp.net`;

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
        };
      }),
    );

    return { ids: rows.map((row) => row.id), messages };
  };

  whatsapp.onMessage(async (message) => {
    if (message.type === "dm") {
      // --- DM handler ---
      const replyJid = toPhoneJid(message.phoneNumber);
      const user = await repos.users.findByWhatsappNumber(message.phoneNumber);
      if (!user) {
        await whatsapp.sendText(
          replyJid,
          "Sorry, you're not authorized to use this bot. Contact your admin to get access.",
        );
        return;
      }

      const userQueue = queue.getQueue(user.id);

      userQueue.enqueue(async () => {
        const command = parseSketchCommand(message.text);
        if (command === "new_session") {
          await deleteSessionId(db, user.id);
          await whatsapp.sendText(replyJid, getNewSessionConfirmation());
          return;
        }

        const workspaceDir = await ensureWorkspace(config, user.id);
        const settingsRow = await repos.settings.get();
        const deliveryJid = toPhoneJid(user.whatsapp_number ?? message.phoneNumber);

        whatsapp.startComposing(deliveryJid);

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

          const onFinalMessage = createWhatsAppMessageHandler(whatsapp, deliveryJid);
          const onToolProgress = async () => {};

          const waIntegrationMcpServers = await buildMcpServers(user.email);
          const pendingInbox = await loadPendingInboxMessages(user.id);

          const userMessage = buildSketchContext({
            messages: [],
            currentUserName: user.name,
            currentMessage: message.text || "See attached files.",
            currentUserEmail: user.email,
            currentUserPhone: user.whatsapp_number ?? message.phoneNumber,
            workspaceDir,
            orgDir: config.CLAUDE_CONFIG_DIR,
            isSharedContext: false,
            inboxMessages: pendingInbox.messages,
          });

          const waTaskContext = {
            platform: "whatsapp" as const,
            contextType: "dm" as const,
            deliveryTarget: deliveryJid,
            createdBy: user.id,
          };

          const result = await runAgent({
            db,
            workspaceKey: user.id,
            userMessage,
            workspaceDir,
            claudeConfigDir: config.CLAUDE_CONFIG_DIR,
            userName: user.name,
            userEmail: user.email,
            userPhone: user.whatsapp_number ?? message.phoneNumber,
            logger,
            platform: "whatsapp",
            onToolProgress,
            onFinalMessage,
            orgName: settingsRow?.org_name,
            botName: settingsRow?.bot_name,
            attachments: attachments.length > 0 ? attachments : undefined,
            integrationMcpServers: waIntegrationMcpServers,
            findIntegrationProvider,
            contextType: "dm",
            taskContext: waTaskContext,
            scheduler,
            inboxMessagesRepo,
            userRepo: repos.users,
            currentUserId: user.id,
            sendDm: sendDmViaWhatsApp,
          });

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
        } catch (err) {
          logger.error({ err, userId: user.id }, "Agent run failed (WhatsApp)");
          if (whatsapp.isConnected) {
            await whatsapp.sendText(deliveryJid, "Something went wrong, try again.");
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
      const command = parseSketchCommand(message.text);
      if (command === "new_session") {
        await deleteSessionId(db, `wa-group-${groupJid}`);
        groupBuffer.clear(groupJid);
        const onFinalMessage = createWhatsAppMessageHandler(whatsapp, groupJid, message.rawMessage as WAMessage);
        await onFinalMessage(getNewSessionConfirmation());
        return;
      }

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
          workspaceDir,
          orgDir: config.CLAUDE_CONFIG_DIR,
          isSharedContext: true,
          threadTag: "thread",
          groupContext: { groupName, groupDescription },
        });

        const onFinalMessage = createWhatsAppMessageHandler(whatsapp, groupJid, message.rawMessage as WAMessage);
        const onToolProgress = async () => {};

        const integrationMcpServers = await buildMcpServers(user?.email ?? null);

        const result = await runAgent({
          db,
          workspaceKey: `wa-group-${groupJid}`,
          userMessage,
          workspaceDir,
          claudeConfigDir: config.CLAUDE_CONFIG_DIR,
          userName,
          userEmail: user?.email,
          userPhone: user?.whatsapp_number ?? null,
          logger,
          platform: "whatsapp",
          onToolProgress,
          onFinalMessage,
          orgName: settingsRow?.org_name,
          botName: settingsRow?.bot_name,
          attachments: attachments.length > 0 ? attachments : undefined,
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
