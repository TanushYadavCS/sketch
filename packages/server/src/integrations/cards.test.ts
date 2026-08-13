import { describe, expect, it, vi } from "vitest";
import {
  collectIntegrationCardsFromProgressEvents,
  extractCanvasIntegrationLookups,
  extractIntegrationLookupsFromProgressEvent,
  isConnectedAccountsInquiry,
  resolveIntegrationLookup,
} from "./cards";
import type { IntegrationProvider } from "./types";

describe("integration cards", () => {
  it("detects connected account enquiries", () => {
    expect(isConnectedAccountsInquiry("what accounts are connected?")).toBe(true);
    expect(isConnectedAccountsInquiry("show my connected integrations")).toBe(true);
    expect(isConnectedAccountsInquiry("which apps are connected?")).toBe(true);
    expect(isConnectedAccountsInquiry("What integrations have I connected?")).toBe(true);
    expect(isConnectedAccountsInquiry("connect github")).toBe(false);
    expect(isConnectedAccountsInquiry("what apps do you support?")).toBe(false);
    expect(isConnectedAccountsInquiry("How do I add integrations?")).toBe(false);
    expect(isConnectedAccountsInquiry("What integrations do you support?")).toBe(false);
    expect(isConnectedAccountsInquiry("Is my Aimfox account connected?")).toBe(false);
  });

  it("extracts app lookups from Canvas CLI commands", () => {
    expect(extractCanvasIntegrationLookups('$CANVAS_CLI search-apps --queries "slack,gmail" --output json')).toEqual({
      queries: ["slack", "gmail"],
      componentKeys: [],
      listConnected: false,
    });
    expect(extractCanvasIntegrationLookups("$CANVAS_CLI search-apps --queries=slack --output json")).toEqual({
      queries: ["slack"],
      componentKeys: [],
      listConnected: false,
    });
    expect(extractCanvasIntegrationLookups("$CANVAS_CLI search-apps --output json")).toEqual({
      queries: [],
      componentKeys: [],
      listConnected: true,
    });
    expect(
      extractCanvasIntegrationLookups(
        "$CANVAS_CLI direct-execute-action --component-key github-create-issue --configured-props '{}' --output json",
      ),
    ).toEqual({
      queries: [],
      componentKeys: ["github-create-issue"],
      listConnected: false,
    });
    expect(
      extractCanvasIntegrationLookups(
        "$CANVAS_CLI direct-execute-action --component-key=google-calendar-oauth-create-event --output json",
      ),
    ).toEqual({
      queries: [],
      componentKeys: ["google-calendar-oauth-create-event"],
      listConnected: false,
    });
    expect(
      extractCanvasIntegrationLookups(
        "$CANVAS_CLI direct-execute-action --component-key microsoft-teams-send-message --output json",
      ),
    ).toEqual({
      queries: [],
      componentKeys: ["microsoft-teams-send-message"],
      listConnected: false,
    });
    expect(
      extractCanvasIntegrationLookups(
        "$CANVAS_CLI direct-execute-action --component-key=google-sheets-oauth-query-formula --output json",
      ),
    ).toEqual({
      queries: [],
      componentKeys: ["google-sheets-oauth-query-formula"],
      listConnected: false,
    });
    expect(
      extractCanvasIntegrationLookups(
        'sh -c \'"$CANVAS_CLI" search-components --raw \'{"queries":[{"app":"linear","query":"create issue"}]}\' --output json\'',
      ),
    ).toEqual({
      queries: ["linear"],
      componentKeys: [],
      listConnected: false,
    });
    expect(
      extractCanvasIntegrationLookups("$CANVAS_CLI get-component-definition --key github-create-issue --output json"),
    ).toEqual({
      queries: [],
      componentKeys: ["github-create-issue"],
      listConnected: false,
    });
  });

  it("extracts app lookups from Canvas MCP tool events", () => {
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__search_apps",
        input: { queries: ["slack", "gmail"] },
      }),
    ).toEqual({ queries: ["slack", "gmail"], componentKeys: [], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "searchApps",
        input: { queries: "notion" },
      }),
    ).toEqual({ queries: ["notion"], componentKeys: [], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__search_apps",
        input: {},
      }),
    ).toEqual({ queries: [], componentKeys: [], listConnected: true });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__direct_execute_action",
        input: { componentKey: "github-create-issue" },
      }),
    ).toEqual({ queries: [], componentKeys: ["github-create-issue"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__direct_execute_action",
        input: { componentKey: "google-calendar-oauth-create-event" },
      }),
    ).toEqual({ queries: [], componentKeys: ["google-calendar-oauth-create-event"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__direct_execute_action",
        input: { componentKey: "google-sheets-oauth-query-formula" },
      }),
    ).toEqual({ queries: [], componentKeys: ["google-sheets-oauth-query-formula"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__search_components",
        input: { queries: [{ app: "linear", query: "create issue" }] },
      }),
    ).toEqual({ queries: ["linear"], componentKeys: [], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__get_component_definition",
        input: { key: "slack-send-message" },
      }),
    ).toEqual({ queries: [], componentKeys: ["slack-send-message"], listConnected: false });
  });

  it("extracts app lookups from missing-connection tool results only", () => {
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_result",
        toolName: "mcp__plugin_pipedream__slack_send_message",
        input: { app: "slack" },
        output: { code: "CONNECTION_NOT_CONNECTED", message: "Slack is not connected" },
      }),
    ).toEqual({ queries: ["slack"], componentKeys: ["slack-send-message"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_result",
        toolName: "mcp__plugin_pipedream__github_create_issue",
        input: {},
        output: [{ type: "text", text: "CONNECTION_NOT_CONNECTED" }],
      }),
    ).toEqual({ queries: [], componentKeys: ["github-create-issue"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_result",
        toolName: "mcp__plugin_pipedream__slack_send_message",
        input: { app: "slack" },
        output: "Rate limit exceeded",
      }),
    ).toEqual({ queries: [], componentKeys: [], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_result",
        toolName: "mcp__plugin_pipedream__github_create_issue",
        input: {},
        output: { filler: "x".repeat(100_000), connectionStatus: "not_connected" },
      }),
    ).toEqual({ queries: [], componentKeys: ["github-create-issue"], listConnected: false });
  });

  it("resolves exactly matched apps to connect or connected cards from provider state", async () => {
    const provider = {
      listApps: async () => ({
        apps: [{ id: "github", name: "GitHub", description: "Code hosting", icon: "https://cdn.example/github.png" }],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps"> as IntegrationProvider;

    const missing = await resolveIntegrationLookup(provider, [], { query: "github" });
    expect(missing.cards).toMatchObject([{ appId: "github", appName: "GitHub", state: "connect" }]);

    const connected = await resolveIntegrationLookup(
      provider,
      [
        {
          id: "conn-1",
          providerId: "provider-1",
          appId: "github",
          appName: "GitHub",
          healthy: true,
          status: "active",
          accountName: "Alice GitHub",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      { query: "GitHub" },
    );
    expect(connected.cards).toMatchObject([
      { appId: "github", appName: "GitHub", state: "connected", accountName: "Alice GitHub" },
    ]);
  });

  it("collects missing app cards from observed Canvas CLI progress", async () => {
    const cards: unknown[] = [];
    const initiateConnection = vi.fn().mockResolvedValue({
      redirectUrl: "https://canvas.example.com/connect/secrets?token=abc",
    });
    const provider = {
      listConnections: async () => [],
      listApps: async () => ({
        apps: [{ id: "slack", name: "Slack", description: "Team chat", icon: "https://cdn.example/slack.png" }],
        pageInfo: { endCursor: null, hasMore: false },
      }),
      initiateConnection,
    } as Pick<IntegrationProvider, "listApps" | "listConnections" | "initiateConnection"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "Bash",
          input: {
            command:
              '$CANVAS_CLI direct-execute-action --component-key slack-send-message --configured-props \'{"text":"hi"}\' --output json',
          },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(initiateConnection).not.toHaveBeenCalled();
    expect(cards).toMatchObject([
      {
        appId: "slack",
        appName: "Slack",
        state: "connect",
      },
    ]);
  });

  it("collects missing cards for hyphenated Canvas app slugs", async () => {
    const cards: unknown[] = [];
    const queries: Array<string | undefined> = [];
    const provider = {
      listConnections: async () => [],
      listApps: async (query?: string) => {
        queries.push(query);
        if (query === "google-calendar-oauth") {
          return {
            apps: [
              {
                id: "google-calendar-oauth",
                name: "Google Calendar",
                description: "Calendar",
                icon: "https://cdn.example/google-calendar.png",
              },
            ],
            pageInfo: { endCursor: null, hasMore: false },
          };
        }
        if (query === "google") {
          return {
            apps: [
              { id: "google-drive", name: "Google Drive", description: "Files" },
              { id: "google-calendar-oauth", name: "Google Calendar", description: "Calendar" },
            ],
            pageInfo: { endCursor: null, hasMore: false },
          };
        }
        return { apps: [], pageInfo: { endCursor: null, hasMore: false } };
      },
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "Bash",
          input: {
            command:
              "$CANVAS_CLI direct-execute-action --component-key=google-calendar-oauth-create-event --output json",
          },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(queries).toEqual(["google-calendar-oauth-create", undefined, "google-calendar-oauth"]);
    expect(cards).toMatchObject([{ appId: "google-calendar-oauth", appName: "Google Calendar", state: "connect" }]);
  });

  it("does not collect a card when the canonical component app has a healthy connection", async () => {
    const cards: unknown[] = [];
    const listApps = vi.fn(async (_query?: string) => ({
      apps: [],
      pageInfo: { endCursor: null, hasMore: false },
    }));
    const provider = {
      listConnections: async () => [
        {
          id: "conn-sheets",
          providerId: "provider-1",
          appId: "google-sheets-oauth",
          appName: "Google Sheets",
          healthy: true,
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      listApps,
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(listApps.mock.calls.map(([query]) => query)).toEqual(["google-sheets-oauth-query", undefined]);
    expect(cards).toEqual([]);
  });

  it("collects a canonical app card when a healthy same-name connection has a different slug", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [
        {
          id: "conn-sheets",
          providerId: "provider-1",
          appId: "google-sheets",
          appName: "Google Sheets",
          app: { name: "Google Sheets", nameSlug: "google-sheets" },
          healthy: true,
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      listApps: async (query?: string) => ({
        apps:
          query === "google-sheets-oauth"
            ? [{ id: "google-sheets-oauth", name: "Google Sheets", description: "Spreadsheets" }]
            : [],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([{ appId: "google-sheets-oauth", appName: "Google Sheets", state: "connect" }]);
  });

  it("does not match separatorless or punctuation connection slugs to a canonical component app", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [
        {
          id: "conn-compact",
          providerId: "provider-1",
          appId: "googlesheetsoauth",
          appName: "Google Sheets Compact",
          healthy: true,
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "conn-punctuation",
          providerId: "provider-1",
          appId: "google_sheets_oauth",
          appName: "Google Sheets Punctuation",
          app: { name: "Google Sheets Punctuation", nameSlug: "google.sheets.oauth" },
          healthy: true,
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      listApps: async (query?: string) => ({
        apps:
          query === "google-sheets-oauth"
            ? [{ id: "google-sheets-oauth", name: "Google Sheets", description: "Spreadsheets" }]
            : [],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([{ appId: "google-sheets-oauth", appName: "Google Sheets", state: "connect" }]);
  });

  it("collects a reconnect card for an unhealthy exact canonical connection", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [
        {
          id: "conn-sheets",
          providerId: "provider-1",
          appId: "google-sheets-oauth",
          appName: "Google Sheets",
          healthy: false,
          status: "error",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      listApps: async () => ({
        apps: [],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([{ appId: "google-sheets-oauth", appName: "Google Sheets", state: "connect" }]);
  });

  it("collects a card for an unconnected canonical component app", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [],
      listApps: async (query?: string) => ({
        apps:
          query === "google-sheets-oauth"
            ? [{ id: "google-sheets-oauth", name: "Google Sheets", description: "Spreadsheets" }]
            : [],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([{ appId: "google-sheets-oauth", appName: "Google Sheets", state: "connect" }]);
  });

  it("collects the longest canonical app even when a shorter prefix is connected", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [
        {
          id: "conn-google",
          providerId: "provider-1",
          appId: "google",
          appName: "Google",
          healthy: true,
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      listApps: async (query?: string) => ({
        apps:
          query === "google-sheets-oauth"
            ? [{ id: "google-sheets-oauth", name: "Google Sheets", description: "Spreadsheets" }]
            : [],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([{ appId: "google-sheets-oauth", appName: "Google Sheets", state: "connect" }]);
  });

  it("does not collect a fuzzy single app without an exact canonical candidate ID", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [],
      listApps: async () => ({
        apps: [{ id: "google-drive", name: "Google Drive", description: "Files" }],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toEqual([]);
  });

  it("does not collect compact or punctuation app IDs for an exact canonical component candidate", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [],
      listApps: async (query?: string) => ({
        apps:
          query === undefined
            ? []
            : [
                { id: "googlesheetsoauth", name: "Google Sheets Compact", description: "Spreadsheets" },
                { id: "google_sheets_oauth", name: "Google Sheets Underscore", description: "Spreadsheets" },
                { id: "google.sheets.oauth", name: "Google Sheets Dotted", description: "Spreadsheets" },
              ],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toEqual([]);
  });

  it("keeps explicit fuzzy-query and canonical component cards distinct across slug boundaries", async () => {
    const cards: Array<{ appId: string }> = [];
    const provider = {
      listConnections: async () => [],
      listApps: async (query?: string) => ({
        apps:
          query === "googlesheetsoauth"
            ? [{ id: "googlesheetsoauth", name: "Google Sheets Compact", description: "Spreadsheets" }]
            : query === "google-sheets-oauth"
              ? [{ id: "google-sheets-oauth", name: "Google Sheets", description: "Spreadsheets" }]
              : [],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__search_apps",
          input: { queries: ["googlesheetsoauth"] },
        },
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards.map((card) => card.appId)).toEqual(["googlesheetsoauth", "google-sheets-oauth"]);
  });

  it.each([
    "google--sheets-oauth-query-formula",
    "-google-sheets-oauth-query-formula",
    "google-sheets-oauth-query-formula-",
  ])("does not collect a card for malformed component key %s", async (componentKey) => {
    const cards: unknown[] = [];
    const listApps = vi.fn(async () => ({
      apps: [{ id: "google-sheets-oauth", name: "Google Sheets", description: "Spreadsheets" }],
      pageInfo: { endCursor: null, hasMore: false },
    }));
    const provider = {
      listConnections: async () => [],
      listApps,
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(listApps).not.toHaveBeenCalled();
    expect(cards).toEqual([]);
  });

  it("resolves a canonical app before an unknown action segment", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [],
      listApps: async (query?: string) => ({
        apps:
          query === "google-sheets-oauth"
            ? [{ id: "google-sheets-oauth", name: "Google Sheets", description: "Spreadsheets" }]
            : [],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-frobnicate-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([{ appId: "google-sheets-oauth", appName: "Google Sheets", state: "connect" }]);
  });

  it("falls back to a cached unfiltered catalog while preserving longest-prefix resolution", async () => {
    const cards: unknown[] = [];
    const listApps = vi.fn(async (query?: string) => ({
      apps:
        query === undefined
          ? [
              { id: "google", name: "Google", description: "Google" },
              { id: "google-sheets-oauth", name: "Google Sheets", description: "Spreadsheets" },
            ]
          : [],
      pageInfo: { endCursor: null, hasMore: false },
    }));
    const provider = {
      listConnections: async () => [],
      listApps,
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-append-values" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(listApps.mock.calls.filter(([query]) => query === undefined)).toHaveLength(1);
    expect(listApps.mock.calls.map(([query]) => query)).not.toContain("google");
    expect(cards).toMatchObject([{ appId: "google-sheets-oauth", appName: "Google Sheets", state: "connect" }]);
  });

  it("caches shared component-key candidates for the collection run", async () => {
    const cards: unknown[] = [];
    const listApps = vi.fn(async (query?: string) => ({
      apps:
        query === "google-sheets-oauth"
          ? [{ id: "google-sheets-oauth", name: "Google Sheets", description: "Spreadsheets" }]
          : [],
      pageInfo: { endCursor: null, hasMore: false },
    }));
    const provider = {
      listConnections: async () => [],
      listApps,
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-frobnicate-formula" },
        },
        {
          kind: "tool_use",
          toolName: "mcp__canvas__direct_execute_action",
          input: { componentKey: "google-sheets-oauth-query-formula" },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(listApps.mock.calls.map(([query]) => query)).toEqual([
      "google-sheets-oauth-query",
      undefined,
      "google-sheets-oauth",
      "google-sheets-oauth-frobnicate",
    ]);
    expect(cards).toMatchObject([{ appId: "google-sheets-oauth", appName: "Google Sheets", state: "connect" }]);
  });

  it("collects missing app cards from observed Canvas MCP search_apps progress", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [],
      listApps: async () => ({
        apps: [{ id: "slack", name: "Slack", description: "Team chat", icon: "https://cdn.example/slack.png" }],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__search_apps",
          input: { queries: ["slack"] },
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([{ appId: "slack", appName: "Slack", state: "connect" }]);
  });

  it("collects missing app cards from connection failure tool results", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [],
      listApps: async () => ({
        apps: [{ id: "slack", name: "Slack", description: "Team chat", icon: "https://cdn.example/slack.png" }],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_result",
          toolName: "mcp__plugin_pipedream__action",
          input: { appSlug: "slack" },
          output: JSON.stringify({ error: { code: "CONNECTION_NOT_CONNECTED" } }),
        },
      ],
      loadIntegrationProvider: async () => provider,
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([{ appId: "slack", appName: "Slack", state: "connect" }]);
  });

  it("collects a missing Linear card from a managed integration lookup", async () => {
    const cards: unknown[] = [];
    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__search_apps",
          input: { queries: ["linear"] },
        },
      ],
      cliIntegrations: {
        listCatalog: () => [
          {
            id: "linear",
            name: "Linear",
            description: "Use Linear through Sketch.",
            icon: "https://linear.app/favicon.svg",
            executionMode: "api",
            connected: false,
            connectionId: null,
          },
        ],
        listConnections: async () => [],
      },
      currentUserId: "alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([
      {
        appId: "linear",
        appName: "Linear",
        state: "connect",
        executionMode: "api",
        connectUrl: "/integrations?connect=linear",
      },
    ]);
  });

  it("collects connected account cards from observed Canvas MCP search_apps without queries", async () => {
    const cards: unknown[] = [];
    const provider = {
      listConnections: async () => [
        {
          id: "conn-1",
          providerId: "provider-1",
          appId: "github",
          appName: "GitHub",
          healthy: true,
          status: "active",
          accountName: "Alice GitHub",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      listApps: async () => {
        throw new Error("should not list apps");
      },
    } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;

    await collectIntegrationCardsFromProgressEvents({
      events: [
        {
          kind: "tool_use",
          toolName: "mcp__canvas__search_apps",
          input: {},
        },
      ],
      loadIntegrationProvider: async () => provider,
      cliIntegrations: {
        listCatalog: () => [
          {
            id: "github",
            name: "GitHub",
            description: "Use GitHub through Sketch.",
            icon: "https://github.com/favicon.svg",
            executionMode: "cli",
            connected: true,
            connectionId: "cli-1",
          },
        ],
        listConnections: async () => [
          {
            id: "cli-1",
            appId: "github",
            appName: "GitHub",
            executionMode: "cli",
            ownerUserId: "alice",
            accountExternalId: "1",
            accountLogin: "alice",
            status: "active",
            verifiedAt: "2026-01-01T00:00:00Z",
            lastVerificationError: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            shares: [],
            canUse: true,
          },
        ],
      },
      currentUserId: "alice",
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([{ appId: "github", appName: "GitHub", state: "connected", executionMode: "cli" }]);
  });
});
