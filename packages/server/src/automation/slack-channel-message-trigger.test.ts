import { workflowTriggerConfigSchema } from "@sketch/shared";
import { describe, expect, it } from "vitest";

describe("Slack channel message trigger", () => {
  it("requires an exact nonblank Slack channel ID", () => {
    expect(workflowTriggerConfigSchema.safeParse({ type: "slack_channel_message", channelId: "C123" }).success).toBe(
      true,
    );
    expect(workflowTriggerConfigSchema.safeParse({ type: "slack_channel_message", channelId: " " }).success).toBe(
      false,
    );
  });
});
