import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatPage, buildChatThreadMessages, hasPendingAssistantProgress, validateChatSearch } from "./chat";

const sendMessage = vi.fn();
const setMessages = vi.fn();
const useChatArgs = vi.fn();
const mocks = vi.hoisted(() => ({
  loadMessages: vi.fn().mockResolvedValue({ messages: [] }),
  navigate: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    webChat: {
      messages: mocks.loadMessages,
    },
  },
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (args: unknown) => {
    useChatArgs(args);
    return {
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "Hi Sketch" }] },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi Karan" }] },
      ],
      status: "ready",
      error: undefined,
      setMessages,
      sendMessage,
    };
  },
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    useParams: () => ({ conversationId: "chat-alpha" }),
    useSearch: () => ({ message: "Plan my day" }),
    useNavigate: () => mocks.navigate,
  };
});

describe("chat route", () => {
  it("validates optional initial message search state", () => {
    expect(validateChatSearch({ message: "  Hello  " })).toEqual({ message: "Hello" });
    expect(validateChatSearch({ message: "" })).toEqual({});
    expect(validateChatSearch({ message: ["No"] })).toEqual({});
  });

  it("extracts visible user and assistant text from AI SDK UI messages", () => {
    const messages = buildChatThreadMessages([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-05-26T10:00:00.000Z",
        parts: [{ type: "text", text: "Hi Sketch" }],
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-05-26T10:01:00.000Z",
        parts: [{ type: "text", text: "Hi Karan" }],
      },
      {
        id: "system-1",
        role: "system",
        parts: [{ type: "text", text: "hidden" }],
      },
    ]);

    expect(messages).toEqual([
      { id: "u1", role: "user", text: "Hi Sketch", createdAt: "2026-05-26T10:00:00.000Z" },
      { id: "a1", role: "assistant", text: "Hi Karan", createdAt: "2026-05-26T10:01:00.000Z" },
    ]);
  });

  it("uses message metadata timestamps for live AI SDK messages", () => {
    const messages = buildChatThreadMessages([
      {
        id: "u-live",
        role: "user",
        metadata: { createdAt: "2026-05-26T10:02:00.000Z" },
        parts: [{ type: "text", text: "Live message" }],
      },
    ]);

    expect(messages).toEqual([
      { id: "u-live", role: "user", text: "Live message", createdAt: "2026-05-26T10:02:00.000Z" },
    ]);
  });

  it("extracts visible assistant progress from AI SDK data parts before final text arrives", () => {
    const messages = buildChatThreadMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "data-progress", id: "progress", data: { lines: ['📖 Reading "notes.md"'] } }],
      },
    ]);

    expect(messages).toEqual([{ id: "a1", role: "assistant", progressLines: ['📖 Reading "notes.md"'] }]);
  });

  it("detects persisted assistant progress as a pending background run", () => {
    expect(
      hasPendingAssistantProgress([
        { id: "u1", role: "user", parts: [{ type: "text", text: "Check notes" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "data-progress", id: "progress", data: { lines: ["Thinking…"] } }],
        },
      ]),
    ).toBe(true);

    expect(
      hasPendingAssistantProgress([
        { id: "u1", role: "user", parts: [{ type: "text", text: "Check notes" }] },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "Done." }] },
      ]),
    ).toBe(false);
  });

  it("extracts generated file data parts as assistant attachments", () => {
    const messages = buildChatThreadMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Created the PDF." },
          {
            type: "data-file",
            id: "file-0",
            data: {
              name: "skills-overview.pdf",
              url: "/api/web-chat/files?path=skills-overview.pdf",
              mediaType: "application/pdf",
              sizeBytes: 9,
            },
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        id: "a1",
        role: "assistant",
        text: "Created the PDF.",
        files: [
          {
            name: "skills-overview.pdf",
            url: "/api/web-chat/files?path=skills-overview.pdf",
            mediaType: "application/pdf",
            sizeBytes: 9,
          },
        ],
      },
    ]);
  });

  it("loads persisted web chat messages into the AI SDK chat state", async () => {
    const persisted = [
      { id: "u-history", role: "user", parts: [{ type: "text", text: "What did we discuss?" }] },
      { id: "a-history", role: "assistant", parts: [{ type: "text", text: "We discussed skills." }] },
    ];
    mocks.loadMessages.mockResolvedValueOnce({ messages: persisted });

    render(<ChatPage />);

    expect(mocks.loadMessages).toHaveBeenCalledWith("chat-alpha");
    await waitFor(() => expect(setMessages).toHaveBeenCalledWith(persisted));
  });

  it("renders a dedicated chat screen and submits the initial search message after history loads", async () => {
    sendMessage.mockClear();
    mocks.navigate.mockClear();

    const { container } = render(<ChatPage />);

    expect(container.firstElementChild).toHaveClass("mx-auto", "box-content", "max-w-4xl", "px-10");
    expect(screen.getByRole("heading", { name: "New web chat" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Thread options")).not.toBeInTheDocument();
    expect(screen.getByText("Hi Sketch")).toBeInTheDocument();
    expect(screen.getByText("Hi Karan")).toBeInTheDocument();
    expect(useChatArgs).toHaveBeenCalledWith(expect.objectContaining({ id: "chat-alpha" }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        text: "Plan my day",
        metadata: { createdAt: expect.any(String) },
      }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/chat/$conversationId",
      params: { conversationId: "chat-alpha" },
      search: {},
      replace: true,
    });
  });
});
