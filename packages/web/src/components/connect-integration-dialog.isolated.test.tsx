import { INTEGRATIONS } from "@/lib/integrations";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { ConnectIntegrationDialog } from "./connect-integration-dialog";

const mockAuth = vi.hoisted(() => ({
  value: { role: "admin" as "admin" | "member", displayName: "Admin", displayIdentifier: "admin@test.com" },
}));

vi.mock("@/routes/dashboard", () => ({
  useDashboardAuth: () => mockAuth.value,
}));

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
});
