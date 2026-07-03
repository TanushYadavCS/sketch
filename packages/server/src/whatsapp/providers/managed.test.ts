import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils";
import type { WhatsAppInboundMessage } from "../provider";
import { createManagedWhatsAppProvider } from "./managed";

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
    expect(JSON.parse(init.body as string)).toEqual({
      to: "+15551234567",
      text: "hello",
      providerConversationId: "conversation-1",
      quotedProviderMessageId: "wamid.parent",
    });
  });

  it("emits normalized inbound platform events into the runtime shape", async () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });
    const handler = vi.fn(async (_message: WhatsAppInboundMessage) => undefined);
    provider.inboundProvider.onMessage(handler);

    await provider.handleInboundEvent({
      provider: "wati",
      providerMessageId: "wamid.inbound",
      providerConversationId: "conversation-1",
      providerTimestamp: "2026-07-02T10:00:00.000Z",
      senderPhoneE164: "+15551234567",
      senderName: "Alice",
      text: "hello",
      quotedMessage: { providerMessageId: "wamid.parent", text: "parent" },
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
