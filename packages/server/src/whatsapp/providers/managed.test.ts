import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils";
import type { WhatsAppInboundMessage } from "../provider";
import { WHATSAPP_TEMPLATE_KEYS } from "../templates";
import {
  InvalidManagedWhatsAppInboundEventError,
  ManagedWhatsAppRequestError,
  createManagedWhatsAppProvider,
} from "./managed";

function inboundPayload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "event-1",
    type: "message",
    provider: "wati",
    providerMessageId: "wamid.inbound",
    providerConversationId: "conversation-1",
    providerTimestamp: "2026-07-02T10:00:00.000Z",
    senderPhoneE164: "+15551234567",
    senderName: "Alice",
    text: "hello",
    quotedMessage: { providerMessageId: "wamid.parent", text: "parent" },
    ...overrides,
  };
}

describe("managed WhatsApp provider", () => {
  it("sends outbound DM text through the platform API", async () => {
    const requestFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            message: {
              providerMessageId: "wamid.outbound",
              providerConversationId: "conversation-1",
              providerTimestamp: "2026-07-02T10:01:00.000Z",
            },
          }),
          { status: 200 },
        ),
    );
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai/",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });

    const sent = await provider.dmProvider.sendText(
      { kind: "dm", phoneE164: "+15551234567", providerConversationId: "conversation-1" },
      "hello",
      {
        quotedMessage: {
          kind: "dm",
          providerId: "managed",
          providerMessageId: "wamid.parent",
          providerConversationId: "conversation-1",
          canonicalConversationId: "dm:+15551234567",
          providerTimestamp: null,
          senderName: "Alice",
          senderProviderId: "+15551234567",
          senderPhoneE164: "+15551234567",
          target: { kind: "dm", phoneE164: "+15551234567" },
          text: "parent",
        },
      },
    );

    expect(sent).toMatchObject({
      providerMessageId: "wamid.outbound",
      providerConversationId: "conversation-1",
      providerTimestamp: "2026-07-02T10:01:00.000Z",
    });
    const [url, init] = requestFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.getsketch.ai/api/whatsapp/outbound/messages");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tenant-token",
      "Content-Type": "application/json",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      to: "+15551234567",
      text: "hello",
      providerConversationId: "conversation-1",
      quotedProviderMessageId: "wamid.parent",
    });
  });

  it("rejects invalid outbound phone numbers before calling the platform", async () => {
    const requestFetch = vi.fn();
    const logger = { warn: vi.fn() } as unknown as Logger;
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger,
      fetch: requestFetch as unknown as typeof fetch,
    });

    await expect(provider.dmProvider.sendText({ kind: "dm", phoneE164: "15551234567" }, "hello")).rejects.toThrow(
      "target phone number is invalid",
    );

    expect(requestFetch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { targetKind: "dm", decision: "rejected", reason: "invalid_e164" },
      "Invalid managed WhatsApp target",
    );
  });

  it("exposes providerCode from structured platform failures", async () => {
    const requestFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "SEND_FAILED",
              message: "Window expired",
              providerCode: "window_expired",
              providerInfo: "wati detail",
            },
          }),
          { status: 502 },
        ),
    );
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });

    await expect(
      provider.dmProvider.sendText({ kind: "dm", phoneE164: "+15551234567" }, "hello"),
    ).rejects.toMatchObject({
      status: 502,
      providerCode: "window_expired",
      providerInfo: "wati detail",
    });
  });

  it("tolerates structured platform failures without providerCode", async () => {
    const requestFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "SEND_FAILED", message: "Provider rejected" } }), { status: 502 }),
    );
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });

    try {
      await provider.dmProvider.sendText({ kind: "dm", phoneE164: "+15551234567" }, "hello");
      throw new Error("expected send to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedWhatsAppRequestError);
      expect((error as ManagedWhatsAppRequestError).providerCode).toBeUndefined();
      expect((error as ManagedWhatsAppRequestError).message).toContain("Provider rejected");
    }
  });

  it("tolerates malformed JSON platform failures", async () => {
    const requestFetch = vi.fn(async () => new Response("{not-json", { status: 502 }));
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });

    await expect(
      provider.dmProvider.sendText({ kind: "dm", phoneE164: "+15551234567" }, "hello"),
    ).rejects.toMatchObject({
      status: 502,
      providerCode: undefined,
    });
  });
  it("includes a bounded platform error response snippet in outbound failures", async () => {
    const requestFetch = vi.fn(async () => new Response(`platform failed ${"x".repeat(800)}`, { status: 502 }));
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });

    await expect(provider.dmProvider.sendText({ kind: "dm", phoneE164: "+15551234567" }, "hello")).rejects.toThrow(
      /^Managed WhatsApp request failed: HTTP 502: platform failed x+/u,
    );

    try {
      await provider.dmProvider.sendText({ kind: "dm", phoneE164: "+15551234567" }, "hello");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message.length).toBeLessThan(580);
    }
  });

  it("sends logical template keys through the platform template API", async () => {
    const requestFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            message: {
              providerMessageId: "wamid.template",
              providerConversationId: "conversation-1",
              providerTimestamp: "2026-07-02T10:02:00.000Z",
            },
          }),
        ),
    );
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });

    expect(provider.dmProvider.capabilities.templates).toBe(true);
    expect(provider.dmProvider.capabilities.templateProvisioning).toBe("manual");
    const sent = await provider.dmProvider.sendTemplate?.(
      { kind: "dm", phoneE164: "+15551234567", providerConversationId: "conversation-1" },
      {
        key: WHATSAPP_TEMPLATE_KEYS.magicLink,
        language: "hi_IN",
        params: {
          recipientName: "Alice\nExample",
          botName: "Sketch\tBot",
          magicLinkUrl: "https://sketch.test/magic",
          missingValue: null,
        },
      },
    );

    expect(sent).toMatchObject({
      providerMessageId: "wamid.template",
      providerConversationId: "conversation-1",
      providerTimestamp: "2026-07-02T10:02:00.000Z",
    });
    const [url, init] = requestFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.getsketch.ai/api/whatsapp/outbound/templates");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tenant-token",
      "Content-Type": "application/json",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(init.body as string);
    expect(payload).not.toHaveProperty("templateName");
    expect(payload).toEqual({
      to: "+15551234567",
      templateKey: WHATSAPP_TEMPLATE_KEYS.magicLink,
      language: "hi_IN",
      params: {
        recipientName: "Alice Example",
        botName: "Sketch Bot",
        magicLinkUrl: "https://sketch.test/magic",
        missingValue: "",
      },
      providerConversationId: "conversation-1",
    });
  });

  it("surfaces template_not_found platform failures from template sends", async () => {
    const requestFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "SEND_FAILED",
              message: "Template mapping not found",
              providerCode: "template_not_found",
              providerInfo: "provider rejected template",
            },
          }),
          { status: 502 },
        ),
    );
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });

    try {
      await provider.dmProvider.sendTemplate?.(
        { kind: "dm", phoneE164: "+15551234567" },
        {
          key: WHATSAPP_TEMPLATE_KEYS.magicLink,
          params: { recipientName: "Alice", botName: "Sketch", magicLinkUrl: "https://sketch.test/magic" },
        },
      );
      throw new Error("expected send to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedWhatsAppRequestError);
      expect(error).toMatchObject({
        status: 502,
        providerCode: "template_not_found",
        providerInfo: "provider rejected template",
      });
      expect((error as Error).message).toContain("template_not_found");
    }
  });

  it("emits normalized inbound platform events into the runtime shape", async () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });
    const handler = vi.fn(async (_message: WhatsAppInboundMessage) => undefined);
    provider.inboundProvider.onMessage(handler);

    const result = await provider.handleInboundEvent(inboundPayload());

    expect(result).toEqual({
      kind: "message",
      eventId: "event-1",
      providerMessageId: "wamid.inbound",
      senderPhoneE164: "+15551234567",
    });
    expect(handler).toHaveBeenCalledWith({
      kind: "dm",
      providerId: "managed",
      providerMessageId: "wamid.inbound",
      providerConversationId: "conversation-1",
      canonicalConversationId: "dm:+15551234567",
      providerTimestamp: "2026-07-02T10:00:00.000Z",
      senderName: "Alice",
      senderProviderId: "+15551234567",
      senderPhoneE164: "+15551234567",
      target: { kind: "dm", phoneE164: "+15551234567", providerConversationId: "conversation-1" },
      text: "hello",
      rawProviderPayload: expect.any(Object),
      quotedMessage: { providerMessageId: "wamid.parent", participantJid: null, text: "parent" },
    });
  });

  it("ignores non-message event types with metadata-only logging", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger,
    });
    const handler = vi.fn(async (_message: WhatsAppInboundMessage) => undefined);
    provider.inboundProvider.onMessage(handler);

    await expect(
      provider.handleInboundEvent({ eventId: "event-status-1", type: "status", text: "ignored" }),
    ).resolves.toEqual({
      kind: "ignored",
      eventId: "event-status-1",
      type: "status",
    });

    expect(handler).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { eventId: "event-status-1", type: "status", decision: "ignored" },
      "Ignored managed WhatsApp inbound event",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("rejects schema-invalid message events without invoking handlers", async () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });
    const handler = vi.fn(async (_message: WhatsAppInboundMessage) => undefined);
    provider.inboundProvider.onMessage(handler);

    await expect(provider.handleInboundEvent(inboundPayload({ senderPhoneE164: "15551234567" }))).rejects.toThrow(
      InvalidManagedWhatsAppInboundEventError,
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("degrades media-only inbound messages to honest text placeholders", async () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });
    const handler = vi.fn(async (_message: WhatsAppInboundMessage) => undefined);
    provider.inboundProvider.onMessage(handler);

    await provider.handleInboundEvent(inboundPayload({ text: "", mediaType: "image" }));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "[WhatsApp media message (image) - media content not available]",
        mediaType: "image",
      }),
    );
  });

  it("rejects group sends", async () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });

    await expect(provider.dmProvider.sendText({ kind: "group", groupId: "group@g.us" }, "hello")).rejects.toThrow(
      "cannot send group messages",
    );
  });
});
