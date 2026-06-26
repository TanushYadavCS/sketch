import type { Kysely } from "kysely";
import { createAgentOutputDeliveryRepository } from "../db/repositories/agent-output-deliveries";
import type { AgentDeliveryConfig } from "../db/repositories/agent-outputs";
import { createConversationRepository } from "../db/repositories/conversations";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { chunkText } from "../formatting/chunking";
import type { Logger } from "../logger";
import { createWorkflowDeliveryCapture, providerTimestampFromWhatsApp } from "../scheduler/delivery-capture";
import type { SlackBot } from "../slack/bot";
import type { WhatsAppBot } from "../whatsapp/bot";
import { isSlackDmChannelId, isSlackUserId } from "../workflows/delivery";
import { type RenderableAgentOutput, renderAgentOutputForDelivery } from "./output-renderer";
import type { AgentDefinition } from "./types";

const SLACK_TEXT_LIMIT = 39_000;

export interface AgentOutputDeliveryRequest {
  definition: AgentDefinition;
  output: RenderableAgentOutput & { id: string };
  delivery: AgentDeliveryConfig;
}

export interface AgentOutputDeliveryPublisher {
  deliver(params: AgentOutputDeliveryRequest): Promise<void>;
}

export interface AgentOutputDeliveryDeps {
  db: Kysely<DB>;
  logger: Logger;
  getSlack: () => SlackBot | null;
  whatsapp: WhatsAppBot;
  settingsRepo: ReturnType<typeof createSettingsRepository>;
}

export function createAgentOutputDeliveryService(deps: AgentOutputDeliveryDeps): AgentOutputDeliveryPublisher {
  const repo = createAgentOutputDeliveryRepository(deps.db);
  const capture = createWorkflowDeliveryCapture({
    conversations: createConversationRepository(deps.db),
    settingsRepo: deps.settingsRepo,
    logger: deps.logger,
  });

  async function sendSlack(delivery: AgentDeliveryConfig, text: string): Promise<string[]> {
    const slack = deps.getSlack();
    if (!slack) throw new Error("Slack bot is not connected.");

    let targetId = delivery.targetId;
    if (delivery.targetType === "dm" && isSlackUserId(targetId) && !isSlackDmChannelId(targetId)) {
      const settings = await deps.settingsRepo.get();
      const dmChannelId = await slack.openDmChannel(targetId, settings?.slack_bot_token ?? undefined);
      if (!dmChannelId) throw new Error("Failed to open Slack DM channel.");
      targetId = dmChannelId;
    }

    const refs: string[] = [];
    for (const chunk of chunkText(text, SLACK_TEXT_LIMIT)) {
      const messageRef = await slack.postMessage(targetId, chunk);
      refs.push(messageRef);
      await capture.captureSlack({ deliveryTarget: targetId, threadTs: null, messageRef, text: chunk });
    }
    return refs;
  }

  async function sendWhatsApp(delivery: AgentDeliveryConfig, text: string): Promise<string[]> {
    if (!deps.whatsapp.isConnected) throw new Error("WhatsApp is not connected.");
    const sent = await deps.whatsapp.sendText(delivery.targetId, text);
    const messageRef = sent?.key?.id;
    if (!messageRef) return [];
    await capture.captureWhatsApp({
      deliveryTarget: delivery.targetId,
      messageRef,
      providerTimestamp: providerTimestampFromWhatsApp(sent),
      text,
    });
    return [messageRef];
  }

  return {
    async deliver(params: AgentOutputDeliveryRequest): Promise<void> {
      const attempt = await repo.createAttempt({
        outputId: params.output.id,
        platform: params.delivery.platform,
        targetType: params.delivery.targetType,
        targetId: params.delivery.targetId,
      });

      try {
        const text = renderAgentOutputForDelivery({
          title: params.definition.title,
          sections: params.definition.sections,
          output: params.output,
          platform: params.delivery.platform,
        });
        const messageRefs =
          params.delivery.platform === "slack"
            ? await sendSlack(params.delivery, text)
            : await sendWhatsApp(params.delivery, text);
        await repo.markSent(attempt.id, messageRefs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await repo.markFailed(attempt.id, message);
        throw err;
      }
    },
  };
}
