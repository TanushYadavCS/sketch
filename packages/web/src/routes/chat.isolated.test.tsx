import { setPendingWebChatSubmission, takePendingWebChatSubmission } from "@/lib/chat-target";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatPage,
  buildChatThreadMessages,
  hasPendingAssistantProgress,
  outgoingRequestOptions,
  outgoingTextMessage,
  titleFromChatMessages,
  validateChatSearch,
} from "./chat";

const sendMessage = vi.fn();
const setMessages = vi.fn();
const useChatArgs = vi.fn();
const mocks = vi.hoisted(() => ({
  loadMessages: vi.fn().mockResolvedValue({ messages: [] }),
  navigate: vi.fn(),
  search: { message: "Plan my day" } as Record<string, unknown>,
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
    useSearch: () => mocks.search,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock("./dashboard", () => ({
  dashboardRoute: { id: "__root__/dashboard" },
  useDashboardAuth: () => ({ displayName: "Karan Nijhawan" }),
}));

vi.mock("@/components/sketch/home-pane", () => ({
  HomePane: ({ firstName }: { firstName: string; children?: ReactNode }) => <div>Chat launcher for {firstName}</div>,
}));

describe("chat route", () => {
  afterEach(() => {
    takePendingWebChatSubmission("chat-alpha");
    mocks.search = { message: "Plan my day" };
  });

  it("validates optional initial message search state", () => {
    expect(validateChatSearch({ message: "  Hello  " })).toEqual({ message: "Hello" });
    expect(validateChatSearch({ prefill: "  Draft this  " })).toEqual({ prefill: "Draft this" });
    expect(validateChatSearch({ message: "  Hello  ", prefill: "  Draft this  " })).toEqual({
      message: "Hello",
      prefill: "Draft this",
    });
    expect(validateChatSearch({ message: "" })).toEqual({});
    expect(validateChatSearch({ prefill: "" })).toEqual({});
    expect(validateChatSearch({ message: ["No"] })).toEqual({});
    expect(validateChatSearch({ prefill: ["No"] })).toEqual({});
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

  it("uses the first user message as the chat title", () => {
    expect(
      titleFromChatMessages([
        { id: "u1", role: "user", parts: [{ type: "text", text: "  Plan my day\nwith the team  " }] },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "Done." }] },
      ]),
    ).toBe("Plan my day with the team");
    expect(titleFromChatMessages([{ id: "a1", role: "assistant", parts: [{ type: "text", text: "Done." }] }])).toBe(
      "New web chat",
    );
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

  it("extracts automation data parts as assistant automation cards", () => {
    const artifact = {
      taskId: "task-123",
      kind: "New automation",
      title: "Daily account brief",
      description: "Summarizes account updates.",
      tags: ["ClickUp", "Slack"],
      scheduleLabel: "Every hour",
      deliveryLabel: "Slack dm",
      builderUrl: "/scheduled-tasks/task-123/edit",
      status: "active" as const,
    };
    const messages = buildChatThreadMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Created the automation." },
          { type: "data-automation", id: "automation-0", data: artifact },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        id: "a1",
        role: "assistant",
        text: "Created the automation.",
        automations: [artifact],
      },
    ]);
  });

  it("puts uploaded attachments in the AI SDK request body and visible message parts", () => {
    const attachment = {
      name: "notes.txt",
      path: "attachments/123-notes.txt",
      relativePath: "attachments/123-notes.txt",
      url: "/api/web-chat/files?path=attachments%2F123-notes.txt",
      mediaType: "text/plain",
      sizeBytes: 11,
    };

    expect(outgoingTextMessage("Read this", [attachment])).toEqual({
      metadata: { createdAt: expect.any(String) },
      parts: [
        { type: "text", text: "Read this" },
        {
          type: "data-file",
          id: "attachment-0",
          data: {
            name: "notes.txt",
            url: "/api/web-chat/files?path=attachments%2F123-notes.txt",
            mediaType: "text/plain",
            sizeBytes: 11,
          },
        },
      ],
    });
    expect(outgoingRequestOptions([attachment])).toEqual({ body: { attachments: [attachment] } });
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

  it("clears stale chat state when the selected conversation has no persisted messages", async () => {
    setMessages.mockClear();
    mocks.loadMessages.mockResolvedValueOnce({ messages: [] });

    render(<ChatPage />);

    await waitFor(() => expect(setMessages).toHaveBeenCalledWith([]));
  });

  it("renders a dedicated chat screen and submits the initial search message after history loads", async () => {
    sendMessage.mockClear();
    mocks.navigate.mockClear();

    const { container } = render(<ChatPage />);

    expect(container.firstElementChild).toHaveClass("mx-auto", "box-content", "max-w-4xl", "px-10");
    expect(screen.getByRole("heading", { name: "Hi Sketch" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Thread options")).not.toBeInTheDocument();
    const thread = within(screen.getByLabelText("Chat thread"));
    expect(thread.getByText("Hi Sketch")).toBeInTheDocument();
    expect(thread.getByText("Hi Karan")).toBeInTheDocument();
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

  it("prefills the composer without submitting the chat", async () => {
    mocks.search = { prefill: "Plan with Sketch" };
    sendMessage.mockClear();
    mocks.navigate.mockClear();

    render(<ChatPage />);

    expect(screen.getByLabelText("Message Sketch")).toHaveValue("Plan with Sketch");
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/chat/$conversationId",
        params: { conversationId: "chat-alpha" },
        search: {},
        replace: true,
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("submits pending Home attachments after history loads", async () => {
    sendMessage.mockClear();
    mocks.navigate.mockClear();
    const attachment = {
      name: "notes.txt",
      path: "attachments/123-notes.txt",
      relativePath: "attachments/123-notes.txt",
      url: "/api/web-chat/files?path=attachments%2F123-notes.txt",
      mediaType: "text/plain",
      sizeBytes: 11,
    };
    setPendingWebChatSubmission("chat-alpha", { text: "Read this", attachments: [attachment] });

    render(<ChatPage />);

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        {
          metadata: { createdAt: expect.any(String) },
          parts: [
            { type: "text", text: "Read this" },
            {
              type: "data-file",
              id: "attachment-0",
              data: {
                name: "notes.txt",
                url: "/api/web-chat/files?path=attachments%2F123-notes.txt",
                mediaType: "text/plain",
                sizeBytes: 11,
              },
            },
          ],
        },
        { body: { attachments: [attachment] } },
      ),
    );
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/chat/$conversationId",
      params: { conversationId: "chat-alpha" },
      search: {},
      replace: true,
    });
  });
});
