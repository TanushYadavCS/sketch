import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createTestDb, createTestLogger } from "../test-utils";
import { createSeedGate, emailToSyncedItem } from "./email";
import { type OutlookMessage, createOutlookConnector, toNormalizedOutlookEmail } from "./outlook";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import type { OAuthCredentials } from "./types";

const logger = createTestLogger();

function outlookMessage(
  id: string,
  overrides: {
    internetMessageId?: string | null;
    conversationId?: string | null;
    from?: { name?: string; address?: string };
    to?: Array<{ name?: string; address?: string }>;
    subject?: string;
    body?: string;
    bodyType?: string;
    headers?: Array<{ name: string; value: string }>;
    sentDateTime?: string | null;
    receivedDateTime?: string | null;
  } = {},
): OutlookMessage {
  const body = overrides.body ?? "Can we discuss pricing?";
  return {
    id,
    internetMessageId: overrides.internetMessageId === undefined ? `<${id}@example.com>` : overrides.internetMessageId,
    conversationId: overrides.conversationId ?? "conversation-1",
    subject: overrides.subject ?? "Pricing discussion",
    sentDateTime: overrides.sentDateTime ?? "2026-02-04T10:00:00Z",
    receivedDateTime: overrides.receivedDateTime ?? "2026-02-04T10:00:02Z",
    webLink: `https://outlook.office.com/mail/id/${id}`,
    from: { emailAddress: overrides.from ?? { name: "Jane Doe", address: "jane@example.com" } },
    toRecipients: (overrides.to ?? [{ name: "Owner", address: "owner@canvasx.ai" }]).map((emailAddress) => ({
      emailAddress,
    })),
    ccRecipients: [],
    bccRecipients: [],
    body: { contentType: overrides.bodyType ?? "text", content: body },
    bodyPreview: body,
    internetMessageHeaders: overrides.headers ?? [{ name: "Message-ID", value: `<${id}@example.com>` }],
  };
}

describe("Outlook connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes Microsoft Graph messages using internetMessageId and lowercased headers", () => {
    const normalized = toNormalizedOutlookEmail(
      outlookMessage("outlook-1", {
        internetMessageId: "<stable@example.com>",
        conversationId: "conversation-42",
        body: "<p>Hello</p>",
        bodyType: "html",
        headers: [
          { name: "Message-ID", value: "<stable@example.com>" },
          { name: "List-Unsubscribe", value: "<mailto:unsubscribe@example.com>" },
        ],
      }),
      "OWNER@CANVASX.AI",
      "inbox",
    );

    expect(normalized).toMatchObject({
      providerFileId: "outlook-1",
      providerMessageId: "<stable@example.com>",
      threadId: "conversation-42",
      folder: "inbox",
      bodyHtml: "<p>Hello</p>",
      bodyText: "<p>Hello</p>",
      ownerEmail: "owner@canvasx.ai",
    });
    expect(normalized?.headers.get("list-unsubscribe")).toBe("<mailto:unsubscribe@example.com>");
    expect(normalized?.from).toEqual({ name: "Jane Doe", email: "jane@example.com" });

    const withoutHeaders = toNormalizedOutlookEmail(
      { ...outlookMessage("outlook-2"), internetMessageHeaders: undefined },
      "owner@canvasx.ai",
      "sent",
    );
    expect(withoutHeaders?.headers.size).toBe(0);
  });

  it("skips messages missing internetMessageId and records a diagnostic marker", async () => {
    const connector = createOutlookConnector();
    const suppressed: Array<{
      providerFileId: string;
      providerMessageId?: string | null;
      threadId?: string | null;
      reason: string;
    }> = [];
    mockGraphFetch((url) => {
      if (url.pathname === "/v1.0/me/mailFolders/inbox/messages") {
        return jsonResponse({ value: [outlookMessage("missing-id", { internetMessageId: null })] });
      }
      if (url.pathname === "/v1.0/me/mailFolders/sentitems/messages") {
        return jsonResponse({ value: [] });
      }
      if (url.pathname === "/v1.0/me/mailFolders/inbox/messages/delta") {
        return jsonResponse({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/inbox-delta" });
      }
      if (url.pathname === "/v1.0/me/mailFolders/sentitems/messages/delta") {
        return jsonResponse({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/sent-delta" });
      }
      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    const items = await drain(
      connector.sync({
        connectorConfigId: "connector-outlook",
        credentials: validCredentials(),
        scopeConfig: { initialDays: 90, maxMessages: 10 },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
        onEmailSuppressed: async (record) => {
          suppressed.push(record);
        },
      }),
    );

    expect(items).toHaveLength(0);
    expect(suppressed).toEqual([
      {
        providerFileId: "missing-id",
        providerMessageId: null,
        threadId: "conversation-1",
        reason: "missing_internet_message_id",
      },
    ]);
  });

  it("keeps per-folder delta cursors independent", async () => {
    const connector = createOutlookConnector();
    mockGraphFetch((url) => {
      if (url.pathname === "/v1.0/me/mailFolders/inbox/messages") {
        return jsonResponse({ value: [outlookMessage("inbox-1")] });
      }
      if (url.pathname === "/v1.0/me/mailFolders/sentitems/messages") {
        return jsonResponse({
          value: [
            outlookMessage("sent-1", {
              from: { name: "Owner", address: "owner@canvasx.ai" },
              to: [{ name: "Jane Doe", address: "jane@example.com" }],
            }),
          ],
        });
      }
      if (url.pathname === "/v1.0/me/mailFolders/inbox/messages/delta") {
        return jsonResponse({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/inbox-delta-1" });
      }
      if (url.pathname === "/v1.0/me/mailFolders/sentitems/messages/delta") {
        return jsonResponse({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/sent-delta-1" });
      }
      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    await drain(
      connector.sync({
        connectorConfigId: "connector-outlook",
        credentials: validCredentials(),
        scopeConfig: { initialDays: 90, maxMessages: 10 },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );

    const cursor = JSON.parse(
      (await connector.getCursor({
        credentials: validCredentials(),
        scopeConfig: {},
        currentCursor: null,
        logger,
      })) ?? "{}",
    ) as { inboxDeltaLink?: string; sentDeltaLink?: string };

    expect(cursor.inboxDeltaLink).toBe("https://graph.microsoft.com/inbox-delta-1");
    expect(cursor.sentDeltaLink).toBe("https://graph.microsoft.com/sent-delta-1");
  });

  it("falls back from a stale 410 cursor for only the affected folder", async () => {
    const connector = createOutlookConnector();
    const requests: URL[] = [];
    mockGraphFetch((url) => {
      requests.push(url);
      if (url.toString() === "https://graph.microsoft.com/inbox-delta-old") {
        return jsonResponse({ error: { code: "SyncStateNotFound" } }, 410);
      }
      if (url.toString() === "https://graph.microsoft.com/sent-delta-old") {
        return jsonResponse({
          value: [
            outlookMessage("sent-2", {
              from: { name: "Owner", address: "owner@canvasx.ai" },
              to: [{ name: "Jane Doe", address: "jane@example.com" }],
            }),
          ],
          "@odata.deltaLink": "https://graph.microsoft.com/sent-delta-new",
        });
      }
      if (url.pathname === "/v1.0/me/mailFolders/inbox/messages") {
        return jsonResponse({ value: [outlookMessage("inbox-after-410")] });
      }
      if (url.pathname === "/v1.0/me/mailFolders/inbox/messages/delta") {
        return jsonResponse({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/inbox-delta-new" });
      }
      throw new Error(`unexpected fetch ${url.toString()}`);
    });
    const cursor = JSON.stringify({
      inboxDeltaLink: "https://graph.microsoft.com/inbox-delta-old",
      sentDeltaLink: "https://graph.microsoft.com/sent-delta-old",
      lastSyncedAt: "2026-02-01T00:00:00.000Z",
      reciprocityEmails: ["jane@example.com"],
    });

    await drain(
      connector.sync({
        connectorConfigId: "connector-outlook",
        credentials: validCredentials(),
        scopeConfig: { maxMessages: 10 },
        cursor,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );

    const inboxFallback = requests.find((url) => url.pathname === "/v1.0/me/mailFolders/inbox/messages");
    expect(inboxFallback?.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-02-01T00:00:00.000Z");
    expect(requests.map((url) => url.toString())).toContain("https://graph.microsoft.com/sent-delta-old");

    const nextCursor = JSON.parse(
      (await connector.getCursor({
        credentials: validCredentials(),
        scopeConfig: {},
        currentCursor: cursor,
        logger,
      })) ?? "{}",
    ) as { inboxDeltaLink?: string; sentDeltaLink?: string };
    expect(nextCursor.inboxDeltaLink).toBe("https://graph.microsoft.com/inbox-delta-new");
    expect(nextCursor.sentDeltaLink).toBe("https://graph.microsoft.com/sent-delta-new");
  });

  it("emits removal records for Graph removals and sync-window shrink", async () => {
    const connector = createOutlookConnector();
    const removals: Array<{
      providerFileId?: string;
      providerMessageId?: string | null;
      sourceCreatedBefore?: string;
      reason: string;
    }> = [];
    mockGraphFetch((url) => {
      if (url.toString() === "https://graph.microsoft.com/inbox-delta-current") {
        return jsonResponse({
          value: [{ id: "removed-inbox", "@removed": { reason: "deleted" } }],
          "@odata.deltaLink": "https://graph.microsoft.com/inbox-delta-next",
        });
      }
      if (url.toString() === "https://graph.microsoft.com/sent-delta-current") {
        return jsonResponse({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/sent-delta-next" });
      }
      throw new Error(`unexpected fetch ${url.toString()}`);
    });
    const cursor = JSON.stringify({
      inboxDeltaLink: "https://graph.microsoft.com/inbox-delta-current",
      sentDeltaLink: "https://graph.microsoft.com/sent-delta-current",
      lastSyncedAt: "2026-02-01T00:00:00.000Z",
      syncWindowStart: "2025-01-01T00:00:00.000Z",
      reciprocityEmails: ["jane@example.com"],
    });

    await drain(
      connector.sync({
        connectorConfigId: "connector-outlook",
        credentials: validCredentials(),
        scopeConfig: { initialDays: 1, maxMessages: 10 },
        cursor,
        logger,
        ownerEmail: "owner@canvasx.ai",
        onSourceItemRemoved: async (record) => {
          removals.push(record);
        },
      }),
    );

    expect(removals).toHaveLength(2);
    expect(removals[0]).toMatchObject({ reason: "outlook_sync_window_shrunk" });
    expect(new Date(removals[0]?.sourceCreatedBefore ?? "").getTime()).toBeGreaterThan(
      new Date("2025-01-01T00:00:00.000Z").getTime(),
    );
    expect(removals[1]).toEqual({ providerFileId: "removed-inbox", reason: "outlook_inbox_removed" });
  });

  it("honors Retry-After for Microsoft Graph throttling", async () => {
    const connector = createOutlookConnector();
    let inboxAttempts = 0;
    mockGraphFetch((url) => {
      if (url.pathname === "/v1.0/me/mailFolders/inbox/messages") {
        inboxAttempts += 1;
        if (inboxAttempts === 1) {
          return new Response("throttled", { status: 429, headers: { "Retry-After": "0" } });
        }
        return jsonResponse({ value: [] });
      }
      if (url.pathname === "/v1.0/me/mailFolders/sentitems/messages") {
        return jsonResponse({ value: [] });
      }
      if (url.pathname === "/v1.0/me/mailFolders/inbox/messages/delta") {
        return jsonResponse({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/inbox-delta" });
      }
      if (url.pathname === "/v1.0/me/mailFolders/sentitems/messages/delta") {
        return jsonResponse({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/sent-delta" });
      }
      throw new Error(`unexpected fetch ${url.toString()}`);
    });

    await drain(
      connector.sync({
        connectorConfigId: "connector-outlook",
        credentials: validCredentials(),
        scopeConfig: { initialDays: 90, maxMessages: 10 },
        cursor: null,
        logger,
        ownerEmail: "owner@canvasx.ai",
      }),
    );

    expect(inboxAttempts).toBe(2);
  });

  it("dedups a folder move by internetMessageId instead of mutable Graph id", async () => {
    const db = await createTestDb();
    try {
      await db
        .insertInto("users")
        .values({ id: "owner", name: "Owner", email: "owner@canvasx.ai", email_verified_at: null })
        .execute();
      const repo = createConnectorRepository(db);
      await repo.createConfig({
        connectorType: "outlook",
        authType: "oauth",
        credentials: JSON.stringify(validCredentials()),
        scopeConfig: JSON.stringify({}),
        createdBy: "owner",
      });
      const config = await repo.findByTypeAndOwner("outlook", "owner");
      if (!config) throw new Error("missing connector config");

      const first = toNormalizedOutlookEmail(
        outlookMessage("graph-id-inbox", { internetMessageId: "<same-message@example.com>" }),
        "owner@canvasx.ai",
        "inbox",
      );
      const moved = toNormalizedOutlookEmail(
        outlookMessage("graph-id-custom-folder", { internetMessageId: "<same-message@example.com>" }),
        "owner@canvasx.ai",
        "inbox",
      );
      if (!first || !moved) throw new Error("normalization failed");

      const reciprocity = new Set(["jane@example.com"]);
      await processSyncedItem({
        db,
        repo,
        connectorConfigId: config.id,
        connectorType: "outlook",
        item: emailToSyncedItem(config.id, first, createSeedGate(first, reciprocity)),
        existingHashes: await loadExistingContentHashes(db, "outlook", config.id),
      });
      await processSyncedItem({
        db,
        repo,
        connectorConfigId: config.id,
        connectorType: "outlook",
        item: emailToSyncedItem(config.id, moved, createSeedGate(moved, reciprocity)),
        existingHashes: await loadExistingContentHashes(db, "outlook", config.id),
      });

      const rows = await db
        .selectFrom("indexed_files")
        .select(["provider_file_id", "provider_message_id"])
        .where("connector_config_id", "=", config.id)
        .execute();
      expect(rows).toEqual([
        { provider_file_id: "graph-id-custom-folder", provider_message_id: "<same-message@example.com>" },
      ]);
    } finally {
      await db.destroy();
    }
  });
});

function validCredentials(): OAuthCredentials {
  return {
    type: "oauth",
    access_token: "access",
    refresh_token: "refresh",
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    client_id: "client",
    client_secret: "secret",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockGraphFetch(handler: (url: URL) => Response): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return handler(url);
  });
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
