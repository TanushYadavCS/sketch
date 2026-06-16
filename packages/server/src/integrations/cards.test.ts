import { describe, expect, it } from "vitest";
import {
  collectIntegrationCardsFromProgressEvents,
  extractCanvasIntegrationLookups,
  isConnectedAccountsInquiry,
  resolveIntegrationLookup,
} from "./cards";
import type { IntegrationProvider } from "./types";

describe("integration cards", () => {
  it("detects connected account enquiries", () => {
    expect(isConnectedAccountsInquiry("what accounts are connected?")).toBe(true);
    expect(isConnectedAccountsInquiry("show my connected integrations")).toBe(true);
    expect(isConnectedAccountsInquiry("which apps are connected?")).toBe(true);
    expect(isConnectedAccountsInquiry("connect github")).toBe(false);
    expect(isConnectedAccountsInquiry("what apps do you support?")).toBe(false);
  });

  it("extracts app lookups from Canvas CLI commands", () => {
    expect(extractCanvasIntegrationLookups('$CANVAS_CLI search-apps --queries "slack,gmail" --output json')).toEqual({
      queries: ["slack", "gmail"],
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
        'sh -c \'"$CANVAS_CLI" search-components --raw \'{"queries":[{"app":"linear","query":"create issue"}]}\' --output json\'',
      ),
    ).toEqual({
      queries: ["linear"],
      listConnected: false,
    });
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
});
