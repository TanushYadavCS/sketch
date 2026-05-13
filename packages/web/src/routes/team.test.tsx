import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamPage } from "./team";

let mockAuth: { email: string; userId?: string } = {
  email: "admin@test.com",
};

function setMockAuth(auth: Partial<typeof mockAuth>) {
  mockAuth = { ...mockAuth, ...auth };
}

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    useRouteContext: () => ({ auth: mockAuth }),
  };
});

afterEach(() => {
  mockAuth = { email: "admin@test.com" };
});

describe("TeamPage", () => {
  it("uses the shared dashboard page width", () => {
    const { container } = renderWithProviders(<TeamPage />);

    expect(container.firstElementChild).toHaveClass("mx-auto", "box-content", "max-w-4xl", "px-10", "py-8");
    expect(container.firstElementChild?.className).not.toContain("max-w-[");
  });

  it("renders member list", async () => {
    renderWithProviders(<TeamPage />);

    await waitFor(() => {
      expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    });
    expect(screen.getByText("Bob Jones")).toBeInTheDocument();
    expect(screen.getByText("Team members")).toBeInTheDocument();
  });

  it("shows empty state when no users", async () => {
    server.use(
      http.get("/api/users", () => {
        return HttpResponse.json({ users: [] });
      }),
    );
    renderWithProviders(<TeamPage />);

    await waitFor(() => {
      expect(screen.getByText("Your team's empty!")).toBeInTheDocument();
    });
  });

  it("shows loading skeleton initially", () => {
    renderWithProviders(<TeamPage />);
    const skeletons = document.querySelectorAll("[data-slot='skeleton']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  describe("Add member dialog", () => {
    it("opens when clicking Add member button", async () => {
      const user = userEvent.setup();
      renderWithProviders(<TeamPage />);

      await waitFor(() => {
        expect(screen.getByText("Alice Smith")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /Add member/i }));

      await waitFor(() => {
        expect(screen.getByText("Add a new team member. Name and email are required.")).toBeInTheDocument();
      });
    });

    it("disables submit when email is missing", async () => {
      const user = userEvent.setup();
      renderWithProviders(<TeamPage />);

      await waitFor(() => {
        expect(screen.getByText("Alice Smith")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /Add member/i }));

      const dialog = await screen.findByRole("dialog");

      await user.type(within(dialog).getByLabelText("Name"), "Charlie");

      expect(within(dialog).getByRole("button", { name: "Add member" })).toBeDisabled();
    }, 15000);

    it("creates a user on submit", async () => {
      const createFn = vi.fn();
      server.use(
        http.post("/api/users", async ({ request }) => {
          const body = (await request.json()) as { name: string; email: string | null; whatsappNumber: string | null };
          createFn(body);
          return HttpResponse.json(
            {
              user: {
                id: "u-new",
                name: body.name,
                email: body.email,
                slack_user_id: null,
                whatsapp_number: body.whatsappNumber,
                created_at: new Date().toISOString(),
              },
            },
            { status: 201 },
          );
        }),
      );

      const user = userEvent.setup();
      renderWithProviders(<TeamPage />);

      await waitFor(() => {
        expect(screen.getByText("Alice Smith")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /Add member/i }));

      const dialog = await screen.findByRole("dialog");

      await user.type(within(dialog).getByLabelText("Name"), "Charlie");
      await user.type(within(dialog).getByLabelText("Email"), "charlie@test.com");
      await user.type(within(dialog).getByLabelText("WhatsApp number"), "+14155551234");
      await user.click(within(dialog).getByRole("button", { name: "Add member" }));

      await waitFor(() => {
        expect(createFn).toHaveBeenCalledWith({
          name: "Charlie",
          type: "human",
          role: null,
          reportsTo: null,
          email: "charlie@test.com",
          whatsappNumber: "+14155551234",
          description: null,
        });
      });
    }, 15000);

    it("shows inline error on duplicate number", async () => {
      server.use(
        http.post("/api/users", () => {
          return HttpResponse.json(
            { error: { code: "CONFLICT", message: "This email or number is already linked to another member" } },
            { status: 409 },
          );
        }),
      );

      const user = userEvent.setup();
      renderWithProviders(<TeamPage />);

      await waitFor(() => {
        expect(screen.getByText("Alice Smith")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /Add member/i }));

      await waitFor(() => {
        expect(screen.getByLabelText("Name")).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText("Name"), "Dupe");
      await user.type(screen.getByLabelText("Email"), "dupe@test.com");
      await user.type(screen.getByLabelText("WhatsApp number"), "+919876543210");
      await user.click(screen.getByRole("button", { name: "Add member" }));

      await waitFor(() => {
        expect(screen.getByText("This email or number is already linked to another member")).toBeInTheDocument();
      });
    });

    it("uses the same capped form viewport when the dialog opens", async () => {
      const user = userEvent.setup();
      renderWithProviders(<TeamPage />);

      await waitFor(() => {
        expect(screen.getByText("Alice Smith")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /Add member/i }));

      const dialog = await screen.findByRole("dialog");
      const formBody = within(dialog).getByRole("button", { name: "Human" }).parentElement?.parentElement;

      expect(dialog).not.toHaveClass("data-[state=open]:zoom-in-95");
      expect(dialog).not.toHaveClass("data-[state=closed]:zoom-out-95");
      expect(formBody).toHaveClass("max-h-[50vh]");
      expect(formBody).toHaveClass("overflow-y-auto");
    });

    it("keeps the agent form in the same capped scroll viewport inside the dialog", async () => {
      const user = userEvent.setup();
      renderWithProviders(<TeamPage />);

      await waitFor(() => {
        expect(screen.getByText("Alice Smith")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /Add member/i }));

      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Agent" }));

      const formBody = within(dialog).getByRole("button", { name: "Human" }).parentElement?.parentElement;

      expect(dialog).not.toHaveClass("overflow-hidden");
      expect(formBody).toHaveClass("max-h-[50vh]");
      expect(formBody).toHaveClass("overflow-y-auto");
      expect(within(dialog).getByRole("button", { name: "Add agent" })).toBeInTheDocument();
    });
  });

  it("shows 'You' badge when userId matches a member", async () => {
    setMockAuth({ userId: "u1" });

    renderWithProviders(<TeamPage />);

    await waitFor(() => {
      expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    });

    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("does not show 'You' badge when userId does not match", async () => {
    setMockAuth({ userId: "u-other" });

    renderWithProviders(<TeamPage />);

    await waitFor(() => {
      expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    });

    expect(screen.queryByText("You")).not.toBeInTheDocument();
  });

  describe("Remove member dialog", () => {
    it("opens from overflow menu and removes on confirm", async () => {
      const removeFn = vi.fn();
      server.use(
        http.delete("/api/users/:id", () => {
          removeFn();
          return HttpResponse.json({ success: true });
        }),
      );

      const user = userEvent.setup();
      renderWithProviders(<TeamPage />);

      await waitFor(() => {
        expect(screen.getByText("Alice Smith")).toBeInTheDocument();
      });

      const menuTriggers = screen.getAllByRole("button").filter((btn) => btn.querySelector("svg"));
      const overflowBtn = menuTriggers[menuTriggers.length - 1];
      await user.click(overflowBtn);

      await waitFor(() => {
        expect(screen.getByText("Remove member")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Remove member"));

      await waitFor(() => {
        expect(screen.getByText("Remove team member?")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Remove" }));

      await waitFor(() => {
        expect(removeFn).toHaveBeenCalled();
      });
    });
  });
});
