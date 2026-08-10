import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => ({
  value: {
    role: "admin" as "admin" | "member",
    displayName: "User",
    displayIdentifier: "user@test.com",
    managedUrl: undefined as string | undefined,
  },
}));
const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...mod,
    useRouteContext: () => ({
      auth: mockAuth.value,
    }),
  };
});
vi.mock("sonner", async (importOriginal) => {
  const mod = await importOriginal<typeof import("sonner")>();
  return { ...mod, toast: mockToast };
});

import { ChannelsPage } from "./channels";

function channelsHandler(
  slack: { configured: boolean; connected: boolean | null },
  whatsapp: {
    configured: boolean;
    connected: boolean | null;
    phoneNumber?: string;
    state?: "needs-pairing" | "connected" | "reconnecting" | "paused";
  },
  email?: { configured: boolean; connected: boolean | null; fromAddress?: string },
) {
  server.use(
    http.get("/api/channels/status", () => {
      return HttpResponse.json({
        channels: [
          { platform: "slack", ...slack, phoneNumber: null, fromAddress: null },
          { platform: "whatsapp", phoneNumber: null, fromAddress: null, ...whatsapp },
          {
            platform: "email",
            configured: email?.configured ?? false,
            connected: email?.connected ?? null,
            phoneNumber: null,
            fromAddress: email?.fromAddress ?? null,
          },
        ],
      });
    }),
  );
}

describe("ChannelsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/channels");
    mockAuth.value = {
      role: "admin",
      displayName: "User",
      displayIdentifier: "user@test.com",
      managedUrl: undefined,
    };
  });

  it("renders both platform cards", async () => {
    renderWithProviders(<ChannelsPage />);

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });
    expect(screen.getByText("WhatsApp")).toBeInTheDocument();
  });

  describe("Slack card", () => {
    it("shows not-configured state with Connect button", async () => {
      channelsHandler({ configured: false, connected: null }, { configured: false, connected: null });
      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByText("Slack")).toBeInTheDocument();
      });

      expect(screen.getByText("Connect a Slack workspace to get started")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    });

    it("shows connected state with green check", async () => {
      channelsHandler({ configured: true, connected: true }, { configured: false, connected: null });
      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByText("Slack")).toBeInTheDocument();
      });

      expect(screen.getByText("Connected")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    });

    it("shows Add to Slack for a disconnected managed tenant", async () => {
      mockAuth.value = {
        role: "admin",
        displayName: "User",
        displayIdentifier: "user@test.com",
        managedUrl: "https://app.getsketch.ai/",
      };
      channelsHandler({ configured: false, connected: null }, { configured: false, connected: null });
      renderWithProviders(<ChannelsPage />);

      const link = await screen.findByRole("link", { name: "Add to Slack" });
      const url = new URL(link.getAttribute("href") ?? "");

      expect(url.origin).toBe("https://app.getsketch.ai");
      expect(url.pathname).toBe("/api/slack/connections/authorization");
      expect(url.searchParams.get("return_to")).toBe(`${window.location.origin}/channels`);
      expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    });

    it("shows a successful managed callback and removes its query parameters", async () => {
      mockAuth.value = {
        role: "admin",
        displayName: "User",
        displayIdentifier: "user@test.com",
        managedUrl: "https://app.getsketch.ai/",
      };
      window.history.replaceState(null, "", "/channels?slack=connected");
      channelsHandler({ configured: true, connected: true }, { configured: false, connected: null });

      renderWithProviders(<ChannelsPage />);

      await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("Slack connected."));
      expect(window.location.search).toBe("");
    });

    it("resumes Slack authorization after managed login", async () => {
      const assignSpy = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
      mockAuth.value = {
        role: "admin",
        displayName: "User",
        displayIdentifier: "user@test.com",
        managedUrl: "https://app.getsketch.ai/",
      };
      window.history.replaceState(null, "", "/channels?connect=slack");
      channelsHandler({ configured: false, connected: null }, { configured: false, connected: null });

      renderWithProviders(<ChannelsPage />);

      await waitFor(() => expect(assignSpy).toHaveBeenCalledOnce());
      const authorizationUrl = new URL(String(assignSpy.mock.calls[0]?.[0]));
      expect(authorizationUrl.origin).toBe("https://app.getsketch.ai");
      expect(authorizationUrl.pathname).toBe("/api/slack/connections/authorization");
      expect(authorizationUrl.searchParams.get("return_to")).toBe(`${window.location.origin}/channels`);
      expect(window.location.search).toBe("");
    });

    it("ignores managed callback parameters in a self-hosted deployment", async () => {
      window.history.replaceState(null, "", "/channels?slack=connected");
      channelsHandler({ configured: false, connected: null }, { configured: false, connected: null });

      renderWithProviders(<ChannelsPage />);

      await screen.findByText("Slack");
      expect(mockToast.success).not.toHaveBeenCalled();
      expect(window.location.search).toBe("?slack=connected");
    });
  });

  describe("member access", () => {
    it("renders disconnected channels without mutation controls for members", async () => {
      mockAuth.value = {
        role: "member",
        displayName: "Member",
        displayIdentifier: "member@test.com",
        managedUrl: undefined,
      };
      channelsHandler(
        { configured: false, connected: null },
        { configured: false, connected: null },
        { configured: false, connected: null },
      );

      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByText("Channel settings are managed by admins.")).toBeInTheDocument();
      });

      expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Pair" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Configure" })).not.toBeInTheDocument();
    });

    it("renders connected channels without action menus for members", async () => {
      mockAuth.value = {
        role: "member",
        displayName: "Member",
        displayIdentifier: "member@test.com",
        managedUrl: undefined,
      };
      channelsHandler(
        { configured: true, connected: true },
        { configured: true, connected: true, phoneNumber: "+1234567890" },
        { configured: true, connected: true, fromAddress: "noreply@example.com" },
      );

      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByText("Channel settings are managed by admins.")).toBeInTheDocument();
      });

      expect(screen.queryByRole("button", { name: "Slack actions" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "WhatsApp actions" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Email actions" })).not.toBeInTheDocument();
    });
  });

  describe("WhatsApp card", () => {
    it("shows not-configured state with Pair button", async () => {
      channelsHandler({ configured: false, connected: null }, { configured: false, connected: null });
      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByText("WhatsApp")).toBeInTheDocument();
      });

      expect(screen.getByText("Pair a WhatsApp number to get started")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Pair" })).toBeInTheDocument();
    });

    it("shows connected state with phone number", async () => {
      channelsHandler(
        { configured: false, connected: null },
        { configured: true, connected: true, phoneNumber: "+1234567890" },
      );
      renderWithProviders(<ChannelsPage />);

      expect(await screen.findByText(/\+1234567890/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Pair" })).not.toBeInTheDocument();
    });

    /**
     * A dropped socket recovers on its own, so the card must say so rather than implying the admin
     * broke something — and it must never offer Pair, which would unlink a working number.
     */
    it("tells a reconnecting tenant that no action is needed", async () => {
      channelsHandler(
        { configured: false, connected: null },
        { configured: true, connected: false, phoneNumber: "+1234567890", state: "reconnecting" },
      );
      renderWithProviders(<ChannelsPage />);

      expect(await screen.findByText(/Reconnecting/)).toBeInTheDocument();
      expect(screen.getByText(/no action needed/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Pair" })).not.toBeInTheDocument();
    });

    /**
     * The paused card's whole job is to stop an admin re-scanning a QR they do not need to
     * re-scan, so it has to name the number and say the credentials are still on file.
     */
    it("tells a paused tenant its connection details are still saved", async () => {
      channelsHandler(
        { configured: false, connected: null },
        { configured: true, connected: false, phoneNumber: "+1234567890", state: "paused" },
      );
      renderWithProviders(<ChannelsPage />);

      expect(await screen.findByText("Paused")).toBeInTheDocument();
      expect(screen.getByText(/We couldn't connect to WhatsApp for \+1234567890/)).toBeInTheDocument();
      expect(screen.getByText(/We'll try again automatically/)).toBeInTheDocument();
      expect(screen.getByText(/still saved/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Pair" })).not.toBeInTheDocument();
    });
  });

  describe("alert banner", () => {
    it("shows when both channels are not connected", async () => {
      channelsHandler({ configured: false, connected: null }, { configured: false, connected: null });
      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByText(/No channels connected/)).toBeInTheDocument();
      });
    });

    it("hidden when at least one channel is connected", async () => {
      channelsHandler({ configured: true, connected: true }, { configured: false, connected: null });
      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByText("Slack")).toBeInTheDocument();
      });

      expect(screen.queryByText(/No channels connected/)).not.toBeInTheDocument();
    });
  });

  describe("Slack connect dialog", () => {
    it("opens when clicking Connect and shows token inputs", async () => {
      channelsHandler({ configured: false, connected: null }, { configured: false, connected: null });

      const user = userEvent.setup();
      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        expect(screen.getByText("Connect Slack")).toBeInTheDocument();
      });

      expect(screen.getByLabelText("Bot Token")).toBeInTheDocument();
      expect(screen.getByLabelText("App-Level Token")).toBeInTheDocument();
    });

    it("disables Connect button without both tokens filled", async () => {
      channelsHandler({ configured: false, connected: null }, { configured: false, connected: null });

      const user = userEvent.setup();
      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        expect(screen.getByText("Connect Slack")).toBeInTheDocument();
      });

      const connectButtons = screen.getAllByRole("button", { name: "Connect" });
      const dialogConnectBtn = connectButtons[connectButtons.length - 1];
      expect(dialogConnectBtn).toBeDisabled();
    });
  });

  describe("Slack disconnect", () => {
    it("shows disconnect confirmation dialog from dropdown", async () => {
      channelsHandler({ configured: true, connected: true }, { configured: false, connected: null });

      const user = userEvent.setup();
      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByText("Connected")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Slack actions" }));
      await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));

      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText("Disconnect Slack?")).toBeInTheDocument();
    }, 15000);

    it("calls disconnect API on confirm", async () => {
      const disconnectFn = vi.fn();
      server.use(
        http.delete("/api/channels/slack", () => {
          disconnectFn();
          return HttpResponse.json({ success: true });
        }),
      );
      channelsHandler({ configured: true, connected: true }, { configured: false, connected: null });

      const user = userEvent.setup();
      renderWithProviders(<ChannelsPage />);

      await waitFor(() => {
        expect(screen.getByText("Connected")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Slack actions" }));
      await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));

      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

      await waitFor(() => {
        expect(disconnectFn).toHaveBeenCalled();
      });
    }, 15000);
  });
});
