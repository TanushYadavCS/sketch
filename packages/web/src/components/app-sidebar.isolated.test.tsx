import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { SidebarProvider } from "@sketch/ui/components/sidebar";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "./app-sidebar";

const mockNavigate = vi.fn();
let mockPathname = "/channels";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    useLocation: () => ({ pathname: mockPathname }),
    useNavigate: () => mockNavigate,
  };
});

function renderSidebar(role?: "admin" | "member") {
  return renderWithProviders(
    <SidebarProvider>
      <AppSidebar displayName="User" displayIdentifier="user@test.com" role={role} />
    </SidebarProvider>,
  );
}

describe("AppSidebar", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockPathname = "/channels";
  });

  it("shows Home as the first primary tab and selects it on /home", () => {
    mockPathname = "/home";

    renderSidebar("admin");

    const primaryLabels = [
      "Home",
      "Channels",
      "Files",
      "Team",
      "Automations",
      "Skills",
      "Integrations",
      "Usage",
      "Settings",
    ];
    const navButtons = screen
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter((label): label is string => Boolean(label && primaryLabels.includes(label)));
    expect(navButtons[0]).toBe("Home");
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute("data-active", "true");
  });

  it("keeps Home selected while viewing the dedicated chat screen", () => {
    mockPathname = "/chat";

    renderSidebar("admin");

    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute("data-active", "true");
  });

  it("keeps Home selected while viewing a specific web chat conversation", () => {
    mockPathname = "/chat/web-chat-2026-05-26-abcdef";

    renderSidebar("admin");

    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute("data-active", "true");
  });

  it("shows Account link for managed admins", async () => {
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

    renderSidebar("admin");

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute("href", "https://app.getsketch.ai");
    });
  });

  it("hides Account link for managed members", async () => {
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

    renderSidebar("member");

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Account" })).not.toBeInTheDocument();
    });
  });

  it("shows Settings link for admins", () => {
    renderSidebar("admin");

    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("shows Settings link for members", () => {
    renderSidebar("member");

    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("shows the signed-in user's auth role in the footer", () => {
    renderSidebar("admin");

    expect(screen.getByText("Admin")).toBeInTheDocument();
  });
});
