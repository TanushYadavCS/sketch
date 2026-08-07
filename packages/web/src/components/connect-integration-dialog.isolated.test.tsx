import { INTEGRATIONS } from "@/lib/integrations";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectIntegrationDialog } from "./connect-integration-dialog";

const mockAuth = vi.hoisted(() => ({
  value: { role: "admin" as "admin" | "member", displayName: "Admin", displayIdentifier: "admin@test.com" },
}));

vi.mock("@/routes/dashboard", () => ({
  useDashboardAuth: () => mockAuth.value,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function renderMicrosoftDialog(options: {
  configured?: boolean;
  envConfigured?: boolean;
  settingsConfigured?: boolean;
  onConfig?: (body: unknown) => void;
}) {
  let configured = options.configured ?? false;
  const integration = INTEGRATIONS.find((item) => item.type === "teams");
  if (!integration) throw new Error("Microsoft Teams integration is missing");

  server.use(
    http.get("/api/oauth/microsoft/status", () =>
      HttpResponse.json({
        configured,
        envConfigured: options.envConfigured ?? false,
        settingsConfigured: options.settingsConfigured ?? false,
        clientId: configured ? "client-id" : null,
        baseUrl: "http://localhost",
        tenant: "common",
      }),
    ),
    http.put("/api/oauth/microsoft/config", async ({ request }) => {
      const body = await request.json();
      options.onConfig?.(body);
      configured = true;
      return HttpResponse.json({ success: true });
    }),
  );

  return renderWithProviders(
    <ConnectIntegrationDialog integration={integration} open={true} onOpenChange={() => {}} onConnected={() => {}} />,
  );
}

function renderGoogleDialog(options: { configured?: boolean; clientId?: string; onConfig?: (body: unknown) => void }) {
  let configured = options.configured ?? true;
  const clientId = options.clientId ?? "123456789-test.apps.googleusercontent.com";
  const integration = INTEGRATIONS.find((item) => item.type === "gmail");
  if (!integration) throw new Error("Gmail integration is missing");

  server.use(
    http.get("/api/oauth/google/status", () =>
      HttpResponse.json({
        configured,
        clientId: configured ? clientId : null,
        baseUrl: "http://localhost",
      }),
    ),
    http.put("/api/oauth/google/config", async ({ request }) => {
      const body = await request.json();
      options.onConfig?.(body);
      configured = true;
      return HttpResponse.json({ success: true });
    }),
  );

  return renderWithProviders(
    <ConnectIntegrationDialog integration={integration} open={true} onOpenChange={() => {}} onConnected={() => {}} />,
  );
}

describe("ConnectIntegrationDialog Microsoft OAuth setup", () => {
  it("lets admins configure Microsoft OAuth when no environment client is present", async () => {
    const user = userEvent.setup();
    const configBodies: unknown[] = [];
    renderMicrosoftDialog({ configured: false, envConfigured: false, onConfig: (body) => configBodies.push(body) });

    expect(await screen.findByRole("heading", { name: "Configure Microsoft Teams" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Application (client) ID"), "client-id");
    await user.type(screen.getByLabelText("Tenant"), "common");
    await user.type(screen.getByLabelText("Client secret"), "client-secret");
    await user.click(screen.getByRole("button", { name: "Save & Continue" }));

    await waitFor(() => expect(configBodies).toHaveLength(1));
    expect(configBodies[0]).toEqual({
      clientId: "client-id",
      tenant: "common",
      clientSecret: "client-secret",
    });
    expect(await screen.findByRole("button", { name: "Connect with Microsoft" })).toBeInTheDocument();
  });

  it("does not show inline setup when Microsoft OAuth is environment-managed", async () => {
    renderMicrosoftDialog({ configured: true, envConfigured: true });

    expect(await screen.findByRole("button", { name: "Connect with Microsoft" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Configure Microsoft Teams" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconfigure OAuth" })).not.toBeInTheDocument();
  });

  it("allows reconfiguration when env exists but a workspace override is saved", async () => {
    renderMicrosoftDialog({ configured: true, envConfigured: true, settingsConfigured: true });

    expect(await screen.findByRole("button", { name: "Connect with Microsoft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconfigure OAuth" })).toBeInTheDocument();
  });

  it("lets admins reconfigure Google OAuth without first going back to Google", async () => {
    const user = userEvent.setup();
    const configBodies: unknown[] = [];
    renderGoogleDialog({ onConfig: (body) => configBodies.push(body) });

    expect(await screen.findByRole("button", { name: "Connect with Google" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reconfigure OAuth" }));

    expect(await screen.findByRole("heading", { name: "Configure Gmail" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Client ID")).toHaveValue("123456789-test.apps.googleusercontent.com"),
    );

    await user.type(screen.getByLabelText("Client Secret"), "client-secret");
    await user.click(screen.getByRole("button", { name: "Save & Continue" }));

    await waitFor(() => expect(configBodies).toHaveLength(1));
    expect(configBodies[0]).toEqual({
      clientId: "123456789-test.apps.googleusercontent.com",
      clientSecret: "client-secret",
    });
  });

  it("imports a connector from an already-connected Canvas app without another click", async () => {
    const importedBodies: unknown[] = [];
    const onConnected = vi.fn();
    const integration = INTEGRATIONS.find((item) => item.type === "gmail");
    if (!integration) throw new Error("Gmail integration is missing");

    server.use(
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
            id: "connector-1",
            connectorType: "gmail",
            syncStatus: "pending",
            alreadyConnected: false,
          },
        });
      }),
    );

    renderWithProviders(
      <ConnectIntegrationDialog
        integration={integration}
        open={true}
        onOpenChange={() => {}}
        onConnected={onConnected}
        preferCanvasCredentialSource={true}
        canvasConnectionReady={true}
        canvasAccountId="secrets:user-1:google:google-gmail-oauth"
      />,
    );

    expect(await screen.findByText("Setting up Sketch sync...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with connected account" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Canvas/)).not.toBeInTheDocument();

    await waitFor(() =>
      expect(importedBodies).toEqual([
        { connectorType: "gmail", accountId: "secrets:user-1:google:google-gmail-oauth" },
      ]),
    );
    expect(onConnected).toHaveBeenCalled();
    expect(screen.queryByText("Configure Gmail")).not.toBeInTheDocument();
  });

  it("imports a Canvas flat-scope connector and goes straight to scope selection", async () => {
    const user = userEvent.setup();
    const scopeBodies: unknown[] = [];
    const onConnected = vi.fn();
    const integration = INTEGRATIONS.find((item) => item.type === "google_calendar");
    if (!integration) throw new Error("Google Calendar integration is missing");

    server.use(
      http.get("/api/connectors/credential-source", () =>
        HttpResponse.json({
          mode: "local",
          canvasConfigured: true,
          canvasCredentialImportConfigured: true,
          publicKeyId: "key-1",
        }),
      ),
      http.post("/api/connectors/canvas/import", () =>
        HttpResponse.json({
          connector: {
            id: "calendar-connector",
            connectorType: "google_calendar",
            syncStatus: "paused",
            alreadyConnected: true,
          },
        }),
      ),
      http.get("/api/connectors/calendar-connector/browse", () =>
        HttpResponse.json({
          type: "flat",
          items: [
            { id: "cal-1", name: "Personal" },
            { id: "cal-2", name: "Work" },
          ],
          scopeConfig: { calendarIds: ["cal-2"] },
        }),
      ),
      http.patch("/api/connectors/calendar-connector/scope", async ({ request }) => {
        scopeBodies.push(await request.json());
        return HttpResponse.json({
          connector: {
            id: "calendar-connector",
            connectorType: "google_calendar",
            syncStatus: "pending",
            scopeConfig: { calendarIds: ["cal-2"] },
          },
        });
      }),
    );

    renderWithProviders(
      <ConnectIntegrationDialog
        integration={integration}
        open={true}
        onOpenChange={() => {}}
        onConnected={onConnected}
        preferCanvasCredentialSource={true}
        canvasConnectionReady={true}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Select calendars" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with connected account" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect 1 calendars" }));

    await waitFor(() => expect(scopeBodies).toEqual([{ scopeConfig: { calendarIds: ["cal-2"] } }]));
    expect(onConnected).toHaveBeenCalled();
  });

  it("does not enable Canvas import when the connect popup is blocked", async () => {
    const user = userEvent.setup();
    const integration = INTEGRATIONS.find((item) => item.type === "gmail");
    if (!integration) throw new Error("Gmail integration is missing");
    vi.spyOn(window, "open").mockReturnValue(null);

    server.use(
      http.get("/api/connectors/credential-source", () =>
        HttpResponse.json({
          mode: "local",
          canvasConfigured: true,
          canvasCredentialImportConfigured: true,
          publicKeyId: "key-1",
        }),
      ),
      http.post("/api/connectors/canvas/connect", () =>
        HttpResponse.json({ redirectUrl: "https://canvas.example.com/connect" }),
      ),
    );

    renderWithProviders(
      <ConnectIntegrationDialog
        integration={integration}
        open={true}
        onOpenChange={() => {}}
        onConnected={() => {}}
        preferCanvasCredentialSource={true}
      />,
    );

    expect(await screen.findByRole("button", { name: "Connect account" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect in Canvas" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect account" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Set up Sketch sync" })).not.toBeInTheDocument());
  });

  it("waits for the connected account to be detected before enabling Canvas import", async () => {
    const user = userEvent.setup();
    const importedBodies: unknown[] = [];
    const onCanvasConnectionStarted = vi.fn();
    const integration = INTEGRATIONS.find((item) => item.type === "google_calendar");
    if (!integration) throw new Error("Google Calendar integration is missing");
    vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);

    server.use(
      http.get("/api/oauth/google/status", () =>
        HttpResponse.json({ configured: true, clientId: "google-client.apps.googleusercontent.com", baseUrl: null }),
      ),
      http.get("/api/connectors/credential-source", () =>
        HttpResponse.json({
          mode: "canvas",
          canvasConfigured: true,
          canvasCredentialImportConfigured: true,
          publicKeyId: "key-1",
        }),
      ),
      http.post("/api/connectors/canvas/connect", () =>
        HttpResponse.json({ redirectUrl: "https://canvas.example.com/connect" }),
      ),
      http.post("/api/connectors/canvas/import", async ({ request }) => {
        importedBodies.push(await request.json());
        return HttpResponse.json({
          connector: {
            id: "calendar-connector",
            connectorType: "google_calendar",
            syncStatus: "paused",
            alreadyConnected: false,
          },
        });
      }),
      http.get("/api/connectors/calendar-connector/browse", () =>
        HttpResponse.json({
          type: "flat",
          items: [{ id: "primary", name: "Primary (primary)" }],
          scopeConfig: { calendarIds: [] },
        }),
      ),
    );

    const { rerender } = renderWithProviders(
      <ConnectIntegrationDialog
        integration={integration}
        open={true}
        onOpenChange={() => {}}
        onConnected={() => {}}
        onCanvasConnectionStarted={onCanvasConnectionStarted}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Connect account" }));

    expect(onCanvasConnectionStarted).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Waiting for sign-in to finish...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up Sketch sync" })).not.toBeInTheDocument();
    expect(importedBodies).toEqual([]);

    rerender(
      <ConnectIntegrationDialog
        integration={integration}
        open={true}
        onOpenChange={() => {}}
        onConnected={() => {}}
        canvasConnectionReady={true}
        canvasAccountId="secrets:user-1:google:google-calendar-oauth"
        onCanvasConnectionStarted={onCanvasConnectionStarted}
      />,
    );

    await waitFor(() =>
      expect(importedBodies).toEqual([
        { connectorType: "google_calendar", accountId: "secrets:user-1:google:google-calendar-oauth" },
      ]),
    );
    expect(await screen.findByRole("heading", { name: "Select calendars" })).toBeInTheDocument();
  });

  it("waits for credential mode before showing the local Outlook Calendar OAuth flow", async () => {
    let releaseCredentialSource: () => void = () => {};
    const credentialSource = new Promise<Response>((resolve) => {
      releaseCredentialSource = () =>
        resolve(
          HttpResponse.json({
            mode: "local",
            canvasConfigured: false,
            canvasCredentialImportConfigured: false,
            publicKeyId: null,
          }),
        );
    });
    const integration = INTEGRATIONS.find((item) => item.type === "outlook_calendar");
    if (!integration) throw new Error("Outlook Calendar integration is missing");

    server.use(
      http.get("/api/connectors/credential-source", () => credentialSource),
      http.get("/api/oauth/microsoft/status", () =>
        HttpResponse.json({
          configured: true,
          envConfigured: true,
          settingsConfigured: false,
          clientId: "client-id",
          baseUrl: "http://localhost",
          tenant: "common",
        }),
      ),
    );

    renderWithProviders(
      <ConnectIntegrationDialog integration={integration} open={true} onOpenChange={() => {}} onConnected={() => {}} />,
    );

    expect(await screen.findByText("Checking connected accounts...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect with Microsoft" })).not.toBeInTheDocument();

    releaseCredentialSource();
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect with Microsoft" })).toBeInTheDocument());
  });
});
