import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { SidebarProvider } from "@sketch/ui/components/sidebar";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "./app-sidebar";

const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    useLocation: () => ({ pathname: "/channels" }),
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

  it("hides Settings link for members", () => {
    renderSidebar("member");

    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("shows the signed-in user's auth role in the footer", () => {
    renderSidebar("admin");

    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("hides the Review entities nav item when experimentalFlag is off", async () => {
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

    renderSidebar("admin");

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Review entities/i })).not.toBeInTheDocument();
    });
  });

  it("shows the Review entities nav item when experimentalFlag is on", async () => {
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
          experimentalFlag: true,
        }),
      ),
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [], total: 0 })),
    );

    renderSidebar("admin");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Review entities/i })).toBeInTheDocument();
    });
  });
});
