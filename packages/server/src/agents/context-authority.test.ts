import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentOutputItemInput } from "../db/repositories/agent-outputs";
import type { DB } from "../db/schema";
import type { IntegrationConnection, IntegrationProvider } from "../integrations/types";
import { createTestDb } from "../test-utils";
import {
  type ContextAuthorityApp,
  type ContextAuthoritySnapshot,
  buildContextAuthoritySnapshot,
  readContextAuthoritySnapshot,
  reconcileItemsWithContextAuthority,
} from "./context-authority";

const NOW = new Date("2026-07-17T09:30:00.000Z");

function outputItem(overrides: Partial<AgentOutputItemInput> = {}): AgentOutputItemInput {
  return {
    sectionKey: "todos",
    title: "Connect application",
    summary: "The application is not connected.",
    priority: "medium",
    label: "todo",
    actionPrompt: null,
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
    ...overrides,
  };
}

function connectedApp(
  key: string,
  source: ContextAuthorityApp["source"],
  names: string[],
  aliases: string[],
): ContextAuthorityApp {
  return {
    key,
    source,
    names,
    aliases,
    updatedAt: NOW.toISOString(),
  };
}

function snapshot(
  apps: ContextAuthorityApp[],
  overrides: Partial<Pick<ContextAuthoritySnapshot, "connectors" | "integrations">> = {},
): ContextAuthoritySnapshot {
  return {
    capturedAt: NOW.toISOString(),
    connectors: {
      status: "available",
      apps: apps.filter((app) => app.source === "connector"),
    },
    integrations: {
      status: "available",
      apps: apps.filter((app) => app.source === "integration"),
    },
    connectedApps: apps,
    ...overrides,
  };
}

function providerConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: "connection-1",
    providerId: "provider-1",
    appId: "microsoft-outlook",
    appName: "Microsoft Outlook",
    app: { name: "Microsoft Outlook", nameSlug: "microsoft-outlook" },
    status: "active",
    healthy: true,
    canUse: true,
    createdAt: "2026-07-16T10:00:00.000Z",
    ...overrides,
  };
}

describe("context authority snapshot", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insertInto("users")
      .values([
        { id: "user-1", name: "Agent User", email: "agent@example.com" },
        { id: "user-2", name: "Other User", email: "other@example.com" },
      ])
      .execute();
  });

  afterEach(async () => {
    await db.destroy().catch(() => undefined);
  });

  async function seedConnector(id: string, connectorType: string, syncStatus: string, createdBy = "user-1") {
    await db
      .insertInto("connector_configs")
      .values({
        id,
        connector_type: connectorType,
        auth_type: "oauth",
        credentials: `credential-${id}`,
        sync_status: syncStatus,
        created_by: createdBy,
        last_synced_at: "2026-07-17T08:00:00.000Z",
        updated_at: "2026-07-17T08:30:00.000Z",
      })
      .execute();
  }

  it("reads only active or syncing connectors owned by the run user without credentials", async () => {
    await seedConnector("calendar-active", "google_calendar", "active");
    await seedConnector("drive-syncing", "google_drive", "syncing");
    await seedConnector("linear-error", "linear", "error");
    await seedConnector("other-gmail", "gmail", "active", "user-2");

    const authority = await buildContextAuthoritySnapshot({
      db,
      userId: "user-1",
      userEmail: "agent@example.com",
      userName: "Agent User",
      now: NOW,
      getIntegrationStatus: async () => ({ kind: "absent" }),
    });

    expect(authority.connectors.status).toBe("available");
    expect(authority.integrations.status).toBe("absent");
    expect(authority.connectedApps.map((app) => app.key)).toEqual([
      "connector:google_calendar",
      "connector:google_drive",
    ]);
    expect(authority.connectedApps[0]?.aliases).toEqual(
      expect.arrayContaining(["google calendar", "googlecalendar", "calendar"]),
    );
    expect(JSON.stringify(authority)).not.toContain("credential-");
  });

  it("includes only active, healthy and permitted provider connections", async () => {
    const provider = {
      listConnections: async () => [
        providerConnection(),
        providerConnection({ id: "expired", appId: "github", appName: "GitHub", status: "expired" }),
        providerConnection({ id: "unhealthy", appId: "notion", appName: "Notion", healthy: false }),
        providerConnection({ id: "forbidden", appId: "salesforce", appName: "Salesforce", canUse: false }),
      ],
    } as Pick<IntegrationProvider, "listConnections"> as IntegrationProvider;

    const authority = await buildContextAuthoritySnapshot({
      db,
      userId: "user-1",
      userEmail: "agent@example.com",
      userName: "Agent User",
      now: NOW,
      getIntegrationStatus: async () => ({ kind: "ok", provider }),
    });

    expect(authority.integrations.status).toBe("available");
    expect(authority.connectedApps.map((app) => app.key)).toEqual(["integration:microsoft-outlook"]);
    expect(authority.connectedApps[0]?.aliases).toEqual(
      expect.arrayContaining(["microsoft outlook", "microsoftoutlook", "outlook"]),
    );
  });

  it("does not treat a provider auth mechanism as an application alias", async () => {
    const provider = {
      listConnections: async () => [
        providerConnection({
          appId: "google-calendar-oauth",
          appName: "Google Calendar",
          app: { name: "Google Calendar", nameSlug: "google-calendar-oauth" },
        }),
      ],
    } as Pick<IntegrationProvider, "listConnections"> as IntegrationProvider;

    const authority = await buildContextAuthoritySnapshot({
      db,
      userId: "user-1",
      userEmail: "agent@example.com",
      userName: "Agent User",
      now: NOW,
      getIntegrationStatus: async () => ({ kind: "ok", provider }),
    });
    const item = outputItem({
      title: "OAuth is not connected",
      summary: "Reconnect OAuth before continuing.",
    });

    expect(authority.connectedApps[0]?.aliases).not.toContain("oauth");
    expect(reconcileItemsWithContextAuthority([item], authority)).toEqual({
      items: [item],
      suppressedCount: 0,
    });
  });

  it("preserves independent unavailable state and fails open when either read fails", async () => {
    await db.destroy();
    const provider = {
      listConnections: async () => [providerConnection()],
    } as Pick<IntegrationProvider, "listConnections"> as IntegrationProvider;

    const authority = await buildContextAuthoritySnapshot({
      db,
      userId: "user-1",
      userEmail: "agent@example.com",
      userName: "Agent User",
      now: NOW,
      getIntegrationStatus: async () => ({ kind: "ok", provider }),
    });
    const result = reconcileItemsWithContextAuthority(
      [outputItem({ title: "Reconnect Microsoft Outlook", summary: "Microsoft Outlook is not connected." })],
      authority,
    );

    expect(authority.connectors.status).toBe("unavailable");
    expect(authority.integrations.status).toBe("available");
    expect(result.suppressedCount).toBe(0);
    expect(result.items).toHaveLength(1);
  });

  it("marks provider construction and connection-list failures unavailable without throwing", async () => {
    await seedConnector("calendar-active", "google_calendar", "active");
    const rejectingProvider = {
      listConnections: async () => {
        throw new Error("connection list unavailable");
      },
    } as Pick<IntegrationProvider, "listConnections"> as IntegrationProvider;

    const loadFailure = await buildContextAuthoritySnapshot({
      db,
      userId: "user-1",
      userEmail: "agent@example.com",
      userName: "Agent User",
      now: NOW,
      getIntegrationStatus: async () => ({ kind: "load_failed", type: "canvas", reason: "bad credentials" }),
    });
    const listFailure = await buildContextAuthoritySnapshot({
      db,
      userId: "user-1",
      userEmail: "agent@example.com",
      userName: "Agent User",
      now: NOW,
      getIntegrationStatus: async () => {
        throw new Error("provider unavailable");
      },
    });
    const connectionListFailure = await buildContextAuthoritySnapshot({
      db,
      userId: "user-1",
      userEmail: "agent@example.com",
      userName: "Agent User",
      now: NOW,
      getIntegrationStatus: async () => ({ kind: "ok", provider: rejectingProvider }),
    });

    expect(loadFailure.integrations.status).toBe("unavailable");
    expect(listFailure.integrations.status).toBe("unavailable");
    expect(connectionListFailure.integrations.status).toBe("unavailable");
  });
});

describe("context authority reconciliation", () => {
  const googleCalendar = connectedApp(
    "connector:google_calendar",
    "connector",
    ["google_calendar"],
    ["google calendar", "googlecalendar", "calendar"],
  );
  const gmail = connectedApp("integration:gmail", "integration", ["gmail"], ["gmail"]);
  const connected = snapshot([googleCalendar, gmail]);

  it("suppresses a connection-only item when every concrete target is connected", () => {
    const result = reconcileItemsWithContextAuthority(
      [
        outputItem({
          title: "Reconnect Google Calendar and Gmail",
          summary: "Google Calendar and Gmail are not connected. Authenticate both before preparing the brief.",
        }),
      ],
      connected,
    );

    expect(result).toEqual({ items: [], suppressedCount: 1 });
  });

  it.each([
    ["Gmail is disconnected", "Reconnect Gmail before continuing."],
    ["Gmail authentication required", "Authenticate Gmail before continuing."],
    ["Gmail isn't connected", "Reconnect Gmail before continuing."],
    ["Gmail connection issue", "Reconnect to Gmail because authentication is required."],
    ["Gmail has a connection issue", "Gmail is not connected."],
    ["Authentication required: Google Calendar", "Reconnect Google Calendar before continuing."],
    ["Reconnect both Google Calendar and Gmail", "Google Calendar and Gmail are not connected."],
  ])("suppresses explicit disconnected or authentication-required wording: %s", (title, summary) => {
    const result = reconcileItemsWithContextAuthority([outputItem({ title, summary })], connected);

    expect(result).toEqual({ items: [], suppressedCount: 1 });
  });

  it.each([
    {
      name: "unknown target",
      title: "Reconnect Jira",
      summary: "Jira is not connected.",
    },
    {
      name: "mixed targets",
      title: "Reconnect Gmail and Jira",
      summary: "Gmail and Jira are not connected.",
    },
    {
      name: "generic target",
      title: "Reconnect both integrations",
      summary: "Both integrations require authentication.",
    },
    {
      name: "mixed concrete and generic targets",
      title: "Reconnect Gmail",
      summary: "Both integrations require authentication.",
    },
    {
      name: "mixed concrete and singular generic targets",
      title: "Reconnect Gmail and the integration",
      summary: "Gmail and the integration are not connected.",
    },
    {
      name: "token prefix collision",
      title: "Reconnect Mail",
      summary: "Mail is not connected.",
    },
    {
      name: "mixed substantive content",
      title: "Gmail is not connected and Acme renewal is at risk",
      summary: "Reconnect Gmail, and ask the account owner to review the renewal.",
    },
    {
      name: "corrective statement",
      title: "Connection status corrected",
      summary: "The previous summary was stale; Gmail is already connected and no longer needs authentication.",
    },
  ])("retains $name items", ({ title, summary }) => {
    const item = outputItem({ title, summary });
    const result = reconcileItemsWithContextAuthority([item], connected);

    expect(result).toEqual({ items: [item], suppressedCount: 0 });
  });

  it("suppresses from an available local authority when the provider is authoritatively absent", () => {
    const authority = snapshot([googleCalendar], {
      integrations: { status: "absent", apps: [] },
    });
    const result = reconcileItemsWithContextAuthority(
      [outputItem({ title: "Connect Google Calendar", summary: "Google Calendar is not connected." })],
      authority,
    );

    expect(result.suppressedCount).toBe(1);
  });

  it("rejects malformed runtime snapshots", () => {
    expect(readContextAuthoritySnapshot({ connectedApps: "gmail" })).toBeNull();
  });
});
