// @vitest-environment jsdom
import type { ConnectorConfig } from "@/lib/api";
import { INTEGRATIONS } from "@/lib/integrations";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor, within } from "@testing-library/react";
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
        experimentalFlag: false,
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

function connectorRowByDescription(description: string): HTMLElement {
  const row = screen.getByText(description).closest(".rounded-lg");
  if (!row) throw new Error(`Could not find connector row for ${description}`);
  return row as HTMLElement;
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

  it("uses an existing native Canvas account when connecting a matching personal connector", async () => {
    const user = userEvent.setup();
    const importedBodies: unknown[] = [];
    setupStatus();
    server.use(
      http.get("/api/mcp-servers", () =>
        HttpResponse.json({
          servers: [
            {
              id: "provider-1",
              type: "canvas",
              slug: "canvas",
              displayName: "Canvas",
              url: "http://canvas.test",
              apiUrl: null,
              credentials: "configured",
              mode: "skill",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      ),
      http.get("/api/mcp-servers/provider-1/connections", () =>
        HttpResponse.json({
          connections: [
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
          ],
        }),
      ),
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
    renderPicker([]);

    await user.click(await screen.findByRole("button", { name: /Browse all/i }));
    await user.click(
      within(connectorRowByDescription("Email messages and threads")).getByRole("button", { name: "Connect" }),
    );

    await waitFor(() =>
      expect(importedBodies).toEqual([
        { connectorType: "gmail", accountId: "secrets:user-1:gmail:google-gmail-oauth" },
      ]),
    );
    expect(screen.queryByRole("button", { name: "Connect account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Canvas/)).not.toBeInTheDocument();
  });

  it("surfaces unfinished Google Calendar setup instead of looking connected", async () => {
    const user = userEvent.setup();
    setupStatus();
    const onManage = renderPicker([
      connector({
        id: "calendar-connector",
        connectorType: "google_calendar",
        authType: "oauth",
        scopeConfig: { calendarIds: [] },
        syncStatus: "paused",
        fileCount: 0,
        createdBy: "admin-1",
        canManage: true,
        canBrowseScope: true,
        canChangeScope: true,
      }),
    ]);

    await user.click(await screen.findByRole("button", { name: /Browse all/i }));

    expect(screen.getByText("Setup needed: choose calendars.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => expect(onManage).toHaveBeenCalledTimes(1));
    expect(onManage.mock.calls[0]?.[1].id).toBe("calendar-connector");
  });

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
