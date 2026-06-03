import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TileGrid } from "./tile-grid";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

describe("TileGrid", () => {
  it("does not show invented workspace metrics in the default Home tiles", () => {
    render(<TileGrid />);

    expect(screen.queryByText("5 running")).not.toBeInTheDocument();
    expect(screen.queryByText("12 in library")).not.toBeInTheDocument();
    expect(screen.queryByText("8 connected")).not.toBeInTheDocument();
    expect(screen.queryByText("7 people")).not.toBeInTheDocument();

    expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    expect(screen.getByText("Skill library")).toBeInTheDocument();
    expect(screen.getByText("Connected apps")).toBeInTheDocument();
    expect(screen.getByText("Team members")).toBeInTheDocument();
  });
});
