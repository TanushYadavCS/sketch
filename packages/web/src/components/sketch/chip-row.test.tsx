import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChipRow, DEFAULT_CHIPS } from "./chip-row";

describe("ChipRow", () => {
  it("passes the picked chip to the caller", () => {
    const onPick = vi.fn();
    render(<ChipRow onPick={onPick} />);

    fireEvent.click(screen.getByRole("button", { name: "Triage inbox" }));

    expect(onPick).toHaveBeenCalledWith(DEFAULT_CHIPS[0]);
    expect(screen.getByLabelText("Suggested prompts")).toHaveClass("chip-scrollbar");
    expect(screen.getByLabelText("Suggested prompts")).not.toHaveClass("scrollbar-none");
  });

  it("scrolls horizontally by dragging and suppresses the drag-ending chip click", () => {
    const onPick = vi.fn();
    render(<ChipRow onPick={onPick} />);
    const scroller = screen.getByLabelText("Suggested prompts") as HTMLDivElement;

    scroller.scrollLeft = 0;
    fireEvent.pointerDown(scroller, { button: 0, pointerId: 1, clientX: 120 });
    fireEvent.pointerMove(scroller, { pointerId: 1, clientX: 70 });
    fireEvent.pointerUp(scroller, { pointerId: 1 });

    expect(scroller.scrollLeft).toBe(50);

    fireEvent.click(screen.getByRole("button", { name: "Triage inbox" }));
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Triage inbox" }));
    expect(onPick).toHaveBeenCalledWith(DEFAULT_CHIPS[0]);
  });
});
