import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...mod,
    useRouteContext: () => ({
      auth: {
        displayName: "Test User",
        displayIdentifier: "user@test.com",
      },
    }),
  };
});

import { SkillsPage } from "./skills";

const mockSkills = [
  {
    id: "s1",
    name: "CRM Lead Creator",
    description: "Creates leads in the CRM system",
    category: "crm",
    body: "You are a CRM assistant.",
  },
  {
    id: "s2",
    name: "Meeting Scheduler",
    description: "Schedules meetings with team members",
    category: "productivity",
    body: "You schedule meetings.",
  },
  {
    id: "s3",
    name: "Slack Notifier",
    description: "Sends notifications to Slack channels",
    category: "comms",
    body: "You send Slack notifications.",
  },
];

function skillsHandler(skills = mockSkills) {
  server.use(
    http.get("/api/skills", () => {
      return HttpResponse.json({ skills });
    }),
  );
}

describe("SkillsPage", () => {
  it("renders skill cards", async () => {
    skillsHandler();
    renderWithProviders(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText("CRM Lead Creator")).toBeInTheDocument();
    });
    expect(screen.getByText("Meeting Scheduler")).toBeInTheDocument();
    expect(screen.getByText("Slack Notifier")).toBeInTheDocument();
  });

  it("shows loading skeleton initially", () => {
    skillsHandler();
    renderWithProviders(<SkillsPage />);
    const skeletons = document.querySelectorAll("[data-slot='skeleton']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state with Create button when no skills exist", async () => {
    skillsHandler([]);
    renderWithProviders(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText("Teach Sketch new tricks")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Create Your First Skill/i })).toBeInTheDocument();
  });

  it("shows error state when API fails", async () => {
    server.use(
      http.get("/api/skills", () => {
        return HttpResponse.json({ error: { code: "INTERNAL", message: "DB error" } }, { status: 500 });
      }),
    );
    renderWithProviders(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load skills/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows Create Skill button in header", async () => {
    skillsHandler();
    renderWithProviders(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText("CRM Lead Creator")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Create Skill/i })).toBeInTheDocument();
  });

  it("filters skills by search query", async () => {
    skillsHandler();
    const user = userEvent.setup();
    renderWithProviders(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText("CRM Lead Creator")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Search active skills/i);
    await user.type(searchInput, "CRM");

    expect(screen.getByText("CRM Lead Creator")).toBeInTheDocument();
    expect(screen.queryByText("Meeting Scheduler")).not.toBeInTheDocument();
    expect(screen.queryByText("Slack Notifier")).not.toBeInTheDocument();
  });

  it("opens skill detail view when clicking a card", async () => {
    skillsHandler();
    const user = userEvent.setup();
    renderWithProviders(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText("CRM Lead Creator")).toBeInTheDocument();
    });

    await user.click(screen.getByText("CRM Lead Creator"));

    await waitFor(() => {
      expect(screen.getByText("You are a CRM assistant.")).toBeInTheDocument();
    });
  });

  it("opens create form when clicking Create Skill", async () => {
    skillsHandler();
    const user = userEvent.setup();
    renderWithProviders(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Create Skill/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Create Skill/i }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Skill name...")).toBeInTheDocument();
    });
  });

  it("calls create API on save", async () => {
    skillsHandler();
    const createFn = vi.fn();
    server.use(
      http.post("/api/skills", async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createFn(body);
        return HttpResponse.json({
          skill: {
            id: "s-new",
            name: body.name,
            description: body.description,
            category: body.category,
            body: body.body,
          },
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Create Skill/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Create Skill/i }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Skill name...")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("Skill name..."), "New Skill");
    await user.type(screen.getByLabelText(/Description/i), "A test skill");
    await user.type(screen.getByLabelText(/Body/i), "Do something useful");

    await user.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => {
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "New Skill",
          description: "A test skill",
          body: "Do something useful",
        }),
      );
    });
  });

  it("calls delete API when deleting a skill", async () => {
    skillsHandler();
    const deleteFn = vi.fn();
    server.use(
      http.delete("/api/skills/:id", ({ params }) => {
        deleteFn(params.id);
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<SkillsPage />);

    await waitFor(() => {
      expect(screen.getByText("CRM Lead Creator")).toBeInTheDocument();
    });

    await user.click(screen.getByText("CRM Lead Creator"));

    await waitFor(() => {
      expect(screen.getByText("You are a CRM assistant.")).toBeInTheDocument();
    });

    const menuTriggers = screen.getAllByRole("button").filter((btn) => btn.querySelector("svg"));
    const actionMenuBtn = menuTriggers[menuTriggers.length - 1];
    await user.click(actionMenuBtn);

    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(screen.getByText(/permanently removed/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Delete/i }));

    await waitFor(() => {
      expect(deleteFn).toHaveBeenCalledWith("s1");
    });
  });
});
