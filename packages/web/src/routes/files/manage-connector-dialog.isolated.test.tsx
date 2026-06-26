import type { ConnectorConfig } from "@/lib/api";
import { getIntegration } from "@/lib/integrations";
// @vitest-environment jsdom
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { ManageConnectorDialog } from "./manage-connector-dialog";

const fireflies = getIntegration("fireflies") ?? null;
const gmail = getIntegration("gmail") ?? null;
const googleCalendar = getIntegration("google_calendar") ?? null;

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
    fileCount: 12,
    isOwner: true,
    canManage: true,
    canDisconnect: true,
    canSync: true,
    canChangeScope: true,
    canUpdateCredentials: true,
    canBrowseScope: true,
    canEnrich: true,
    ...overrides,
  };
}

describe("ManageConnectorDialog connector capabilities", () => {
  it("renders another user's per-user connector as read-only", async () => {
    let entityCountCalls = 0;
    server.use(
      http.get("/api/connectors/:id/entity-count", () => {
        entityCountCalls++;
        return HttpResponse.json({ count: 3 });
      }),
    );

    renderWithProviders(
      <ManageConnectorDialog
        definition={fireflies}
        connector={connector({
          isOwner: false,
          canManage: false,
          canDisconnect: false,
          canSync: false,
          canChangeScope: false,
          canUpdateCredentials: false,
          canBrowseScope: false,
          canEnrich: false,
        })}
        open
        onOpenChange={() => {}}
        onDisconnected={() => {}}
        onReconnect={() => {}}
      />,
    );

    expect(
      await screen.findByText("Read-only connection. Scope and credential controls are unavailable for this account."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Disconnect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sync now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Update credentials/i })).not.toBeInTheDocument();
    expect(entityCountCalls).toBe(0);
  });

  it("renders owner controls and fetches entity count only after disconnect confirm opens", async () => {
    const user = userEvent.setup();
    let entityCountCalls = 0;
    server.use(
      http.get("/api/connectors/:id/entity-count", () => {
        entityCountCalls++;
        return HttpResponse.json({ count: 3 });
      }),
    );

    renderWithProviders(
      <ManageConnectorDialog
        definition={fireflies}
        connector={connector()}
        open
        onOpenChange={() => {}}
        onDisconnected={() => {}}
        onReconnect={() => {}}
      />,
    );

    expect(await screen.findByRole("button", { name: /Sync now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Update credentials/i })).toBeInTheDocument();
    expect(entityCountCalls).toBe(0);

    await user.click(screen.getByRole("button", { name: /Disconnect/i }));

    expect(await screen.findByText("Disconnect Fireflies?")).toBeInTheDocument();
    await waitFor(() => expect(entityCountCalls).toBe(1));
  });

  it("passes the disconnected connector back to the Files page", async () => {
    const user = userEvent.setup();
    const onDisconnected = vi.fn();
    server.use(
      http.get("/api/connectors/:id/entity-count", () => HttpResponse.json({ count: 0 })),
      http.delete("/api/connectors/:id", () => HttpResponse.json({ success: true })),
    );

    renderWithProviders(
      <ManageConnectorDialog
        definition={fireflies}
        connector={connector({ id: "disconnect-me" })}
        open
        onOpenChange={() => {}}
        onDisconnected={onDisconnected}
        onReconnect={() => {}}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Disconnect/i }));
    const alert = await screen.findByRole("alertdialog");
    await user.click(within(alert).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(onDisconnected).toHaveBeenCalledTimes(1));
    expect(onDisconnected.mock.calls[0]?.[0]).toMatchObject({ id: "disconnect-me", connectorType: "fireflies" });
  });

  it("keeps Gmail management content constrained inside the dialog", async () => {
    server.use(
      http.get("/api/connectors/:id/suppressed-emails", () =>
        HttpResponse.json({ countsByReason: {}, recent: [], total: 0, hasMore: false }),
      ),
      http.get("/api/connectors/:id/email-threads", () =>
        HttpResponse.json({
          threads: Array.from({ length: 12 }, (_, index) => ({
            threadKey: `thread-${index}`,
            latestIndexedFileId: `file-${index}`,
            latestSubject: `Very long Gmail conversation subject ${index} that should truncate inside the modal row`,
            messageCount: index + 1,
            lastActivity: "2026-06-01T00:00:00Z",
            participants: [
              "Long Participant Name <long.participant@example.com>",
              "Another Participant <another.participant@example.com>",
            ],
          })),
          total: 12,
          hasMore: false,
        }),
      ),
    );

    renderWithProviders(
      <ManageConnectorDialog
        definition={gmail}
        connector={connector({ connectorType: "gmail", authType: "oauth", scopeConfig: { initialDays: 90 } })}
        open
        onOpenChange={() => {}}
        onDisconnected={() => {}}
        onReconnect={() => {}}
      />,
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveClass("max-h-[calc(100vh-2rem)]", "overflow-y-auto");

    const conversations = screen.getByText("Conversations").parentElement;
    expect(conversations).not.toBeNull();
    const list = await within(conversations as HTMLElement).findByRole("list");
    expect(list).toHaveClass("max-h-72", "overflow-y-auto");
  });

  it("saves Google Calendar scope as selected calendarIds", async () => {
    const user = userEvent.setup();
    let patchedBody: unknown;
    server.use(
      http.get("/api/connectors/:id/browse", () =>
        HttpResponse.json({
          type: "flat",
          scopeConfig: { calendarIds: [] },
          items: [
            { id: "primary", name: "Work" },
            { id: "team", name: "Team" },
          ],
        }),
      ),
      http.patch("/api/connectors/:id/scope", async ({ request }) => {
        patchedBody = await request.json();
        return HttpResponse.json({
          connector: {
            id: "calendar-conn",
            connectorType: "google_calendar",
            scopeConfig: { calendarIds: ["team"] },
            syncStatus: "syncing",
          },
        });
      }),
    );

    renderWithProviders(
      <ManageConnectorDialog
        definition={googleCalendar}
        connector={connector({
          id: "calendar-conn",
          connectorType: "google_calendar",
          authType: "oauth",
          scopeConfig: { calendarIds: [] },
          fileCount: 0,
        })}
        open
        onOpenChange={() => {}}
        onDisconnected={() => {}}
        onReconnect={() => {}}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Team" }));
    await user.click(screen.getByRole("button", { name: /Save & re-sync/i }));

    await waitFor(() => {
      expect(patchedBody).toEqual({ scopeConfig: { calendarIds: ["team"] } });
    });
  });
});
