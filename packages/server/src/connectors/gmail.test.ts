import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import type { EmailSyncedItem } from "./email";
import { type GmailMessage, createGmailConnector, toNormalizedEmail } from "./gmail";
import type { OAuthCredentials } from "./types";

const logger = createTestLogger();

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function gmailMessage(
  id: string,
  overrides: {
    messageId?: string;
    from?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    labels?: string[];
    body?: string;
    headers?: Array<{ name: string; value: string }>;
  } = {},
): GmailMessage {
  return {
    id,
    threadId: "thread-1",
    labelIds: overrides.labels ?? ["INBOX"],
    internalDate: "1770000000000",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Message-ID", value: overrides.messageId ?? `<${id}@example.com>` },
        { name: "From", value: overrides.from ?? "Jane Doe <jane@example.com>" },
        { name: "To", value: overrides.to ?? "Owner <owner@canvasx.ai>" },
        ...(overrides.cc ? [{ name: "Cc", value: overrides.cc }] : []),
        ...(overrides.bcc ? [{ name: "Bcc", value: overrides.bcc }] : []),
        { name: "Subject", value: overrides.subject ?? "Pricing discussion" },
        ...(overrides.headers ?? []),
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: b64url(overrides.body ?? "Can we discuss pricing?") },
        },
      ],
    },
  };
}

describe("Gmail connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes Gmail messages without leaking Bcc into the shared email envelope", () => {
    const normalized = toNormalizedEmail(
      gmailMessage("gmail-1", {
        bcc: "Hidden <hidden@example.com>",
        body: "Hello from Gmail",
      }),
      "owner@canvasx.ai",
    );

    expect(normalized).toMatchObject({
      providerFileId: "gmail-1",
      providerMessageId: "<gmail-1@example.com>",
      threadId: "thread-1",
      folder: "inbox",
      bodyText: "Hello from Gmail",
    });
    expect(normalized?.bcc).toEqual([{ name: "Hidden", email: "hidden@example.com" }]);
  });

  it("syncs retained reciprocal messages and records suppressed bulk messages", async () => {
    const connector = createGmailConnector();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      const path = url.pathname;
      const q = url.searchParams.get("q");

      if (path === "/gmail/v1/users/me/profile") {
        return jsonResponse({ historyId: "history-start" });
      }

      if (path === "/gmail/v1/users/me/messages" && q?.startsWith("newer_than")) {
        return jsonResponse({
          messages: [{ id: "retained" }, { id: "bulk" }],
        });
      }

      if (path === "/gmail/v1/users/me/messages" && q?.startsWith("in:sent")) {
        return jsonResponse({ messages: [{ id: "sent" }] });
      }

      if (path.endsWith("/messages/retained")) {
        return jsonResponse(gmailMessage("retained"));
      }

      if (path.endsWith("/messages/bulk")) {
        return jsonResponse(
          gmailMessage("bulk", {
            from: "Newsletter <news@example.com>",
            subject: "Weekly update",
            headers: [{ name: "List-Unsubscribe", value: "<mailto:unsubscribe@example.com>" }],
          }),
        );
      }

      if (path.endsWith("/messages/sent")) {
        return jsonResponse(
          gmailMessage("sent", {
            from: "Owner <owner@canvasx.ai>",
            to: "Jane Doe <jane@example.com>",
            labels: ["SENT"],
          }),
        );
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const suppressed: Array<{ providerFileId: string; reason: string }> = [];
    const credentials = validCredentials();

    const items: EmailSyncedItem[] = [];
    for await (const item of connector.sync({
      connectorConfigId: "connector-gmail",
      credentials,
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
    expect(items[0].emailEnvelope.connectorConfigId).toBe("connector-gmail");
    expect(suppressed).toEqual([{ providerFileId: "bulk", reason: "bulk" }]);

    const messageRequests = fetchSpy.mock.calls
      .map(([input]) => new URL(input.toString()))
      .filter((url) => url.pathname.includes("/gmail/v1/users/me/messages/"));
    const retainedRequest = messageRequests.find((url) => url.pathname.endsWith("/messages/retained"));
    const bulkRequest = messageRequests.find((url) => url.pathname.endsWith("/messages/bulk"));
    const sentRequest = messageRequests.find((url) => url.pathname.endsWith("/messages/sent"));
    expect(retainedRequest?.searchParams.get("format")).toBe("full");
    expect(bulkRequest?.searchParams.get("format")).toBe("full");
    expect(sentRequest?.searchParams.get("format")).toBe("metadata");
    expect(sentRequest?.searchParams.getAll("metadataHeaders")).toEqual([
      "From",
      "To",
      "Cc",
      "Message-ID",
      "Subject",
      "Date",
    ]);
  });

  it("returns the history id snapshotted before incremental message processing", async () => {
    const connector = createGmailConnector();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      const path = url.pathname;

      if (path === "/gmail/v1/users/me/profile") {
        return jsonResponse({ historyId: "history-before-run" });
      }

      if (path === "/gmail/v1/users/me/history") {
        expect(url.searchParams.get("startHistoryId")).toBe("history-old");
        return jsonResponse({ history: [{ messagesAdded: [{ message: { id: "retained" } }] }] });
      }

      if (path.endsWith("/messages/retained")) {
        return jsonResponse(gmailMessage("retained"));
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const credentials = validCredentials();
    const items: EmailSyncedItem[] = [];
    for await (const item of connector.sync({
      connectorConfigId: "connector-gmail",
      credentials,
      scopeConfig: {},
      cursor: JSON.stringify({
        historyId: "history-old",
        reciprocityEmails: ["jane@example.com"],
      }),
      logger,
      ownerEmail: "owner@canvasx.ai",
    })) {
      items.push(item as EmailSyncedItem);
    }

    const nextCursor = JSON.parse(
      (await connector.getCursor({ credentials, scopeConfig: {}, currentCursor: null, logger })) ?? "{}",
    );

    expect(fetchSpy).toHaveBeenCalled();
    expect(items).toHaveLength(1);
    expect(nextCursor).toMatchObject({ mode: "history", historyId: "history-before-run" });
  });

  it("skips failed message fetches while retaining successfully fetched messages", async () => {
    const connector = createGmailConnector();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      const path = url.pathname;

      if (path === "/gmail/v1/users/me/profile") {
        return jsonResponse({ historyId: "history-after-run" });
      }

      if (path === "/gmail/v1/users/me/history") {
        return jsonResponse({
          history: [
            {
              messagesAdded: [{ message: { id: "broken" } }, { message: { id: "retained" } }],
            },
          ],
        });
      }

      if (path.endsWith("/messages/broken")) {
        return new Response("bad message", { status: 400 });
      }

      if (path.endsWith("/messages/retained")) {
        return jsonResponse(gmailMessage("retained"));
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const credentials = validCredentials();
    const items: EmailSyncedItem[] = [];
    for await (const item of connector.sync({
      connectorConfigId: "connector-gmail",
      credentials,
      scopeConfig: {},
      cursor: JSON.stringify({
        historyId: "history-old",
        reciprocityEmails: ["jane@example.com"],
      }),
      logger,
      ownerEmail: "owner@canvasx.ai",
    })) {
      items.push(item as EmailSyncedItem);
    }

    expect(items).toHaveLength(1);
    expect(items[0].providerFileId).toBe("retained");
  });

  it("stores a list continuation cursor when the initial window hits the per-run cap", async () => {
    const connector = createGmailConnector();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      const path = url.pathname;
      const q = url.searchParams.get("q");

      if (path === "/gmail/v1/users/me/profile") {
        return jsonResponse({ historyId: "history-start" });
      }

      if (path === "/gmail/v1/users/me/messages" && q?.startsWith("newer_than")) {
        return jsonResponse({
          messages: [{ id: "sent-page" }],
          nextPageToken: "page-2",
        });
      }

      if (path === "/gmail/v1/users/me/messages" && q?.startsWith("in:sent")) {
        return jsonResponse({ messages: [] });
      }

      if (path.endsWith("/messages/sent-page")) {
        return jsonResponse(
          gmailMessage("sent-page", {
            from: "Owner <owner@canvasx.ai>",
            to: "Jane Doe <jane@example.com>",
            labels: ["SENT"],
          }),
        );
      }

      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const credentials = validCredentials();
    const items: EmailSyncedItem[] = [];
    for await (const item of connector.sync({
      connectorConfigId: "connector-gmail",
      credentials,
      scopeConfig: { maxMessages: 1, maxReciprocitySent: 1 },
      cursor: null,
      logger,
      ownerEmail: "owner@canvasx.ai",
    })) {
      items.push(item as EmailSyncedItem);
    }

    const nextCursor = JSON.parse(
      (await connector.getCursor({ credentials, scopeConfig: {}, currentCursor: null, logger })) ?? "{}",
    );

    expect(items).toHaveLength(1);
    expect(nextCursor).toMatchObject({
      mode: "list",
      historyId: "history-start",
      pageToken: "page-2",
    });
    expect(nextCursor.reciprocityEmails).toContain("jane@example.com");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function validCredentials(): OAuthCredentials {
  return {
    type: "oauth",
    access_token: "token",
    refresh_token: "refresh",
    client_id: "client",
    client_secret: "secret",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}
