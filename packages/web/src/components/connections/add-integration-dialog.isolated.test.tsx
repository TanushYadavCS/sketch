import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddIntegrationDialog } from "./add-integration-dialog";

describe("AddIntegrationDialog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not verify a cancelled OAuth flow from an existing org-shared connection owned by someone else", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSuccess = vi.fn();
    const popup = { closed: false, close: vi.fn() };

    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

    server.use(
      http.get("/api/mcp-servers/provider-1/apps", () =>
        HttpResponse.json({
          apps: [{ id: "github", name: "GitHub", description: "Code hosting" }],
          pageInfo: { endCursor: null, hasMore: false },
        }),
      ),
      http.post("/api/mcp-servers/provider-1/connections", () =>
        HttpResponse.json({ redirectUrl: "https://example.com/oauth" }),
      ),
      http.get("/api/mcp-servers/provider-1/connections", () =>
        HttpResponse.json({
          connections: [
            {
              id: "secrets:owner-1:github:github",
              providerId: "provider-1",
              source: "canvas_user_secrets",
              appId: "github",
              appName: "GitHub",
              status: "active",
              accessLevel: "organization",
              ownerName: "Tara",
              isOwnedByViewer: false,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      ),
    );

    renderWithProviders(
      <AddIntegrationDialog
        open={true}
        onOpenChange={vi.fn()}
        providerId="provider-1"
        connectedAppIds={new Set()}
        onSuccess={onSuccess}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /GitHub/ }));
    expect(await screen.findByText("Waiting for authorization...")).toBeInTheDocument();

    popup.closed = true;
    vi.advanceTimersByTime(500);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Authorization cancelled" })).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
