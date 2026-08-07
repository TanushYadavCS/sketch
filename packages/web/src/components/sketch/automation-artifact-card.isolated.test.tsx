import type { AutomationArtifact } from "@/lib/api";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationArtifactCard } from "./automation-artifact-card";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

const artifact: AutomationArtifact = {
  taskId: "task-123",
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
    mocks.navigate.mockClear();
  });

  it("renders automation details and opens the production builder route", async () => {
    const user = userEvent.setup();
    render(<AutomationArtifactCard artifact={artifact} conversationId="chat-alpha" />);

    expect(screen.getByText("Daily account brief")).toBeInTheDocument();
    expect(screen.getByText("ClickUp")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/scheduled-tasks/$taskId/edit",
      params: { taskId: "task-123" },
      search: { conversationId: "chat-alpha" },
    });

    await user.click(screen.getByRole("button", { name: "Save as-is" }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: "/scheduled-tasks" });
  });

  it("uses the exact conversation embedded in the artifact URL when no prop is supplied", async () => {
    const user = userEvent.setup();
    render(
      <AutomationArtifactCard
        artifact={{ ...artifact, builderUrl: "/scheduled-tasks/task-123/edit?conversationId=source-chat" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/scheduled-tasks/$taskId/edit",
      params: { taskId: "task-123" },
      search: { conversationId: "source-chat" },
    });
  });
});
