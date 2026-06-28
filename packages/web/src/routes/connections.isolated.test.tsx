import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
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
    window.history.replaceState({}, "", "/integrations?connect=github");

    server.use(
      http.get("/api/mcp-servers/provider-1/apps", () => {
        throw new Error("direct connect should not use app search");
      }),
      http.post("/api/mcp-servers/provider-1/connections/intents", async ({ request }) => {
        intentBodies.push(await request.json());
        return HttpResponse.json({
          app: { id: "github", name: "GitHub", description: "Code hosting" },
          redirectUrl: "#oauth",
        });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("Opening GitHub")).toBeInTheDocument();
    await waitFor(() => {
      expect(intentBodies).toHaveLength(1);
    });
    expect(intentBodies[0]).toMatchObject({
      appId: "github",
      callbackUrl: `${window.location.origin}/integrations/callback?app=github`,
    });
    await waitFor(() => {
      expect(window.location.hash).toBe("#oauth");
    });
  });

  it("shows provider setup when no integration provider is configured", async () => {
    window.history.replaceState({}, "", "/integrations?connect=github");
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
        id: "secrets:user-1:github:github",
        providerId: "provider-1",
        source: "canvas_user_secrets",
        appId: "github",
        appName: "GitHub",
        status: "active",
        accessLevel: "personal",
        isOwnedByViewer: true,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    window.history.replaceState({}, "", "/integrations?connect=github");

    server.use(
      http.post("/api/mcp-servers/provider-1/connections/intents", () => {
        intent();
        return HttpResponse.json({ app: { id: "github", name: "GitHub", description: "" }, redirectUrl: "#oauth" });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("GitHub is connected")).toBeInTheDocument();
    expect(intent).not.toHaveBeenCalled();
  });

  it("verifies callback connections before showing success", async () => {
    const intent = vi.fn();
    setupCommonHandlers([
      {
        id: "secrets:user-1:github:github",
        providerId: "provider-1",
        source: "canvas_user_secrets",
        appId: "github",
        appName: "GitHub",
        status: "active",
        accessLevel: "personal",
        isOwnedByViewer: true,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    window.history.replaceState({}, "", "/integrations?verify_connected=github");

    server.use(
      http.post("/api/mcp-servers/provider-1/connections/intents", () => {
        intent();
        return HttpResponse.json({ app: { id: "github", name: "GitHub", description: "" }, redirectUrl: "#oauth" });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("GitHub is connected")).toBeInTheDocument();
    expect(intent).not.toHaveBeenCalled();
  });

  it("nudges users to connect a matching personal connector after Canvas connection verification", async () => {
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
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    window.history.replaceState({}, "", "/integrations?verify_connected=google-gmail-oauth");

    server.use(
      http.get("/api/connectors/canvas/suggestions", ({ request }) => {
        expect(new URL(request.url).searchParams.get("appId")).toBe("google-gmail-oauth");
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
    expect(await screen.findByText("Sync Gmail into Files?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect connector" })).toBeInTheDocument();
  });

  it("keeps polling callback verification until the provider returns the connection", async () => {
    const connection = {
      id: "secrets:user-1:github:github",
      providerId: "provider-1",
      source: "canvas_user_secrets",
      appId: "github",
      appName: "GitHub",
      status: "active",
      accessLevel: "personal",
      isOwnedByViewer: true,
      createdAt: "2026-01-01T00:00:00Z",
    };
    let connectionRequests = 0;
    setupCommonHandlers();
    window.history.replaceState({}, "", "/integrations?verify_connected=github");

    server.use(
      http.get("/api/mcp-servers/provider-1/connections", () => {
        connectionRequests += 1;
        return HttpResponse.json({ connections: connectionRequests >= 3 ? [connection] : [] });
      }),
    );

    renderWithProviders(<ConnectionsPage />);

    expect(await screen.findByText("Checking GitHub")).toBeInTheDocument();
    await waitFor(() => expect(connectionRequests).toBeGreaterThanOrEqual(3), { timeout: 5000 });

    expect(await screen.findByText("GitHub is connected")).toBeInTheDocument();
    expect(connectionRequests).toBeGreaterThanOrEqual(3);
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
