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

    expect(screen.getByText("Hi Sketch").closest(".markdown-body")?.parentElement).toHaveClass("rounded-[12px]");
    expect(screen.getByText("Hi Karan").closest(".markdown-body")?.parentElement).not.toHaveClass("rounded-[12px]");
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

  it("renders Sketch markdown formatting and autolinked URLs", () => {
    render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "Here is **the plan**:\n\n- Open https://example.com/docs\n- Ship it",
          },
        ]}
      />,
    );

    expect(screen.getByText("the plan").tagName.toLowerCase()).toBe("strong");
    expect(screen.getByRole("list")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "example.com/docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders user message URLs as links without breaking the chat bubble", () => {
    render(<ChatThread messages={[{ id: "u1", role: "user", text: "Read https://example.com/report" }]} />);

    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "example.com/report" })).toHaveAttribute(
      "href",
      "https://example.com/report",
    );
  });

  it("keeps explicit markdown link labels and compacts only bare long URLs", () => {
    render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "[Named sheet](https://docs.google.com/spreadsheets/d/very-long-id/edit)\n\nhttps://docs.google.com/spreadsheets/d/very-long-id-that-would-wrap-across-the-chat/edit",
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Named sheet" })).toHaveAttribute(
      "href",
      "https://docs.google.com/spreadsheets/d/very-long-id/edit",
    );
    const compactLink = screen.getByRole("link", { name: "docs.google.com/spreadsheets/d/very-lon..." });
    expect(compactLink).toHaveAttribute(
      "href",
      "https://docs.google.com/spreadsheets/d/very-long-id-that-would-wrap-across-the-chat/edit",
    );
  });

  it("normalizes Slack-style links from older web chat responses", () => {
    render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "<https://docs.google.com/spreadsheets/d/sheet-id/edit|Polka Canvas MCP Test>",
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Polka Canvas MCP Test" })).toHaveAttribute(
      "href",
      "https://docs.google.com/spreadsheets/d/sheet-id/edit",
    );
    expect(screen.queryByText(/<https:/)).not.toBeInTheDocument();
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
