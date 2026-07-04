import { describe, expect, it, vi } from "vitest";
import { WHATSAPP_TEXT_LIMIT } from "./chunking";
import {
  type DeliverProactiveDmParams,
  ProactiveDeliveryInvalidTargetError,
  ProactiveDeliveryTextSendError,
  deliverProactiveDm,
} from "./proactive-delivery";
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
    listPending?: ReturnType<typeof vi.fn>;
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
      listPendingForRecipientByKind: overrides.listPending ?? vi.fn().mockResolvedValue([{ id: "inbox-1" }]),
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
    expect(result.deliveryTarget).toBe("dm:+15551234567");
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith(target, text);
    expect(deps.conversations.findLatestInboundWhatsAppDmFromRecipient).not.toHaveBeenCalled();
    expect(deps.inboxMessages.create).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("substitutes the recipient phone for invalid managed provider targets", async () => {
    const sendText = vi.fn().mockResolvedValue(sentText);
    const deps = buildDeps({ capabilities: textOnlyCapabilities, sendText });
    const providerTarget: WhatsAppTarget = {
      kind: "dm",
      phoneE164: "",
      providerConversationId: "6a436a0b5a5429ba2f5d8153",
    };

    const result = await deliverProactiveDm({
      target: providerTarget,
      recipientUserId: "user-1",
      senderUserId: "user-1",
      recipientPhoneE164: "+919867673672",
      text: "resolved output",
      ...deps,
    });

    expect(result.mode).toBe("text");
    expect(result.deliveryTarget).toBe("dm:+919867673672");
    expect(sendText).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+919867673672", providerConversationId: "6a436a0b5a5429ba2f5d8153" },
      "resolved output",
    );
  });

  it("throws a typed failure when neither target nor recipient has a valid phone", async () => {
    const sendText = vi.fn().mockResolvedValue(sentText);
    const deps = buildDeps({ capabilities: textOnlyCapabilities, sendText });
    const providerTarget: WhatsAppTarget = {
      kind: "dm",
      phoneE164: "",
      providerConversationId: "6a436a0b5a5429ba2f5d8153",
    };

    let thrown: unknown;
    try {
      await deliverProactiveDm({
        target: providerTarget,
        recipientUserId: "user-1",
        senderUserId: "user-1",
        recipientPhoneE164: "not-a-phone",
        text: "unresolved output",
        ...deps,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProactiveDeliveryInvalidTargetError);
    expect(thrown).toMatchObject({
      targetKind: "dm",
      reason: "invalid_e164",
      targetShape: "provider_conversation_id",
    });
    expect(sendText).not.toHaveBeenCalled();
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

    expect(result).toEqual({
      mode: "text",
      deliveryTarget: "dm:+15551234567",
      sent: sentText,
      textSends: [{ text, sent: sentText }],
    });
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith(target, text);
    expect(deps.inboxMessages.create).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it("chunks in-window session text sequentially", async () => {
    const firstSent = { ...sentText, providerMessageId: "text-1" };
    const secondSent = { ...sentText, providerMessageId: "text-2" };
    const sendText = vi.fn().mockResolvedValueOnce(firstSent).mockResolvedValueOnce(secondSent);
    const deps = buildDeps({
      lastInbound: { receivedAt: "2026-07-03T09:00:00.000Z", providerTimestamp: null },
      sendText,
    });
    const text = `${"a".repeat(WHATSAPP_TEXT_LIMIT)} ${"b".repeat(24)}`;

    const result = await deliverProactiveDm({
      target,
      recipientUserId: "user-1",
      senderUserId: "user-1",
      text,
      now: new Date("2026-07-03T10:00:00.000Z"),
      ...deps,
    });

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenNthCalledWith(1, target, "a".repeat(WHATSAPP_TEXT_LIMIT));
    expect(sendText).toHaveBeenNthCalledWith(2, target, "b".repeat(24));
    expect(result).toEqual({
      mode: "text",
      deliveryTarget: "dm:+15551234567",
      sent: secondSent,
      textSends: [
        { text: "a".repeat(WHATSAPP_TEXT_LIMIT), sent: firstSent },
        { text: "b".repeat(24), sent: secondSent },
      ],
    });
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

  it("sends one deterministic nudge when concurrent deliveries park for the same recipient", async () => {
    let releaseBothCreates!: () => void;
    const bothCreates = new Promise<void>((resolve) => {
      releaseBothCreates = resolve;
    });
    const createdRows: Array<{ id: string; created_at: string }> = [];
    const create = vi.fn(async (data: { message: string }) => {
      const row = {
        id: data.message === "first" ? "inbox-b" : "inbox-a",
        created_at: "2026-07-03T10:00:00.000Z",
      };
      createdRows.push(row);
      if (createdRows.length === 2) releaseBothCreates();
      return row;
    });
    const listPending = vi.fn(async () => {
      await bothCreates;
      return [...createdRows].sort((left, right) => {
        const byCreatedAt = left.created_at.localeCompare(right.created_at);
        return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
      });
    });
    const deps = buildDeps({ listPending });
    deps.inboxMessages.create = create as unknown as DeliverProactiveDmParams["inboxMessages"]["create"];

    const [first, second] = await Promise.all([
      deliverProactiveDm({ target, recipientUserId: "user-1", senderUserId: "user-1", text: "first", ...deps }),
      deliverProactiveDm({ target, recipientUserId: "user-1", senderUserId: "user-1", text: "second", ...deps }),
    ]);

    expect(deps.inboxMessages.create).toHaveBeenCalledTimes(2);
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ mode: "parked", inboxMessageId: "inbox-b" });
    expect(second).toMatchObject({ mode: "nudge", inboxMessageId: "inbox-a" });
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: "user-1",
        inboxMessageId: "inbox-b",
        inboxKind: "workflow_output",
        nudgeSent: false,
      }),
      "WhatsApp proactive delivery parked without duplicate nudge",
    );
  });

  it("throws chunked text failures with already-sent refs attached", async () => {
    const firstSent = { ...sentText, providerMessageId: "text-1" };
    const cause = new Error("second chunk failed");
    const sendText = vi.fn().mockResolvedValueOnce(firstSent).mockRejectedValueOnce(cause);
    const deps = buildDeps({
      lastInbound: { receivedAt: "2026-07-03T09:00:00.000Z", providerTimestamp: null },
      sendText,
    });
    const text = `${"a".repeat(WHATSAPP_TEXT_LIMIT)} ${"b".repeat(WHATSAPP_TEXT_LIMIT)} ${"c".repeat(12)}`;

    let thrown: unknown;
    try {
      await deliverProactiveDm({
        target,
        recipientUserId: "user-1",
        senderUserId: "user-1",
        text,
        now: new Date("2026-07-03T10:00:00.000Z"),
        ...deps,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProactiveDeliveryTextSendError);
    expect(thrown).toMatchObject({
      cause,
      textSends: [{ text: "a".repeat(WHATSAPP_TEXT_LIMIT), sent: firstSent }],
    });
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
