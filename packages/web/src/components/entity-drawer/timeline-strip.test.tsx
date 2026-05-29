/**
 * TimelineStrip contract:
 *  - "1 of N" counter renders with the correct total
 *  - month dividers appear inline ahead of their group's cards
 *  - clicking a card invokes onSelectItem with the item
 */
import { renderWithProviders } from "@/test/utils";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TimelineStrip } from "./timeline-strip";

const groups = [
  {
    month: "2026-05",
    items: [
      {
        fileId: "f1",
        fileName: "Atlas standup",
        sourceType: "fireflies",
        occurredAt: "2026-05-22T00:00:00.000Z",
        mentionConfidence: "EXTRACTED" as const,
        mentionCount: 2,
        contextSnippet: "Sarah leads Atlas...",
        url: null,
      },
    ],
  },
  {
    month: "2026-04",
    items: [
      {
        fileId: "f2",
        fileName: "Helios spec",
        sourceType: "google_drive",
        occurredAt: "2026-04-10T00:00:00.000Z",
        mentionConfidence: "INFERRED" as const,
        mentionCount: 1,
        contextSnippet: null,
        url: null,
      },
    ],
  },
];

describe("TimelineStrip", () => {
  it("renders cards with month dividers inline and a 1-of-N counter", async () => {
    renderWithProviders(<TimelineStrip groups={groups} />);
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
    expect(screen.getByText("May 2026")).toBeInTheDocument();
    expect(screen.getByText("Apr 2026")).toBeInTheDocument();
    expect(screen.getByText("Atlas standup")).toBeInTheDocument();
    expect(screen.getByText("Helios spec")).toBeInTheDocument();
    expect(screen.getByText("×2")).toBeInTheDocument();
  });

  it("calls onSelectItem with the clicked item", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(<TimelineStrip groups={groups} onSelectItem={onSelect} />);
    await user.click(screen.getByText("Helios spec"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ fileId: "f2" }));
  });
});
