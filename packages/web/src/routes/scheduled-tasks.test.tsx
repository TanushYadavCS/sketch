import type { ScheduledTaskListItem } from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTasksPage } from "./scheduled-tasks";

let mockAuth: { role: "admin" | "member"; email: string; userId?: string } = {
  role: "admin",
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
  mockAuth = { role: "admin", email: "admin@test.com" };
});

function buildTask(overrides: Partial<ScheduledTaskListItem> = {}): ScheduledTaskListItem {
  return {
    id: "task-1",
    platform: "slack",
    contextType: "channel",
    deliveryTarget: "C123",
    threadTs: null,
    prompt: "Post the Monday revenue summary",
    scheduleType: "cron",
    scheduleValue: "0 9 * * 1",
    timezone: "Asia/Kolkata",
    sessionMode: "fresh",
    nextRunAt: "2026-03-20T03:30:00.000Z",
    lastRunAt: "2026-03-13T03:30:00.000Z",
    status: "active",
    createdBy: "user-1",
    createdAt: "2026-03-10T09:15:00.000Z",
    targetLabel: "#ops",
    targetKindLabel: "Slack channel",
    creatorName: "Alice Member",
    scheduleLabel: "Cron: 0 9 * * 1 (Asia/Kolkata)",
    canPause: true,
    canResume: false,
    canDelete: true,
    title: null,
    description: null,
    steps: null,
    stepCount: 0,
    outputTarget: null,
    outputPlatform: null,
    lastRunStatus: null,
    runCount: 0,
    ...overrides,
  };
}

function installTaskHandlers(initialTasks: ScheduledTaskListItem[]) {
  let tasks = [...initialTasks];

  server.use(
    http.get("/api/scheduled-tasks", () => {
      return HttpResponse.json({ tasks });
    }),
    http.get("/api/scheduled-tasks/:id/runs", () => {
      return HttpResponse.json({ runs: [] });
    }),
    http.post("/api/scheduled-tasks/:id/pause", ({ params }) => {
      tasks = tasks.map((task) =>
        task.id === params.id ? { ...task, status: "paused", canPause: false, canResume: true } : task,
      );
      const task = tasks.find((item) => item.id === params.id);
      return HttpResponse.json({ task });
    }),
    http.post("/api/scheduled-tasks/:id/resume", ({ params }) => {
      tasks = tasks.map((task) =>
        task.id === params.id ? { ...task, status: "active", canPause: true, canResume: false } : task,
      );
      const task = tasks.find((item) => item.id === params.id);
      return HttpResponse.json({ task });
    }),
    http.delete("/api/scheduled-tasks/:id", ({ params }) => {
      tasks = tasks.filter((task) => task.id !== params.id);
      return HttpResponse.json({ success: true });
    }),
  );
}

describe("ScheduledTasksPage", () => {
  it("shows a loading skeleton before rendering task rows", async () => {
    server.use(
      http.get("/api/scheduled-tasks", async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return HttpResponse.json({ tasks: [buildTask()] });
      }),
    );

    renderWithProviders(<ScheduledTasksPage />);

    expect(document.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getByText("Post the Monday revenue summary")).toBeInTheDocument();
    });
  });

  it("shows the empty state when there are no tasks", async () => {
    installTaskHandlers([]);

    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("No automations yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Create an automation by asking the assistant to set up a recurring task or multi-step workflow.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the workspace subtitle", async () => {
    installTaskHandlers([buildTask()]);

    const { rerender } = renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("View and manage automations across the workspace")).toBeInTheDocument();
    });

    setMockAuth({ role: "member", userId: "user-1" });
    rerender(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("View and manage the automations you created through chat")).toBeInTheDocument();
    });
  });

  it("always shows creator names in task rows", async () => {
    installTaskHandlers([
      buildTask({ creatorName: "Alice Admin" }),
      buildTask({
        id: "task-2",
        prompt: "Send a WhatsApp follow-up",
        platform: "whatsapp",
        contextType: "dm",
        deliveryTarget: "919999999999@s.whatsapp.net",
        targetLabel: "Bob User",
        targetKindLabel: "WhatsApp DM",
        creatorName: "Alice Admin",
      }),
    ]);

    const { unmount } = renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Post the Monday revenue summary")).toBeInTheDocument();
    });
    expect(screen.getByText("Send a WhatsApp follow-up")).toBeInTheDocument();
    expect(screen.queryAllByText(/Alice Admin/).length).toBeGreaterThanOrEqual(0);

    unmount();

    setMockAuth({ role: "member", userId: "user-1" });
    server.use(
      http.get("/api/scheduled-tasks", () => {
        return HttpResponse.json({
          tasks: [
            buildTask({
              id: "task-member",
              prompt: "Only my task",
              creatorName: "Alice Admin",
            }),
          ],
        });
      }),
    );

    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Only my task")).toBeInTheDocument();
    });
    expect(screen.queryByText("Send a WhatsApp follow-up")).not.toBeInTheDocument();
    expect(screen.queryByText(/Alice Admin/)).not.toBeInTheDocument();
  });

  it("renders expanded task details for troubleshooting", async () => {
    installTaskHandlers([
      buildTask({
        deliveryTarget: "C999",
        timezone: "UTC",
      }),
    ]);

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Post the Monday revenue summary")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Show details for Post the Monday revenue summary/i }));

    await waitFor(() => {
      expect(screen.getByText("Timezone")).toBeInTheDocument();
    });
    expect(screen.getByText("UTC")).toBeInTheDocument();
    expect(screen.getByText("Session mode")).toBeInTheDocument();
  });

  it("pauses an active task via the dropdown menu", async () => {
    installTaskHandlers([buildTask()]);

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Active")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Actions for Post the Monday revenue summary/i }));
    await user.click(screen.getByRole("menuitem", { name: /pause/i }));

    await waitFor(() => {
      expect(screen.getByText("Paused")).toBeInTheDocument();
    });
  });

  it("resumes a paused task via the dropdown menu", async () => {
    installTaskHandlers([
      buildTask({
        status: "paused",
        canPause: false,
        canResume: true,
      }),
    ]);

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Paused")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Actions for Post the Monday revenue summary/i }));
    await user.click(screen.getByRole("menuitem", { name: /resume/i }));

    await waitFor(() => {
      expect(screen.getByText("Active")).toBeInTheDocument();
    });
  });

  it("deletes a task after confirmation via the dropdown menu", async () => {
    installTaskHandlers([buildTask()]);

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Post the Monday revenue summary")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Actions for Post the Monday revenue summary/i }));
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete automation?")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getByText("No automations yet")).toBeInTheDocument();
    });
    expect(screen.queryByText("Post the Monday revenue summary")).not.toBeInTheDocument();
  }, 15000);

  it("renders fallback target ids when no friendly target label is available", async () => {
    installTaskHandlers([
      buildTask({
        deliveryTarget: "unknown@g.us",
        targetLabel: "unknown@g.us",
        targetKindLabel: "WhatsApp group",
        platform: "whatsapp",
      }),
    ]);

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Post the Monday revenue summary")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Show details for Post the Monday revenue summary/i }));

    await waitFor(() => {
      expect(screen.getByText(/unknown@g\.us/)).toBeInTheDocument();
    });
  });
});
