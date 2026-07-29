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
const reconnectTemplate = {
  key: WHATSAPP_TEMPLATE_KEYS.reconnectNotification,
  params: {
    recipientName: "Admin",
    phoneNumber: "+91 9980470200",
    reconnectUrl: "https://goosebumps.getsketch.ai/channels",
  },
  fallbackText: "Baileys disconnected",
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

  it("prefers the alert's own template over the proactive update template", async () => {
    const deps = createDeps({ receivedAt: "2026-07-15T09:00:00.000Z", providerTimestamp: null });
    const transport = createWhatsAppOperationalAlertTransport(deps);

    await transport.send({ ...sendInput(new Date("2026-07-17T10:00:00.000Z")), template: reconnectTemplate });

    expect(deps.whatsapp.sendText).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+919876543210" },
      reconnectTemplate,
    );
  });

  it("still sends a direct message inside the customer service window when a template is provided", async () => {
    const deps = createDeps({ receivedAt: "2026-07-17T09:00:00.000Z", providerTimestamp: null });
    const transport = createWhatsAppOperationalAlertTransport(deps);

    await transport.send({ ...sendInput(new Date("2026-07-17T10:00:00.000Z")), template: reconnectTemplate });

    expect(deps.whatsapp.sendText).toHaveBeenCalledTimes(1);
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("uses the alert's template after an apparently in-window direct message is rejected", async () => {
    const deps = createDeps({ receivedAt: "2026-07-17T09:00:00.000Z", providerTimestamp: null });
    vi.mocked(deps.whatsapp.sendText).mockRejectedValue(
      Object.assign(new Error("window expired"), { providerCode: "window_expired" }),
    );
    const transport = createWhatsAppOperationalAlertTransport(deps);

    await transport.send({ ...sendInput(new Date("2026-07-17T10:00:00.000Z")), template: reconnectTemplate });

    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+919876543210" },
      reconnectTemplate,
    );
  });

  it("falls back to the proactive update template when the alert's template has no approved mapping", async () => {
    const deps = createDeps({ receivedAt: "2026-07-15T09:00:00.000Z", providerTimestamp: null });
    vi.mocked(deps.whatsapp.sendTemplate).mockImplementation(async (_target, template) => {
      if (template.key === WHATSAPP_TEMPLATE_KEYS.reconnectNotification) {
        throw Object.assign(new Error("no approved mapping"), { providerCode: "template_not_found" });
      }
      return sent;
    });
    const transport = createWhatsAppOperationalAlertTransport(deps);

    await expect(
      transport.send({ ...sendInput(new Date("2026-07-17T10:00:00.000Z")), template: reconnectTemplate }),
    ).resolves.toEqual({ providerMessageId: "message-1" });
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledTimes(2);
    expect(deps.whatsapp.sendTemplate).toHaveBeenLastCalledWith(
      { kind: "dm", phoneE164: "+919876543210" },
      expect.objectContaining({ key: WHATSAPP_TEMPLATE_KEYS.proactiveUpdate }),
    );
  });

  it("does not swallow non-mapping template errors for the alert's template", async () => {
    const deps = createDeps({ receivedAt: "2026-07-15T09:00:00.000Z", providerTimestamp: null });
    vi.mocked(deps.whatsapp.sendTemplate).mockRejectedValue(
      Object.assign(new Error("provider unavailable"), { providerCode: "503" }),
    );
    const transport = createWhatsAppOperationalAlertTransport(deps);

    await expect(
      transport.send({ ...sendInput(new Date("2026-07-17T10:00:00.000Z")), template: reconnectTemplate }),
    ).rejects.toMatchObject({ providerCode: "503" });
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it("sends text outside the customer service window when the provider does not support templates", async () => {
    const deps = createDeps({ receivedAt: "2026-07-15T09:00:00.000Z", providerTimestamp: null });
    vi.mocked(deps.whatsapp.getCapabilities).mockReturnValue({ ...capabilities, templates: false });
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

  it("rejects a null direct-message result as retryable", async () => {
    const deps = createDeps({ receivedAt: "2026-07-17T09:00:00.000Z", providerTimestamp: null });
    vi.mocked(deps.whatsapp.sendText).mockResolvedValue(null);
    const transport = createWhatsAppOperationalAlertTransport(deps);

    await expect(transport.send(sendInput(new Date("2026-07-17T10:00:00.000Z")))).rejects.toMatchObject({
      providerCode: "transport_unavailable",
      retryIndefinitely: true,
    });
  });

  it("rejects a null template result as retryable", async () => {
    const deps = createDeps({ receivedAt: "2026-07-15T09:00:00.000Z", providerTimestamp: null });
    vi.mocked(deps.whatsapp.sendTemplate).mockResolvedValue(null);
    const transport = createWhatsAppOperationalAlertTransport(deps);

    await expect(transport.send(sendInput(new Date("2026-07-17T10:00:00.000Z")))).rejects.toMatchObject({
      providerCode: "transport_unavailable",
      retryIndefinitely: true,
    });
  });
});
