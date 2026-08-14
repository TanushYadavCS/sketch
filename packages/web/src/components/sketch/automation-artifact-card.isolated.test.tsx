import type { AutomationArtifact } from "@/lib/api";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_BUILDER_AUTO_OPEN_DELAY_MS, AutomationArtifactCard } from "./automation-artifact-card";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  createConversation: vi.fn().mockResolvedValue({
    conversation: { conversationId: "builder-new" },
    created: true,
  }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock("@/lib/api", () => ({
  api: { scheduledTasks: { createConversation: mocks.createConversation } },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const artifact: AutomationArtifact = {
  taskId: "task-123",
  requiresBuilder: true,
  kind: "New automation",
  title: "Daily account brief",
  description: "Summarizes account updates and posts the highlights.",
  tags: ["ClickUp", "Slack", "Scheduled"],
  scheduleLabel: "Every hour",
  deliveryLabel: "Slack dm",
  builderUrl: "/scheduled-tasks/task-123/edit",
  status: "active",
};

describe("AutomationArtifactCard", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    mocks.navigate.mockClear();
    mocks.createConversation.mockClear();
    mocks.createConversation.mockResolvedValue({
      conversation: { conversationId: "builder-new" },
      created: true,
    });
  });

  it("renders automation details and opens a fresh builder conversation", async () => {
    const user = userEvent.setup();
    render(<AutomationArtifactCard artifact={artifact} conversationId="chat-alpha" />);

    expect(screen.getByText("Daily account brief")).toBeInTheDocument();
    expect(screen.getByText("ClickUp")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to builder" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Go to builder" }));
    expect(mocks.createConversation).toHaveBeenCalledWith("task-123", { createNew: true });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/scheduled-tasks/$taskId/edit",
      params: { taskId: "task-123" },
      search: { conversationId: "builder-new" },
      viewTransition: true,
    });
  });

  it("uses the exact conversation embedded in the artifact URL when no prop is supplied", async () => {
    const user = userEvent.setup();
    render(
      <AutomationArtifactCard
        artifact={{ ...artifact, builderUrl: "/scheduled-tasks/task-123/edit?conversationId=source-chat" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Go to builder" }));

    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/scheduled-tasks/$taskId/edit",
      params: { taskId: "task-123" },
      search: { conversationId: "source-chat" },
      viewTransition: true,
    });
  });

  it("does not auto-open again after browser Back remounts the handoff card", async () => {
    vi.useFakeTimers();
    try {
      const firstRender = render(
        <AutomationArtifactCard artifact={artifact} autoOpen autoOpenKey="assistant-handoff-1" />,
      );
      expect(screen.getByRole("button", { name: "Go to builder" })).toBeEnabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOMATION_BUILDER_AUTO_OPEN_DELAY_MS);
      });
      expect(mocks.navigate).toHaveBeenCalledOnce();

      firstRender.unmount();
      render(<AutomationArtifactCard artifact={artifact} autoOpen autoOpenKey="assistant-handoff-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOMATION_BUILDER_AUTO_OPEN_DELAY_MS);
      });

      expect(mocks.navigate).toHaveBeenCalledOnce();
      expect(mocks.createConversation).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
