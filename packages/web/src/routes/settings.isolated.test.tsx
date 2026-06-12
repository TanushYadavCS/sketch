import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { SettingsPage } from "./settings";

function settingsHandlers(
  options: {
    microsoftConfigured?: boolean;
    envConfigured?: boolean;
    settingsConfigured?: boolean;
    onMicrosoftStatus?: () => void;
  } = {},
) {
  const envConfigured = options.envConfigured ?? false;
  const settingsConfigured = options.settingsConfigured ?? ((options.microsoftConfigured ?? false) && !envConfigured);
  const microsoftConfigured = options.microsoftConfigured ?? (envConfigured || settingsConfigured);

  server.use(
    http.get("/api/settings/access", () => HttpResponse.json({ adminCanReadAllFiles: false })),
    http.get("/api/settings/api-key", () => HttpResponse.json({ configured: false, apiKey: null })),
    http.get("/api/local-devices", () =>
      HttpResponse.json({ devices: [], baseUrl: "http://localhost", websocketUrl: "ws://localhost" }),
    ),
    http.get("/api/api-tokens", () => HttpResponse.json({ tokens: [], mcpUrl: "http://localhost/mcp" })),
    http.get("/api/oauth/microsoft/status", () => {
      options.onMicrosoftStatus?.();
      return HttpResponse.json({
        configured: microsoftConfigured,
        envConfigured,
        settingsConfigured,
        clientId: microsoftConfigured ? "client-id" : null,
        baseUrl: "http://localhost",
        tenant: "common",
      });
    }),
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    mockAuth.value = { role: "admin", displayName: "Admin", displayIdentifier: "admin@test.com" };
    settingsHandlers();
  });

  it("shows Microsoft OAuth settings to admins when the client is missing", async () => {
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("Shared Outlook and Teams client")).toBeInTheDocument();
    expect(screen.getByText("Microsoft OAuth")).toBeInTheDocument();
  });

  it("shows Microsoft OAuth settings to admins when the client is configured from settings", async () => {
    settingsHandlers({ microsoftConfigured: true });

    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("Shared Outlook and Teams client")).toBeInTheDocument();
    expect(screen.getByDisplayValue("client-id")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
  });

  it("hides Microsoft OAuth settings when the client is configured from env", async () => {
    const onMicrosoftStatus = vi.fn();
    settingsHandlers({ microsoftConfigured: true, envConfigured: true, onMicrosoftStatus });

    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(onMicrosoftStatus).toHaveBeenCalled();
    });
    expect(screen.queryByText("Shared Outlook and Teams client")).not.toBeInTheDocument();
    expect(screen.queryByText("Microsoft OAuth")).not.toBeInTheDocument();
  });

  it("shows Microsoft OAuth settings when env exists but a saved workspace config is still active", async () => {
    settingsHandlers({ microsoftConfigured: true, envConfigured: true, settingsConfigured: true });

    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("Shared Outlook and Teams client")).toBeInTheDocument();
    expect(screen.getByDisplayValue("client-id")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
  });
});
