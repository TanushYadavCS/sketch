import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatThread } from "./chat-thread";

describe("ChatThread", () => {
  it("uses the Apeksha chat message treatment for user and Sketch messages", () => {
    render(
      <ChatThread
        messages={[
          { id: "u1", role: "user", text: "Hi Sketch" },
          { id: "a1", role: "assistant", text: "Hi Karan" },
        ]}
      />,
    );

    expect(screen.getByText("Hi Sketch").closest("div")).toHaveClass("rounded-[12px]");
    expect(screen.getByText("Hi Karan").closest("div")).not.toHaveClass("rounded-[12px]");
    const avatar = screen.getByLabelText("Sketch");
    expect(avatar).not.toHaveClass("mt-[2px]");
    expect(avatar.querySelectorAll("img")).toHaveLength(1);
  });

  it("shows the animated Sketch thinking state while waiting for a response", () => {
    render(<ChatThread busy />);

    expect(screen.getByLabelText("Sketch is thinking")).toHaveClass("sketch-icon-thinking");
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("shows live tool progress instead of the generic thinking row", () => {
    render(<ChatThread busy messages={[{ id: "a1", role: "assistant", progressLines: ['📖 Reading "notes.md"'] }]} />);

    expect(screen.getByText('📖 Reading "notes.md"').closest("div")).toHaveClass("sketch-text-thinking");
    expect(screen.getByText('📖 Reading "notes.md"').closest("div")).toHaveClass("italic");
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  });

  it("shows generated files as downloadable attachments", () => {
    render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "Created the PDF.",
            files: [{ name: "skills-overview.pdf", url: "/api/web-chat/files?path=skills-overview.pdf" }],
          },
        ]}
      />,
    );

    const link = screen.getByRole("link", { name: "skills-overview.pdf" });
    expect(link).toHaveAttribute("href", "/api/web-chat/files?path=skills-overview.pdf");
    expect(link).toHaveAttribute("download", "skills-overview.pdf");
  });

  it("renders compact timestamps for dated messages", () => {
    render(
      <ChatThread
        messages={[
          { id: "u1", role: "user", text: "Hi Sketch", createdAt: "2026-05-26T10:24:00.000Z" },
          { id: "a1", role: "assistant", text: "Hi Karan", createdAt: "2026-05-26T10:25:00.000Z" },
        ]}
      />,
    );

    const timestamps = screen.getAllByText(/\d{1,2}:\d{2}/);
    expect(timestamps).toHaveLength(2);
    expect(timestamps[0].tagName.toLowerCase()).toBe("time");
    expect(timestamps[0]).toHaveAttribute("dateTime", "2026-05-26T10:24:00.000Z");
  });
});
