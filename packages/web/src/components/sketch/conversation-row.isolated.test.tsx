import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationRow, formatRelative } from "./conversation-row";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params?: { conversationId?: string };
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={params?.conversationId ? `/chat/${params.conversationId}` : to} className={className}>
      {children}
    </a>
  ),
}));

describe("ConversationRow", () => {
  it("matches the Recents row shape from the Sketch design", () => {
    render(
      <ConversationRow
        id="web-chat"
        title="Create a PDF for my skills"
        channel="web"
        occurredAt="2026-05-26T06:30:00.000Z"
        now={new Date("2026-05-26T06:48:00.000Z")}
      />,
    );

    const link = screen.getByRole("link", { name: /Create a PDF for my skills/i });
    expect(link).toHaveAttribute("href", "/chat/web-chat");
    expect(link).toHaveClass("rounded-[6px]", "px-[8px]", "py-[8px]");
    expect(screen.getByLabelText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("18m")).toBeInTheDocument();
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-05-26T12:00:00.000Z");

  it("uses the design's compact monotonic relative-time labels", () => {
    expect(formatRelative("2026-05-26T11:59:45.000Z", now)).toBe("now");
    expect(formatRelative("2026-05-26T11:42:00.000Z", now)).toBe("18m");
    expect(formatRelative("2026-05-26T09:00:00.000Z", now)).toBe("3h");
    expect(formatRelative("2026-05-24T12:00:00.000Z", now)).toBe("2d");
    expect(formatRelative("2026-05-12T12:00:00.000Z", now)).toBe("2w");
  });
});
