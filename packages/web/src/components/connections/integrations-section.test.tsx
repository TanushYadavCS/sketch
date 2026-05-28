import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import type { IntegrationConnection } from "@sketch/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { IntegrationsSection } from "./integrations-section";

const baseConnection = {
  providerId: "provider-1",
  appId: "github",
  appName: "GitHub",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
} satisfies Partial<IntegrationConnection>;

function renderSection(
  connections: IntegrationConnection[],
  onDisconnect = vi.fn(),
  options: { accessSettingsEnabled?: boolean } = {},
) {
  return renderWithProviders(
    <IntegrationsSection
      connections={connections}
      isLoadingConnections={false}
      providerId="provider-1"
      orgName="Acme"
      accessSettingsEnabled={options.accessSettingsEnabled ?? true}
      onAdd={vi.fn()}
      onDisconnect={onDisconnect}
    />,
  );
}

describe("IntegrationsSection", () => {
  it("renders Canvas access metadata and gates destructive controls", () => {
    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:github:github",
        source: "canvas_user_secrets",
        accountName: "Engineering GitHub",
        authType: "oauth",
        accessLevel: "organization",
        ownerName: "Tara",
        isOwnedByViewer: false,
        canManageAccess: false,
        canDelete: false,
        connectedAt: "2026-01-02T00:00:00Z",
      },
      {
        ...baseConnection,
        id: "secrets:viewer-1:notion:notion",
        source: "canvas_user_secrets",
        appId: "notion",
        appName: "Notion",
        accessLevel: "personal",
        isOwnedByViewer: true,
        canManageAccess: true,
        canDelete: true,
      },
      {
        ...baseConnection,
        id: "pd-1",
        source: "pipedream",
        appId: "slack",
        appName: "Slack",
        accountName: "Team Slack",
        canManageAccess: false,
        canDelete: true,
      },
    ]);

    expect(screen.getByText("Org shared")).toBeInTheDocument();
    expect(screen.queryByText("Personal")).not.toBeInTheDocument();
    expect(screen.getByText("Owned by Tara")).toBeInTheDocument();
    expect(screen.queryByText("Engineering GitHub")).not.toBeInTheDocument();
    expect(screen.queryByText("OAuth")).not.toBeInTheDocument();
    expect(screen.queryByText(/Connected by:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Owner: Tara")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect GitHub" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect Notion" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings for Notion" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Settings unavailable for Slack" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Open settings for Slack" })).not.toBeInTheDocument();
  });

  it("keeps integration row metadata clean and hides API-key labels", () => {
    renderSection([
      {
        ...baseConnection,
        id: "secrets:viewer-1:meta-ads:meta-ads",
        source: "canvas_user_secrets",
        appId: "meta-ads",
        appName: "Meta Ads",
        accountName: "Business Manager",
        authType: "oauth",
        accessLevel: "personal",
        isOwnedByViewer: true,
        canManageAccess: true,
        canDelete: true,
      },
      {
        ...baseConnection,
        id: "secrets:viewer-1:app-store-connect:app-store-connect",
        source: "canvas_user_secrets",
        appId: "app-store-connect",
        appName: "App Store Connect",
        accountName: "KEY CSSFS",
        authType: "api-key",
        accessLevel: "personal",
        isOwnedByViewer: true,
        canManageAccess: true,
        canDelete: true,
      },
      {
        ...baseConnection,
        id: "secrets:viewer-1:aimfox:aimfox",
        source: "canvas_user_secrets",
        appId: "aimfox",
        appName: "Aimfox",
        accountName: ".",
        accessLevel: "personal",
        isOwnedByViewer: true,
        canManageAccess: true,
        canDelete: true,
      },
      {
        ...baseConnection,
        id: "secrets:viewer-1:fireflies:fireflies",
        source: "canvas_user_secrets",
        appId: "fireflies",
        appName: "Fireflies",
        accountName: "9KQ7S2A1D4",
        accessLevel: "personal",
        isOwnedByViewer: true,
        canManageAccess: true,
        canDelete: true,
      },
    ]);

    expect(screen.getByText("Business Manager")).toBeInTheDocument();
    expect(screen.queryByText("OAuth")).not.toBeInTheDocument();
    expect(screen.queryByText("API key")).not.toBeInTheDocument();
    expect(screen.queryByText("KEY CSSFS")).not.toBeInTheDocument();
    expect(screen.queryByText("9KQ7S2A1D4")).not.toBeInTheDocument();
    expect(screen.queryByText(".")).not.toBeInTheDocument();
    expect(screen.getAllByText("·")).toHaveLength(1);
  });

  it("uses owner display names instead of provider-generated account labels for shared accounts", () => {
    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:aimfox:aimfox",
        source: "canvas_user_secrets",
        appId: "aimfox",
        appName: "Aimfox",
        accountName: "tanushyadav87@gmail.com's Aimfox Connection",
        accessLevel: "organization",
        ownerName: "Tanush Yadav",
        ownerUserId: "tanushyadav87@gmail.com",
        isOwnedByViewer: false,
        canManageAccess: false,
        canDelete: false,
        connectedAt: "2026-05-27T00:00:00Z",
      },
    ]);

    expect(screen.getByText("Owned by Tanush Yadav")).toBeInTheDocument();
    expect(screen.getByText("Connected May 27")).toBeInTheDocument();
    expect(screen.queryByText(/gmail\.com/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Aimfox Connection/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect Aimfox" })).toBeDisabled();
  });

  it("hides access settings controls when access settings are disabled", () => {
    renderSection(
      [
        {
          ...baseConnection,
          id: "secrets:viewer-1:github:github",
          source: "canvas_user_secrets",
          accessLevel: "personal",
          isOwnedByViewer: true,
          canManageAccess: true,
          canDelete: true,
        },
      ],
      vi.fn(),
      { accessSettingsEnabled: false },
    );

    expect(screen.queryByRole("button", { name: "Open settings for GitHub" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings unavailable for GitHub" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect GitHub" })).toBeInTheDocument();
  });

  it("hides access-control state when access settings are disabled", () => {
    renderSection(
      [
        {
          ...baseConnection,
          id: "secrets:owner-1:github:github",
          source: "canvas_user_secrets",
          accountName: "Engineering GitHub",
          accessLevel: "organization",
          ownerName: "Tara",
          isOwnedByViewer: false,
          canManageAccess: false,
          canDelete: false,
        },
      ],
      vi.fn(),
      { accessSettingsEnabled: false },
    );

    expect(screen.queryByText("Org shared")).not.toBeInTheDocument();
    expect(screen.queryByText("Owned by Tara")).not.toBeInTheDocument();
    expect(screen.getByText("Engineering GitHub")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open settings for GitHub" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect GitHub" })).toBeEnabled();
  });

  it("keeps shared accounts non-destructive when Canvas omits canDelete", () => {
    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:github:github",
        source: "canvas_user_secrets",
        accessLevel: "organization",
        ownerName: "Tara",
        isOwnedByViewer: false,
        canManageAccess: false,
      },
    ]);

    expect(screen.getByRole("button", { name: "Disconnect GitHub" })).toBeDisabled();
  });

  it("saves org sharing only for manageable Canvas-owned accounts", async () => {
    const user = userEvent.setup();
    const onDisconnect = vi.fn();
    let requestBody: unknown;

    server.use(
      http.patch("/api/mcp-servers/provider-1/connections/:connectionId/access", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ success: true, connection: null });
      }),
    );

    renderSection(
      [
        {
          ...baseConnection,
          id: "secrets:viewer-1:github:github",
          source: "canvas_user_secrets",
          accountName: "Engineering GitHub",
          authType: "oauth",
          accessLevel: "personal",
          isOwnedByViewer: true,
          canManageAccess: true,
          canDelete: true,
        },
      ],
      onDisconnect,
    );

    await user.click(screen.getByRole("button", { name: "Open settings for GitHub" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Only you can use this connection.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(screen.getByRole("switch", { name: "Share with organization" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(requestBody).toEqual({ accessLevel: "organization" });
      expect(onDisconnect).toHaveBeenCalled();
    });
  });

  it("shows non-owner shared Canvas accounts as usable but not manageable", async () => {
    const user = userEvent.setup();

    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:github:github",
        source: "canvas_user_secrets",
        accessLevel: "organization",
        ownerName: "Tara",
        isOwnedByViewer: false,
        canManageAccess: false,
        canDelete: false,
      },
    ]);

    await user.click(screen.getByRole("button", { name: "Open settings for GitHub" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Owned by:/)).toBeInTheDocument();
    expect(within(dialog).getAllByText("Tara").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText("Owner: Tara")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Tara shared this connection with the organization. You can use it, but only the owner can manage access or credentials.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "Share with organization" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("suppresses email-derived shared account labels in the settings dialog", async () => {
    const user = userEvent.setup();

    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:aimfox:aimfox",
        source: "canvas_user_secrets",
        appId: "aimfox",
        appName: "Aimfox",
        accountName: "tanushyadav87@gmail.com's Aimfox Connection",
        accessLevel: "organization",
        ownerName: "Tanush Yadav",
        isOwnedByViewer: false,
        canManageAccess: false,
        canDelete: false,
      },
    ]);

    await user.click(screen.getByRole("button", { name: "Open settings for Aimfox" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Owned by:/)).toBeInTheDocument();
    expect(within(dialog).getAllByText("Tanush Yadav").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText(/gmail\.com/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Aimfox Connection/)).not.toBeInTheDocument();
  });

  it("does not render separator-only owner names from Canvas", async () => {
    const user = userEvent.setup();

    renderSection([
      {
        ...baseConnection,
        id: "secrets:owner-1:github:github",
        source: "canvas_user_secrets",
        accessLevel: "organization",
        ownerName: ".",
        ownerUserId: "owner-1",
        isOwnedByViewer: false,
        canManageAccess: false,
        canDelete: false,
      },
    ]);

    expect(screen.queryByText(/Owned by:/)).not.toBeInTheDocument();
    expect(screen.queryByText("teammate")).not.toBeInTheDocument();
    expect(screen.queryByText("Owner: .")).not.toBeInTheDocument();
    expect(screen.queryByText(".")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open settings for GitHub" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Owned by:/)).toBeInTheDocument();
    expect(within(dialog).getAllByText("teammate").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText("Owner: .")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "teammate shared this connection with the organization. You can use it, but only the owner can manage access or credentials.",
      ),
    ).toBeInTheDocument();
  });
});
