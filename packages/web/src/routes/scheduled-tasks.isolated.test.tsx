import type { AutomationRunItem, ScheduledTaskListItem } from "@/lib/api";
import { AUTOMATION_REFRESH_INTERVAL_MS } from "@/lib/automation-refresh";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTasksPage } from "./scheduled-tasks";

let mockAuth: { role: "admin" | "member"; email: string; userId?: string } = {
  role: "admin",
  email: "admin@test.com",
};
const mockNavigate = vi.fn();

function setMockAuth(auth: Partial<typeof mockAuth>) {
  mockAuth = { ...mockAuth, ...auth };
}

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    useRouteContext: () => ({ auth: mockAuth }),
    useNavigate: () => mockNavigate,
  };
});

afterEach(() => {
  vi.useRealTimers();
  mockAuth = { role: "admin", email: "admin@test.com" };
  mockNavigate.mockReset();
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
    originChat: null,
    steps: null,
    stepCount: 0,
    triggerConfig: null,
    outputTarget: null,
    outputPlatform: null,
    outputThreadTs: null,
    outputMode: "deliver",
    delivery: {
      platform: "slack",
      targetType: "channel",
      targetId: "C123",
      threadTs: null,
      mode: "deliver",
      label: "#ops",
    },
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
    expect(screen.getByText("Mondays at 9:00 AM")).toBeInTheDocument();
  });

  it("renders a Slack channel message trigger and channel in the automation list", async () => {
    installTaskHandlers([
      buildTask({
        scheduleType: "external",
        scheduleValue: "slack_channel_message",
        scheduleLabel: "Slack channel message - C123",
        triggerConfig: { type: "slack_channel_message", channelId: "C123" },
      }),
    ]);

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    expect(await screen.findByText("Trigger · Slack channel message · C123")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Show details for Post the Monday revenue summary/i }));
    expect(await screen.findByText("Trigger-based")).toBeInTheDocument();
    expect(screen.getByText("Slack channel message · C123")).toBeInTheDocument();
    expect(screen.queryByText("Timezone")).not.toBeInTheDocument();
    expect(screen.queryByText("Next run")).not.toBeInTheDocument();
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
    expect(screen.getAllByRole("button", { name: "Create automation" })).toHaveLength(2);
  });

  it("creates an admin draft and navigates to its fresh builder conversation", async () => {
    installTaskHandlers([]);
    server.use(
      http.post("/api/scheduled-tasks", () =>
        HttpResponse.json({ automationId: "draft-1", conversationId: "builder-draft-1" }, { status: 201 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => expect(screen.getByText("No automations yet")).toBeInTheDocument());
    await user.click(screen.getAllByRole("button", { name: "Create automation" })[0]);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId: "draft-1" },
        search: { conversationId: "builder-draft-1" },
      });
    });
  });

  it("keeps create automation actions hidden for members", async () => {
    setMockAuth({ role: "member", userId: "member-1" });
    installTaskHandlers([]);

    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => expect(screen.getByText("No automations yet")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Create automation" })).not.toBeInTheDocument();
  });

  it("refreshes the list graph and run history after an external run starts", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const initialTask = buildTask({
      title: "Stale workflow",
      steps: JSON.stringify([
        { id: "trigger", type: "trigger", label: "Schedule", icon: "clock" },
        { id: "check", type: "agent", label: "Check rating", icon: "robot" },
      ]),
      stepCount: 2,
    });
    const freshRun: AutomationRunItem = {
      id: "run-fresh",
      task_id: initialTask.id,
      trigger_data: null,
      status: "completed",
      step_outputs: JSON.stringify({
        check: { output: "fresh output", status: "completed", duration_ms: 10 },
      }),
      error_message: null,
      started_at: "2026-03-15T03:30:00.000Z",
      completed_at: "2026-03-15T03:30:01.000Z",
    };
    const freshTask = buildTask({
      ...initialTask,
      title: "Fresh workflow",
      steps: JSON.stringify([
        { id: "trigger", type: "trigger", label: "Schedule", icon: "clock" },
        { id: "check", type: "agent", label: "Check rating", icon: "robot" },
        { id: "notify", type: "action", label: "Notify Slack", icon: "slack" },
      ]),
      stepCount: 3,
      runCount: 1,
      lastRunStatus: "completed",
      lastRunAt: freshRun.completed_at,
    });
    let taskRequests = 0;
    let runRequests = 0;
    server.use(
      http.get("/api/scheduled-tasks", () => {
        taskRequests += 1;
        return HttpResponse.json({ tasks: [taskRequests === 1 ? initialTask : freshTask] });
      }),
      http.get("/api/scheduled-tasks/:id/runs", () => {
        runRequests += 1;
        return HttpResponse.json({ runs: runRequests === 1 ? [] : [freshRun] });
      }),
      http.get("/api/scheduled-tasks/:id/step-content", () => HttpResponse.json({ stepContent: [] })),
    );

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => expect(screen.getByText("Stale workflow")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Show details for Stale workflow/i }));
    expect(screen.getByText("Recent Runs")).toBeInTheDocument();
    expect(screen.queryByText(/Mar 1[45]/)).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(AUTOMATION_REFRESH_INTERVAL_MS);
    });

    await waitFor(() => expect(screen.getByText("Fresh workflow")).toBeInTheDocument());
    expect(screen.getByText("Notify Slack")).toBeInTheDocument();
    expect(screen.getByText("Recent Runs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mar 15, 2026/ })).toBeInTheDocument();
    expect(taskRequests).toBeGreaterThanOrEqual(2);
    expect(runRequests).toBeGreaterThanOrEqual(2);
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
    expect(screen.getAllByText(/by Alice Admin/).length).toBeGreaterThanOrEqual(2);

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

  it("renders compact workflow row signals", async () => {
    installTaskHandlers([
      buildTask({
        title: "Churn-risk alert -> notify CS",
        steps: JSON.stringify([
          { id: "trigger", type: "trigger", label: "Churn threshold", icon: "clock" },
          { id: "score", type: "agent", label: "Score account", icon: "robot" },
          { id: "notify", type: "action", label: "Notify CS", icon: "slack" },
          { id: "log", type: "action", label: "Log outcome", icon: "code" },
        ]),
        stepCount: 4,
        runCount: 5,
        lastRunStatus: "completed",
      }),
    ]);

    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Churn-risk alert -> notify CS")).toBeInTheDocument();
    });
    expect(screen.getByText("workflow · 4 steps · by Alice Member")).toBeInTheDocument();
    expect(screen.getByLabelText("4 workflow steps")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByLabelText("5 recent run signals")).toBeInTheDocument();
  });

  it("filters admin tasks by owner, status, and search", async () => {
    setMockAuth({ role: "admin", userId: "admin-1" });
    installTaskHandlers([
      buildTask({
        id: "task-mine",
        title: "Owned workflow",
        createdBy: "admin-1",
        creatorName: "Admin User",
        steps: JSON.stringify([
          { id: "trigger", type: "trigger", label: "Schedule", icon: "clock" },
          { id: "agent", type: "agent", label: "Analyze", icon: "robot" },
        ]),
        stepCount: 2,
      }),
      buildTask({
        id: "task-system",
        title: "System digest",
        createdBy: null,
        creatorName: null,
        status: "paused",
        canPause: false,
        canResume: true,
      }),
      buildTask({
        id: "task-attention",
        title: "Failing campaign",
        createdBy: "user-2",
        creatorName: "Beta User",
        lastRunStatus: "failed",
      }),
    ]);

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Owned workflow")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /All tasks 3/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /My tasks 1/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /System tasks 1/i })).toBeInTheDocument();
    expect(screen.getByText(/by Admin User/)).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Filter by team member" }));
    await user.click(screen.getByRole("option", { name: /Beta User/i }));
    expect(screen.getByText("Failing campaign")).toBeInTheDocument();
    expect(screen.queryByText("Owned workflow")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Needs attention 1/i }));
    expect(screen.getByText("Failing campaign")).toBeInTheDocument();
    expect(screen.queryByText("Owned workflow")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Filter by team member" }));
    await user.click(screen.getByRole("option", { name: /All creators/i }));
    await user.click(screen.getByRole("button", { name: /All 3/i }));
    await user.click(screen.getByRole("button", { name: /System tasks 1/i }));
    expect(screen.getByText("System digest")).toBeInTheDocument();
    expect(screen.queryByText("Failing campaign")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Search tasks"), "owned");
    expect(screen.getByText("No tasks match these filters")).toBeInTheDocument();
  });

  it("mutes paused workflow icons", async () => {
    installTaskHandlers([
      buildTask({
        title: "Paused workflow",
        status: "paused",
        canPause: false,
        canResume: true,
        steps: JSON.stringify([
          { id: "trigger", type: "trigger", label: "Schedule", icon: "clock" },
          { id: "agent", type: "agent", label: "Analyze", icon: "robot" },
        ]),
        stepCount: 2,
      }),
    ]);

    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Paused workflow")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("paused workflow icon")).toHaveClass("text-muted-foreground");
    expect(screen.getByLabelText("paused workflow icon")).not.toHaveClass("text-brand-accent");
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

  it("shows Canvas-managed trigger state in task rows and details", async () => {
    installTaskHandlers([
      buildTask({
        id: "task-canvas",
        prompt: "Handle ClickUp issues",
        scheduleType: "external",
        scheduleValue: "canvas",
        scheduleLabel: "Canvas managed: ClickUp - new issue created",
        nextRunAt: null,
        lastRunAt: null,
        triggerConfig: {
          type: "canvas",
          app: "ClickUp",
          eventDescription: "new issue created",
          componentKey: "clickup.issue.created",
          status: "pending_canvas_setup",
        },
      }),
    ]);

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Handle ClickUp issues")).toBeInTheDocument();
    });
    expect(screen.getByText("Trigger · Canvas · ClickUp · new issue created")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Show details for Handle ClickUp issues/i }));

    await waitFor(() => {
      expect(screen.getByText("Trigger")).toBeInTheDocument();
    });
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("Trigger-based")).toBeInTheDocument();
    expect(screen.getByText("Canvas · ClickUp · new issue created")).toBeInTheDocument();
    expect(screen.queryByText("Pending setup")).not.toBeInTheDocument();
  });

  it("pauses an active task via the dropdown menu", async () => {
    installTaskHandlers([buildTask()]);

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByLabelText("Task status: active")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Actions for Post the Monday revenue summary/i }));
    await user.click(screen.getByRole("menuitem", { name: /pause/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Task status: paused")).toBeInTheDocument();
    });
  });

  it("opens the builder from the actions menu", async () => {
    installTaskHandlers([buildTask()]);

    const user = userEvent.setup();
    renderWithProviders(<ScheduledTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("Post the Monday revenue summary")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Actions for Post the Monday revenue summary/i }));
    await user.click(screen.getByRole("menuitem", { name: /open builder/i }));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/scheduled-tasks/$taskId/edit",
      params: { taskId: "task-1" },
      search: {},
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
      expect(screen.getByLabelText("Task status: paused")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Actions for Post the Monday revenue summary/i }));
    await user.click(screen.getByRole("menuitem", { name: /resume/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Task status: active")).toBeInTheDocument();
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
