import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import {
  type WhatsAppCapabilities,
  type WhatsAppDmProvider,
  type WhatsAppGroupProvider,
  type WhatsAppInboundMessage,
  type WhatsAppInboundProvider,
  type WhatsAppMessageHandler,
  type WhatsAppTarget,
  whatsappTargetFromDeliveryTarget,
} from "./provider";
import { createWhatsAppRuntime } from "./runtime";

const capabilities: WhatsAppCapabilities = {
  text: true,
  media: true,
  quotedReply: true,
  templates: false,
  templateProvisioning: "none",
  interactive: false,
  deliveryStatus: false,
  typing: true,
  reactions: true,
  edit: true,
  groups: true,
};

function providerConversationId(target: WhatsAppTarget): string {
  return target.kind === "group" ? target.groupId : (target.providerConversationId ?? `dm:${target.phoneE164}`);
}

function createDmProvider(id: string): WhatsAppDmProvider {
  return {
    id,
    role: "dm",
    capabilities: { ...capabilities, groups: false },
    isConnected: true,
    sendText: vi.fn(async (target) => ({
      providerMessageId: `${id}-sent`,
      providerConversationId: providerConversationId(target),
      providerTimestamp: null,
    })),
    sendTemplate: vi.fn(async (target) => ({
      providerMessageId: `${id}-template-sent`,
      providerConversationId: providerConversationId(target),
      providerTimestamp: null,
    })),
  };
}

function createGroupProvider(id: string): WhatsAppGroupProvider {
  return {
    id,
    role: "group",
    capabilities,
    isConnected: true,
    sendText: vi.fn(async (target) => ({
      providerMessageId: `${id}-sent`,
      providerConversationId: providerConversationId(target),
      providerTimestamp: null,
    })),
  };
}

function createInboundProvider(id: string) {
  let handler: WhatsAppMessageHandler | null = null;
  const provider: WhatsAppInboundProvider = {
    id,
    onMessage: vi.fn((nextHandler) => {
      handler = nextHandler;
    }),
  };
  return {
    provider,
    emit: async (message: WhatsAppInboundMessage) => {
      await handler?.(message);
    },
  };
}

function dmMessage(providerId: string): WhatsAppInboundMessage {
  return {
    kind: "dm",
    providerId,
    providerMessageId: `${providerId}-dm`,
    providerConversationId: "111@s.whatsapp.net",
    canonicalConversationId: "dm:+111",
    providerTimestamp: null,
    senderName: "Alice",
    senderProviderId: "111@s.whatsapp.net",
    senderPhoneE164: "+111",
    target: { kind: "dm", phoneE164: "+111", providerConversationId: "111@s.whatsapp.net" },
    text: "hello",
  };
}

function groupMessage(providerId: string): WhatsAppInboundMessage {
  return {
    kind: "group",
    providerId,
    providerMessageId: `${providerId}-group`,
    providerConversationId: "group@g.us",
    canonicalConversationId: "group:group@g.us",
    providerTimestamp: null,
    senderName: "Alice",
    senderProviderId: "111@s.whatsapp.net",
    senderPhoneE164: "+111",
    target: { kind: "group", groupId: "group@g.us" },
    text: "hello group",
    isMentioned: true,
  };
}

describe("createWhatsAppRuntime", () => {
  it("routes DM targets to the configured DM provider and group targets to the configured group provider", async () => {
    const dmProvider = createDmProvider("wati");
    const groupProvider = createGroupProvider("baileys");
    const runtime = createWhatsAppRuntime({
      dmProviderId: "wati",
      groupProviderId: "baileys",
      dmProviders: [dmProvider],
      groupProviders: [groupProvider],
      inboundProviders: [],
      logger: createTestLogger(),
    });

    await runtime.sendText(whatsappTargetFromDeliveryTarget("111@s.whatsapp.net"), "dm");
    await runtime.sendText(whatsappTargetFromDeliveryTarget("group@g.us"), "group");

    expect(dmProvider.sendText).toHaveBeenCalledOnce();
    expect(groupProvider.sendText).toHaveBeenCalledOnce();
  });

  it("rejects group sends when the group provider is disabled", async () => {
    const runtime = createWhatsAppRuntime({
      dmProviderId: "baileys",
      groupProviderId: "none",
      dmProviders: [createDmProvider("baileys")],
      groupProviders: [createGroupProvider("baileys")],
      inboundProviders: [],
      logger: createTestLogger(),
    });

    await expect(runtime.sendText(whatsappTargetFromDeliveryTarget("group@g.us"), "group")).rejects.toThrow(
      "WhatsApp group provider is disabled",
    );
  });

  it("filters inbound messages by the configured provider role", async () => {
    const baileysInbound = createInboundProvider("baileys");
    const watiInbound = createInboundProvider("wati");
    const handler = vi.fn();
    const runtime = createWhatsAppRuntime({
      dmProviderId: "wati",
      groupProviderId: "baileys",
      dmProviders: [createDmProvider("baileys"), createDmProvider("wati")],
      groupProviders: [createGroupProvider("baileys")],
      inboundProviders: [baileysInbound.provider, watiInbound.provider],
      logger: createTestLogger(),
    });
    runtime.onMessage(handler);

    await baileysInbound.emit(dmMessage("baileys"));
    await baileysInbound.emit(groupMessage("baileys"));
    await watiInbound.emit(dmMessage("wati"));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "group", providerId: "baileys" }));
    expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "dm", providerId: "wati" }));
    expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "dm", providerId: "baileys" }));
  });

  it("uses provider templates for configured DM providers without affecting Baileys groups", async () => {
    const dmProvider = createDmProvider("wati");
    const groupProvider = createGroupProvider("baileys");
    const runtime = createWhatsAppRuntime({
      dmProviderId: "wati",
      groupProviderId: "baileys",
      dmProviders: [dmProvider],
      groupProviders: [groupProvider],
      inboundProviders: [],
      logger: createTestLogger(),
    });

    await runtime.sendTemplate({ kind: "dm", phoneE164: "+111" }, { key: "whatsapp.magic_link", params: {} });
    await runtime.sendText({ kind: "group", groupId: "group@g.us" }, "group");

    expect(dmProvider.sendTemplate).toHaveBeenCalledOnce();
    expect(groupProvider.sendText).toHaveBeenCalledOnce();
  });

  it("falls back to text templates for providers without official template support", async () => {
    const dmProvider = createDmProvider("baileys");
    dmProvider.sendTemplate = undefined;
    dmProvider.capabilities.templates = false;
    const runtime = createWhatsAppRuntime({
      dmProviderId: "baileys",
      groupProviderId: "none",
      dmProviders: [dmProvider],
      groupProviders: [],
      inboundProviders: [],
      logger: createTestLogger(),
    });

    await runtime.sendTemplate(
      { kind: "dm", phoneE164: "+111" },
      { key: "whatsapp.magic_link", params: {}, fallbackText: "fallback" },
    );

    expect(dmProvider.sendText).toHaveBeenCalledWith({ kind: "dm", phoneE164: "+111" }, "fallback");
  });
});
