import { describe, expect, it } from "vitest";
import {
  normalizedGroupMetadataSchema,
  stagedMediaRefSchema,
  whatsAppComposingRequestSchema,
  whatsAppFacadeHealthSchema,
  whatsAppGroupMetadataRequestSchema,
  whatsAppGroupSyncSummarySchema,
  whatsAppMediaDownloadRefSchema,
  whatsAppPairingEventSchema,
  whatsAppPairingStatusSchema,
  whatsAppQuotedRefSchema,
  whatsAppReactionRequestSchema,
  whatsAppReactionResultSchema,
  whatsAppResolveLidRequestSchema,
  whatsAppSendContentSchema,
  whatsAppSendOptionsSchema,
  whatsAppSendRequestSchema,
  whatsAppSendResultSchema,
} from "./facade-contract";

describe("WhatsApp socket facade contract", () => {
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
    expect(whatsAppPairingStatusSchema.parse({ connected: true, phoneNumber: "+15551234567" })).toEqual({
      connected: true,
      phoneNumber: "+15551234567",
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
