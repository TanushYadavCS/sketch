/**
 * Live Brief Task Links — focused front-end slice.
 *
 * Contract:
 *  - DailyBriefItem may carry optional `taskId` + `task` (live-state overlay).
 *    Missing values must normalize safely for mixed-version compatibility.
 *  - The Brief row keeps the snapshot title and, when `task` is present, shows
 *    the normalized live status instead of the generated todo label. No Select
 *    inside the row button.
 *  - The detail drawer renders a compact "Current task" section when `task`
 *    exists: live status (editable Select when canEditStatus, passive pill
 *    otherwise), current task title only when different from the snapshot,
 *    priority, and updated/completed metadata. Read-only rows show a concise
 *    reason and no Select.
 *  - Home owns the status mutation and a pure cache-overlay helper updates
 *    every brief item whose taskId matches the returned task, preserving
 *    snapshot fields and replacing only the task overlay.
 */
import type { DailyBrief as DailyBriefData, DailyBriefItem, DailyBriefResponse, DailyBriefTaskState } from "@/lib/api";
import { renderWithProviders } from "@/test/utils";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DailyBrief } from "./daily-brief";
import {
  applyReviewOverlayToBriefResponse,
  applyTaskOverlayToBriefResponse,
  formatBriefTaskStatus,
} from "./task-overlay";

function baseTask(overrides: Partial<DailyBriefTaskState> = {}): DailyBriefTaskState {
  return {
    id: "task-1",
    title: "Live task title",
    status: "in_progress",
    statusRaw: null,
    statusAuthority: "local",
    priority: "medium",
    completedAt: null,
    updatedAt: "2026-07-17T10:00:00.000Z",
    canEditStatus: true,
    readonlyReason: null,
    ...overrides,
  };
}

function todoItem(id: string, title: string, task?: DailyBriefTaskState | null): DailyBriefItem {
  return {
    id,
    sectionKey: "todos",
    title,
    summary: "Snapshot summary",
    priority: "high",
    label: "todo",
    displayRef: "KG-12",
    actionType: null,
    actionLabel: null,
    actionPrompt: "Plan this",
    sourceUrl: null,
    structuredPayload: null,
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
    taskId: task ? task.id : null,
    task,
  };
}

function briefWithTodos(todos: DailyBriefItem[]): DailyBriefData {
  return {
    id: "brief-1",
    userId: "user-1",
    briefDate: "2026-07-17",
    timezone: "UTC",
    status: "ready",
    generatedAt: null,
    masthead: null,
    sections: {
      meetings: [],
      todos,
      untracked_followups: [],
      looks_resolved: [],
      customer_updates: [],
      active_projects: [],
    },
  };
}

function emptyResponse(brief: DailyBriefData): DailyBriefResponse {
  return {
    brief,
    running: false,
    briefDate: brief.briefDate,
    timezone: brief.timezone,
  };
}

describe("Brief row live task status", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("shows the normalized live status instead of the generated todo label", () => {
    const task = baseTask({ status: "in_progress" });
    const brief = briefWithTodos([todoItem("t-1", "Snapshot title", task)]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    const row = screen.getByRole("button", { name: /Snapshot title/ });
    expect(within(row).getAllByText(formatBriefTaskStatus("in_progress")).length).toBeGreaterThan(0);
    expect(within(row).queryByText("Todo")).not.toBeInTheDocument();
  });

  it("keeps the snapshot title even when the live task title differs", () => {
    const task = baseTask({ title: "Different live title" });
    const brief = briefWithTodos([todoItem("t-1", "Snapshot title", task)]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    expect(screen.getByRole("button", { name: /Snapshot title/ })).toBeInTheDocument();
    expect(screen.queryByText("Different live title")).not.toBeInTheDocument();
  });

  it("does not render an interactive status control inside the row button", () => {
    const task = baseTask();
    const brief = briefWithTodos([todoItem("t-1", "Snapshot title", task)]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    const row = screen.getByRole("button", { name: /Snapshot title/ });
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("Inline follow-up review actions", () => {
  it("renders the grouped completion decision before the full chat action and reports the selected choice", async () => {
    const user = userEvent.setup();
    const onReviewFollowup = vi.fn();
    const reviewItem = {
      ...todoItem("review-1", "Confirm launch is done"),
      sectionKey: "looks_resolved" as const,
      actionLabel: "Review with Sketch",
      review: {
        kind: "completion" as const,
        id: "recommendation-1",
        state: "pending" as const,
        canReview: true,
      },
    };
    const brief = {
      ...briefWithTodos([]),
      sections: {
        ...briefWithTodos([]).sections,
        looks_resolved: [reviewItem],
      },
    };

    renderWithProviders(
      <DailyBrief brief={brief} running={false} onOpenChat={() => {}} onReviewFollowup={onReviewFollowup} />,
    );

    const row = screen.getByRole("button", { name: /Confirm launch is done/ }).closest("article");
    expect(row).not.toBeNull();
    const chatAction = within(row as HTMLElement).getByRole("button", { name: "Review with Sketch" });
    const decisionGroup = within(row as HTMLElement).getByRole("group", {
      name: "Completion review decision",
    });
    const markDone = within(decisionGroup).getByRole("button", { name: "Mark as done" });
    expect(decisionGroup).not.toContainElement(chatAction);
    const rowButtons = Array.from((row as HTMLElement).querySelectorAll("button"));
    expect(rowButtons.indexOf(markDone as HTMLButtonElement)).toBeLessThan(
      rowButtons.indexOf(chatAction as HTMLButtonElement),
    );

    await user.click(markDone);
    expect(onReviewFollowup).toHaveBeenCalledWith("completion", "recommendation-1", "confirm_done");
  });

  it("renders terminal review outcomes without mutation controls", () => {
    const reviewItem = {
      ...todoItem("seed-1", "Follow up with Acme"),
      sectionKey: "untracked_followups" as const,
      review: {
        kind: "seed" as const,
        id: "candidate-1",
        state: "dismissed" as const,
        canReview: false,
        acceptedTaskId: null,
      },
    };
    const brief = {
      ...briefWithTodos([]),
      sections: {
        ...briefWithTodos([]).sections,
        untracked_followups: [reviewItem],
      },
    };

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    expect(screen.getByText("Dismissed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Track" })).not.toBeInTheDocument();
  });

  it("renders seed decisions before the full chat action and reports the selected choice", async () => {
    const user = userEvent.setup();
    const onReviewFollowup = vi.fn();
    const reviewItem = {
      ...todoItem("seed-1", "Follow up with Acme"),
      sectionKey: "untracked_followups" as const,
      actionLabel: "Discuss with Sketch",
      review: {
        kind: "seed" as const,
        id: "candidate-1",
        state: "pending" as const,
        canReview: true,
        acceptedTaskId: null,
      },
    };
    const brief = {
      ...briefWithTodos([]),
      sections: {
        ...briefWithTodos([]).sections,
        untracked_followups: [reviewItem],
      },
    };

    renderWithProviders(
      <DailyBrief brief={brief} running={false} onOpenChat={() => {}} onReviewFollowup={onReviewFollowup} />,
    );

    const row = screen.getByRole("button", { name: /Follow up with Acme/ }).closest("article");
    expect(row).not.toBeNull();
    const chatAction = within(row as HTMLElement).getByRole("button", { name: "Discuss with Sketch" });
    const decisionGroup = within(row as HTMLElement).getByRole("group", {
      name: "Follow-up tracking decision",
    });
    const dismiss = within(decisionGroup).getByRole("button", { name: "Dismiss" });
    expect(decisionGroup).not.toContainElement(chatAction);
    const rowButtons = Array.from((row as HTMLElement).querySelectorAll("button"));
    expect(rowButtons.indexOf(dismiss as HTMLButtonElement)).toBeLessThan(
      rowButtons.indexOf(chatAction as HTMLButtonElement),
    );

    await user.click(dismiss);
    expect(onReviewFollowup).toHaveBeenCalledWith("seed", "candidate-1", "dismiss");
  });

  it("keeps the grouped review decision before the full chat action in the detail drawer", async () => {
    const user = userEvent.setup();
    const onReviewFollowup = vi.fn();
    const reviewItem = {
      ...todoItem("review-drawer-1", "Confirm drawer launch is done"),
      sectionKey: "looks_resolved" as const,
      actionLabel: "Review with Sketch",
      review: {
        kind: "completion" as const,
        id: "recommendation-drawer-1",
        state: "pending" as const,
        canReview: true,
      },
    };
    const brief = {
      ...briefWithTodos([]),
      sections: {
        ...briefWithTodos([]).sections,
        looks_resolved: [reviewItem],
      },
    };

    renderWithProviders(
      <DailyBrief brief={brief} running={false} onOpenChat={() => {}} onReviewFollowup={onReviewFollowup} />,
    );

    await user.click(screen.getByRole("button", { name: /Confirm drawer launch is done/ }));
    const drawer = await screen.findByRole("dialog");
    const chatAction = within(drawer).getByRole("button", { name: "Review with Sketch" });
    const decisionGroup = within(drawer).getByRole("group", {
      name: "Completion review decision",
    });
    const keepOpen = within(decisionGroup).getByRole("button", { name: "Keep open" });
    const drawerButtons = Array.from(drawer.querySelectorAll("button"));
    expect(decisionGroup).not.toContainElement(chatAction);
    expect(drawerButtons.indexOf(keepOpen as HTMLButtonElement)).toBeLessThan(
      drawerButtons.indexOf(chatAction as HTMLButtonElement),
    );

    await user.click(keepOpen);
    expect(onReviewFollowup).toHaveBeenCalledWith("completion", "recommendation-drawer-1", "keep_open");
  });
});

describe("Brief detail drawer Current task section", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("shows the current task title only when it differs from the snapshot title", async () => {
    const user = userEvent.setup();
    const task = baseTask({ title: "Different live title" });
    const brief = briefWithTodos([todoItem("t-1", "Snapshot title", task)]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Snapshot title/ }));

    expect(await screen.findByText("Current task")).toBeInTheDocument();
    expect(screen.getByText("Different live title")).toBeInTheDocument();
  });

  it("renders an editable status select and updates status through the callback", async () => {
    const user = userEvent.setup();
    const task = baseTask({ id: "task-edit", status: "open" });
    const brief = briefWithTodos([todoItem("t-1", "Snapshot title", task)]);
    const onUpdateTaskStatus = vi.fn();

    renderWithProviders(
      <DailyBrief brief={brief} running={false} onOpenChat={() => {}} onUpdateTaskStatus={onUpdateTaskStatus} />,
    );

    await user.click(screen.getByRole("button", { name: /Snapshot title/ }));
    const combobox = await screen.findByRole("combobox", { name: /Live task title status/ });
    await user.click(combobox);
    await user.click(await screen.findByRole("option", { name: "Done" }));

    expect(onUpdateTaskStatus).toHaveBeenCalledWith("task-edit", "done");
  });

  it("presents priority, status, and update metadata with clear labels", async () => {
    const user = userEvent.setup();
    const task = baseTask({ status: "open", priority: "medium" });
    const brief = briefWithTodos([todoItem("t-current-task-hierarchy", "Snapshot title", task)]);

    renderWithProviders(
      <DailyBrief brief={brief} running={false} onOpenChat={() => {}} onUpdateTaskStatus={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: /Snapshot title/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByRole("heading", { name: "Current task" })).toBeInTheDocument();
    expect(within(drawer).getAllByText("Medium priority")).toHaveLength(1);
    expect(within(drawer).queryByText("High priority")).not.toBeInTheDocument();
    expect(within(drawer).getByText("Status")).toBeInTheDocument();
    expect(within(drawer).getByRole("combobox", { name: /Live task title status/ })).toBeInTheDocument();
    expect(within(drawer).getByText(/Updated/)).toBeInTheDocument();
  });

  it("disables the status select while that task is updating", async () => {
    const user = userEvent.setup();
    const task = baseTask({ id: "task-busy" });
    const brief = briefWithTodos([todoItem("t-1", "Snapshot title", task)]);

    renderWithProviders(
      <DailyBrief
        brief={brief}
        running={false}
        onOpenChat={() => {}}
        onUpdateTaskStatus={() => {}}
        updatingTaskId="task-busy"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Snapshot title/ }));
    const combobox = await screen.findByRole("combobox", { name: /Live task title status/ });
    expect(combobox).toBeDisabled();
  });

  it("shows a passive pill and external-authority reason instead of a select", async () => {
    const user = userEvent.setup();
    const task = baseTask({
      canEditStatus: false,
      readonlyReason: "external_authority",
      statusAuthority: "external",
      statusRaw: "In Review",
    });
    const brief = briefWithTodos([todoItem("t-1", "Snapshot title", task)]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Snapshot title/ }));
    await screen.findByText("Current task");
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(drawer).getByText(formatBriefTaskStatus("in_progress"))).toBeInTheDocument();
    expect(within(drawer).getByText(/managed by the source system/i)).toBeInTheDocument();
  });

  it("shows a not_owner reason when read-only due to ownership", async () => {
    const user = userEvent.setup();
    const task = baseTask({
      canEditStatus: false,
      readonlyReason: "not_owner",
    });
    const brief = briefWithTodos([todoItem("t-1", "Snapshot title", task)]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Snapshot title/ }));
    await screen.findByText("Current task");
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(drawer).getByText(/creator, assignee, or an admin/i)).toBeInTheDocument();
  });
});

describe("Brief detail drawer context block", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("renders the editorial 'Why it's in your brief' label and summary for a non-meeting item", async () => {
    const user = userEvent.setup();
    const brief = briefWithTodos([todoItem("t-ctx-1", "Snapshot title", null)]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Snapshot title/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByText("Briefing note")).toBeInTheDocument();
    expect(within(drawer).getByText("Snapshot summary")).toBeInTheDocument();
    expect(within(drawer).queryByText(/Why it[\u2019']s in your brief/i)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/^Context$/)).not.toBeInTheDocument();
  });

  it("translates Task Attention reasons into friendly explanations without exposing internal keys", async () => {
    const user = userEvent.setup();
    const item = {
      ...todoItem("t-attention-new", "New customer follow-up", null),
      summary: "Task Attention: new_since_last_brief, meaningfully_changed.",
      structuredPayload: {
        attentionReasons: ["new_since_last_brief", "meaningfully_changed"],
        changedFields: [],
      } as unknown as DailyBriefItem["structuredPayload"],
    };
    const brief = briefWithTodos([item]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /New customer follow-up/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByText("New since your last brief")).toBeInTheDocument();
    expect(within(drawer).getByText("This task was added after your previous brief.")).toBeInTheDocument();
    expect(within(drawer).queryByText("Recently updated")).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/new_since_last_brief/)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/Task Attention:/)).not.toBeInTheDocument();
  });

  it("names changed fields in plain language", async () => {
    const user = userEvent.setup();
    const item = {
      ...todoItem("t-attention-changed", "Updated launch handoff", null),
      summary: "Task Attention: meaningfully_changed; changed: priority, status.",
      structuredPayload: {
        attentionReasons: ["meaningfully_changed"],
        changedFields: ["priority", "status"],
      } as unknown as DailyBriefItem["structuredPayload"],
    };
    const brief = briefWithTodos([item]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Updated launch handoff/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByText("Recently updated")).toBeInTheDocument();
    expect(within(drawer).getByText("The priority and status changed since your previous brief.")).toBeInTheDocument();
    expect(within(drawer).queryByText(/meaningfully_changed/)).not.toBeInTheDocument();
  });

  it("uses generic friendly copy when changed fields are not user-facing", async () => {
    const user = userEvent.setup();
    const item = {
      ...todoItem("t-attention-unknown-change", "Updated internal task", null),
      summary: "Task Attention: meaningfully_changed; changed: owner_entity_id.",
      structuredPayload: {
        attentionReasons: ["meaningfully_changed"],
        changedFields: ["owner_entity_id"],
      } as unknown as DailyBriefItem["structuredPayload"],
    };
    const brief = briefWithTodos([item]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Updated internal task/ }));
    const drawer = await screen.findByRole("dialog");

    expect(
      within(drawer).getByText("Something important about this task changed since your previous brief."),
    ).toBeInTheDocument();
    expect(within(drawer).queryByText(/owner entity id/i)).not.toBeInTheDocument();
  });

  it("keeps a friendly status explanation when status is the only attention reason", async () => {
    const user = userEvent.setup();
    const item = {
      ...todoItem("t-attention-status", "Status changed task", null),
      summary: "Task Attention: status_changed.",
      structuredPayload: {
        attentionReasons: ["status_changed"],
        changedFields: ["status"],
      } as unknown as DailyBriefItem["structuredPayload"],
    };
    const brief = briefWithTodos([item]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Status changed task/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByText("Status changed")).toBeInTheDocument();
    expect(within(drawer).getByText("Its status changed since your previous brief.")).toBeInTheDocument();
    expect(within(drawer).queryByText(/status_changed/)).not.toBeInTheDocument();
  });

  it("uses neutral copy for a future attention reason instead of exposing its key", async () => {
    const user = userEvent.setup();
    const item = {
      ...todoItem("t-attention-future", "Future attention task", null),
      summary: "Task Attention: future_internal_reason.",
      structuredPayload: {
        attentionReasons: ["future_internal_reason"],
        changedFields: [],
      } as unknown as DailyBriefItem["structuredPayload"],
    };
    const brief = briefWithTodos([item]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Future attention task/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByText("Recent activity")).toBeInTheDocument();
    expect(within(drawer).getByText("Sketch noticed recent activity on this task.")).toBeInTheDocument();
    expect(within(drawer).queryByText(/future_internal_reason/)).not.toBeInTheDocument();
  });

  it("does not repeat priority when the source value already includes the label", async () => {
    const user = userEvent.setup();
    const task = baseTask({ priority: "No priority" });
    const brief = briefWithTodos([todoItem("t-priority-label", "Task without priority", task)]);

    renderWithProviders(
      <DailyBrief brief={brief} running={false} onOpenChat={() => {}} onUpdateTaskStatus={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: /Task without priority/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByText("No priority")).toBeInTheDocument();
    expect(within(drawer).queryByText("No priority priority")).not.toBeInTheDocument();
  });

  it("renders nothing when the summary is empty (no label, no body)", async () => {
    const user = userEvent.setup();
    const brief = briefWithTodos([{ ...todoItem("t-ctx-empty", "No summary item", null), summary: "" }]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /No summary item/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).queryByText("Briefing note")).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/Why it[\u2019']s in your brief/i)).not.toBeInTheDocument();
  });

  it("renders the same editorial context block for a meeting item with a summary", async () => {
    const user = userEvent.setup();
    const meetingItem: DailyBriefItem = {
      id: "meeting-ctx-1",
      sectionKey: "meetings",
      title: "Quarterly review",
      summary: "Recurring sync to align hiring plans.",
      priority: "medium",
      label: "meeting",
      displayRef: null,
      actionType: null,
      actionLabel: null,
      actionPrompt: null,
      sourceUrl: null,
      structuredPayload: {
        startTime: "2026-07-17T15:00:00.000Z",
        via: null,
        attendees: [],
      },
      knowledgeRefs: { entityIds: [], fileIds: [] },
      sortOrder: 0,
    };
    const brief: DailyBriefData = {
      ...briefWithTodos([]),
      sections: {
        meetings: [meetingItem],
        todos: [],
        untracked_followups: [],
        looks_resolved: [],
        customer_updates: [],
        active_projects: [],
      },
    };

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Quarterly review/ }));
    const drawer = await screen.findByRole("dialog");

    expect(within(drawer).getByText("Briefing note")).toBeInTheDocument();
    expect(within(drawer).getByText("Recurring sync to align hiring plans.")).toBeInTheDocument();
    expect(within(drawer).queryByText(/Why it[\u2019']s in your brief/i)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/^Context$/)).not.toBeInTheDocument();
  });
});

describe("Missing-field compatibility", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("renders safely when items omit taskId/task entirely (legacy payloads)", () => {
    const legacyItem: DailyBriefItem = {
      id: "legacy-1",
      sectionKey: "todos",
      title: "Legacy todo",
      summary: "",
      priority: "medium",
      label: "todo",
      displayRef: null,
      actionType: null,
      actionLabel: null,
      actionPrompt: null,
      sourceUrl: null,
      structuredPayload: null,
      knowledgeRefs: { entityIds: [], fileIds: [] },
      sortOrder: 0,
    };
    const brief = briefWithTodos([legacyItem]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    expect(screen.getByRole("button", { name: /Legacy todo/ })).toBeInTheDocument();
  });

  it("renders safely when a task overlay is present but partial fields are missing", () => {
    const partialTask = {
      ...baseTask(),
      priority: null,
      completedAt: null,
      updatedAt: "2026-07-17T10:00:00.000Z",
    } as DailyBriefTaskState;
    const brief = briefWithTodos([todoItem("t-1", "Snapshot title", partialTask)]);

    renderWithProviders(<DailyBrief brief={brief} running={false} onOpenChat={() => {}} />);

    expect(screen.getByRole("button", { name: /Snapshot title/ })).toBeInTheDocument();
  });
});

describe("applyTaskOverlayToBriefResponse (cache overlay updater)", () => {
  it("replaces the task overlay on every brief item whose taskId matches, preserving snapshot fields", () => {
    const taskA = baseTask({ id: "task-shared", status: "open" });
    const taskB = baseTask({ id: "task-other", status: "open" });
    const brief = briefWithTodos([
      todoItem("t-1", "Snapshot A", taskA),
      todoItem("t-2", "Snapshot B", taskB),
      todoItem("t-3", "Snapshot A2", taskA),
    ]);
    const response = emptyResponse(brief);

    const updated = applyTaskOverlayToBriefResponse(response, {
      ...taskA,
      status: "done",
      completedAt: "2026-07-17T12:00:00.000Z",
      updatedAt: "2026-07-17T12:00:00.000Z",
    });

    const todos = updated.brief?.sections.todos ?? [];
    expect(todos[0].taskId).toBe("task-shared");
    expect(todos[0].title).toBe("Snapshot A");
    expect(todos[0].task?.status).toBe("done");
    expect(todos[0].task?.completedAt).toBe("2026-07-17T12:00:00.000Z");
    expect(todos[1].taskId).toBe("task-other");
    expect(todos[1].task?.status).toBe("open");
    expect(todos[2].taskId).toBe("task-shared");
    expect(todos[2].title).toBe("Snapshot A2");
    expect(todos[2].task?.status).toBe("done");
  });

  it("matches overlays across all sections, not only todos", () => {
    const task = baseTask({ id: "task-x", status: "open" });
    const brief: DailyBriefData = {
      ...briefWithTodos([todoItem("t-1", "Snapshot todo", task)]),
      sections: {
        meetings: [],
        todos: [todoItem("t-1", "Snapshot todo", task)],
        untracked_followups: [{ ...todoItem("f-1", "Snapshot followup", task), sectionKey: "untracked_followups" }],
        looks_resolved: [],
        customer_updates: [],
        active_projects: [],
      },
    };
    const response = emptyResponse(brief);

    const updated = applyTaskOverlayToBriefResponse(response, { ...task, status: "dropped" });

    expect(updated.brief?.sections.todos[0].task?.status).toBe("dropped");
    expect(updated.brief?.sections.untracked_followups[0].task?.status).toBe("dropped");
  });

  it("leaves the brief unchanged when no taskId matches", () => {
    const task = baseTask({ id: "task-shared", status: "open" });
    const brief = briefWithTodos([todoItem("t-1", "Snapshot", task)]);
    const response = emptyResponse(brief);

    const updated = applyTaskOverlayToBriefResponse(response, { ...baseTask({ id: "task-unknown" }), status: "done" });

    expect(updated.brief?.sections.todos[0].task?.status).toBe("open");
  });

  it("returns the response unchanged when there is no brief", () => {
    const response: DailyBriefResponse = { brief: null, running: false, briefDate: "2026-07-17", timezone: "UTC" };
    const updated = applyTaskOverlayToBriefResponse(response, baseTask({ status: "done" }));
    expect(updated).toBe(response);
  });
});

describe("applyReviewOverlayToBriefResponse", () => {
  it("updates only live review and task overlays while preserving snapshot fields", () => {
    const reviewItem = {
      ...todoItem("seed-1", "Snapshot seed title"),
      sectionKey: "untracked_followups" as const,
      review: {
        kind: "seed" as const,
        id: "candidate-1",
        state: "pending" as const,
        canReview: true,
        acceptedTaskId: null,
      },
    };
    const brief = {
      ...briefWithTodos([]),
      sections: { ...briefWithTodos([]).sections, untracked_followups: [reviewItem] },
    };
    const task = baseTask({ id: "accepted-task", status: "open" });

    const updated = applyReviewOverlayToBriefResponse(emptyResponse(brief), {
      review: {
        kind: "seed",
        id: "candidate-1",
        state: "accepted",
        canReview: false,
        acceptedTaskId: "accepted-task",
      },
      task,
    });

    const item = updated.brief?.sections.untracked_followups[0];
    expect(item?.title).toBe("Snapshot seed title");
    expect(item?.review).toMatchObject({ state: "accepted", acceptedTaskId: "accepted-task" });
    expect(item?.taskId).toBe("accepted-task");
    expect(item?.task).toEqual(task);
  });

  it("clears stale task identity when the reviewed task is no longer visible", () => {
    const task = baseTask({ id: "hidden-task" });
    const reviewItem = {
      ...todoItem("seed-1", "Snapshot seed title", task),
      sectionKey: "untracked_followups" as const,
      review: {
        kind: "seed" as const,
        id: "candidate-1",
        state: "pending" as const,
        canReview: true,
        acceptedTaskId: null,
      },
    };
    const brief = {
      ...briefWithTodos([]),
      sections: { ...briefWithTodos([]).sections, untracked_followups: [reviewItem] },
    };

    const updated = applyReviewOverlayToBriefResponse(emptyResponse(brief), {
      review: {
        kind: "seed",
        id: "candidate-1",
        state: "accepted",
        canReview: false,
        acceptedTaskId: null,
      },
      task: null,
    });

    const item = updated.brief?.sections.untracked_followups[0];
    expect(item?.taskId).toBeNull();
    expect(item?.task).toBeNull();
  });
});
