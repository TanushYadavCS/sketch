import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("TabContentContainer", () => {
  it("fills the page shell instead of applying a second page width", () => {
    render(<TabContentContainer data-testid="tab-content" />);

    const content = screen.getByTestId("tab-content");

    expect(content).toHaveClass("w-full");
    expect(content.className).not.toContain("mx-auto");
    expect(content.className).not.toContain("max-w-4xl");
  });
});
