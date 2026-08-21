import { describe, expect, it, vi } from "vitest";
import { createSendTargetMessage } from "./target-delivery";

function makeCapture() {
  return { captureSlack: vi.fn().mockResolvedValue(undefined), captureWhatsApp: vi.fn().mockResolvedValue(undefined) };
}

function makeSlack() {
  return {
    postMessage: vi.fn().mockResolvedValue("1700000000.0001"),
    postThreadReply: vi.fn().mockResolvedValue("1700000000.0002"),
  };
}

function makeWhatsApp(sendResult: { providerMessageId: string | null; providerTimestamp: string | null } | null) {
  return { isConnected: true, sendText: vi.fn().mockResolvedValue(sendResult) };
}

describe("createSendTargetMessage", () => {
  it("posts a top-level Slack channel message and captures it", async () => {
    const slack = makeSlack();
    const capture = makeCapture();
    const send = createSendTargetMessage({ getSlack: () => slack, whatsapp: makeWhatsApp(null), capture });

    const result = await send({ platform: "slack", targetType: "channel", targetId: "C123", message: "hello" });

    expect(slack.postMessage).toHaveBeenCalledWith("C123", "hello");
    expect(slack.postThreadReply).not.toHaveBeenCalled();
    expect(capture.captureSlack).toHaveBeenCalledWith({
      deliveryTarget: "C123",
      threadTs: null,
      messageRef: "1700000000.0001",
      text: "hello",
    });
    expect(result).toEqual({ messageRef: "1700000000.0001" });
  });

  it("posts a Slack thread reply and captures the thread timestamp", async () => {
    const slack = makeSlack();
    const capture = makeCapture();
    const send = createSendTargetMessage({ getSlack: () => slack, whatsapp: makeWhatsApp(null), capture });

    await send({
      platform: "slack",
      targetType: "channel",
      targetId: "C123",
      message: "in thread",
      threadTs: "1699999999.0009",
    });

    expect(slack.postThreadReply).toHaveBeenCalledWith("C123", "1699999999.0009", "in thread");
    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(capture.captureSlack).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: "1699999999.0009", messageRef: "1700000000.0002" }),
    );
  });

  it("reads the Slack bot through the getter on every send, not at construction", async () => {
    const slack = makeSlack();
    let current: ReturnType<typeof makeSlack> | null = null;
    const send = createSendTargetMessage({
      getSlack: () => current,
      whatsapp: makeWhatsApp(null),
      capture: makeCapture(),
    });

    await expect(
      send({ platform: "slack", targetType: "channel", targetId: "C123", message: "hello" }),
    ).rejects.toThrow("Slack bot is not connected");

    current = slack;
    const result = await send({ platform: "slack", targetType: "channel", targetId: "C123", message: "hello" });

    expect(result).toEqual({ messageRef: "1700000000.0001" });
    expect(slack.postMessage).toHaveBeenCalledOnce();
  });

  it("fails a Slack send when the bot is not connected", async () => {
    const send = createSendTargetMessage({
      getSlack: () => null,
      whatsapp: makeWhatsApp(null),
      capture: makeCapture(),
    });

    await expect(
      send({ platform: "slack", targetType: "channel", targetId: "C123", message: "hello" }),
    ).rejects.toThrow("Slack bot is not connected");
  });

  it("sends to a WhatsApp group and captures the confirmed message", async () => {
    const whatsapp = makeWhatsApp({ providerMessageId: "wamid-1", providerTimestamp: "2026-07-31T10:00:00.000Z" });
    const capture = makeCapture();
    const send = createSendTargetMessage({ getSlack: () => null, whatsapp, capture });

    const result = await send({
      platform: "whatsapp",
      targetType: "group",
      targetId: "12345@g.us",
      message: "standup in 5",
    });

    expect(whatsapp.sendText).toHaveBeenCalledWith({ kind: "group", groupId: "12345@g.us" }, "standup in 5");
    expect(capture.captureWhatsApp).toHaveBeenCalledWith({
      deliveryTarget: "12345@g.us",
      messageRef: "wamid-1",
      providerTimestamp: "2026-07-31T10:00:00.000Z",
      text: "standup in 5",
    });
    expect(result).toEqual({ messageRef: "wamid-1" });
  });

  it("fails an unconfirmed WhatsApp group send and does not capture it", async () => {
    const whatsapp = makeWhatsApp(null);
    const capture = makeCapture();
    const send = createSendTargetMessage({ getSlack: () => null, whatsapp, capture });

    await expect(
      send({ platform: "whatsapp", targetType: "group", targetId: "12345@g.us", message: "hello" }),
    ).rejects.toThrow("WhatsApp did not confirm the group message was sent");
    expect(capture.captureWhatsApp).not.toHaveBeenCalled();
  });

  it("fails a WhatsApp send whose result has no provider message ID", async () => {
    const whatsapp = makeWhatsApp({ providerMessageId: null, providerTimestamp: null });
    const send = createSendTargetMessage({ getSlack: () => null, whatsapp, capture: makeCapture() });

    await expect(
      send({ platform: "whatsapp", targetType: "group", targetId: "12345@g.us", message: "hello" }),
    ).rejects.toThrow("WhatsApp did not confirm the group message was sent");
  });

  it("fails a WhatsApp send when the connection is down", async () => {
    const whatsapp = { isConnected: false, sendText: vi.fn() };
    const send = createSendTargetMessage({ getSlack: () => null, whatsapp, capture: makeCapture() });

    await expect(
      send({ platform: "whatsapp", targetType: "group", targetId: "12345@g.us", message: "hello" }),
    ).rejects.toThrow("WhatsApp is not connected");
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it("fails a WhatsApp send whose target is not a group JID", async () => {
    const whatsapp = makeWhatsApp({ providerMessageId: "wamid-1", providerTimestamp: null });
    const send = createSendTargetMessage({ getSlack: () => null, whatsapp, capture: makeCapture() });

    await expect(
      send({ platform: "whatsapp", targetType: "group", targetId: "15550001234@s.whatsapp.net", message: "hello" }),
    ).rejects.toThrow("A WhatsApp target must be a group");
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it("fails mismatched platform and target type combinations without any delivery or capture", async () => {
    const slack = makeSlack();
    const whatsapp = makeWhatsApp(null);
    const capture = makeCapture();
    const send = createSendTargetMessage({ getSlack: () => slack, whatsapp, capture });

    await expect(send({ platform: "slack", targetType: "group", targetId: "C123", message: "hi" })).rejects.toThrow(
      "A Slack target must be a channel",
    );
    await expect(
      send({ platform: "whatsapp", targetType: "channel", targetId: "12345@g.us", message: "hi" }),
    ).rejects.toThrow("A WhatsApp target must be a group");
    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(slack.postThreadReply).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(capture.captureSlack).not.toHaveBeenCalled();
    expect(capture.captureWhatsApp).not.toHaveBeenCalled();
  });
});
