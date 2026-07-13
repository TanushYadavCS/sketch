import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationRow, formatRelative } from "./conversation-row";

const { linkMock } = vi.hoisted(() => ({
  linkMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: (
    {
      to,
      params,
      children,
      className,
      onMouseEnter,
      onFocus,
      ...props
    }: {
      to: string;
      params?: { conversationId?: string };
      children: React.ReactNode;
      className?: string;
      onMouseEnter?: React.MouseEventHandler<HTMLAnchorElement>;
      onFocus?: React.FocusEventHandler<HTMLAnchorElement>;
      viewTransition?: boolean;
    },
    context: unknown,
  ) => {
    linkMock({ to, params, children, className, onMouseEnter, onFocus, ...props }, context ?? {});
    return (
      <a
        href={params?.conversationId ? `/chat/${params.conversationId}` : to}
        className={className}
        onMouseEnter={onMouseEnter}
        onFocus={onFocus}
      >
        {children}
      </a>
    );
  },
}));

describe("ConversationRow", () => {
  afterEach(() => {
    linkMock.mockClear();
  });

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

  it("opts both conversation link variants into view transitions", () => {
    const props = {
      id: "web-chat",
      title: "Create a PDF for my skills",
      channel: "web" as const,
      occurredAt: "2026-05-26T06:30:00.000Z",
    };
    const { rerender } = render(<ConversationRow {...props} />);

    expect(linkMock).toHaveBeenCalledWith(expect.objectContaining({ viewTransition: true }), expect.anything());

    linkMock.mockClear();
    rerender(<ConversationRow {...props} onDelete={() => undefined} />);

    expect(linkMock).toHaveBeenCalledWith(expect.objectContaining({ viewTransition: true }), expect.anything());
  });

  it("reports hover and keyboard focus as conversation intent", async () => {
    const user = userEvent.setup();
    const onConversationIntent = vi.fn();
    render(
      <ConversationRow
        id="web-chat"
        title="Create a PDF for my skills"
        channel="web"
        occurredAt="2026-05-26T06:30:00.000Z"
        onConversationIntent={onConversationIntent}
      />,
    );

    const link = screen.getByRole("link", { name: /Create a PDF for my skills/i });
    await user.hover(link);
    expect(onConversationIntent).toHaveBeenCalledWith("web-chat");

    onConversationIntent.mockClear();
    await user.tab();
    expect(link).toHaveFocus();
    expect(onConversationIntent).toHaveBeenCalledWith("web-chat");
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
