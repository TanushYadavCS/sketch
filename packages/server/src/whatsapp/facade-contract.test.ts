import { describe, expect, it } from "vitest";
import {
  WHATSAPP_FACADE_CONTRACT_VERSION,
  normalizedGroupMetadataSchema,
  stagedMediaRefSchema,
  whatsAppComposingRequestSchema,
  whatsAppFacadeHealthSchema,
  whatsAppGroupMetadataRequestSchema,
  whatsAppGroupSyncSummarySchema,
  whatsAppHistoryBatchEnvelopeSchema,
  whatsAppHistorySyncRequestSchema,
  whatsAppHistorySyncResponseSchema,
  whatsAppInboundEnvelopeVersionSchema,
  whatsAppMediaDownloadRefSchema,
  whatsAppMessageEnvelopeSchema,
  whatsAppPairingEventSchema,
  whatsAppPairingStatusSchema,
  whatsAppQuotedRefSchema,
  whatsAppReactionRequestSchema,
  whatsAppReactionResultSchema,
  whatsAppResolveLidRequestSchema,
  whatsAppSendContentSchema,
  whatsAppSendOptionsSchema,
  whatsAppSendRequestSchema,
  whatsAppSendResponseSchema,
  whatsAppSendResultSchema,
} from "./facade-contract";

describe("WhatsApp socket facade contract", () => {
  it("advertises the history-sync facade contract revision", () => {
    expect(WHATSAPP_FACADE_CONTRACT_VERSION).toBe("1.2");
    expect(
      whatsAppHistorySyncRequestSchema.parse({
        count: 50,
        oldestMessageKey: { remoteJid: "group@g.us", id: "oldest", fromMe: true },
        oldestMessageTimestamp: 1_768_464_420,
      }),
    ).toMatchObject({ count: 50, oldestMessageKey: { fromMe: true } });
    expect(whatsAppHistorySyncResponseSchema.parse({ requestSessionId: "request-1" })).toEqual({
      requestSessionId: "request-1",
    });
    expect(() =>
      whatsAppHistorySyncRequestSchema.parse({
        count: 51,
        oldestMessageKey: { remoteJid: "group@g.us", id: "oldest", fromMe: false },
        oldestMessageTimestamp: 1_768_464_420,
      }),
    ).toThrow();
  });
  it("accepts compatible minor envelope versions and rejects unknown majors", () => {
    expect(whatsAppInboundEnvelopeVersionSchema.parse("1.7")).toBe("1.7");
    expect(() => whatsAppInboundEnvelopeVersionSchema.parse("2.0")).toThrow();
  });

  it("round-trips connection keys and defaults legacy queued envelopes to null", () => {
    const message = {
      version: "1.0",
      kind: "history_message" as const,
      providerTimestamp: "2026-07-15T08:27:00.000Z",
      providerConversationId: "120363000000001@g.us",
      providerMessageId: "history-1",
      eventKey: "event-history-1",
      connectionKey: "000000000007:000000000019",
      fromMe: false,
      message: {
        type: "group" as const,
        text: "history text",
        jid: "120363000000001@g.us",
        messageId: "history-1",
        pushName: "Sender",
        senderJid: "15551234567@s.whatsapp.net",
        senderPhone: "+15551234567",
        isMentioned: false,
        rawProviderPayload: {},
        stagedMediaRef: null,
        mediaStagingError: null,
      },
    };
    expect(whatsAppMessageEnvelopeSchema.parse(message).connectionKey).toBe(message.connectionKey);
    expect(whatsAppMessageEnvelopeSchema.parse({ ...message, connectionKey: undefined }).connectionKey).toBeNull();

    const batch = whatsAppHistoryBatchEnvelopeSchema.parse({
      version: "1.0",
      kind: "history_batch",
      providerTimestamp: message.providerTimestamp,
      connectionKey: message.connectionKey,
      batch: { batchId: "batch-1", chunkIndex: 0, chunkCount: 1, syncType: 1, progress: 100, isLatest: true },
      messages: [message],
    });
    expect(batch.connectionKey).toBe(message.connectionKey);
    expect(whatsAppHistoryBatchEnvelopeSchema.parse({ ...batch, connectionKey: undefined }).connectionKey).toBeNull();
  });
  it("parses send and quoted-reference examples", () => {
    const providerRef = {
      kind: "providerMessageId",
      providerConversationId: "120363000000001@g.us",
      value: "wamid.quoted",
    } as const;

    expect(whatsAppQuotedRefSchema.parse({ kind: "eventKey", value: "sha256:event" })).toEqual({
      kind: "eventKey",
      value: "sha256:event",
    });
    expect(whatsAppQuotedRefSchema.parse(providerRef)).toEqual(providerRef);
    expect(whatsAppSendContentSchema.parse({ kind: "text", text: "Hello" })).toEqual({
      kind: "text",
      text: "Hello",
    });
    expect(
      whatsAppSendContentSchema.parse({
        kind: "file",
        filePath: "/tmp/report.pdf",
        mimeType: "application/pdf",
        fileName: "report.pdf",
      }),
    ).toMatchObject({ kind: "file", fileName: "report.pdf" });
    expect(whatsAppSendOptionsSchema.parse({ quotedRef: providerRef, idempotencyKey: "send-1" })).toEqual({
      quotedRef: providerRef,
      idempotencyKey: "send-1",
    });
    expect(
      whatsAppSendRequestSchema.parse({
        target: "120363000000001@g.us",
        content: { kind: "text", text: "Hello" },
        opts: { quotedRef: providerRef, idempotencyKey: "send-1" },
      }),
    ).toMatchObject({ target: "120363000000001@g.us", opts: { idempotencyKey: "send-1" } });
    expect(
      whatsAppSendResultSchema.parse({
        providerMessageId: "wamid.sent",
        providerConversationId: "120363000000001@g.us",
        providerTimestamp: "2026-07-15T08:27:00.000Z",
        rawProviderPayload: { key: { id: "wamid.sent" } },
      }),
    ).toMatchObject({ providerMessageId: "wamid.sent", providerTimestamp: "2026-07-15T08:27:00.000Z" });
    expect(whatsAppSendResponseSchema.parse({ result: null })).toEqual({ result: null });
  });

  it("parses reaction and staged-media examples", () => {
    expect(whatsAppComposingRequestSchema.parse({ target: "120363000000001@g.us", on: true })).toEqual({
      target: "120363000000001@g.us",
      on: true,
    });
    expect(
      whatsAppReactionRequestSchema.parse({
        target: "120363000000001@g.us",
        quotedRef: { kind: "eventKey", value: "sha256:event" },
        emoji: "",
      }),
    ).toMatchObject({ emoji: "" });
    expect(whatsAppReactionResultSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(whatsAppReactionResultSchema.parse({ error: "unknown-message" })).toEqual({
      error: "unknown-message",
    });
    expect(
      whatsAppMediaDownloadRefSchema.parse({
        messageRef: {
          kind: "providerMessageId",
          providerConversationId: "120363000000001@g.us",
          value: "wamid.media",
        },
        destinationDir: "/data/workspaces/channel/attachments",
        maxFileBytes: 10_485_760,
      }),
    ).toMatchObject({ maxFileBytes: 10_485_760 });
    expect(
      stagedMediaRefSchema.parse({
        stagedPath: "/data/wa-staging/media.bin",
        mime: "application/octet-stream",
        size: 42,
        sha256: "a".repeat(64),
        originalName: "media.bin",
      }),
    ).toMatchObject({ size: 42, sha256: "a".repeat(64) });
  });

  it("parses normalized group, pairing, sync, and health examples", () => {
    expect(
      normalizedGroupMetadataSchema.parse({
        id: "120363000000001@g.us",
        subject: "Operations",
        desc: null,
        participants: [
          {
            jid: "15551234567@s.whatsapp.net",
            phoneE164: "+15551234567",
            lid: null,
            admin: "admin",
          },
        ],
      }),
    ).toMatchObject({ participants: [{ jid: "15551234567@s.whatsapp.net" }] });
    expect(whatsAppGroupSyncSummarySchema.parse({ synced: 12 })).toEqual({ synced: 12 });
    expect(whatsAppGroupMetadataRequestSchema.parse({ jid: "120363000000001@g.us", opts: { refresh: true } })).toEqual({
      jid: "120363000000001@g.us",
      opts: { refresh: true },
    });
    expect(whatsAppResolveLidRequestSchema.parse({ jid: "86702773280883@lid" })).toEqual({
      jid: "86702773280883@lid",
    });
    expect(
      whatsAppPairingStatusSchema.parse({
        connected: true,
        phoneNumber: "+15551234567",
        lid: "86702773280883@lid",
      }),
    ).toEqual({
      connected: true,
      phoneNumber: "+15551234567",
      lid: "86702773280883@lid",
    });
    expect(whatsAppPairingEventSchema.parse({ type: "qr", qr: "qr-payload" })).toEqual({
      type: "qr",
      qr: "qr-payload",
    });
    expect(
      whatsAppFacadeHealthSchema.parse({
        socketState: "connected",
        queueDepth: 0,
        insertFailures: 0,
        uptime: 120.5,
        scriptHash: "inprocess",
        contractVersion: "1.0",
      }),
    ).toMatchObject({ socketState: "connected", contractVersion: "1.0" });
  });
});
