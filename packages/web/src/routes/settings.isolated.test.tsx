import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    onMicrosoftConfig?: (body: unknown) => void;
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
    http.put("/api/oauth/microsoft/config", async ({ request }) => {
      options.onMicrosoftConfig?.(await request.json());
      return HttpResponse.json({ success: true });
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
    expect(screen.getByText("Workspace override")).toBeInTheDocument();
  });

  it("allows Microsoft OAuth settings to be saved when the client is configured from env", async () => {
    const user = userEvent.setup();
    const onMicrosoftStatus = vi.fn();
    const onMicrosoftConfig = vi.fn();
    settingsHandlers({ microsoftConfigured: true, envConfigured: true, onMicrosoftStatus, onMicrosoftConfig });

    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(onMicrosoftStatus).toHaveBeenCalled();
    });
    expect(await screen.findByText("Shared Outlook and Teams client")).toBeInTheDocument();
    expect(screen.getByText("Environment fallback")).toBeInTheDocument();
    expect(screen.getByDisplayValue("client-id")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Client secret"), "client-secret");
    const microsoftSection = screen.getByLabelText("Client secret").closest("section");
    if (!microsoftSection) throw new Error("Microsoft OAuth section not found");
    await user.click(within(microsoftSection).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onMicrosoftConfig).toHaveBeenCalledWith({
        clientId: "client-id",
        clientSecret: "client-secret",
        tenant: "common",
      });
    });
  });

  it("shows Microsoft OAuth settings when env exists but a saved workspace config is still active", async () => {
    settingsHandlers({ microsoftConfigured: true, envConfigured: true, settingsConfigured: true });

    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("Shared Outlook and Teams client")).toBeInTheDocument();
    expect(screen.getByDisplayValue("client-id")).toBeInTheDocument();
    expect(screen.getByText("Workspace override")).toBeInTheDocument();
  });
});
