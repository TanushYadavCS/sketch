import { describe, expect, it } from "vitest";
import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import { requireWorkflowMessageText, resolveWorkflowDelivery } from "./delivery";

function makeTask(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
  return {
    id: "task-1",
    platform: "slack",
    context_type: "channel",
    delivery_target: "C_SOURCE",
    thread_ts: null,
    prompt: "Do it",
    schedule_type: "cron",
    schedule_value: "0 9 * * 1",
    timezone: "UTC",
    session_mode: "fresh",
    next_run_at: null,
    last_run_at: null,
    status: "active",
    created_by: "U_OWNER",
    created_at: "2026-01-01T00:00:00.000Z",
    title: null,
    description: null,
    origin_platform: null,
    origin_conversation_id: null,
    origin_provider_thread_id: null,
    origin_message_id: null,
    steps: null,
    edges: null,
    output_target: null,
    output_platform: null,
    output_thread_ts: null,
    output_mode: "deliver",
    updated_at: "2026-01-01T00:00:00.000Z",
    revision: 0,
    last_edited_by: null,
    ...overrides,
  };
}

describe("resolveWorkflowDelivery", () => {
  it("ignores output_platform without an output_target", () => {
    expect(resolveWorkflowDelivery(makeTask({ output_platform: "whatsapp" }))).toEqual({
      platform: "slack",
      targetType: "channel",
      targetId: "C_SOURCE",
      threadTs: null,
      mode: "deliver",
    });
  });

  it("uses output_platform when output_target is present", () => {
    expect(
      resolveWorkflowDelivery(
        makeTask({
          output_platform: "whatsapp",
          output_target: "120363000000@g.us",
        }),
      ),
    ).toEqual({
      platform: "whatsapp",
      targetType: "group",
      targetId: "120363000000@g.us",
      threadTs: null,
      mode: "deliver",
    });
  });
});

describe("requireWorkflowMessageText", () => {
  it("accepts and trims human-readable text", () => {
    expect(requireWorkflowMessageText("  *Done*\n  ")).toBe("*Done*");
  });

  it("rejects structured output", () => {
    expect(() => requireWorkflowMessageText({ summary: "Done" })).toThrow("human-readable string");
    expect(() => requireWorkflowMessageText(["Done"])).toThrow("human-readable string");
    expect(() => requireWorkflowMessageText(' {"summary":"Done"} ')).toThrow("serialized JSON");
    expect(() => requireWorkflowMessageText('```json\n{"summary":"Done"}\n``` ')).toThrow("serialized JSON");
  });
});
