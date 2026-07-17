import { describe, expect, it, vi } from "vitest";
import type { OperationalAlertRow } from "../db/repositories/operational-alerts";
import type { WhatsAppCapabilities, WhatsAppSendResult } from "../whatsapp/provider";
import type { WhatsAppRuntime } from "../whatsapp/runtime";
import { WHATSAPP_TEMPLATE_KEYS } from "../whatsapp/templates";
import type { OperationalAlertRecipient } from "./types";
import { createWhatsAppOperationalAlertTransport } from "./whatsapp-transport";

const capabilities: WhatsAppCapabilities = {
  text: true,
  media: false,
  quotedReply: false,
  templates: true,
  templateProvisioning: "manual",
  interactive: false,
  deliveryStatus: false,
  typing: false,
  reactions: false,
  edit: false,
  groups: false,
};
const sent: WhatsAppSendResult = {
  providerMessageId: "message-1",
  providerConversationId: "dm:+919876543210",
  providerTimestamp: "2026-07-17T10:00:00.000Z",
};
const recipient: OperationalAlertRecipient = {
  id: "admin-1",
  name: "Admin",
  destination: "+919876543210",
};

function createDeps(lastInbound: { receivedAt: string; providerTimestamp: string | null } | null) {
  return {
    whatsapp: {
      getCapabilities: vi.fn(() => capabilities),
      sendText: vi.fn().mockResolvedValue(sent),
      sendTemplate: vi.fn().mockResolvedValue(sent),
    } as unknown as Pick<WhatsAppRuntime, "getCapabilities" | "sendText" | "sendTemplate">,
    conversations: {
      findLatestInboundWhatsAppDmFromRecipient: vi.fn().mockResolvedValue(lastInbound),
    },
  };
}

function sendInput(now: Date) {
  return {
    alert: {} as OperationalAlertRow,
    recipient,
    directMessage: "Baileys disconnected",
    templateSummary: "Baileys disconnected",
    orgName: "Goosebumps",
    botName: "Sketch",
    now,
  };
}

describe("WhatsApp operational alert transport", () => {
  it("sends a direct message inside the customer service window", async () => {
    const deps = createDeps({ receivedAt: "2026-07-17T09:00:00.000Z", providerTimestamp: null });
    const transport = createWhatsAppOperationalAlertTransport(deps);

    await expect(transport.send(sendInput(new Date("2026-07-17T10:00:00.000Z")))).resolves.toEqual({
      providerMessageId: "message-1",
    });
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+919876543210" },
      "Baileys disconnected",
    );
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("uses the proactive update template outside the customer service window", async () => {
    const deps = createDeps({ receivedAt: "2026-07-15T09:00:00.000Z", providerTimestamp: null });
    const transport = createWhatsAppOperationalAlertTransport(deps);

    await transport.send(sendInput(new Date("2026-07-17T10:00:00.000Z")));

    expect(deps.whatsapp.sendText).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+919876543210" },
      expect.objectContaining({
        key: WHATSAPP_TEMPLATE_KEYS.proactiveUpdate,
        params: expect.objectContaining({ recipientName: "Admin", botName: "Sketch" }),
      }),
    );
  });

  it("falls back to a template when the provider rejects an apparently in-window direct message", async () => {
    const deps = createDeps({ receivedAt: "2026-07-17T09:00:00.000Z", providerTimestamp: null });
    vi.mocked(deps.whatsapp.sendText).mockRejectedValue(
      Object.assign(new Error("window expired"), { providerCode: "window_expired" }),
    );
    const transport = createWhatsAppOperationalAlertTransport(deps);

    await expect(transport.send(sendInput(new Date("2026-07-17T10:00:00.000Z")))).resolves.toEqual({
      providerMessageId: "message-1",
    });
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
  });
});
