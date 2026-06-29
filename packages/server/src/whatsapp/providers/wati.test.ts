import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils";
import { type WhatsAppInboundMessage, whatsappDeliveryTargetFromTarget } from "../provider";
import {
  createWatiWhatsAppProvider,
  normalizeWatiPhoneNumber,
  parseWatiDeliveryStatusEvent,
  parseWatiWebhookEvent,
} from "./wati";

function documentedMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "69282478274a880fe782b2d9",
    created: "2025-11-27T10:14:16.6268572Z",
    whatsappMessageId: "wamid.inbound",
    conversationId: "conversation-1",
    ticketId: "ticket-1",
    text: "hello",
    type: "text",
    data: null,
    timestamp: "1764238453",
    owner: false,
    eventType: "message",
    statusString: "SENT",
    waId: "8618719149214",
    senderName: "Alice",
    replyContextId: "wamid.parent",
    channelPhoneNumber: "17435002445",
    ...overrides,
  };
}

function quotedMessage(): WhatsAppInboundMessage {
  return {
    kind: "dm",
    providerId: "wati",
    providerMessageId: "wamid.inbound",
    providerConversationId: "conversation-1",
    canonicalConversationId: "dm:+15551234567",
    providerTimestamp: null,
    senderName: "Alice",
    senderProviderId: "15551234567",
    senderPhoneE164: "+15551234567",
    target: { kind: "dm", phoneE164: "+15551234567" },
    text: "hello",
  };
}

function firstFetchCall(requestFetch: { mock: { calls: unknown[][] } }): [URL, RequestInit] {
  const call = requestFetch.mock.calls[0];
  if (!call) throw new Error("expected fetch call");
  return [call[0] as URL, call[1] as RequestInit];
}

describe("Wati webhook parsing", () => {
  it("normalizes documented inbound message payloads into WhatsApp DM events", () => {
    const parsed = parseWatiWebhookEvent(documentedMessagePayload(), { channelPhoneNumber: "+17435002445" });

    expect(parsed).toMatchObject({
      kind: "message",
      message: {
        kind: "dm",
        providerId: "wati",
        providerMessageId: "wamid.inbound",
        providerConversationId: "conversation-1",
        canonicalConversationId: "dm:+8618719149214",
        providerTimestamp: "2025-11-27T10:14:13.000Z",
        senderName: "Alice",
        senderProviderId: "8618719149214",
        senderPhoneE164: "+8618719149214",
        target: { kind: "dm", phoneE164: "+8618719149214" },
        text: "hello",
        quotedMessage: { providerMessageId: "wamid.parent", participantJid: null, text: "" },
      },
    });
    if (parsed.kind !== "message") throw new Error("expected message");
    expect(whatsappDeliveryTargetFromTarget(parsed.message.target)).toBe("dm:+8618719149214");
    expect(parsed.kind === "message" ? parsed.message.rawProviderPayload : null).toEqual(documentedMessagePayload());
  });

  it("accepts media message variants without requiring text", () => {
    const parsed = parseWatiWebhookEvent(
      documentedMessagePayload({
        whatsappMessageId: "wamid.media",
        text: null,
        type: "image",
        replyContextId: "",
      }),
    );

    expect(parsed).toMatchObject({
      kind: "message",
      message: {
        providerMessageId: "wamid.media",
        text: "",
        mediaType: "image",
      },
    });
  });

  it("ignores owner, reaction, and channel-mismatched events without crashing", () => {
    expect(parseWatiWebhookEvent(documentedMessagePayload({ owner: true }))).toMatchObject({
      kind: "delivery_status",
      event: { providerMessageId: "wamid.inbound", status: "SENT" },
    });
    expect(parseWatiWebhookEvent(documentedMessagePayload({ type: "reaction" }))).toEqual({
      kind: "ignored",
      reason: "unsupported_message_type",
    });
    expect(parseWatiWebhookEvent(documentedMessagePayload(), { channelPhoneNumber: "+15551234567" })).toEqual({
      kind: "ignored",
      reason: "channel_mismatch",
    });
    expect(
      parseWatiWebhookEvent(documentedMessagePayload({ channelPhoneNumber: null }), {
        channelPhoneNumber: "+15551234567",
      }),
    ).toEqual({
      kind: "ignored",
      reason: "channel_mismatch",
    });
  });

  it("parses delivery/status payloads without treating them as inbound messages", () => {
    const parsed = parseWatiDeliveryStatusEvent({
      eventType: "messageStatus",
      whatsappMessageId: "wamid.status",
      conversationId: "conversation-1",
      statusString: "READ",
      timestamp: "1764238453",
    });

    expect(parsed).toMatchObject({
      kind: "delivery_status",
      event: {
        providerId: "wati",
        providerMessageId: "wamid.status",
        providerConversationId: "conversation-1",
        eventType: "messageStatus",
        status: "READ",
        failureCode: null,
        failureDetail: null,
        providerTimestamp: "2025-11-27T10:14:13.000Z",
      },
    });
  });

  it("keeps Wati delivery failure metadata without logging message content", () => {
    const parsed = parseWatiDeliveryStatusEvent({
      eventType: "templateMessageFailed",
      whatsappMessageId: "wamid.failed",
      conversationId: "conversation-1",
      statusString: "Failed",
      failedCode: "131026",
      failedDetail: "Message undeliverable",
    });

    expect(parsed).toMatchObject({
      kind: "delivery_status",
      event: {
        providerMessageId: "wamid.failed",
        providerConversationId: "conversation-1",
        eventType: "templateMessageFailed",
        status: "Failed",
        failureCode: "131026",
        failureDetail: "Message undeliverable",
      },
    });
  });

  it("returns metadata-only unrecognized results for unsafe message shapes", () => {
    expect(parseWatiWebhookEvent({ eventType: "message", type: "text", text: "missing ids" })).toEqual({
      kind: "unrecognized",
      reason: "missing_required_message_fields",
      eventType: "message",
      messageType: "text",
    });
    expect(parseWatiWebhookEvent({ eventType: "ticketAssigned", ticketId: "t1" })).toEqual({
      kind: "unrecognized",
      reason: "unsupported_event_type",
      eventType: "ticketAssigned",
      messageType: null,
    });
  });

  it("ignores BSUID-only inbound events until Sketch supports username identities", () => {
    expect(parseWatiWebhookEvent(documentedMessagePayload({ waId: null, bsuid: "bsuid-1" }))).toEqual({
      kind: "ignored",
      reason: "unsupported_sender_identity",
    });
  });

  it("normalizes Wati phone variants to strict E.164", () => {
    expect(normalizeWatiPhoneNumber("8618719149214")).toBe("+8618719149214");
    expect(normalizeWatiPhoneNumber("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeWatiPhoneNumber("0000")).toBeNull();
  });
});

describe("Wati outbound provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends quoted session text messages through the v1 Wati endpoint", async () => {
    const requestFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          result: "success",
          message: {
            whatsappMessageId: "wamid.sent",
            conversationId: "conversation-2",
            time: "1764238453",
          },
        }),
      );
    });
    const provider = createWatiWhatsAppProvider({
      apiEndpoint: "https://live-mt-server.wati.io/tenant-1/",
      accessToken: "wati-token",
      webhookToken: "webhook-token",
      channelPhoneNumber: "+17435002445",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });

    const sent = await provider.dmProvider.sendText({ kind: "dm", phoneE164: "+15551234567" }, "hello", {
      quotedMessage: quotedMessage(),
    });

    const [url, init] = firstFetchCall(requestFetch);
    expect(url.toString()).toBe("https://live-mt-server.wati.io/tenant-1/api/v1/sendSessionMessage/15551234567");
    expect(init.headers).toEqual({
      Authorization: "Bearer wati-token",
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect((init.body as URLSearchParams).get("messageText")).toBe("hello");
    expect((init.body as URLSearchParams).get("replyContextId")).toBe("wamid.inbound");
    expect((init.body as URLSearchParams).get("channelPhoneNumber")).toBe("17435002445");
    expect(sent).toEqual({
      providerMessageId: "wamid.sent",
      providerConversationId: "conversation-2",
      providerTimestamp: "2025-11-27T10:14:13.000Z",
      rawProviderPayload: {
        ok: true,
        result: "success",
        message: {
          whatsappMessageId: "wamid.sent",
          conversationId: "conversation-2",
          time: "1764238453",
        },
      },
    });
  });

  it("sends files through the v1 session file endpoint when no channel is configured", async () => {
    const requestFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: "success" })));
    const provider = createWatiWhatsAppProvider({
      apiEndpoint: "https://tenant.wati.io",
      accessToken: "wati-token",
      webhookToken: "webhook-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });

    const tmpDir = await mkdtemp(join(tmpdir(), "wati-send-file-v1-"));
    const filePath = join(tmpDir, "note.txt");
    await writeFile(filePath, "file body");

    try {
      await provider.dmProvider.sendFile?.(
        { kind: "dm", phoneE164: "+15551234567" },
        filePath,
        "text/plain",
        "note.txt",
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    const [url, init] = firstFetchCall(requestFetch);
    expect(url.toString()).toBe("https://tenant.wati.io/api/v1/sendSessionFile/15551234567");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer wati-token" });
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("target")).toBeNull();
  });

  it("sends files through the v3 Wati file endpoint with channel-qualified targets", async () => {
    const requestFetch = vi.fn(async () => new Response(JSON.stringify({ message: { id: "sent-file" } })));
    const provider = createWatiWhatsAppProvider({
      apiEndpoint: "https://live-mt-server.wati.io/tenant-1",
      accessToken: "wati-token",
      webhookToken: "webhook-token",
      channelPhoneNumber: "17435002445",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });

    const tmpDir = await mkdtemp(join(tmpdir(), "wati-send-file-"));
    const filePath = join(tmpDir, "note.txt");
    await writeFile(filePath, "file body");

    try {
      await provider.dmProvider.sendFile?.(
        { kind: "dm", phoneE164: "+15551234567" },
        filePath,
        "text/plain",
        "note.txt",
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    const [url, init] = firstFetchCall(requestFetch);
    expect(url.toString()).toBe("https://live-mt-server.wati.io/api/ext/v3/conversations/messages/file");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer wati-token" });
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("target")).toBe("17435002445:15551234567");
  });

  it("downloads Wati media into the workspace attachment directory", async () => {
    const requestFetch = vi.fn(async () => {
      return new Response("image-bytes", {
        headers: {
          "content-type": "image/png",
          "content-disposition": 'attachment; filename="photo.png"',
        },
      });
    });
    const provider = createWatiWhatsAppProvider({
      apiEndpoint: "https://tenant.wati.io",
      accessToken: "wati-token",
      webhookToken: "webhook-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });
    const parsed = parseWatiWebhookEvent(documentedMessagePayload({ id: "wati-internal-id", type: "image" }));
    if (parsed.kind !== "message") throw new Error("expected message");
    const workspaceDir = await mkdtemp(join(tmpdir(), "wati-download-"));

    try {
      const attachments = await provider.dmProvider.downloadMedia?.(parsed.message, workspaceDir, {
        maxFileBytes: 1024,
      });

      expect(attachments).toEqual([
        expect.objectContaining({
          originalName: "photo.png",
          mimeType: "image/png",
          sizeBytes: "image-bytes".length,
        }),
      ]);
      expect(await readFile(attachments?.[0]?.localPath ?? "", "utf8")).toBe("image-bytes");
      const [url] = firstFetchCall(requestFetch);
      expect(url.pathname).toBe("/api/ext/v3/conversations/messages/file/wati-internal-id");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("retries Wati media download with the WhatsApp message id after an internal id miss", async () => {
    const requestFetch = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("/wati-internal-id")) {
        return new Response("missing", { status: 404 });
      }

      return new Response("image-bytes", {
        headers: {
          "content-type": "image/png",
          "content-disposition": 'attachment; filename="photo.png"',
        },
      });
    });
    const provider = createWatiWhatsAppProvider({
      apiEndpoint: "https://tenant.wati.io",
      accessToken: "wati-token",
      webhookToken: "webhook-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });
    const parsed = parseWatiWebhookEvent(
      documentedMessagePayload({ id: "wati-internal-id", whatsappMessageId: "wamid.media", type: "image" }),
    );
    if (parsed.kind !== "message") throw new Error("expected message");
    const workspaceDir = await mkdtemp(join(tmpdir(), "wati-download-fallback-"));

    try {
      const attachments = await provider.dmProvider.downloadMedia?.(parsed.message, workspaceDir, {
        maxFileBytes: 1024,
      });

      expect(attachments).toEqual([expect.objectContaining({ originalName: "photo.png" })]);
      expect(requestFetch).toHaveBeenCalledTimes(2);
      expect(requestFetch.mock.calls.map(([url]) => (url as URL).pathname)).toEqual([
        "/api/ext/v3/conversations/messages/file/wati-internal-id",
        "/api/ext/v3/conversations/messages/file/wamid.media",
      ]);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("emits only normalized inbound messages from handleWebhook", async () => {
    const provider = createWatiWhatsAppProvider({
      apiEndpoint: "https://tenant.wati.io",
      accessToken: "wati-token",
      webhookToken: "webhook-token",
      logger: createTestLogger(),
      fetch: vi.fn() as unknown as typeof fetch,
    });
    const handler = vi.fn();
    provider.inboundProvider.onMessage(handler);

    const results = await provider.handleWebhook([
      documentedMessagePayload({ whatsappMessageId: "wamid.one" }),
      documentedMessagePayload({ owner: true, whatsappMessageId: "wamid.owner" }),
    ]);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: "wamid.one" }));
    expect(results).toEqual([
      { kind: "message", providerMessageId: "wamid.one", senderPhoneE164: "+8618719149214" },
      expect.objectContaining({ kind: "delivery_status" }),
    ]);
  });
});
