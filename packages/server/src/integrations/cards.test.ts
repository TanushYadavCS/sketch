import { describe, expect, it } from "vitest";
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
      listConnected: false,
    });
    expect(extractCanvasIntegrationLookups("$CANVAS_CLI search-apps --queries=slack --output json")).toEqual({
      queries: ["slack"],
      listConnected: false,
    });
    expect(extractCanvasIntegrationLookups("$CANVAS_CLI search-apps --output json")).toEqual({
      queries: [],
      listConnected: true,
    });
    expect(
      extractCanvasIntegrationLookups(
        "$CANVAS_CLI direct-execute-action --component-key github-create-issue --configured-props '{}' --output json",
      ),
    ).toEqual({
      queries: ["github"],
      listConnected: false,
    });
    expect(
      extractCanvasIntegrationLookups(
        "$CANVAS_CLI direct-execute-action --component-key=google-calendar-oauth-create-event --output json",
      ),
    ).toEqual({
      queries: ["google-calendar-oauth"],
      listConnected: false,
    });
    expect(
      extractCanvasIntegrationLookups(
        "$CANVAS_CLI direct-execute-action --component-key microsoft-teams-send-message --output json",
      ),
    ).toEqual({
      queries: ["microsoft-teams"],
      listConnected: false,
    });
    expect(
      extractCanvasIntegrationLookups(
        'sh -c \'"$CANVAS_CLI" search-components --raw \'{"queries":[{"app":"linear","query":"create issue"}]}\' --output json\'',
      ),
    ).toEqual({
      queries: ["linear"],
      listConnected: false,
    });
    expect(
      extractCanvasIntegrationLookups("$CANVAS_CLI get-component-definition --key github-create-issue --output json"),
    ).toEqual({
      queries: ["github"],
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
    ).toEqual({ queries: ["slack", "gmail"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "searchApps",
        input: { queries: "notion" },
      }),
    ).toEqual({ queries: ["notion"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__search_apps",
        input: {},
      }),
    ).toEqual({ queries: [], listConnected: true });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__direct_execute_action",
        input: { componentKey: "github-create-issue" },
      }),
    ).toEqual({ queries: ["github"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__direct_execute_action",
        input: { componentKey: "google-calendar-oauth-create-event" },
      }),
    ).toEqual({ queries: ["google-calendar-oauth"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__search_components",
        input: { queries: [{ app: "linear", query: "create issue" }] },
      }),
    ).toEqual({ queries: ["linear"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__get_component_definition",
        input: { key: "slack-send-message" },
      }),
    ).toEqual({ queries: ["slack"], listConnected: false });
  });

  it("extracts app lookups from missing-connection tool results only", () => {
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_result",
        toolName: "mcp__plugin_pipedream__slack_send_message",
        input: { app: "slack" },
        output: { code: "CONNECTION_NOT_CONNECTED", message: "Slack is not connected" },
      }),
    ).toEqual({ queries: ["slack"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_result",
        toolName: "mcp__plugin_pipedream__github_create_issue",
        input: {},
        output: [{ type: "text", text: "CONNECTION_NOT_CONNECTED" }],
      }),
    ).toEqual({ queries: ["github"], listConnected: false });
    expect(
      extractIntegrationLookupsFromProgressEvent({
        kind: "tool_result",
        toolName: "mcp__plugin_pipedream__slack_send_message",
        input: { app: "slack" },
        output: "Rate limit exceeded",
      }),
    ).toEqual({ queries: [], listConnected: false });
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

    expect(cards).toMatchObject([{ appId: "slack", appName: "Slack", state: "connect" }]);
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

    expect(queries).toEqual(["google-calendar-oauth"]);
    expect(cards).toMatchObject([{ appId: "google-calendar-oauth", appName: "Google Calendar", state: "connect" }]);
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
      userEmail: "alice@example.com",
      userName: "Alice",
      collector: { collect: (card) => cards.push(card) },
    });

    expect(cards).toMatchObject([
      { appId: "github", appName: "GitHub", state: "connected", accountName: "Alice GitHub" },
    ]);
  });
});
