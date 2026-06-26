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

  it("opens a direct connect state for an initial app id", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();
    const popup = { closed: false, close: vi.fn() };
    const intentBodies: unknown[] = [];

    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

    server.use(
      http.get("/api/mcp-servers/provider-1/apps", () => {
        throw new Error("direct connect should not use app search");
      }),
      http.post("/api/mcp-servers/provider-1/connections/intents", async ({ request }) => {
        intentBodies.push(await request.json());
        return HttpResponse.json({
          app: { id: "gmail", name: "Gmail", description: "Email", icon: "https://example.com/gmail.png" },
          redirectUrl: "https://example.com/oauth",
        });
      }),
    );

    renderWithProviders(
      <AddIntegrationDialog
        open={true}
        onOpenChange={onOpenChange}
        providerId="provider-1"
        connectedAppIds={new Set()}
        initialAppId="google-gmail-oauth"
        initialSearch="google-gmail-oauth"
        onSuccess={onSuccess}
      />,
    );

    expect(screen.queryByPlaceholderText("Search integrations...")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Connect Gmail" })).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(intentBodies).toEqual([
      { appId: "google-gmail-oauth", callbackUrl: `${window.location.origin}/integrations/callback` },
    ]);

    await user.click(screen.getByRole("button", { name: "Connect Gmail" }));

    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith("https://example.com/oauth", "_blank", "width=600,height=700"),
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does not verify a cancelled OAuth flow from an existing org-shared connection owned by someone else", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSuccess = vi.fn();
    const popup = { closed: false, close: vi.fn(), location: { href: "" } };

    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

    server.use(
      http.get("/api/mcp-servers/provider-1/apps", () =>
        HttpResponse.json({
          apps: [{ id: "github", name: "GitHub", description: "Code hosting" }],
          pageInfo: { endCursor: null, hasMore: false },
        }),
      ),
      http.post("/api/mcp-servers/provider-1/connections/intents", () =>
        HttpResponse.json({
          app: { id: "github", name: "GitHub", description: "Code hosting" },
          redirectUrl: "https://example.com/oauth",
        }),
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
    expect(screen.getByText("Waiting for authorization...")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Authorization cancelled" })).not.toBeInTheDocument();

    vi.advanceTimersByTime(30_000);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Authorization cancelled" })).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
