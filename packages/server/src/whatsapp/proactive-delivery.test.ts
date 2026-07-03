import { describe, expect, it, vi } from "vitest";
import { type DeliverProactiveDmParams, deliverProactiveDm } from "./proactive-delivery";
import type { WhatsAppCapabilities, WhatsAppSendResult, WhatsAppTarget } from "./provider";
import { WHATSAPP_TEMPLATE_KEYS } from "./templates";

const templateCapabilities: WhatsAppCapabilities = {
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

const textOnlyCapabilities: WhatsAppCapabilities = {
  ...templateCapabilities,
  templates: false,
  templateProvisioning: "none",
};

const target: WhatsAppTarget = { kind: "dm", phoneE164: "+15551234567" };
const sentText: WhatsAppSendResult = {
  providerMessageId: "text-1",
  providerConversationId: "dm:+15551234567",
  providerTimestamp: "2026-07-03T10:00:00.000Z",
};
const sentNudge: WhatsAppSendResult = {
  providerMessageId: "nudge-1",
  providerConversationId: "dm:+15551234567",
  providerTimestamp: "2026-07-03T10:00:01.000Z",
};

function buildDeps(
  overrides: {
    capabilities?: WhatsAppCapabilities;
    lastInbound?: { receivedAt: string; providerTimestamp: string | null } | null;
    sendText?: ReturnType<typeof vi.fn>;
    hasPending?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    whatsapp: {
      getCapabilities: vi.fn(() => overrides.capabilities ?? templateCapabilities),
      sendText: overrides.sendText ?? vi.fn().mockResolvedValue(sentText),
      sendTemplate: vi.fn().mockResolvedValue(sentNudge),
    } as unknown as DeliverProactiveDmParams["whatsapp"],
    conversations: {
      findLatestInboundWhatsAppDmFromRecipient: vi.fn().mockResolvedValue(overrides.lastInbound ?? null),
    } as unknown as DeliverProactiveDmParams["conversations"],
    inboxMessages: {
      create: vi.fn().mockResolvedValue({ id: "inbox-1" }),
      hasPendingForRecipientByKind: overrides.hasPending ?? vi.fn().mockResolvedValue(false),
    } as unknown as DeliverProactiveDmParams["inboxMessages"],
    logger: { debug: vi.fn() },
  };
}

describe("deliverProactiveDm", () => {
  it("passes through to sendText when the provider does not require templates", async () => {
    const deps = buildDeps({ capabilities: textOnlyCapabilities });
    const text = "line one\nline two";

    const result = await deliverProactiveDm({
      target,
      recipientUserId: "user-1",
      senderUserId: "user-1",
      text,
      ...deps,
    });

    expect(result.mode).toBe("text");
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith(target, text);
    expect(deps.conversations.findLatestInboundWhatsAppDmFromRecipient).not.toHaveBeenCalled();
    expect(deps.inboxMessages.create).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("sends full multi-line text when the customer-service window is open", async () => {
    const deps = buildDeps({ lastInbound: { receivedAt: "2026-07-03T09:00:00.000Z", providerTimestamp: null } });
    const text = "first line\nsecond line\nthird line";

    const result = await deliverProactiveDm({
      target,
      recipientUserId: "user-1",
      senderUserId: "user-1",
      text,
      now: new Date("2026-07-03T10:00:00.000Z"),
      ...deps,
    });

    expect(result).toEqual({ mode: "text", sent: sentText });
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith(target, text);
    expect(deps.inboxMessages.create).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("parks the output and sends a nudge when the window is closed", async () => {
    const deps = buildDeps({ lastInbound: { receivedAt: "2026-07-02T00:00:00.000Z", providerTimestamp: null } });

    const result = await deliverProactiveDm({
      target,
      recipientUserId: "user-1",
      senderUserId: "user-1",
      recipientName: "Alice",
      text: "closed window output",
      now: new Date("2026-07-03T10:00:00.000Z"),
      ...deps,
    });

    expect(result.mode).toBe("nudge");
    expect(result.inboxMessageId).toBe("inbox-1");
    expect(deps.inboxMessages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: "user-1",
        senderUserId: "user-1",
        message: "closed window output",
        kind: "workflow_output",
        resolutionMode: "auto_consume",
        platform: "whatsapp",
      }),
    );
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        key: WHATSAPP_TEMPLATE_KEYS.taskNudge,
        params: { recipientName: "Alice" },
      }),
    );
  });

  it("parks and nudges when there is no inbound history", async () => {
    const deps = buildDeps();

    await deliverProactiveDm({
      target,
      recipientUserId: "user-1",
      senderUserId: "user-1",
      text: "no history output",
      ...deps,
    });

    expect(deps.inboxMessages.create).toHaveBeenCalledOnce();
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledOnce();
  });

  it("skips duplicate nudges while another workflow output is pending", async () => {
    const hasPending = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const deps = buildDeps({ hasPending });

    await deliverProactiveDm({ target, recipientUserId: "user-1", senderUserId: "user-1", text: "first", ...deps });
    await deliverProactiveDm({ target, recipientUserId: "user-1", senderUserId: "user-1", text: "second", ...deps });

    expect(deps.inboxMessages.create).toHaveBeenCalledTimes(2);
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: "user-1", inboxKind: "workflow_output", nudgeSent: false }),
      "WhatsApp proactive delivery parked without duplicate nudge",
    );
  });

  it.each(["contact_not_found", "window_expired"])(
    "falls back to park-and-nudge for %s text errors",
    async (providerCode) => {
      const error = Object.assign(new Error("send failed"), { providerCode });
      const deps = buildDeps({
        lastInbound: { receivedAt: "2026-07-03T09:00:00.000Z", providerTimestamp: null },
        sendText: vi.fn().mockRejectedValue(error),
      });

      const result = await deliverProactiveDm({
        target,
        recipientUserId: "user-1",
        senderUserId: "user-1",
        text: "fallback output",
        now: new Date("2026-07-03T10:00:00.000Z"),
        ...deps,
      });

      expect(result.mode).toBe("nudge");
      expect(deps.inboxMessages.create).toHaveBeenCalledOnce();
      expect(deps.whatsapp.sendTemplate).toHaveBeenCalledOnce();
    },
  );

  it.each(["provider_rejected", undefined])("propagates non-window text errors: %s", async (providerCode) => {
    const error = Object.assign(new Error("send failed"), providerCode ? { providerCode } : {});
    const deps = buildDeps({
      lastInbound: { receivedAt: "2026-07-03T09:00:00.000Z", providerTimestamp: null },
      sendText: vi.fn().mockRejectedValue(error),
    });

    await expect(
      deliverProactiveDm({
        target,
        recipientUserId: "user-1",
        senderUserId: "user-1",
        text: "propagate output",
        now: new Date("2026-07-03T10:00:00.000Z"),
        ...deps,
      }),
    ).rejects.toThrow("send failed");
    expect(deps.inboxMessages.create).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });
});
