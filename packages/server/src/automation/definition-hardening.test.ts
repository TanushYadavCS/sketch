import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { describe, expect, it } from "vitest";
import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import {
  AutomationValidationError,
  buildAutomationDefinition,
  isAutomationPlaceholderDraft,
  validateAutomationBuilderSaveRequest,
} from "./definition";

function placeholderRow(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
  return {
    id: "draft-1",
    platform: "slack",
    context_type: "dm",
    delivery_target: "D123",
    thread_ts: null,
    prompt: "Describe the automation.",
    execution_mode: "hybrid",
    schedule_type: "interval",
    schedule_value: "3600",
    timezone: "UTC",
    session_mode: "fresh",
    next_run_at: null,
    last_run_at: null,
    status: "paused",
    created_by: "user-1",
    created_at: "2026-07-13T08:00:00.000Z",
    title: "New automation",
    description: null,
    origin_platform: "web",
    origin_conversation_id: "chat-1",
    origin_provider_thread_id: null,
    origin_message_id: null,
    steps: null,
    edges: null,
    output_target: "D123",
    output_platform: "slack",
    output_thread_ts: null,
    output_mode: "deliver",
    updated_at: "2026-07-13T08:00:00.000Z",
    revision: 0,
    last_edited_by: "user-1",
    ...overrides,
  } as ScheduledTaskRow;
}

describe("automation definition hardening", () => {
  it("projects only an untouched web-origin placeholder as a placeholder draft", () => {
    const row = placeholderRow();
    const definition = buildAutomationDefinition({ row, stepContentRows: [], runRows: [] });

    expect(isAutomationPlaceholderDraft({ row, stepContentRows: [], runRows: [] })).toBe(true);
    expect(definition.isPlaceholderDraft).toBe(true);
  });

  it("does not project legacy or authored lookalikes as placeholder drafts", () => {
    const legacy = placeholderRow({ origin_platform: null, origin_conversation_id: null });
    const authored = placeholderRow({ steps: "[]" });
    const anonymous = placeholderRow({ created_by: null, last_edited_by: null });

    expect(isAutomationPlaceholderDraft({ row: legacy, stepContentRows: [], runRows: [] })).toBe(false);
    expect(isAutomationPlaceholderDraft({ row: authored, stepContentRows: [], runRows: [] })).toBe(false);
    expect(isAutomationPlaceholderDraft({ row: anonymous, stepContentRows: [], runRows: [] })).toBe(false);
    expect(
      isAutomationPlaceholderDraft({
        row: placeholderRow(),
        stepContentRows: [
          {
            task_id: "draft-1",
            step_id: "step1",
            content_type: "prompt",
            content: "A real request",
            apps: null,
            updated_at: "2026-07-13T08:00:00.000Z",
          },
        ],
        runRows: [],
      }),
    ).toBe(false);
  });
  it("does not repeat the same issue for duplicate persisted step ids", () => {
    const request = {
      title: "Duplicate step workflow",
      description: null,
      prompt: "Validate duplicate ids",
      executionMode: "deterministic",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1-5",
      timezone: "UTC",
      status: "paused",
      delivery: {
        platform: "slack",
        targetType: "dm",
        targetId: "U123",
        threadTs: null,
        mode: "silent",
      },
      steps: [
        { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
        {
          id: "action",
          type: "action",
          label: "Search",
          icon: "code",
          position: { x: 260, y: 0 },
          actionCapabilities: { sketchTools: [], usesIntegrationActions: false },
        },
        {
          id: "action",
          type: "action",
          label: "Search",
          icon: "code",
          position: { x: 260, y: 0 },
          actionCapabilities: { sketchTools: [], usesIntegrationActions: false },
        },
      ],
      edges: [],
      stepContent: {
        action: {
          taskId: "task-1",
          stepId: "action",
          contentType: "script",
          content: "return null;",
          apps: null,
        },
      },
    } as unknown as AutomationBuilderSaveRequest;

    let error: unknown;
    try {
      validateAutomationBuilderSaveRequest({ request, brokerCapable: false });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AutomationValidationError);
    expect(
      (error as AutomationValidationError).issues.filter((issue) => issue.code === "ACTION_CAPABILITIES_REQUIRED"),
    ).toHaveLength(1);
  });
});
