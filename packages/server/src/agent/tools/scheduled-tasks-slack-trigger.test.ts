import { describe, expect, it, vi } from "vitest";
import { handleManageScheduledTasks } from "./scheduled-tasks";

const trigger = (channelId: string) => ({
  id: "trigger",
  type: "trigger" as const,
  label: "Slack channel message",
  icon: "slack",
  position: { x: 0, y: 0 },
  triggerConfig: { type: "slack_channel_message" as const, channelId },
});

const agent = {
  id: "agent",
  type: "agent" as const,
  label: "Create task",
  icon: "sketch-ai",
  position: { x: 240, y: 0 },
  agentPrompt: "Create a task from the Slack message.",
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  const scheduler = {
    addTask: vi.fn().mockResolvedValue({ id: "task-1", status: "active", delivery: { mode: "silent" } }),
    getTaskById: vi.fn().mockResolvedValue({
      id: "task-1",
      platform: "slack",
      contextType: "channel",
      deliveryTarget: "C1",
      threadTs: null,
      prompt: "Create task",
      scheduleType: "external",
      scheduleValue: "slack_channel_message",
      timezone: "UTC",
      status: "active",
      createdBy: "u1",
      title: "Create task",
      description: null,
      steps: JSON.stringify([trigger("C1"), agent]),
      edges: JSON.stringify([{ id: "trigger-agent", from: "trigger", to: "agent" }]),
      outputTarget: "C1",
      outputPlatform: "slack",
      outputThreadTs: null,
      outputMode: "silent",
      revision: 0,
    }),
    updateTask: vi.fn(),
  };
  return {
    scheduler,
    taskContext: { platform: "slack" as const, contextType: "channel" as const, deliveryTarget: "C1", createdBy: "u1" },
    stepContentRepo: { upsert: vi.fn().mockResolvedValue(undefined), getByTask: vi.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

describe("manage_scheduled_tasks Slack channel trigger", () => {
  it("infers the external Slack trigger schedule when adding a channel-message workflow", async () => {
    const deps = makeDeps();

    await handleManageScheduledTasks(
      { action: "add", title: "Slack bug report", steps: [trigger("C1"), agent], output_mode: "silent" },
      deps as never,
    );

    expect(deps.scheduler.addTask).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleType: "external", scheduleValue: "slack_channel_message" }),
    );
  });

  it("rejects a blank Slack channel ID", async () => {
    const deps = makeDeps();

    const result = await handleManageScheduledTasks(
      { action: "add", title: "Slack bug report", steps: [trigger(" "), agent], output_mode: "silent" },
      deps as never,
    );

    expect(result.content[0]?.text).toContain("Slack channel message trigger requires channelId");
    expect(deps.scheduler.addTask).not.toHaveBeenCalled();
  });

  it("rejects a schedule-only update to an existing Slack channel trigger", async () => {
    const deps = makeDeps();

    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "task-1", schedule_value: "canvas" },
      deps as never,
    );

    expect(result.content[0]?.text).toContain("update the Slack channel message trigger steps");
    expect(deps.scheduler.updateTask).not.toHaveBeenCalled();
  });
});
