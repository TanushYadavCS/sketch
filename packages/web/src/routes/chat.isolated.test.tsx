import { setPendingWebChatSubmission, takePendingWebChatSubmission } from "@/lib/chat-target";
import { WEB_CHAT_CONVERSATIONS_QUERY_KEY } from "@/lib/web-chat-conversations";
import { renderWithProviders } from "@/test/utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentType, type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatPage,
  SMOOTH_TEXT_STREAM_DELAY_MS,
  buildChatThreadMessages,
  chatIndexRoute,
  hasPendingAssistantProgress,
  nextSmoothedAssistantText,
  outgoingRequestOptions,
  outgoingTextMessage,
  releaseReadySmoothedAssistantText,
  titleFromChatMessages,
  useKnownNewWebChatConversation,
  validateChatSearch,
  webChatMessagesQueryKey,
} from "./chat";

const ChatIndexPage = chatIndexRoute.options.component as ComponentType;

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
  workspaceSummary: vi.fn().mockResolvedValue({
    automations: { running: 0, total: 0, nextRunAt: null },
    skills: { total: 0, yours: 0, shared: 0 },
    integrations: { connected: 0, appNames: [] },
    team: { total: 1, humans: 1, agents: 0 },
  }),
  conversations: vi.fn().mockResolvedValue({
    conversations: [
      {
        id: "chat-alpha",
        title: "Plan my day",
        channel: "web",
        updatedAt: "2026-07-13T08:00:00.000Z",
      },
    ],
  }),
  removeConversation: vi.fn().mockResolvedValue({ success: true }),
  homePaneProps: vi.fn(),
  conversationId: "chat-alpha",
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

function mockReducedMotionPreference() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

vi.mock("@/lib/api", () => ({
  api: {
    webChat: {
      messages: mocks.loadMessages,
      progressSettings: mocks.progressSettings,
      updateProgressSettings: mocks.updateProgressSettings,
      interrupt: mocks.interrupt,
      conversations: mocks.conversations,
      removeConversation: mocks.removeConversation,
    },
    workspace: {
      summary: mocks.workspaceSummary,
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
    useParams: () => ({ conversationId: mocks.conversationId }),
    useSearch: () => mocks.search,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock("./dashboard", () => ({
  dashboardRoute: { id: "__root__/dashboard" },
  useDashboardAuth: () => ({ displayName: "Karan Nijhawan" }),
}));

vi.mock("@/components/sketch/home-pane", () => ({
  HomePane: (props: { firstName: string; children?: ReactNode }) => {
    mocks.homePaneProps(props);
    return <div>Chat launcher for {props.firstName}</div>;
  },
}));

describe("chat route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    takePendingWebChatSubmission("chat-alpha");
    takePendingWebChatSubmission("chat-beta");
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
    mocks.workspaceSummary.mockClear();
    mocks.conversations.mockClear();
    mocks.removeConversation.mockClear();
    mocks.homePaneProps.mockClear();
    mockChatStatus = "ready";
    mockChatError = undefined;
    clearError.mockReset();
    mockChatMessages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Hi Sketch" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi Karan" }] },
    ];
    mocks.conversationId = "chat-alpha";
    mocks.search = { message: "Plan my day" };
  });

  it("redirects the legacy chat index to a clean new conversation", async () => {
    mocks.search = {};
    renderWithProviders(<ChatIndexPage />);

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/chat/$conversationId",
          search: { new: true },
          replace: true,
          viewTransition: true,
        }),
      ),
    );
  });

  it("respects reduced motion when opening a clean chat from the legacy index", async () => {
    mockReducedMotionPreference();
    mocks.search = {};
    renderWithProviders(<ChatIndexPage />);

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/chat/$conversationId",
          search: { new: true },
          viewTransition: false,
        }),
      ),
    );
  });

  it("preserves an initial message when the legacy chat index redirects", async () => {
    renderWithProviders(<ChatIndexPage />);

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/chat/$conversationId",
          search: { message: "Plan my day" },
          replace: true,
        }),
      ),
    );
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
    expect(validateChatSearch({ new: true })).toEqual({ new: true });
    expect(validateChatSearch({ new: "true" })).toEqual({ new: true });
    expect(validateChatSearch({ new: "false" })).toEqual({});
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

    expect(container.firstElementChild).toHaveClass(
      "mx-auto",
      "box-content",
      "max-w-4xl",
      "px-4",
      "sm:px-10",
      "w-[calc(100%-32px)]",
      "sm:w-[calc(100%-80px)]",
    );
    expect(container.querySelector(".sketch-chat-route-enter")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hi Sketch" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Thread options")).not.toBeInTheDocument();
    const thread = within(screen.getByLabelText("Chat thread"));
    expect(screen.getByLabelText("Chat thread").parentElement).toHaveClass("right-[-18px]", "pr-[18px]");
    expect(thread.getByText("Hi Sketch")).toBeInTheDocument();
    expect(thread.getByText("Hi Karan")).toBeInTheDocument();
    expect(useChatArgs).toHaveBeenCalledWith(expect.objectContaining({ id: "chat-alpha", messages: [] }));
    expect(screen.queryByLabelText("Loading conversation")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Sketch")).not.toBeDisabled();
    expect(mocks.loadMessages).not.toHaveBeenCalled();
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Plan my day" })));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/chat/$conversationId",
      params: { conversationId: "chat-alpha" },
      search: {},
      replace: true,
      viewTransition: true,
    });
  });

  it("removes cached history before sending an initial new-chat message", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(webChatMessagesQueryKey("chat-alpha"), {
      messages: [{ id: "u-cached", role: "user", parts: [{ type: "text", text: "Cached question" }] }],
      updatedAt: "2026-07-13T08:00:00.000Z",
    });
    sendMessage.mockClear();

    render(
      <QueryClientProvider client={queryClient}>
        <ChatPage />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Plan my day" })));
    expect(queryClient.getQueryData(webChatMessagesQueryKey("chat-alpha"))).toBeUndefined();
  });

  it("refreshes sidebar recents after the first new-chat message persists", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    sendMessage.mockResolvedValueOnce(undefined);

    render(
      <QueryClientProvider client={queryClient}>
        <ChatPage />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Plan my day" })));
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: WEB_CHAT_CONVERSATIONS_QUERY_KEY }));
  });

  it("preserves the initial message during StrictMode effect replay", async () => {
    sendMessage.mockClear();
    setMessages.mockClear();

    renderWithProviders(
      <StrictMode>
        <ChatPage />
      </StrictMode>,
    );

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(setMessages).not.toHaveBeenCalledWith([]);
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

  it("keeps history unready and renders a retryable load error after initial rejection", async () => {
    const unhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", unhandledRejection);
    mocks.search = {};
    mocks.loadMessages.mockRejectedValueOnce(new Error("History unavailable"));

    renderWithProviders(<ChatPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load this conversation.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByLabelText("Message Sketch")).toBeDisabled();
    expect(screen.getByLabelText("Message Sketch")).toHaveAttribute("placeholder", "Conversation unavailable");
    expect(screen.queryByLabelText("Chat thread")).not.toBeInTheDocument();
    await Promise.resolve();
    expect(unhandledRejection).not.toHaveBeenCalled();

    window.removeEventListener("unhandledrejection", unhandledRejection);
  });

  it("retries initial history with a fresh signal and adopts the successful response", async () => {
    const user = userEvent.setup();
    const persisted = [
      { id: "u-history", role: "user", parts: [{ type: "text", text: "Persisted question" }] },
      { id: "a-history", role: "assistant", parts: [{ type: "text", text: "Persisted answer" }] },
    ];
    mocks.search = {};
    mocks.loadMessages
      .mockRejectedValueOnce(new Error("History unavailable"))
      .mockResolvedValueOnce({ messages: persisted, updatedAt: "2026-07-13T08:00:00.000Z" });

    renderWithProviders(<ChatPage />);

    await user.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(setMessages).toHaveBeenCalledWith(persisted));
    expect(screen.queryByText("Couldn’t load this conversation.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Sketch")).not.toBeDisabled();
    expect(mocks.loadMessages).toHaveBeenCalledTimes(2);
    expect(mocks.loadMessages.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.loadMessages.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.loadMessages.mock.calls[1]?.[1]?.signal).not.toBe(mocks.loadMessages.mock.calls[0]?.[1]?.signal);
  });

  it("consumes an aborted initial history request without showing a load error", async () => {
    mocks.search = {};
    mocks.loadMessages.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    renderWithProviders(<ChatPage />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Loading conversation")).toBeInTheDocument();
    expect(screen.queryByText("Couldn’t load this conversation.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Sketch")).toBeDisabled();
  });

  it("retains known-new state after search cleanup and clears it for another conversation", () => {
    const { result, rerender } = renderHook(
      ({ conversationId, hasNewConversationIntent }) =>
        useKnownNewWebChatConversation(conversationId, hasNewConversationIntent),
      {
        initialProps: {
          conversationId: "chat-alpha",
          hasNewConversationIntent: true,
        },
      },
    );

    expect(result.current).toBe(true);

    rerender({ conversationId: "chat-alpha", hasNewConversationIntent: false });
    expect(result.current).toBe(true);

    rerender({ conversationId: "chat-beta", hasNewConversationIntent: false });
    expect(result.current).toBe(false);
  });

  it("adopts fresh cached history without clearing messages or flashing the loading shell", async () => {
    const persisted = [
      { id: "u-cached", role: "user", parts: [{ type: "text", text: "Cached question" }] },
      { id: "a-cached", role: "assistant", parts: [{ type: "text", text: "Cached answer" }] },
    ];
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(
      webChatMessagesQueryKey("chat-alpha"),
      { messages: persisted, updatedAt: "2026-07-13T08:00:00.000Z" },
      { updatedAt: Date.now() },
    );
    mocks.search = {};
    setMessages.mockClear();

    render(
      <QueryClientProvider client={queryClient}>
        <ChatPage />
      </QueryClientProvider>,
    );

    expect(screen.queryByLabelText("Loading conversation")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Sketch")).not.toBeDisabled();
    expect(setMessages).not.toHaveBeenCalledWith([]);
    expect(useChatArgs).toHaveBeenCalledWith(expect.objectContaining({ messages: persisted }));
    await waitFor(() => expect(setMessages).toHaveBeenCalledWith(persisted));
    expect(mocks.loadMessages).not.toHaveBeenCalled();
  });

  it("removes cached history before sending a follow-up message", async () => {
    const user = userEvent.setup();
    const persisted = [
      { id: "u-cached", role: "user", parts: [{ type: "text", text: "Cached question" }] },
      { id: "a-cached", role: "assistant", parts: [{ type: "text", text: "Cached answer" }] },
    ];
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(
      webChatMessagesQueryKey("chat-alpha"),
      { messages: persisted, updatedAt: "2026-07-13T08:00:00.000Z" },
      { updatedAt: Date.now() },
    );
    mocks.search = {};
    sendMessage.mockClear();

    render(
      <QueryClientProvider client={queryClient}>
        <ChatPage />
      </QueryClientProvider>,
    );

    await user.type(screen.getByLabelText("Message Sketch"), "Follow up");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Follow up" }), undefined);
    expect(queryClient.getQueryData(webChatMessagesQueryKey("chat-alpha"))).toBeUndefined();
  });

  it("disables the initial-message cleanup transition when reduced motion is preferred", async () => {
    mockReducedMotionPreference();
    sendMessage.mockClear();
    mocks.navigate.mockClear();

    renderWithProviders(<ChatPage />);

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/chat/$conversationId",
      params: { conversationId: "chat-alpha" },
      search: {},
      replace: true,
      viewTransition: false,
    });
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
      viewTransition: true,
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
