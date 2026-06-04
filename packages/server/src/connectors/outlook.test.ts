import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import type { EmailSyncedItem } from "./email";
import { type OutlookMessage, createOutlookConnector, toNormalizedOutlookEmail } from "./outlook";
import type { OAuthCredentials } from "./types";

const logger = createTestLogger();

function outlookMessage(
  id: string,
  overrides: {
    internetMessageId?: string | null;
    from?: { name?: string; address?: string };
    to?: Array<{ name?: string; address?: string }>;
    subject?: string;
    body?: string;
    headers?: Array<{ name: string; value: string }>;
  } = {},
): OutlookMessage {
  return {
    id,
    internetMessageId: overrides.internetMessageId ?? `<${id}@example.com>`,
    conversationId: "conversation-1",
    subject: overrides.subject ?? "Pricing discussion",
    sentDateTime: "2026-02-04T10:00:00Z",
    receivedDateTime: "2026-02-04T10:00:02Z",
    webLink: `https://outlook.office.com/mail/id/${id}`,
    from: { emailAddress: overrides.from ?? { name: "Jane Doe", address: "jane@example.com" } },
    toRecipients: (overrides.to ?? [{ name: "Owner", address: "owner@canvasx.ai" }]).map((emailAddress) => ({
      emailAddress,
    })),
    ccRecipients: [],
    bccRecipients: [],
    body: { contentType: "text", content: overrides.body ?? "Can we discuss pricing?" },
    bodyPreview: overrides.body ?? "Can we discuss pricing?",
    internetMessageHeaders: overrides.headers ?? [{ name: "Message-ID", value: `<${id}@example.com>` }],
  };
}

describe("Outlook connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes Microsoft Graph messages into the shared email envelope shape", () => {
    const normalized = toNormalizedOutlookEmail(outlookMessage("outlook-1"), "owner@canvasx.ai");

    expect(normalized).toMatchObject({
      providerFileId: "outlook-1",
      providerMessageId: "<outlook-1@example.com>",
      threadId: "conversation-1",
      folder: "inbox",
      bodyText: "Can we discuss pricing?",
    });
    expect(normalized?.from).toEqual({ name: "Jane Doe", email: "jane@example.com" });
  });

  it("syncs retained reciprocal messages and records suppressed bulk messages", async () => {
    const connector = createOutlookConnector();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === "/v1.0/me/messages") {
        return jsonResponse({ value: [{ id: "retained" }, { id: "bulk" }] });
      }

      if (url.pathname === "/v1.0/me/mailFolders/sentitems/messages") {
        return jsonResponse({ value: [{ id: "sent" }] });
      }

      if (url.pathname.endsWith("/messages/retained")) {
        return jsonResponse(outlookMessage("retained"));
      }

      if (url.pathname.endsWith("/messages/bulk")) {
        return jsonResponse(
          outlookMessage("bulk", {
            from: { name: "Newsletter", address: "news@example.com" },
            subject: "Weekly update",
            headers: [{ name: "List-Unsubscribe", value: "<mailto:unsubscribe@example.com>" }],
          }),
        );
      }

      if (url.pathname.endsWith("/messages/sent")) {
        return jsonResponse(
          outlookMessage("sent", {
            from: { name: "Owner", address: "owner@canvasx.ai" },
            to: [{ name: "Jane Doe", address: "jane@example.com" }],
          }),
        );
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const suppressed: Array<{ providerFileId: string; reason: string }> = [];
    const items: EmailSyncedItem[] = [];
    for await (const item of connector.sync({
      connectorConfigId: "connector-outlook",
      credentials: validCredentials(),
      scopeConfig: { initialDays: 90, maxMessages: 10, maxReciprocitySent: 10 },
      cursor: null,
      logger,
      ownerEmail: "owner@canvasx.ai",
      onEmailSuppressed: async (record) => {
        suppressed.push({ providerFileId: record.providerFileId, reason: record.reason });
      },
    })) {
      items.push(item as EmailSyncedItem);
    }

    expect(fetchSpy).toHaveBeenCalled();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      providerFileId: "retained",
      providerMessageId: "<retained@example.com>",
      fileType: "email_message",
      accessEmails: ["jane@example.com", "owner@canvasx.ai"],
      authorEmail: "jane@example.com",
    });
    expect(items[0].emailEnvelope.connectorConfigId).toBe("connector-outlook");
    expect(suppressed).toEqual([{ providerFileId: "bulk", reason: "bulk" }]);
  });
});

function validCredentials(): OAuthCredentials {
  return {
    type: "oauth",
    access_token: "access",
    refresh_token: "refresh",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    client_id: "client",
    client_secret: "secret",
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
