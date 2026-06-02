import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomePane } from "./home-pane";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

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

describe("HomePane", () => {
  it("uses the shared dashboard tab content width", () => {
    const { container } = render(<HomePane firstName="Karan" onSubmit={() => undefined} />);

    expect(container.firstElementChild).toHaveClass("w-full", "mx-auto", "box-content", "max-w-4xl", "px-10", "py-8");
    expect(container.firstElementChild?.className).not.toContain("max-w-[");
  });

  it("keeps Home as a launcher and renders the design's empty Recents state", () => {
    render(<HomePane firstName="Karan" onSubmit={() => undefined} />);

    expect(screen.queryByLabelText("Chat thread")).not.toBeInTheDocument();
    expect(screen.getByText("Recents")).toBeInTheDocument();
    expect(screen.getByText("Your conversations will appear here")).toBeInTheDocument();
  });

  it("prefills the chat input when a suggested prompt chip is clicked", async () => {
    const user = userEvent.setup();
    render(<HomePane firstName="Karan" onSubmit={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Triage inbox" }));

    expect(screen.getByLabelText("Message Sketch")).toHaveValue("Triage my inbox from the last 24 hours");
  });

  it("renders Recents with the same section and row copy as the provided design", () => {
    render(
      <HomePane
        firstName="Karan"
        onSubmit={() => undefined}
        recents={[
          {
            id: "web-chat",
            title: "Create a PDF for my skills",
            channel: "web",
            occurredAt: "2026-05-26T06:30:00.000Z",
            now: new Date("2026-05-26T06:48:00.000Z"),
          },
        ]}
      />,
    );

    expect(screen.getByText("Recent conversations")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create a PDF for my skills/i })).toHaveAttribute("href", "/chat/web-chat");
    expect(screen.getByText("18m")).toBeInTheDocument();
    expect(screen.queryByText("Your conversations will appear here")).not.toBeInTheDocument();
  });

  it("confirms before deleting a recent conversation", async () => {
    const user = userEvent.setup();
    const onDeleteConversation = vi.fn();
    render(
      <HomePane
        firstName="Karan"
        onSubmit={() => undefined}
        onDeleteConversation={onDeleteConversation}
        recents={[
          {
            id: "web-chat",
            title: "Create a PDF for my skills",
            channel: "web",
            occurredAt: "2026-05-26T06:30:00.000Z",
            now: new Date("2026-05-26T06:48:00.000Z"),
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Conversation actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /Delete chat/i }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Delete conversation?")).toBeInTheDocument();
    expect(onDeleteConversation).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDeleteConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "web-chat", title: "Create a PDF for my skills" }),
    );
  });
});
