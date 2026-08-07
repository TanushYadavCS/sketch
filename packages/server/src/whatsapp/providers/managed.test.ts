import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, flush } from "../../test-utils";
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

describe("managed WhatsApp typing indicators", () => {
  const composingCleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of composingCleanups) cleanup();
    composingCleanups.length = 0;
    vi.restoreAllMocks();
  });

  function createTypingProvider(requestFetch: ReturnType<typeof vi.fn>, logger = createTestLogger()) {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai/",
      tenantToken: "tenant-token",
      logger,
      fetch: requestFetch as unknown as typeof fetch,
    });
    const target = { kind: "dm", phoneE164: "+15551234567" } as const;
    composingCleanups.push(() => provider.dmProvider.stopComposing?.(target));
    return { provider, target };
  }

  it("advertises typing support", () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });

    expect(provider.dmProvider.capabilities.typing).toBe(true);
  });

  it("posts a typing request to the platform for a DM", async () => {
    const requestFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { provider, target } = createTypingProvider(requestFetch);

    expect(() => provider.dmProvider.startComposing?.(target)).not.toThrow();
    await flush();

    expect(requestFetch).toHaveBeenCalledOnce();
    const [url, init] = requestFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.getsketch.ai/api/whatsapp/outbound/typing");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer tenant-token", "Content-Type": "application/json" },
    });
    expect(JSON.parse(init.body as string)).toEqual({ to: "+15551234567" });
  });

  it("ignores group targets and invalid phone numbers", async () => {
    const requestFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const { provider } = createTypingProvider(requestFetch);

    provider.dmProvider.startComposing?.({ kind: "group", groupId: "group@g.us" });
    provider.dmProvider.startComposing?.({ kind: "dm", phoneE164: "not-a-phone" });
    await flush();

    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("issues one request per session and sends again after stop", async () => {
    const requestFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const { provider, target } = createTypingProvider(requestFetch);

    provider.dmProvider.startComposing?.(target);
    provider.dmProvider.startComposing?.(target);
    await flush();
    expect(requestFetch).toHaveBeenCalledOnce();

    provider.dmProvider.stopComposing?.(target);
    provider.dmProvider.startComposing?.(target);
    await flush();
    expect(requestFetch).toHaveBeenCalledTimes(2);

    const firstSignal = (requestFetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal;
    expect(firstSignal?.aborted).toBe(true);
  });

  it("swallows platform failures and logs only safe metadata", async () => {
    const requestFetch = vi.fn(async () => new Response("recipient +15551234567 rejected", { status: 502 }));
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const { provider, target } = createTypingProvider(requestFetch, logger);

    expect(() => provider.dmProvider.startComposing?.(target)).not.toThrow();
    await flush();

    expect(warn).toHaveBeenCalledWith(
      { provider: "managed", action: "typing", status: 502, targetKind: "dm" },
      "Managed WhatsApp typing request failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("tenant-token");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("15551234567");
  });

  it("swallows rejected typing fetches without an unhandled rejection", async () => {
    const requestFetch = vi.fn(async () => {
      throw new Error("platform unreachable from +15551234567 with tenant-token");
    });
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const { provider, target } = createTypingProvider(requestFetch, logger);

    expect(() => provider.dmProvider.startComposing?.(target)).not.toThrow();
    await flush();

    expect(warn).toHaveBeenCalledWith(
      { provider: "managed", action: "typing", status: null, targetKind: "dm" },
      "Managed WhatsApp typing request failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("tenant-token");
  });

  it("ignores a stale in-flight response after stop and restart", async () => {
    const pending: Array<(response: Response) => void> = [];
    const requestFetch = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const { provider, target } = createTypingProvider(requestFetch, logger);

    provider.dmProvider.startComposing?.(target);
    provider.dmProvider.stopComposing?.(target);
    provider.dmProvider.startComposing?.(target);

    pending[0]?.(new Response(null, { status: 502 }));
    pending[1]?.(new Response(null, { status: 200 }));
    await flush();
    await flush();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("managed WhatsApp provider", () => {
  it("advertises managed inbound media support", () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });

    expect(provider.dmProvider.capabilities.media).toBe(true);
  });

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

  it("emits downloadable inbound media references through the runtime shape", async () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });
    const handler = vi.fn(async (_message: WhatsAppInboundMessage) => undefined);
    provider.inboundProvider.onMessage(handler);

    await provider.handleInboundEvent(
      inboundPayload({
        text: "what is in this image?",
        mediaType: "image",
        media: {
          type: "image",
          providerMessageId: "wamid.inbound",
          downloadPath: "/api/whatsapp/media/wamid.inbound?senderPhoneE164=%2B15551234567",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
        },
      }),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "what is in this image?",
        mediaType: "image",
        rawProviderPayload: expect.objectContaining({
          media: {
            type: "image",
            providerMessageId: "wamid.inbound",
            downloadPath: "/api/whatsapp/media/wamid.inbound?senderPhoneE164=%2B15551234567",
            fileName: "photo.jpg",
            mimeType: "image/jpeg",
          },
        }),
      }),
    );
  });

  it("downloads managed inbound media into the workspace attachment directory", async () => {
    const requestFetch = vi.fn(async () => {
      return new Response("image-bytes", {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="ignored.bin"',
        },
      });
    });
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai/",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
      fetch: requestFetch as typeof fetch,
    });
    let captured: WhatsAppInboundMessage | undefined;
    provider.inboundProvider.onMessage(async (message) => {
      captured = message;
    });
    await provider.handleInboundEvent(
      inboundPayload({
        text: "",
        mediaType: "image",
        media: {
          type: "image",
          providerMessageId: "wamid.inbound",
          downloadPath: "/api/whatsapp/media/wamid.inbound?senderPhoneE164=%2B15551234567",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
        },
      }),
    );
    const workspaceDir = await mkdtemp(join(tmpdir(), "managed-download-"));

    try {
      if (!captured) throw new Error("expected inbound message");
      const attachments = await provider.dmProvider.downloadMedia?.(captured, workspaceDir, { maxFileBytes: 1024 });

      expect(attachments).toEqual([
        expect.objectContaining({
          originalName: "photo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: "image-bytes".length,
        }),
      ]);
      expect(await readFile(attachments?.[0]?.localPath ?? "", "utf8")).toBe("image-bytes");
      const [url, init] = requestFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://app.getsketch.ai/api/whatsapp/media/wamid.inbound?senderPhoneE164=%2B15551234567");
      expect(init.headers).toEqual({
        Authorization: "Bearer tenant-token",
        Accept: "application/octet-stream",
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("refuses managed media download paths outside the platform media endpoint", async () => {
    const requestFetch = vi.fn();
    const logger = { warn: vi.fn() } as unknown as Logger;
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger,
      fetch: requestFetch as unknown as typeof fetch,
    });
    let captured: WhatsAppInboundMessage | undefined;
    provider.inboundProvider.onMessage(async (message) => {
      captured = message;
    });
    await provider.handleInboundEvent(
      inboundPayload({
        text: "",
        mediaType: "image",
        media: {
          type: "image",
          providerMessageId: "wamid.inbound",
          downloadPath: "https://example.test/media/wamid.inbound",
        },
      }),
    );

    if (!captured) throw new Error("expected inbound message");
    await expect(provider.dmProvider.downloadMedia?.(captured, "/tmp", { maxFileBytes: 1024 })).resolves.toEqual([]);
    expect(requestFetch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { providerMessageId: "wamid.inbound", mediaType: "image" },
      "Managed WhatsApp media message has no downloadable platform path",
    );
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

  it("keeps media-only inbound messages empty when media is downloadable", async () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });
    const handler = vi.fn(async (_message: WhatsAppInboundMessage) => undefined);
    provider.inboundProvider.onMessage(handler);

    await provider.handleInboundEvent(
      inboundPayload({
        text: "",
        mediaType: "image",
        media: {
          type: "image",
          providerMessageId: "wamid.inbound",
          downloadPath: "/api/whatsapp/media/wamid.inbound?senderPhoneE164=%2B15551234567",
        },
      }),
    );

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: "", mediaType: "image" }));
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
