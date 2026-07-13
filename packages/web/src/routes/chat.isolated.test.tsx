import { setPendingWebChatSubmission, takePendingWebChatSubmission } from "@/lib/chat-target";
import { renderWithProviders } from "@/test/utils";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatPage,
  SMOOTH_TEXT_STREAM_DELAY_MS,
  buildChatThreadMessages,
  hasPendingAssistantProgress,
  nextSmoothedAssistantText,
  outgoingRequestOptions,
  outgoingTextMessage,
  releaseReadySmoothedAssistantText,
  titleFromChatMessages,
  validateChatSearch,
} from "./chat";

const sendMessage = vi.fn();
const setMessages = vi.fn();
const clearError = vi.fn();
const useChatArgs = vi.fn();
let mockChatStatus = "ready";
let mockChatError: Error | undefined;
let mockChatMessages: Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }> = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Hi Sketch" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi Karan" }] },
];
const mocks = vi.hoisted(() => ({
  loadMessages: vi.fn().mockResolvedValue({ messages: [] }),
  progressSettings: vi.fn().mockResolvedValue({ toolProgress: "friendly" }),
  updateProgressSettings: vi.fn((toolProgress: string) => Promise.resolve({ toolProgress })),
  interrupt: vi.fn().mockResolvedValue({ success: true, interrupted: true }),
  navigate: vi.fn(),
  listMcpServers: vi.fn().mockResolvedValue([]),
  listConnections: vi.fn().mockResolvedValue([]),
  listApps: vi.fn().mockResolvedValue({ apps: [], pageInfo: { endCursor: null, hasMore: false } }),
  createConnection: vi.fn().mockResolvedValue({ redirectUrl: "https://canvas.example/connect" }),
  createConnectionIntent: vi.fn().mockResolvedValue({
    app: { id: "github", name: "GitHub", description: "Code hosting" },
    redirectUrl: "https://canvas.example/connect",
  }),
  search: { message: "Plan my day" } as Record<string, unknown>,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

vi.mock("@/lib/api", () => ({
  api: {
    webChat: {
      messages: mocks.loadMessages,
      progressSettings: mocks.progressSettings,
      updateProgressSettings: mocks.updateProgressSettings,
      interrupt: mocks.interrupt,
    },
    mcpServers: {
      list: mocks.listMcpServers,
      listConnections: mocks.listConnections,
      listApps: mocks.listApps,
      createConnection: mocks.createConnection,
      createConnectionIntent: mocks.createConnectionIntent,
    },
  },
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (args: unknown) => {
    useChatArgs(args);
    return {
      messages: mockChatMessages,
      status: mockChatStatus,
      error: mockChatError,
      clearError,
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    takePendingWebChatSubmission("chat-alpha");
    mocks.loadMessages.mockReset();
    mocks.loadMessages.mockResolvedValue({ messages: [] });
    mocks.progressSettings.mockReset();
    mocks.progressSettings.mockResolvedValue({ toolProgress: "friendly" });
    mocks.updateProgressSettings.mockReset();
    mocks.updateProgressSettings.mockImplementation((toolProgress: string) => Promise.resolve({ toolProgress }));
    mocks.interrupt.mockReset();
    mocks.interrupt.mockResolvedValue({ success: true, interrupted: true });
    mocks.listMcpServers.mockReset();
    mocks.listMcpServers.mockResolvedValue([]);
    mocks.listConnections.mockReset();
    mocks.listConnections.mockResolvedValue([]);
    mocks.listApps.mockReset();
    mocks.listApps.mockResolvedValue({ apps: [], pageInfo: { endCursor: null, hasMore: false } });
    mocks.createConnection.mockReset();
    mocks.createConnection.mockResolvedValue({ redirectUrl: "https://canvas.example/connect" });
    mocks.createConnectionIntent.mockReset();
    mocks.createConnectionIntent.mockResolvedValue({
      app: { id: "github", name: "GitHub", description: "Code hosting" },
      redirectUrl: "https://canvas.example/connect",
    });
    mockChatStatus = "ready";
    mockChatError = undefined;
    clearError.mockReset();
    mockChatMessages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Hi Sketch" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi Karan" }] },
    ];
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

  it("extracts automation cards from assistant data parts", () => {
    const artifact = {
      taskId: "task-123",
      kind: "New automation",
      title: "Send weekly customer brief",
      description: "Summarizes customer updates every Monday.",
      tags: ["Scheduled", "Slack"],
      scheduleLabel: "Cron: 0 9 * * 1 (Asia/Kolkata)",
      deliveryLabel: "Slack DM",
      builderUrl: "/scheduled-tasks/task-123/edit",
      status: "active" as const,
    };
    const messages = buildChatThreadMessages([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-05-26T10:03:00.000Z",
        parts: [
          { type: "text", text: "Automation created." },
          { type: "data-automation", id: "automation-0", data: artifact },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        id: "a1",
        role: "assistant",
        text: "Automation created.",
        createdAt: "2026-05-26T10:03:00.000Z",
        automations: [artifact],
      },
    ]);
  });

  it("extracts structured assistant progress from AI SDK data parts before final text arrives", () => {
    const messages = buildChatThreadMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "data-progress",
            id: "progress",
            data: {
              items: [
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
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        id: "a1",
        role: "assistant",
        timeline: [
          {
            id: "progress",
            type: "progress",
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
        ],
      },
    ]);
  });

  it("keeps legacy assistant progress lines when structured items are absent", () => {
    const messages = buildChatThreadMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "data-progress", id: "progress", data: { lines: ['📖 Reading "notes.md"'] } }],
      },
    ]);

    expect(messages).toEqual([
      {
        id: "a1",
        role: "assistant",
        timeline: [{ id: "progress", type: "progress", progressLines: ['📖 Reading "notes.md"'] }],
      },
    ]);
  });

  it("renders interrupted assistant runs as pause guidance instead of assistant text", () => {
    const rawMessages = [
      {
        id: "a1",
        role: "assistant" as const,
        parts: [
          {
            type: "data-interruption" as const,
            id: "interruption",
            data: { detail: "Sketch paused.", label: "Tell Sketch what to do differently." },
          },
        ],
      },
    ];
    const messages = buildChatThreadMessages(rawMessages);

    expect(messages).toEqual([
      {
        id: "a1",
        role: "assistant",
        interruption: {
          detail: "Sketch paused.",
          label: "Tell Sketch what to do differently.",
        },
      },
    ]);
    expect(hasPendingAssistantProgress(rawMessages)).toBe(false);
  });

  it("preserves assistant text and progress in stream order", () => {
    expect(
      buildChatThreadMessages([
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "text", text: "Let me check." },
            {
              type: "data-progress",
              id: "progress-0",
              data: { items: [{ id: "read-notes", kind: "tool-call", label: 'Reading "notes.md"', toolName: "Read" }] },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "a1",
        role: "assistant",
        timeline: [
          { id: "text-0", type: "text", text: "Let me check." },
          {
            id: "progress-0",
            type: "progress",
            progressItems: [{ id: "read-notes", kind: "tool-call", label: 'Reading "notes.md"', toolName: "Read" }],
          },
        ],
      },
    ]);

    expect(
      buildChatThreadMessages([
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "text", text: "Let me check." },
            {
              type: "data-progress",
              id: "progress-0",
              data: { items: [{ id: "read-notes", kind: "tool-call", label: 'Reading "notes.md"', toolName: "Read" }] },
            },
            { type: "text", text: "Still checking." },
            {
              type: "data-progress",
              id: "progress-1",
              data: { items: [{ id: "run-tests", kind: "tool-call", label: "Running tests", toolName: "Bash" }] },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "a1",
        role: "assistant",
        timeline: [
          { id: "text-0", type: "text", text: "Let me check." },
          {
            id: "progress-0",
            type: "progress",
            progressItems: [{ id: "read-notes", kind: "tool-call", label: 'Reading "notes.md"', toolName: "Read" }],
          },
          { id: "text-2", type: "text", text: "Still checking." },
          {
            id: "progress-1",
            type: "progress",
            progressItems: [{ id: "run-tests", kind: "tool-call", label: "Running tests", toolName: "Bash" }],
          },
        ],
      },
    ]);
  });

  it("reveals streamed assistant text incrementally between incoming chunks", () => {
    const target = "Here is the answer, with enough text to reveal smoothly.";
    const firstFrame = nextSmoothedAssistantText("", target, 16);

    expect(firstFrame.length).toBeGreaterThan(0);
    expect(firstFrame.length).toBeLessThan(target.length);
    expect(target.startsWith(firstFrame)).toBe(true);
    expect(nextSmoothedAssistantText(firstFrame, target, 1000)).toBe(target);
    expect(nextSmoothedAssistantText("Old answer", target, 16)).toBe(target);
  });

  it("keeps streamed assistant text buffered until the reveal delay expires", () => {
    const pendingSegments = [{ text: "Hello", readyAt: SMOOTH_TEXT_STREAM_DELAY_MS }];

    expect(releaseReadySmoothedAssistantText("", pendingSegments, SMOOTH_TEXT_STREAM_DELAY_MS - 1)).toEqual({
      availableText: "",
      pendingSegments,
    });
    expect(releaseReadySmoothedAssistantText("", pendingSegments, SMOOTH_TEXT_STREAM_DELAY_MS)).toEqual({
      availableText: "Hello",
      pendingSegments: [],
    });
  });

  it("detects persisted assistant progress as a pending background run", () => {
    expect(
      hasPendingAssistantProgress([
        { id: "u1", role: "user", parts: [{ type: "text", text: "Check notes" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "data-progress", id: "progress", data: { items: [{ kind: "generic", label: "Thinking" }] } }],
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

  it("extracts integration connection cards from assistant data parts", () => {
    const messages = buildChatThreadMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Connect GitHub first." },
          {
            type: "data-integration-connection",
            id: "integration-connection-0",
            data: {
              requestId: "integration-req-1",
              appId: "github",
              appName: "GitHub",
              icon: "https://cdn.example.com/github.png",
              reason: "Connect GitHub so Sketch can inspect repository issues.",
            },
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        id: "a1",
        role: "assistant",
        text: "Connect GitHub first.",
        integrationConnections: [
          {
            requestId: "integration-req-1",
            appId: "github",
            appName: "GitHub",
            icon: "https://cdn.example.com/github.png",
            reason: "Connect GitHub so Sketch can inspect repository issues.",
          },
        ],
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

  it("forwards AbortSignal through the web chat messages API helper", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [], updatedAt: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { api: actualApi } = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");

    await actualApi.webChat.messages("chat-alpha", { signal });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/web-chat/messages?conversationId=chat-alpha",
      expect.objectContaining({ signal }),
    );
  });

  it("loads persisted web chat messages into the AI SDK chat state", async () => {
    const persisted = [
      { id: "u-history", role: "user", parts: [{ type: "text", text: "What did we discuss?" }] },
      { id: "a-history", role: "assistant", parts: [{ type: "text", text: "We discussed skills." }] },
    ];
    mocks.search = {};
    mocks.loadMessages.mockResolvedValueOnce({ messages: persisted, updatedAt: "2026-07-13T08:00:00.000Z" });

    renderWithProviders(<ChatPage />);

    expect(mocks.loadMessages).toHaveBeenCalledWith(
      "chat-alpha",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await waitFor(() => expect(setMessages).toHaveBeenCalledWith(persisted));
  });

  it("clears stale chat state when the selected conversation has no persisted messages", async () => {
    setMessages.mockClear();
    mocks.search = {};
    mocks.loadMessages.mockResolvedValueOnce({ messages: [], updatedAt: null });

    renderWithProviders(<ChatPage />);

    await waitFor(() => expect(setMessages).toHaveBeenCalledWith([]));
  });

  it("skips history for an initial message new chat and sends immediately", async () => {
    sendMessage.mockClear();
    mocks.navigate.mockClear();

    const { container } = renderWithProviders(<ChatPage />);

    expect(container.firstElementChild).toHaveClass("mx-auto", "box-content", "max-w-4xl", "px-10");
    expect(container.querySelector(".sketch-chat-route-enter")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hi Sketch" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Thread options")).not.toBeInTheDocument();
    const thread = within(screen.getByLabelText("Chat thread"));
    expect(screen.getByLabelText("Chat thread").parentElement).toHaveClass("right-[-18px]", "pr-[18px]");
    expect(thread.getByText("Hi Sketch")).toBeInTheDocument();
    expect(thread.getByText("Hi Karan")).toBeInTheDocument();
    expect(useChatArgs).toHaveBeenCalledWith(expect.objectContaining({ id: "chat-alpha" }));
    expect(mocks.loadMessages).not.toHaveBeenCalled();
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Plan my day" })));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/chat/$conversationId",
      params: { conversationId: "chat-alpha" },
      search: {},
      replace: true,
    });
  });

  it("renders a loading shell and disables the composer until existing history resolves", async () => {
    const history = deferred<{
      messages: Array<{ id: string; role: "user" | "assistant"; parts: Array<{ type: string; text: string }> }>;
      updatedAt: string | null;
    }>();
    mocks.search = {};
    mocks.loadMessages.mockReturnValueOnce(history.promise);

    renderWithProviders(<ChatPage />);

    expect(screen.getByLabelText("Loading conversation")).toBeInTheDocument();
    expect(screen.getByLabelText("Message Sketch")).toBeDisabled();

    history.resolve({
      messages: [{ id: "u-history", role: "user", parts: [{ type: "text", text: "Persisted question" }] }],
      updatedAt: "2026-07-13T08:00:00.000Z",
    });

    await waitFor(() => expect(screen.queryByLabelText("Loading conversation")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Message Sketch")).not.toBeDisabled();
  });

  it("reconciles an SDK error from persisted history and updates the shared cache", async () => {
    const persisted = [
      { id: "user-latest", role: "user", parts: [{ type: "text", text: "Latest question" }] },
      { id: "assistant-final", role: "assistant", parts: [{ type: "text", text: "Recovered answer" }] },
    ];
    const response = { messages: persisted, updatedAt: "2026-07-13T08:00:00.000Z" };
    const setQueryData = vi.spyOn(QueryClient.prototype, "setQueryData");
    mocks.search = {};
    mockChatStatus = "error";
    mockChatError = new Error("Network error");
    mockChatMessages = [{ id: "user-latest", role: "user", parts: [{ type: "text", text: "Latest question" }] }];
    mocks.loadMessages.mockResolvedValue(response);

    renderWithProviders(<ChatPage />);

    await waitFor(() => expect(clearError).toHaveBeenCalledTimes(1));
    expect(setMessages).toHaveBeenCalledWith(persisted);
    expect(screen.queryByText("Network error")).not.toBeInTheDocument();
    expect(setQueryData).toHaveBeenCalledWith(["web-chat", "messages", "chat-alpha"], response);
  });

  it("uses reconciliation instead of the old ready-only interval polling effect", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    const persisted = [
      { id: "user-latest", role: "user", parts: [{ type: "text", text: "Latest question" }] },
      {
        id: "assistant-progress",
        role: "assistant",
        parts: [{ type: "data-progress", id: "progress", data: { lines: ["Working"] } }],
      },
    ];
    mocks.search = {};
    mockChatMessages = persisted;
    mocks.loadMessages.mockResolvedValue({ messages: persisted, updatedAt: "2026-07-13T08:00:00.000Z" });

    renderWithProviders(<ChatPage />);

    await waitFor(() => expect(setMessages).toHaveBeenCalledWith(persisted));
    expect(intervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 1500);
  });

  it("loads and updates the web chat activity renderer mode", async () => {
    const user = userEvent.setup();
    mocks.progressSettings.mockResolvedValueOnce({ toolProgress: "technical" });

    renderWithProviders(<ChatPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Progress updates: Technical" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Progress updates: Technical" }));
    expect(await screen.findByText("Progress updates")).toBeInTheDocument();
    await user.click(await screen.findByRole("menuitemradio", { name: /Off/ }));

    await waitFor(() => expect(mocks.updateProgressSettings).toHaveBeenCalledWith("off"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Progress updates: Off" })).not.toBeDisabled());
  });

  it("interrupts the active web chat run from the prompt input", async () => {
    const user = userEvent.setup();
    mockChatStatus = "streaming";

    renderWithProviders(<ChatPage />);

    await waitFor(() => expect(screen.getByLabelText("Pause Sketch")).toBeInTheDocument());
    await user.click(screen.getByLabelText("Pause Sketch"));

    await waitFor(() => expect(mocks.interrupt).toHaveBeenCalledWith("chat-alpha"));
  });

  it("prefills the composer without submitting the chat", async () => {
    mocks.search = { prefill: "Plan with Sketch" };
    sendMessage.mockClear();
    mocks.navigate.mockClear();

    renderWithProviders(<ChatPage />);

    expect(screen.getByLabelText("Message Sketch")).toHaveValue("Plan with Sketch");
    expect(mocks.loadMessages).not.toHaveBeenCalled();
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

    renderWithProviders(<ChatPage />);

    expect(mocks.loadMessages).not.toHaveBeenCalled();
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

  it("opens Canvas connections from assistant cards in a popup and keeps state on the card", async () => {
    const user = userEvent.setup();
    let connectionStarted = false;
    let connectionVerified = false;
    const events: string[] = [];
    const popup = { closed: false, close: vi.fn(), location: { href: "" } };
    vi.spyOn(window, "open").mockImplementation(() => {
      events.push("popup");
      return popup as unknown as Window;
    });
    mocks.search = {};
    mockChatMessages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Connect GitHub first." },
          {
            type: "data-integration-connection",
            id: "integration-connection-0",
            data: {
              requestId: "integration-req-1",
              appId: "github",
              appName: "GitHub",
              reason: "Connect GitHub so Sketch can inspect repository issues.",
            },
          },
        ],
      },
    ];
    mocks.listMcpServers.mockResolvedValue([
      {
        id: "provider-1",
        type: "canvas",
        slug: "canvas",
        displayName: "Canvas",
        url: "https://mcp.example",
        apiUrl: "https://canvas.example",
        credentials: {},
        mode: "mcp",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    mocks.createConnectionIntent.mockImplementation(async () => {
      expect(events).toEqual(["popup"]);
      events.push("intent");
      connectionStarted = true;
      return { app: { id: "github", name: "GitHub", description: "Code hosting" }, redirectUrl: "about:blank" };
    });
    mocks.listConnections.mockImplementation(async () =>
      connectionStarted && connectionVerified
        ? [
            {
              id: "conn-1",
              providerId: "provider-1",
              source: "canvas_user_secrets",
              appId: "github",
              appName: "GitHub",
              status: "active",
              accessLevel: "personal",
              isOwnedByViewer: true,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ]
        : [],
    );

    renderWithProviders(<ChatPage />);

    await waitFor(() => expect(mocks.listConnections).toHaveBeenCalled());
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(mocks.createConnectionIntent).toHaveBeenCalledWith(
        "provider-1",
        "github",
        expect.any(String),
        expect.objectContaining({ id: "github", name: "GitHub" }),
      ),
    );
    expect(mocks.listApps).not.toHaveBeenCalled();
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank", "width=600,height=700");
    expect(popup.location.href).toBe("about:blank");
    expect(screen.queryByRole("dialog", { name: "Connect GitHub" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connecting", hidden: true })).toBeDisabled();

    connectionVerified = true;
    window.postMessage({ type: "sketch-integration-connected" }, window.location.origin);

    await waitFor(() => expect(screen.getByRole("button", { name: "Connected" })).toBeDisabled());
    await waitFor(() => expect(screen.queryByTitle("Connect GitHub")).not.toBeInTheDocument());
  });

  it("keeps integration cards disabled while the provider configuration is loading", async () => {
    const user = userEvent.setup();
    const popup = { closed: false, close: vi.fn(), location: { href: "" } };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const servers =
      deferred<
        Array<{
          id: string;
          type: string;
          slug: string;
          displayName: string;
          url: string;
          apiUrl: string;
          credentials: Record<string, never>;
          mode: string;
          createdAt: string;
          updatedAt: string;
        }>
      >();
    mocks.search = {};
    mockChatMessages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Connect GitHub first." },
          {
            type: "data-integration-connection",
            id: "integration-connection-0",
            data: {
              requestId: "integration-req-1",
              appId: "github",
              appName: "GitHub",
              reason: "Connect GitHub so Sketch can inspect repository issues.",
            },
          },
        ],
      },
    ];
    mocks.listMcpServers.mockReturnValue(servers.promise);
    mocks.createConnectionIntent.mockResolvedValue({
      app: { id: "github", name: "GitHub", description: "Code hosting" },
      redirectUrl: "about:blank",
    });

    renderWithProviders(<ChatPage />);

    const connectButton = await screen.findByRole("button", { name: "Connect" });
    await waitFor(() => expect(connectButton).toBeDisabled());
    expect(screen.getByText("Checking")).toBeInTheDocument();
    await user.click(connectButton);
    expect(mocks.createConnectionIntent).not.toHaveBeenCalled();

    servers.resolve([
      {
        id: "provider-1",
        type: "canvas",
        slug: "canvas",
        displayName: "Canvas",
        url: "https://mcp.example",
        apiUrl: "https://canvas.example",
        credentials: {},
        mode: "mcp",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Connect" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(mocks.createConnectionIntent).toHaveBeenCalledWith(
        "provider-1",
        "github",
        expect.any(String),
        expect.objectContaining({ id: "github", name: "GitHub" }),
      ),
    );
  });
});
