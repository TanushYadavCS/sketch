import type { Logger } from "../logger";
import {
  WHATSAPP_NONE_PROVIDER_ID,
  type WhatsAppDmProvider,
  type WhatsAppDmProviderId,
  type WhatsAppGroupMetadata,
  type WhatsAppGroupProvider,
  type WhatsAppGroupProviderId,
  type WhatsAppInboundMessage,
  type WhatsAppInboundProvider,
  type WhatsAppMessageHandler,
  type WhatsAppSendOptions,
  type WhatsAppSendResult,
  type WhatsAppTarget,
} from "./provider";
import type { WhatsAppTemplateRequest } from "./templates";

export interface WhatsAppRuntime {
  isConnected: boolean;
  onMessage(handler: WhatsAppMessageHandler): void;
  sendText(target: WhatsAppTarget, text: string, options?: WhatsAppSendOptions): Promise<WhatsAppSendResult | null>;
  sendTemplate(target: WhatsAppTarget, template: WhatsAppTemplateRequest): Promise<WhatsAppSendResult | null>;
  sendFile(target: WhatsAppTarget, filePath: string, mimeType: string, fileName: string): Promise<void>;
  startComposing(target: WhatsAppTarget): void;
  stopComposing(target: WhatsAppTarget): void;
  addReaction(message: WhatsAppInboundMessage, emoji: string): Promise<void>;
  removeReaction(message: WhatsAppInboundMessage): Promise<void>;
  downloadMedia(
    message: WhatsAppInboundMessage,
    workspaceDir: string,
    params: { maxFileBytes: number },
  ): Promise<import("../files").Attachment[]>;
  getGroupMetadata(groupId: string): Promise<WhatsAppGroupMetadata | undefined>;
  resolveJidToPhone(jid: string): Promise<string | null>;
}

export interface WhatsAppRuntimeConfig {
  dmProviderId: WhatsAppDmProviderId;
  groupProviderId: WhatsAppGroupProviderId;
  dmProviders: WhatsAppDmProvider[];
  groupProviders: WhatsAppGroupProvider[];
  inboundProviders: WhatsAppInboundProvider[];
  logger: Logger;
}

export function createWhatsAppRuntime(config: WhatsAppRuntimeConfig): WhatsAppRuntime {
  const dmProviders = new Map(config.dmProviders.map((provider) => [provider.id, provider]));
  const groupProviders = new Map(config.groupProviders.map((provider) => [provider.id, provider]));

  const resolveDmProvider = (): WhatsAppDmProvider => {
    const provider = dmProviders.get(config.dmProviderId);
    if (!provider) throw new Error(`WhatsApp DM provider is not available: ${config.dmProviderId}`);
    return provider;
  };

  const resolveGroupProvider = (): WhatsAppGroupProvider => {
    if (config.groupProviderId === WHATSAPP_NONE_PROVIDER_ID) {
      throw new Error("WhatsApp group provider is disabled");
    }
    const provider = groupProviders.get(config.groupProviderId);
    if (!provider) throw new Error(`WhatsApp group provider is not available: ${config.groupProviderId}`);
    return provider;
  };

  const resolveProviderForTarget = (target: WhatsAppTarget): WhatsAppDmProvider | WhatsAppGroupProvider => {
    return target.kind === "dm" ? resolveDmProvider() : resolveGroupProvider();
  };

  const resolveProviderForMessage = (message: WhatsAppInboundMessage): WhatsAppDmProvider | WhatsAppGroupProvider => {
    return message.kind === "dm" ? resolveDmProvider() : resolveGroupProvider();
  };

  const shouldHandleInboundMessage = (message: WhatsAppInboundMessage): boolean => {
    if (message.kind === "dm") return message.providerId === config.dmProviderId;
    return config.groupProviderId !== WHATSAPP_NONE_PROVIDER_ID && message.providerId === config.groupProviderId;
  };

  return {
    get isConnected() {
      const dmProvider = dmProviders.get(config.dmProviderId);
      const groupProvider =
        config.groupProviderId === WHATSAPP_NONE_PROVIDER_ID ? null : groupProviders.get(config.groupProviderId);
      return Boolean(dmProvider?.isConnected || groupProvider?.isConnected);
    },

    onMessage(handler) {
      for (const provider of config.inboundProviders) {
        provider.onMessage(async (message) => {
          if (!shouldHandleInboundMessage(message)) return;
          await handler(message);
        });
      }
    },

    async sendText(target, text, options) {
      return resolveProviderForTarget(target).sendText(target, text, options);
    },

    async sendTemplate(target, template) {
      const provider = resolveProviderForTarget(target);
      if (provider.sendTemplate) return provider.sendTemplate(target, template);
      if (provider.capabilities.templates) {
        throw new Error(`WhatsApp provider ${provider.id} cannot send templates from this runtime`);
      }
      if (!template.fallbackText) {
        throw new Error(`WhatsApp provider ${provider.id} does not support templates`);
      }
      return provider.sendText(target, template.fallbackText);
    },

    async sendFile(target, filePath, mimeType, fileName) {
      const provider = resolveProviderForTarget(target);
      if (!provider.sendFile) {
        config.logger.warn({ providerId: provider.id, targetKind: target.kind }, "WhatsApp provider cannot send files");
        return;
      }
      await provider.sendFile(target, filePath, mimeType, fileName);
    },

    startComposing(target) {
      resolveProviderForTarget(target).startComposing?.(target);
    },

    stopComposing(target) {
      resolveProviderForTarget(target).stopComposing?.(target);
    },

    async addReaction(message, emoji) {
      await resolveProviderForMessage(message).addReaction?.(message, emoji);
    },

    async removeReaction(message) {
      await resolveProviderForMessage(message).removeReaction?.(message);
    },

    async downloadMedia(message, workspaceDir, params) {
      return (await resolveProviderForMessage(message).downloadMedia?.(message, workspaceDir, params)) ?? [];
    },

    getGroupMetadata(groupId) {
      return resolveGroupProvider().getGroupMetadata?.(groupId) ?? Promise.resolve(undefined);
    },

    async resolveJidToPhone(jid) {
      for (const provider of [...dmProviders.values(), ...groupProviders.values()]) {
        const phone = await provider.resolveProviderContactToPhone?.(jid);
        if (phone) return phone;
      }
      return null;
    },
  };
}
