import type { DailyBrief as DailyBriefData, DailyBriefItem } from "@/lib/api";
import { useEntityUi } from "@/lib/entity-ui";
import { renderWithProviders } from "@/test/utils";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyBrief } from "./daily-brief";

function meetingItem(id: string, title: string, startTime: string): DailyBriefItem {
  return {
    id,
    sectionKey: "meetings",
    title,
    summary: "",
    priority: "medium",
    label: "Meeting",
    displayRef: null,
    actionType: null,
    actionLabel: null,
    actionPrompt: null,
    sourceUrl: null,
    structuredPayload: { startTime, via: null, attendees: [] },
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
  };
}

function projectItem(id: string, title: string, entityId: string, actionPrompt: string | null = null): DailyBriefItem {
  return {
    id,
    sectionKey: "active_projects",
    title,
    summary: "",
    priority: "medium",
    label: "Project",
    displayRef: null,
    actionType: null,
    actionLabel: null,
    actionPrompt,
    sourceUrl: null,
    structuredPayload: null,
    knowledgeRefs: { entityIds: [entityId], fileIds: [] },
    sortOrder: 0,
  };
}

function briefWith(meetings: DailyBriefItem[], activeProjects: DailyBriefItem[] = []): DailyBriefData {
  return {
    id: "brief-1",
    userId: "user-1",
    briefDate: "2026-06-27",
    timezone: "UTC",
    status: "ready",
    generatedAt: null,
    masthead: null,
    sections: { meetings, todos: [], customer_updates: [], active_projects: activeProjects },
  };
}

function StackProbe() {
  const ui = useEntityUi();
  return <div data-testid="open-stack">{ui.stack.join(",")}</div>;
}

function rowWithBadge(): HTMLElement {
  const badge = screen.getByText("Now / Next");
  const row = badge.closest("button");
  if (!row) throw new Error("Now / Next badge is not inside a meeting row");
  return row;
}

describe("DailyBrief Now / Next marker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances the Now / Next badge as meeting start times pass", () => {
    vi.setSystemTime(new Date("2026-06-27T08:00:00.000Z"));
    const meetings = [
      meetingItem("m-standup", "Standup", "2026-06-27T09:00:00.000Z"),
      meetingItem("m-review", "Design review", "2026-06-27T11:00:00.000Z"),
    ];

    render(<DailyBrief brief={briefWith(meetings)} running={false} calendarConnected onOpenChat={() => {}} />);

    expect(within(rowWithBadge()).getByText("Standup")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(61 * 60 * 1000);
    });

    expect(within(rowWithBadge()).getByText("Design review")).toBeInTheDocument();
  });

  it("opens active-project items through their first entity reference", () => {
    const activeProject = projectItem("project-item", "Atlas rollout", "entity-project-1");
    renderWithProviders(
      <>
        <DailyBrief brief={briefWith([], [activeProject])} running={false} onOpenChat={() => {}} />
        <StackProbe />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Atlas rollout" }));

    expect(screen.getByTestId("open-stack")).toHaveTextContent("entity-project-1");
  });

  it("keeps active-project chat actions available alongside entity navigation", () => {
    const activeProject = projectItem("project-item", "Atlas rollout", "entity-project-1", "Catch me up on Atlas");
    const onOpenChat = vi.fn();
    renderWithProviders(<DailyBrief brief={briefWith([], [activeProject])} running={false} onOpenChat={onOpenChat} />);

    const action = screen.getByRole("button", { name: "Catch me up" });
    expect(action.parentElement).not.toHaveClass("hidden");
    fireEvent.click(action);

    expect(onOpenChat).toHaveBeenCalledWith("Catch me up on Atlas");
  });
});
