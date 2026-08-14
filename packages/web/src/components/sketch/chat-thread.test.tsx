import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatThread } from "./chat-thread";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

function stubClipboardWriteText() {
  const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

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

  it("renders bounded choice questions and returns the selected stable ID", () => {
    const onSelectQuestion = vi.fn();
    const question = {
      id: "delivery-mode",
      prompt: "Where should Sketch send the result?",
      options: [
        { id: "slack", label: "Slack" },
        { id: "email", label: "Email", description: "Send it to your inbox." },
      ],
    };

    render(
      <ChatThread messages={[{ id: "question-1", role: "assistant", question }]} onSelectQuestion={onSelectQuestion} />,
    );

    const questionCard = screen.getByTestId("question-card");
    expect(questionCard).toBeInTheDocument();
    expect(questionCard).toHaveClass("max-w-[640px]");
    expect(questionCard.querySelector("[data-question-flow-step]")).toHaveClass("min-h-0");
    expect(screen.getByLabelText("Sketch").parentElement).toContainElement(questionCard);
    expect(questionCard).toHaveAttribute("data-question-id", question.id);

    const slackOption = screen.getByRole("button", { name: "Slack" });
    expect(slackOption).toHaveAttribute("data-question-option-id", "slack");
    fireEvent.click(slackOption);
    expect(onSelectQuestion).toHaveBeenCalledWith(question, question.options[0]);
    expect(screen.getByRole("button", { name: /Email Send it to your inbox/ })).toBeDisabled();
  });

  it("walks batched questions progressively and submits their ordered answers", () => {
    const onSubmitQuestionBatch = vi.fn();
    const batch = {
      batchId: "setup-1",
      questions: [
        {
          id: "source",
          prompt: "Where should I look?",
          options: [
            { id: "gmail", label: "Gmail" },
            { id: "drive", label: "Google Drive" },
          ],
        },
        {
          id: "delivery",
          prompt: "Where should I send it?",
          options: [
            { id: "slack", label: "Slack" },
            { id: "email", label: "Email" },
          ],
        },
      ],
    };

    render(
      <ChatThread
        messages={[{ id: "batch-message", role: "assistant", questionBatch: batch }]}
        onSubmitQuestionBatch={onSubmitQuestionBatch}
      />,
    );

    const card = screen.getByTestId("question-batch-card");
    expect(card).toHaveAttribute("data-question-batch-id", "setup-1");
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.queryByText("Where should I send it?")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
    expect(onSubmitQuestionBatch).not.toHaveBeenCalled();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Slack" }));

    expect(onSubmitQuestionBatch).toHaveBeenCalledWith(batch, {
      batchId: "setup-1",
      answers: [
        { questionId: "source", optionId: "gmail" },
        { questionId: "delivery", optionId: "slack" },
      ],
    });
    expect(screen.getByRole("button", { name: "Slack" })).toBeDisabled();
  });

  it("only enables the latest single-or-batch question interaction", () => {
    render(
      <ChatThread
        messages={[
          {
            id: "single-message",
            role: "assistant",
            question: {
              id: "old-question",
              prompt: "Old question",
              options: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
            },
          },
          {
            id: "batch-message",
            role: "assistant",
            questionBatch: {
              batchId: "latest-batch",
              questions: [
                {
                  id: "one",
                  prompt: "First",
                  options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                  ],
                },
                {
                  id: "two",
                  prompt: "Second",
                  options: [
                    { id: "c", label: "C" },
                    { id: "d", label: "D" },
                  ],
                },
              ],
            },
          },
        ]}
        onSelectQuestion={vi.fn()}
        onSubmitQuestionBatch={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Yes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "A" })).toBeEnabled();
  });

  it("renders interrupted runs as guidance instead of a Sketch message", () => {
    render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            interruption: {
              detail: "Sketch paused.",
              label: "What should Sketch do differently?",
            },
          },
        ]}
      />,
    );

    expect(screen.queryByLabelText("Sketch")).not.toBeInTheDocument();
    expect(screen.getByText("Sketch paused.").closest("[data-interruption-notice]")).toBeInTheDocument();
    expect(screen.getByText("What should Sketch do differently?").closest("[data-interruption-notice]")).toHaveClass(
      "border-l-2",
    );
  });

  it("shows live tool progress instead of the generic thinking row", () => {
    render(
      <ChatThread
        busy
        messages={[
          {
            id: "a1",
            role: "assistant",
            progressItems: [
              {
                id: "read-notes",
                kind: "tool-call",
                label: 'Reading "notes.md"',
                detail: "Checking the uploaded notes",
                toolName: "Read",
                icon: { type: "tool", name: "Read" },
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText('Reading "notes.md"').closest("[data-progress-item]")).toBeInTheDocument();
    expect(screen.getByText("Checking the uploaded notes")).toBeInTheDocument();
    const activeLine = screen.getByText('Reading "notes.md"').closest("[data-progress-line]");
    expect(activeLine).toHaveClass("sketch-shimmer-progress");
    expect(screen.getByText("Checking the uploaded notes").closest("[data-progress-line]")).toBe(activeLine);
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  });

  it("renders legacy progress lines without visible Slack emoji treatment", () => {
    render(<ChatThread busy messages={[{ id: "a1", role: "assistant", progressLines: ['📖 Reading "notes.md"'] }]} />);

    expect(screen.getByText('Reading "notes.md"').closest("[data-progress-item]")).toBeInTheDocument();
    expect(screen.queryByText('📖 Reading "notes.md"')).not.toBeInTheDocument();
  });

  it("renders assistant progress as a timeline with text between tool calls", () => {
    const timeline = [
      { id: "text-0", type: "text" as const, text: "Let me check the workspace." },
      {
        id: "progress-0",
        type: "progress" as const,
        progressItems: [{ kind: "file", label: "Reading", detail: "notes.md", toolName: "Read" }],
      },
      { id: "text-2", type: "text" as const, text: "I found the relevant note. Checking the tests next." },
      {
        id: "progress-1",
        type: "progress" as const,
        progressItems: [{ kind: "shell", label: "Running", detail: "pnpm test", toolName: "Bash" }],
      },
    ];
    const { container, rerender } = render(
      <ChatThread
        busy
        messages={[
          {
            id: "a1",
            role: "assistant",
            timeline,
          },
        ]}
      />,
    );
    const textEntry = container.querySelectorAll("[data-timeline-entry]")[2];

    expect(container.querySelectorAll("[data-timeline-entry]")).toHaveLength(4);
    expect(screen.getByText("Let me check the workspace.")).toBeInTheDocument();
    expect(screen.getByText("I found the relevant note. Checking the tests next.")).toBeInTheDocument();
    expect(screen.getByText("Reading").closest("[data-progress-item]")).toBeInTheDocument();
    expect(screen.getByText("Running").closest("[data-progress-line]")).toHaveClass("sketch-shimmer-progress");
    expect(screen.getByText("Reading").closest("[data-progress-line]")).not.toHaveClass("sketch-shimmer-progress");

    rerender(
      <ChatThread
        busy
        messages={[
          {
            id: "a1",
            role: "assistant",
            timeline: [
              ...timeline.slice(0, 2),
              {
                id: "text-2",
                type: "text",
                text: "I found the relevant note. Checking the tests next. Almost done.",
              },
              timeline[3],
            ],
          },
        ]}
      />,
    );

    expect(container.querySelectorAll("[data-timeline-entry]")[2]).toBe(textEntry);
  });

  it("renders integration connection cards with progress and completion states", () => {
    const onConnect = vi.fn();
    const connection = {
      requestId: "integration-req-1",
      appId: "github",
      appName: "GitHub",
      reason: "Connect GitHub so Sketch can inspect repository issues.",
    };
    const { rerender } = render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "Connect GitHub first.",
            integrationConnections: [connection],
          },
        ]}
        onConnectIntegration={onConnect}
      />,
    );

    expect(screen.getByText("Connect GitHub").closest("[data-integration-connection-card]")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledWith(connection);

    rerender(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "Connect GitHub first.",
            integrationConnections: [connection],
          },
        ]}
        integrationConnectionStatuses={{ "integration-req-1": "connecting" }}
        onConnectIntegration={onConnect}
      />,
    );

    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connecting" })).toBeDisabled();

    rerender(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "Connect GitHub first.",
            integrationConnections: [connection],
          },
        ]}
        integrationConnectionStatuses={{ "integration-req-1": "connected" }}
        onConnectIntegration={onConnect}
      />,
    );

    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Connected" })).toBeDisabled();
  });

  it("renders GitHub connection cards with the white GitHub mark", () => {
    const iconUrl = "https://cdn.example.com/github.png";

    render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "Connect GitHub first.",
            integrationConnections: [
              {
                requestId: "integration-req-1",
                appId: "github",
                appName: "GitHub",
                icon: iconUrl,
              },
            ],
          },
        ]}
        onConnectIntegration={vi.fn()}
      />,
    );

    expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    const icon = document.querySelector("[data-integration-connection-card] svg");
    expect(icon).toBeInTheDocument();
    expect(icon?.parentElement).toHaveClass("bg-[#24292f]", "text-white");
    expect(document.querySelector("[data-integration-connection-card] img")).not.toBeInTheDocument();
  });

  it("renders connected integration account cards without a connect action", () => {
    render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            integrationConnections: [
              {
                requestId: "integration-connected-github",
                appId: "github",
                appName: "GitHub",
                state: "connected",
                accountName: "Alice GitHub",
              },
            ],
          },
        ]}
        onConnectIntegration={vi.fn()}
      />,
    );

    expect(screen.getByText("GitHub connected")).toBeInTheDocument();
    expect(screen.getByText("Alice GitHub is connected and available to Sketch.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connected" })).toBeDisabled();
  });

  it("starts a new scrolling progress window after assistant text", () => {
    const { container } = render(
      <ChatThread
        busy
        messages={[
          {
            id: "a1",
            role: "assistant",
            timeline: [
              {
                id: "progress-0",
                type: "progress",
                progressItems: [{ kind: "file", label: "Reading old notes", toolName: "Read" }],
              },
              { id: "text-1", type: "text", text: "Finished the old check." },
              {
                id: "progress-1",
                type: "progress",
                progressItems: [{ kind: "search", label: "Searching files", toolName: "Grep" }],
              },
              {
                id: "progress-2",
                type: "progress",
                progressItems: [{ kind: "shell", label: "Running tests", toolName: "Bash" }],
              },
              {
                id: "progress-3",
                type: "progress",
                progressItems: [{ kind: "file", label: "Editing summary", toolName: "Edit" }],
              },
              {
                id: "progress-4",
                type: "progress",
                progressItems: [{ kind: "file", label: "Writing response", toolName: "Write" }],
              },
            ],
          },
        ]}
      />,
    );

    expect(container.querySelectorAll("[data-progress-item]")).toHaveLength(4);
    expect(screen.getByText("Reading old notes")).toBeInTheDocument();
    expect(screen.getByText("Finished the old check.")).toBeInTheDocument();
    expect(screen.queryByText("Searching files")).not.toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("Editing summary")).toBeInTheDocument();
    expect(screen.getByText("Writing response").closest("[data-progress-line]")).toHaveClass("sketch-shimmer-progress");
  });

  it("collapses completed timeline activity and reopens a scrollable full history", () => {
    const { container } = render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            timeline: [
              {
                id: "progress-0",
                type: "progress",
                progressItems: [{ kind: "file", label: "Reading notes", toolName: "Read" }],
              },
              { id: "text-1", type: "text", text: "I found the relevant note. Checking the tests next." },
              {
                id: "progress-2",
                type: "progress",
                progressItems: [{ kind: "search", label: "Searching files", toolName: "Grep" }],
              },
              {
                id: "progress-3",
                type: "progress",
                progressItems: [{ kind: "shell", label: "Running tests", toolName: "Bash" }],
              },
              {
                id: "progress-4",
                type: "progress",
                progressItems: [{ kind: "file", label: "Editing summary", toolName: "Edit" }],
              },
              { id: "text-5", type: "text", text: "Final answer is ready." },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Final answer is ready.")).toBeInTheDocument();
    expect(screen.queryByText("Reading notes")).not.toBeInTheDocument();
    expect(screen.queryByText("I found the relevant note. Checking the tests next.")).not.toBeInTheDocument();
    expect(screen.queryByText("Searching files")).not.toBeInTheDocument();

    const button = screen.getByRole("button", { name: /Activity timeline 4 tool calls, 1 update/ });
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("[data-timeline-history]")).toHaveClass("max-h-[260px]", "overflow-y-auto");
    expect(container.querySelectorAll("[data-progress-item]")).toHaveLength(4);
    expect(screen.getByText("Reading notes")).toBeInTheDocument();
    expect(screen.getByText("I found the relevant note. Checking the tests next.")).toBeInTheDocument();
    expect(screen.getByText("Searching files")).toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("Editing summary")).toBeInTheDocument();
    expect(screen.getAllByText("Final answer is ready.")).toHaveLength(1);
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

  it("copies a complete assistant response from the message footer", async () => {
    const writeText = stubClipboardWriteText();

    render(<ChatThread messages={[{ id: "a1", role: "assistant", text: "Final answer.\n\nSecond paragraph." }]} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Final answer.\n\nSecond paragraph."));
    expect(screen.getByRole("button", { name: "Response copied" })).toBeInTheDocument();
  });

  it("does not show response copy while an assistant response is still active", () => {
    render(<ChatThread busy messages={[{ id: "a1", role: "assistant", text: "Partial answer" }]} />);

    expect(screen.queryByRole("button", { name: "Copy response" })).not.toBeInTheDocument();
  });

  it("copies only final timeline text from the assistant response footer", async () => {
    const writeText = stubClipboardWriteText();

    render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            timeline: [
              {
                id: "progress-0",
                type: "progress",
                progressItems: [{ kind: "file", label: "Reading notes", toolName: "Read" }],
              },
              { id: "text-1", type: "text", text: "Final answer is ready." },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Final answer is ready."));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("Reading notes"));
  });

  it("does not show response copy for assistant activity without final text", () => {
    render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            timeline: [
              {
                id: "progress-0",
                type: "progress",
                progressItems: [{ kind: "file", label: "Reading notes", toolName: "Read" }],
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.queryByRole("button", { name: "Copy response" })).not.toBeInTheDocument();
  });

  it("copies assistant paragraph and code blocks separately", async () => {
    const writeText = stubClipboardWriteText();

    render(
      <ChatThread
        messages={[
          {
            id: "a1",
            role: "assistant",
            text: "Intro paragraph.\n\n```ts\nconst answer = 42;\n```\n\nSecond paragraph.",
          },
        ]}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Copy text block" })[0]);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Intro paragraph."));

    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("const answer = 42;"));

    expect(screen.getByText("const answer = 42;").tagName.toLowerCase()).toBe("code");
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
