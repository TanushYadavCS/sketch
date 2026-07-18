import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { SidebarProvider } from "@sketch/ui/components/sidebar";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "./app-sidebar";

const mockNavigate = vi.fn();
let mockPathname = "/home";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  const React = await import("react");
  const Link = React.forwardRef<
    HTMLAnchorElement,
    {
      to: string;
      params?: Record<string, string>;
      children?: React.ReactNode;
      viewTransition?: unknown;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>
  >(({ to, params, children, viewTransition: _viewTransition, ...props }, ref) => {
    const href = params
      ? Object.entries(params).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)
      : to;
    return React.createElement("a", { ...props, ref, href }, children);
  });
  return {
    ...actual,
    Link,
    useLocation: () => ({ pathname: mockPathname }),
    useNavigate: () => mockNavigate,
  };
});

function renderSidebar(role?: "admin" | "member", defaultOpen = true) {
  return renderWithProviders(
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar displayName="User" displayIdentifier="user@test.com" role={role} />
    </SidebarProvider>,
  );
}

function conversations(count: number) {
  server.use(
    http.get("/api/web-chat/conversations", () =>
      HttpResponse.json({
        conversations: Array.from({ length: count }, (_, index) => ({
          id: `chat-${index + 1}`,
          title: `Conversation ${index + 1}`,
          channel: "web",
          updatedAt: `2026-07-${String(17 - index).padStart(2, "0")}T08:00:00.000Z`,
        })),
      }),
    ),
  );
}

describe("AppSidebar", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockPathname = "/home";
  });

  it("renders top actions and the pinned surface hierarchy", () => {
    renderSidebar("admin");

    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    const labels = links.map((link) => link.textContent?.trim()).filter(Boolean);
    expect(labels.slice(0, 5)).toEqual(["Add integration", "Home", "Agents", "Your org", "Automations"]);
    expect(screen.queryByRole("link", { name: "Chat" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("data-active", "true");
  });

  it("treats web chat as part of Home while marking the current recent row", async () => {
    conversations(1);
    mockPathname = "/chat/chat-1";
    renderSidebar("admin");

    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("data-active", "true");
    expect(await screen.findByRole("link", { name: /Conversation 1/ })).toHaveAttribute("aria-current", "page");
  });

  it("opens a fresh conversation directly from New chat", async () => {
    const user = userEvent.setup();
    renderSidebar("admin");

    await user.click(screen.getByRole("button", { name: "New chat" }));

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/chat/$conversationId",
        search: { new: true },
      }),
    );
  });

  it("opens More inline and exposes the production destinations", async () => {
    const user = userEvent.setup();
    renderSidebar("admin");

    const trigger = screen.getByRole("button", { name: "Show more destinations" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Access" })).toHaveAttribute("href", "/team");
    expect(screen.getByRole("link", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });

  it("defaults More open when one of its child routes is active", () => {
    mockPathname = "/channels";
    renderSidebar("admin");

    expect(screen.getByRole("button", { name: "Hide more destinations" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Channels" })).toHaveAttribute("data-active", "true");
  });

  it("uses a dropdown for More when the desktop rail is collapsed", async () => {
    const user = userEvent.setup();
    renderSidebar("admin", false);

    await user.click(screen.getByRole("button", { name: "More destinations" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Files" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Access" })).toBeInTheDocument();
  });

  it("renders real recents, caps them at five, and does not fabricate status rows", async () => {
    conversations(7);
    renderSidebar("admin");

    expect(await screen.findByRole("link", { name: /Conversation 1/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Conversation 5/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Conversation 6/ })).not.toBeInTheDocument();
    expect(screen.queryByText("working")).not.toBeInTheDocument();
  });

  it("renders a quiet empty state when there are no conversations", async () => {
    renderSidebar("admin");

    expect(await screen.findByText("No recent conversations")).toBeInTheDocument();
  });

  it("shows the scoped Your Org count to admins and hides the row from members", async () => {
    server.use(http.get("/api/entity-review", () => HttpResponse.json({ rows: [], total: 3 })));
    const { unmount } = renderSidebar("admin");

    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Your org/ })).toBeInTheDocument();
    unmount();

    renderSidebar("member");
    expect(screen.queryByRole("link", { name: /Your org/ })).not.toBeInTheDocument();
  });

  it("shows managed Account only to admins", async () => {
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
          managedUrl: "https://app.getsketch.ai",
        }),
      ),
    );
    mockPathname = "/channels";
    const { unmount } = renderSidebar("admin");

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute("href", "https://app.getsketch.ai"),
    );
    unmount();

    renderSidebar("member");
    await waitFor(() => expect(screen.queryByRole("link", { name: "Account" })).not.toBeInTheDocument());
  });

  it("shows the signed-in role in the profile trigger", () => {
    renderSidebar("admin");

    expect(screen.getByRole("button", { name: "Account menu, signed in as User" })).toHaveTextContent("Admin");
  });

  it("keeps settings and usage in More instead of duplicating them in the profile menu", async () => {
    const user = userEvent.setup();
    renderSidebar("admin");

    await user.click(screen.getByRole("button", { name: "Show more destinations" }));
    expect(screen.getAllByRole("link", { name: /^(Settings|Usage)$/ })).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Account menu, signed in as User" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Usage" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Theme/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();
  });
});
