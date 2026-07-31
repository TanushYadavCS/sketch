import type { SendTargetMessage } from "../agent/tools/types";
import type { SlackDeliveryCaptureParams, WhatsAppDeliveryCaptureParams } from "../scheduler/delivery-capture";
import {
  type WhatsAppTarget,
  whatsappDeliveryTargetFromTarget,
  whatsappTargetFromDeliveryTarget,
} from "../whatsapp/provider";

export interface TargetDeliverySlack {
  postMessage: (channelId: string, text: string) => Promise<string>;
  postThreadReply: (channelId: string, threadTs: string, text: string) => Promise<string>;
}

export interface TargetDeliveryWhatsApp {
  readonly isConnected: boolean;
  sendText: (
    target: WhatsAppTarget,
    text: string,
  ) => Promise<{ providerMessageId: string | null; providerTimestamp: string | null } | null>;
}

export interface TargetDeliveryCapture {
  captureSlack: (params: SlackDeliveryCaptureParams) => Promise<void>;
  captureWhatsApp: (params: WhatsAppDeliveryCaptureParams) => Promise<void>;
}

export interface TargetDeliveryDeps {
  getSlack: () => TargetDeliverySlack | null;
  whatsapp: TargetDeliveryWhatsApp;
  capture: TargetDeliveryCapture;
}

/**
 * Posts into a shared destination (Slack channel or WhatsApp group) on behalf
 * of the requesting user. Membership is authorized by the caller before this
 * runs. The sent text is captured into the conversation the same way scheduled
 * workflow output is, so the agent can later read back what it said. A WhatsApp
 * send the provider does not confirm is treated as a failure, because the
 * aggregate connection state cannot distinguish a dead group provider from a
 * live DM provider.
 */
export function createSendTargetMessage(deps: TargetDeliveryDeps): SendTargetMessage {
  return async ({ platform, targetType, targetId, message, threadTs }) => {
    if (platform === "slack") {
      if (targetType !== "channel") throw new Error("A Slack target must be a channel");
      const slack = deps.getSlack();
      if (!slack) throw new Error("Slack bot is not connected");

      const messageRef = threadTs
        ? await slack.postThreadReply(targetId, threadTs, message)
        : await slack.postMessage(targetId, message);
      await deps.capture.captureSlack({
        deliveryTarget: targetId,
        threadTs: threadTs ?? null,
        messageRef,
        text: message,
      });
      return { messageRef };
    }

    if (targetType !== "group") throw new Error("A WhatsApp target must be a group");
    if (!deps.whatsapp.isConnected) throw new Error("WhatsApp is not connected");
    const target = whatsappTargetFromDeliveryTarget(targetId);
    if (target.kind !== "group") throw new Error("A WhatsApp target must be a group");

    const sent = await deps.whatsapp.sendText(target, message);
    const messageRef = sent?.providerMessageId;
    if (!messageRef) throw new Error("WhatsApp did not confirm the group message was sent");
    await deps.capture.captureWhatsApp({
      deliveryTarget: whatsappDeliveryTargetFromTarget(target),
      messageRef,
      providerTimestamp: sent?.providerTimestamp ?? null,
      text: message,
    });
    return { messageRef };
  };
}
