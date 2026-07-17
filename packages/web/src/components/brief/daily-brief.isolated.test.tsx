import type { DailyBrief as DailyBriefData, DailyBriefItem } from "@/lib/api";
import { act, render, screen, within } from "@testing-library/react";
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

function briefWith(meetings: DailyBriefItem[]): DailyBriefData {
  return {
    id: "brief-1",
    userId: "user-1",
    briefDate: "2026-06-27",
    timezone: "UTC",
    status: "ready",
    generatedAt: null,
    masthead: null,
    sections: {
      meetings,
      todos: [],
      untracked_followups: [],
      looks_resolved: [],
      customer_updates: [],
      active_projects: [],
    },
  };
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

  it("renders safely when an older API response omits durable follow-up sections", () => {
    const brief = briefWith([]);
    const legacyBrief = {
      ...brief,
      sections: {
        meetings: brief.sections.meetings,
        todos: brief.sections.todos,
        customer_updates: brief.sections.customer_updates,
        active_projects: brief.sections.active_projects,
      },
    } as unknown as DailyBriefData;

    render(<DailyBrief brief={legacyBrief} running={false} calendarConnected onOpenChat={() => {}} />);

    expect(screen.getByText("Untracked follow-ups")).toBeInTheDocument();
    expect(screen.getByText("Looks resolved")).toBeInTheDocument();
  });
});
