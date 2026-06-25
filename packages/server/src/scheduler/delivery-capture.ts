import type { createConversationRepository } from "../db/repositories/conversations";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { Logger } from "../logger";

export interface WorkflowDeliveryCaptureDeps {
  conversations: ReturnType<typeof createConversationRepository>;
  settingsRepo: ReturnType<typeof createSettingsRepository>;
  logger: Logger;
}

export interface SlackDeliveryCaptureParams {
  deliveryTarget: string;
  threadTs: string | null;
  messageRef: string;
  text: string;
}

export interface WhatsAppDeliveryCaptureParams {
  deliveryTarget: string;
  messageRef: string;
  providerTimestamp: string | null;
  text: string;
}

export function providerTimestampFromSlackTs(ts: string | undefined): string | null {
  if (!ts) return null;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

export function providerTimestampFromWhatsApp(message: { messageTimestamp?: unknown }): string | null {
  const seconds = Number(message.messageTimestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

export function createWorkflowDeliveryCapture(deps: WorkflowDeliveryCaptureDeps) {
  async function getBotName(): Promise<string> {
    try {
      const settings = await deps.settingsRepo.get();
      return settings?.bot_name ?? "Sketch";
    } catch {
      return "Sketch";
    }
  }

  return {
    async captureSlack(params: SlackDeliveryCaptureParams): Promise<void> {
      try {
        const conversation = await deps.conversations.getOrCreate({
          platform: "slack",
          kind: params.deliveryTarget.startsWith("D") ? "dm" : "channel",
          providerConversationId: params.deliveryTarget,
        });
        await deps.conversations.insertMessage({
          conversationId: conversation.id,
          providerMessageId: params.messageRef,
          senderJid: "bot",
          senderName: await getBotName(),
          isBot: true,
          addressedToSketch: false,
          text: params.text,
          providerThreadId: params.threadTs,
          providerParentMessageId: params.threadTs,
          isThreadReply: Boolean(params.threadTs),
          providerTimestamp: providerTimestampFromSlackTs(params.messageRef),
        });
      } catch (err) {
        deps.logger.warn({ err, deliveryTarget: params.deliveryTarget }, "Workflow delivery capture failed");
      }
    },

    async captureWhatsApp(params: WhatsAppDeliveryCaptureParams): Promise<void> {
      try {
        const conversation = await deps.conversations.getOrCreate({
          platform: "whatsapp",
          kind: params.deliveryTarget.endsWith("@g.us") ? "group" : "dm",
          providerConversationId: params.deliveryTarget,
        });
        await deps.conversations.insertMessage({
          conversationId: conversation.id,
          providerMessageId: params.messageRef,
          senderJid: "bot",
          senderName: await getBotName(),
          isBot: true,
          addressedToSketch: false,
          text: params.text,
          providerTimestamp: params.providerTimestamp,
        });
      } catch (err) {
        deps.logger.warn({ err, deliveryTarget: params.deliveryTarget }, "Workflow delivery capture failed");
      }
    },
  };
}
