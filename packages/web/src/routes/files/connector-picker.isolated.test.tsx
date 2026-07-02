// @vitest-environment jsdom
import type { ConnectorConfig } from "@/lib/api";
import { INTEGRATIONS } from "@/lib/integrations";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { ConnectorPicker } from "./connector-picker";

vi.mock("@/routes/dashboard", () => ({
  useDashboardAuth: () => ({
    role: "admin",
    userId: "admin-1",
    displayName: "Admin",
    displayIdentifier: "admin@test.com",
  }),
}));

function setupStatus() {
  server.use(
    http.get("/api/setup/status", () =>
      HttpResponse.json({
        completed: true,
        currentStep: 5,
        adminEmail: "admin@test.com",
        orgName: "Acme",
        botName: "Sketch",
        slackConnected: true,
        llmConnected: true,
        llmProvider: "anthropic",
      }),
    ),
  );
}

function connector(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    id: "conn-1",
    connectorType: "fireflies",
    authType: "api_key",
    scopeConfig: {},
    syncStatus: "active",
    lastSyncedAt: null,
    errorMessage: null,
    createdBy: "member-1",
    createdAt: "2026-01-01T00:00:00Z",
    fileCount: 5,
    isOwner: false,
    canManage: false,
    canDisconnect: false,
    canSync: false,
    canChangeScope: false,
    canUpdateCredentials: false,
    canBrowseScope: false,
    canEnrich: false,
    ...overrides,
  };
}

function sourceCountsFor(connectors: ConnectorConfig[]) {
  const counts = new Map<string, number>();
  for (const c of connectors) counts.set(c.connectorType, (counts.get(c.connectorType) ?? 0) + (c.fileCount ?? 0));
  return counts;
}

function connectorMemberCountsFor(connectors: ConnectorConfig[]) {
  const counts = new Map<string, Set<string>>();
  for (const c of connectors) {
    const owners = counts.get(c.connectorType) ?? new Set<string>();
    owners.add(c.createdBy);
    counts.set(c.connectorType, owners);
  }
  return Object.fromEntries([...counts.entries()].map(([type, owners]) => [type, owners.size]));
}

function renderPicker(
  connectors: ConnectorConfig[],
  onManage = vi.fn(),
  options: { teamMemberCount?: number; connectorMemberCounts?: Record<string, number> } = {},
) {
  renderWithProviders(
    <ConnectorPicker
      connectors={connectors}
      teamMemberCount={options.teamMemberCount ?? 3}
      connectorMemberCounts={options.connectorMemberCounts ?? connectorMemberCountsFor(connectors)}
      sourceCounts={sourceCountsFor(connectors)}
      totalFiles={5}
      localFileCount={0}
      sourceFilter={null}
      onSourceFilterChange={() => {}}
      onConnected={() => {}}
      onManageConnector={onManage}
    />,
  );
  return onManage;
}

describe("ConnectorPicker connector capabilities", () => {
  it.each(INTEGRATIONS.filter((def) => def.perUserAuth).map((def) => [def.name, def] as const))(
    "applies the visible account pattern to %s",
    async (_name, def) => {
      const user = userEvent.setup();
      setupStatus();
      renderPicker([
        connector({
          connectorType: def.type,
          authType: def.authType,
          fileCount: 7,
          createdByName: "Test Member",
          createdByEmail: "member@test.com",
          credentialHint: `${def.type}@provider.test`,
        }),
      ]);

      await user.click(await screen.findByRole("button", { name: /Browse all/i }));

      expect(screen.getByText(def.description)).toBeInTheDocument();
      expect(screen.queryByText("1 of 3 members connected")).not.toBeInTheDocument();
      expect(screen.queryByText("Test Member")).not.toBeInTheDocument();
      expect(screen.queryByText(`${def.type}@provider.test`)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Connect mine" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Manage" }));

      expect(screen.getByText("1 of 3 members connected")).toBeInTheDocument();
      expect(screen.getByText("Test Member")).toBeInTheDocument();
      expect(screen.getByText(`${def.type}@provider.test`)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View Test Member" })).toBeInTheDocument();
    },
    10000,
  );

  it("renders View and Connect mine for an admin seeing another user's per-user connector", async () => {
    const user = userEvent.setup();
    setupStatus();
    server.use(
      http.get("/api/oauth/microsoft/status", () =>
        HttpResponse.json({ configured: true, baseUrl: "http://localhost" }),
      ),
    );
    renderPicker([
      connector({
        connectorType: "outlook",
        authType: "oauth",
        fileCount: 12,
        createdByName: "Test Member",
        createdByEmail: "member@test.com",
        credentialHint: "member@microsoft.test",
      }),
    ]);

    await user.click(await screen.findByRole("button", { name: /Browse all/i }));

    expect(await screen.findAllByText("Outlook")).toHaveLength(2);
    expect(screen.getByText("Microsoft 365 email messages and threads")).toBeInTheDocument();
    expect(screen.queryByText("1 of 3 members connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Test Member")).not.toBeInTheDocument();
    expect(screen.queryByText("member@microsoft.test")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect mine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage" }));

    expect(screen.getByText("1 of 3 members connected")).toBeInTheDocument();
    expect(screen.getByText("Test Member")).toBeInTheDocument();
    expect(screen.getByText("member@microsoft.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View Test Member" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect mine" }));

    expect(await screen.findByRole("heading", { name: "Connect Outlook" })).toBeInTheDocument();
  });

  it("prefers the viewer's manageable per-user connector as the manage target", async () => {
    const user = userEvent.setup();
    setupStatus();
    const onManage = renderPicker([
      connector({ id: "other-conn", createdByName: "Test Member", credentialHint: "member@fireflies.test" }),
      connector({
        id: "own-conn",
        createdBy: "admin-1",
        createdByName: "Admin",
        credentialHint: "admin@fireflies.test",
        isOwner: true,
        canManage: true,
        canDisconnect: true,
        canSync: true,
        canChangeScope: true,
        canUpdateCredentials: true,
        canBrowseScope: true,
        canEnrich: true,
      }),
    ]);

    await user.click(await screen.findByRole("button", { name: /Browse all/i }));
    expect(screen.getByText("Meeting transcripts and summaries")).toBeInTheDocument();
    expect(screen.queryByText("2 of 3 members connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Test Member")).not.toBeInTheDocument();
    expect(screen.queryByText("member@fireflies.test")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage" }));

    expect(screen.getByText("2 of 3 members connected")).toBeInTheDocument();
    expect(screen.getByText("Test Member")).toBeInTheDocument();
    expect(screen.getByText("member@fireflies.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View Test Member" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View Test Member" }));

    await waitFor(() => expect(onManage).toHaveBeenCalledTimes(1));
    expect(onManage.mock.calls[0]?.[1].id).toBe("other-conn");

    await user.click(await screen.findByRole("button", { name: /Browse all/i }));
    await user.click(await screen.findByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("button", { name: "Manage You" }));

    await waitFor(() => expect(onManage).toHaveBeenCalledTimes(2));
    expect(onManage.mock.calls[1]?.[1].id).toBe("own-conn");
  });
});
