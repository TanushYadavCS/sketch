import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => ({
  value: { role: "admin" as "admin" | "member", displayName: "Admin", displayIdentifier: "admin@test.com" },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...mod,
    useRouteContext: () => ({
      auth: mockAuth.value,
    }),
  };
});

import { ConnectionsPage } from "./connections";

function setupCommonHandlers(connections: unknown[] = []) {
  server.use(
    http.get("/api/setup/status", () =>
      HttpResponse.json({
        completed: true,
        currentStep: 4,
        adminEmail: "admin@test.com",
        orgName: "Acme",
        botName: "Sketch",
        slackConnected: true,
        llmConnected: true,
        llmProvider: "anthropic",
      }),
    ),
    http.get("/api/mcp-servers", () =>
      HttpResponse.json({
        servers: [
          {
            id: "provider-1",
            type: "canvas",
            slug: "canvas",
            displayName: "Canvas",
            url: "https://canvas.example.com/mcp",
            apiUrl: "https://canvas.example.com",
            credentials: {},
            mode: "skill",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    ),
    http.get("/api/mcp-servers/provider-1/connections", () => HttpResponse.json({ connections })),
  );
}

describe("ConnectionsPage direct connect", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mockAuth.value = { role: "admin", displayName: "Admin", displayIdentifier: "admin@test.com" };
    window.history.replaceState({}, "", "/integrations");
  });

  it("starts a connection intent without running app search", async () => {
    const intentBodies: unknown[] = [];
    setupCommonHandlers();
    window.history.replaceState({}, "", "/integrations?connect=notion");

    server.use(
      http.get("/api/mcp-servers/provider-1/apps", () => {
        throw new Error("direct connect should not use app search");
      }),
      http.post("/api/mcp-servers/provider-1/connections/intents", async ({ request }) => {
        intentBodies.push(await request.json());
        return HttpResponse.json({
          app: { id: "notion", name: "Notion", description: "Workspace notes" },
          redirectUrl: "#oauth",
        });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("Opening Notion")).toBeInTheDocument();
    await waitFor(() => {
      expect(intentBodies).toHaveLength(1);
    });
    expect(intentBodies[0]).toMatchObject({
      appId: "notion",
      callbackUrl: `${window.location.origin}/integrations/callback?app=notion`,
    });
    await waitFor(() => {
      expect(window.location.hash).toBe("#oauth");
    });
  });

  it("shows provider setup when no integration provider is configured", async () => {
    window.history.replaceState({}, "", "/integrations?connect=notion");
    server.use(
      http.get("/api/setup/status", () =>
        HttpResponse.json({
          completed: true,
          currentStep: 4,
          adminEmail: "admin@test.com",
          orgName: "Acme",
          botName: "Sketch",
          slackConnected: true,
          llmConnected: true,
          llmProvider: "anthropic",
        }),
      ),
      http.get("/api/mcp-servers", () => HttpResponse.json({ servers: [] })),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("Set up integrations first")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up provider" })).toBeInTheDocument();
  });

  it("does not start a new intent for an already connected app", async () => {
    const intent = vi.fn();
    setupCommonHandlers([
      {
        id: "secrets:user-1:notion:notion",
        providerId: "provider-1",
        source: "canvas_user_secrets",
        appId: "notion",
        appName: "Notion",
        status: "active",
        accessLevel: "personal",
        isOwnedByViewer: true,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    window.history.replaceState({}, "", "/integrations?connect=notion");

    server.use(
      http.post("/api/mcp-servers/provider-1/connections/intents", () => {
        intent();
        return HttpResponse.json({ app: { id: "notion", name: "Notion", description: "" }, redirectUrl: "#oauth" });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("Notion is connected")).toBeInTheDocument();
    expect(intent).not.toHaveBeenCalled();
  });

  it("verifies callback connections before showing success", async () => {
    const intent = vi.fn();
    setupCommonHandlers([
      {
        id: "secrets:user-1:notion:notion",
        providerId: "provider-1",
        source: "canvas_user_secrets",
        appId: "notion",
        appName: "Notion",
        status: "active",
        accessLevel: "personal",
        isOwnedByViewer: true,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    window.history.replaceState({}, "", "/integrations?verify_connected=notion");

    server.use(
      http.post("/api/mcp-servers/provider-1/connections/intents", () => {
        intent();
        return HttpResponse.json({ app: { id: "notion", name: "Notion", description: "" }, redirectUrl: "#oauth" });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("Notion is connected")).toBeInTheDocument();
    expect(intent).not.toHaveBeenCalled();
  });

  it("nudges users to connect a matching personal connector after Canvas connection verification", async () => {
    const user = userEvent.setup();
    const importedBodies: unknown[] = [];
    setupCommonHandlers([
      {
        id: "secrets:user-1:gmail:google-gmail-oauth",
        providerId: "provider-1",
        source: "canvas_user_secrets",
        appId: "google-gmail-oauth",
        appName: "Gmail",
        status: "active",
        accessLevel: "personal",
        isOwnedByViewer: true,
        icon: "https://img.test/gmail.png",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    window.history.replaceState({}, "", "/integrations?verify_connected=google-gmail-oauth");

    server.use(
      http.get("/api/connectors/canvas/suggestions", ({ request }) => {
        const params = new URL(request.url).searchParams;
        expect(params.get("appId")).toBe("google-gmail-oauth");
        expect(params.get("accountId")).toBe("secrets:user-1:gmail:google-gmail-oauth");
        expect(params.get("source")).toBe("canvas_user_secrets");
        return HttpResponse.json({
          suggestion: {
            connectorType: "gmail",
            appId: "google-gmail-oauth",
            accountId: "secrets:user-1:gmail:google-gmail-oauth",
          },
        });
      }),
      http.get("/api/connectors/credential-source", () =>
        HttpResponse.json({
          mode: "local",
          canvasConfigured: true,
          canvasCredentialImportConfigured: true,
          publicKeyId: "key-1",
        }),
      ),
      http.post("/api/connectors/canvas/import", async ({ request }) => {
        importedBodies.push(await request.json());
        return HttpResponse.json({
          connector: {
            id: "gmail-connector",
            connectorType: "gmail",
            syncStatus: "pending",
            alreadyConnected: false,
          },
        });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("Gmail is connected")).toBeInTheDocument();
    expect(await screen.findByText("Add Gmail to the org brain?")).toBeInTheDocument();
    expect(document.querySelector('img[src="https://img.test/gmail.png"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to org brain" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add to org brain" }));

    await waitFor(() =>
      expect(importedBodies).toEqual([
        { connectorType: "gmail", accountId: "secrets:user-1:gmail:google-gmail-oauth" },
      ]),
    );
    expect(screen.queryByRole("button", { name: "Continue with connected account" })).not.toBeInTheDocument();
  });

  it("does not nudge users for matching legacy Pipedream connections", async () => {
    const suggestions = vi.fn();
    setupCommonHandlers([
      {
        id: "apn_gmail",
        providerId: "provider-1",
        source: "pipedream",
        appId: "google-gmail-oauth",
        appName: "Gmail",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    window.history.replaceState({}, "", "/integrations?verify_connected=google-gmail-oauth");

    server.use(
      http.get("/api/connectors/canvas/suggestions", () => {
        suggestions();
        return HttpResponse.json({
          suggestion: {
            connectorType: "gmail",
            appId: "google-gmail-oauth",
          },
        });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("Gmail is connected")).toBeInTheDocument();
    expect(screen.queryByText("Add Gmail to the org brain?")).not.toBeInTheDocument();
    expect(suggestions).not.toHaveBeenCalled();
  });

  it("keeps polling callback verification until the provider returns the connection", async () => {
    const connection = {
      id: "secrets:user-1:notion:notion",
      providerId: "provider-1",
      source: "canvas_user_secrets",
      appId: "notion",
      appName: "Notion",
      status: "active",
      accessLevel: "personal",
      isOwnedByViewer: true,
      createdAt: "2026-01-01T00:00:00Z",
    };
    let connectionRequests = 0;
    setupCommonHandlers();
    window.history.replaceState({}, "", "/integrations?verify_connected=notion");

    server.use(
      http.get("/api/mcp-servers/provider-1/connections", () => {
        connectionRequests += 1;
        return HttpResponse.json({ connections: connectionRequests >= 3 ? [connection] : [] });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("Checking Notion")).toBeInTheDocument();
    await waitFor(() => expect(connectionRequests).toBeGreaterThanOrEqual(3), { timeout: 5000 });

    expect(await screen.findByText("Notion is connected")).toBeInTheDocument();
    expect(connectionRequests).toBeGreaterThanOrEqual(3);
  });

  it("connects GitHub through the local PAT wizard instead of Canvas", async () => {
    const user = userEvent.setup();
    const connectBodies: unknown[] = [];
    const verificationBodies: unknown[] = [];
    setupCommonHandlers();
    server.use(
      http.get("/api/integration-apps", () =>
        HttpResponse.json({
          apps: [
            {
              id: "github",
              name: "GitHub",
              description: "Use GitHub through Sketch.",
              icon: "https://github.com/favicon.svg",
              executionMode: "cli",
              connected: false,
              connectionId: null,
            },
          ],
          executionMode: "cli",
        }),
      ),
      http.get("/api/integration-apps/connections", () => HttpResponse.json({ connections: [] })),
      http.get("/api/mcp-servers/provider-1/apps", () =>
        HttpResponse.json({ apps: [], pageInfo: { endCursor: null, hasMore: false } }),
      ),
      http.post("/api/integration-apps/github/verification", async ({ request }) => {
        verificationBodies.push(await request.json());
        return HttpResponse.json({
          identity: { externalId: "123", login: "octocat", avatarUrl: null, accountType: "User" },
        });
      }),
      http.post("/api/integration-apps/github/connections", async ({ request }) => {
        connectBodies.push(await request.json());
        return HttpResponse.json(
          {
            connection: {
              id: "cli-1",
              appId: "github",
              appName: "GitHub",
              executionMode: "cli",
              ownerUserId: "owner-1",
              accountLogin: "octocat",
              accountExternalId: "123",
              accountAvatarUrl: null,
              accountType: "User",
              status: "active",
              verifiedAt: "2026-01-01T00:00:00Z",
              lastVerificationError: null,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              shares: [],
            },
          },
          { status: 201 },
        );
      }),
      http.put("/api/integration-apps/github/connections/cli-1/shares", () =>
        HttpResponse.json({ connection: { status: "active", accountLogin: "octocat", shares: [] } }),
      ),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(screen.queryByText("GitHub CLI")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add integration" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    await user.click(await screen.findByRole("button", { name: /GitHub/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const tokenInput = await screen.findByLabelText("Personal access token");
    await user.type(tokenInput, "ghp_test_token");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    await waitFor(() => expect(verificationBodies).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(connectBodies).toHaveLength(1));

    expect(await screen.findByText("@octocat")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("ghp_test_token")).not.toBeInTheDocument();
    expect(verificationBodies).toEqual([{ token: "ghp_test_token" }]);
    expect(connectBodies).toEqual([{ token: "ghp_test_token", targets: [] }]);
  });

  it("shows callback errors without starting a new intent", async () => {
    const intent = vi.fn();
    setupCommonHandlers();
    window.history.replaceState({}, "", "/integrations?connect_error=1&app=github");

    server.use(
      http.post("/api/mcp-servers/provider-1/connections/intents", () => {
        intent();
        return HttpResponse.json({ app: { id: "github", name: "GitHub", description: "" }, redirectUrl: "#oauth" });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("Could not connect GitHub")).toBeInTheDocument();
    expect(screen.getByText("Connection was not completed. Please try again.")).toBeInTheDocument();
    expect(intent).not.toHaveBeenCalled();
  });
});
