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
    const requests: string[] = [];

    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

    server.use(
      http.get("/api/mcp-servers/provider-1/apps", ({ request }) => {
        const url = new URL(request.url);
        requests.push(url.searchParams.toString());
        return HttpResponse.json({
          apps: [{ id: "github", name: "GitHub", description: "Code hosting", icon: "https://example.com/github.png" }],
          pageInfo: { endCursor: null, hasMore: false },
        });
      }),
      http.post("/api/mcp-servers/provider-1/connections", async ({ request }) => {
        const body = await request.json();
        expect(body).toMatchObject({
          appId: "github",
          callbackUrl: `${window.location.origin}/integrations/callback`,
        });
        return HttpResponse.json({ redirectUrl: "https://example.com/oauth" });
      }),
    );

    renderWithProviders(
      <AddIntegrationDialog
        open={true}
        onOpenChange={onOpenChange}
        providerId="provider-1"
        connectedAppIds={new Set()}
        initialAppId="github"
        initialSearch="github"
        onSuccess={onSuccess}
      />,
    );

    expect(screen.queryByPlaceholderText("Search integrations...")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Connect GitHub" })).toBeInTheDocument();
    expect(screen.getByText("Code hosting")).toBeInTheDocument();
    expect(requests).toEqual(["q=github&limit=10"]);

    await user.click(screen.getByRole("button", { name: "Connect GitHub" }));

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
