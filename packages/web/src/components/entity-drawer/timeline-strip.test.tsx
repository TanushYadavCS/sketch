/**
 * TimelineStrip contract:
 *  - total-entries counter renders with the correct total
 *  - month headers appear above each group of rows
 *  - clicking a row invokes onSelectItem with the item
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
        fileType: "transcript",
        contentCategory: "document",
        sourceType: "fireflies",
        occurredAt: "2026-05-22T00:00:00.000Z",
        mentionConfidence: "EXTRACTED" as const,
        mentionCount: 2,
        contextSnippet: "Sarah leads Atlas...",
        url: null,
        rollupGroupId: null,
        crmActivity: null,
      },
    ],
  },
  {
    month: "2026-04",
    items: [
      {
        fileId: "f2",
        fileName: "Helios spec",
        fileType: "doc",
        contentCategory: "document",
        sourceType: "google_drive",
        occurredAt: "2026-04-10T00:00:00.000Z",
        mentionConfidence: "INFERRED" as const,
        mentionCount: 1,
        contextSnippet: null,
        url: null,
        rollupGroupId: null,
        crmActivity: null,
      },
    ],
  },
];

describe("TimelineStrip", () => {
  it("renders rows grouped under month headers with a total-entries counter", async () => {
    renderWithProviders(<TimelineStrip groups={groups} />);
    expect(screen.getByText(/2 entries/)).toBeInTheDocument();
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

  it("renders CRM activity rows with activity type and body indicator", async () => {
    renderWithProviders(
      <TimelineStrip
        groups={[
          {
            month: "2026-05",
            items: [
              {
                fileId: "crm-task-1",
                fileName: "Follow up on renewal - Jane Buyer",
                fileType: "crm_task",
                contentCategory: "document",
                sourceType: "zoho_crm",
                occurredAt: "2026-05-21T00:00:00.000Z",
                mentionConfidence: "EXTRACTED",
                mentionCount: 1,
                contextSnippet: "CRM activity parent",
                url: null,
                rollupGroupId: "Deals:d1",
                crmActivity: { activityType: "task", hasBody: true },
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("Follow up on renewal - Jane Buyer")).toBeInTheDocument();
    expect(screen.queryByText("zoho_crm")).not.toBeInTheDocument();
  });
});
