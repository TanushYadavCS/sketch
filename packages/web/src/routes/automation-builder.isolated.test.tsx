import type { AutomationDefinition } from "@/lib/api";
import { ApiRequestError } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationBuilderPage } from "./automation-builder";

const mocks = vi.hoisted(() => ({
  getAutomation: vi.fn(),
  listConversations: vi.fn(),
  loadMessages: vi.fn(),
  navigate: vi.fn(),
  originChatMessages: vi.fn(),
  createConversation: vi.fn(),
  selectConversation: vi.fn(),
  archiveConversation: vi.fn(),
  interruptChat: vi.fn(),
  runTask: vi.fn(),
  saveAutomation: vi.fn(),
  testStep: vi.fn(),
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  search: { conversationId: "chat-alpha" } as Record<string, unknown>,
  chatMessages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Create an automation" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "All set." }] },
  ] as Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }>,
  chatStatus: "ready",
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      scheduledTasks: {
        get: mocks.getAutomation,
        conversations: mocks.listConversations,
        createConversation: mocks.createConversation,
        selectConversation: mocks.selectConversation,
        archiveConversation: mocks.archiveConversation,
        originChatMessages: mocks.originChatMessages,
        run: mocks.runTask,
        save: mocks.saveAutomation,
        testStep: mocks.testStep,
      },
      webChat: {
        messages: mocks.loadMessages,
        interrupt: mocks.interruptChat,
        uploadAttachment: vi.fn(),
        transcribe: vi.fn(),
      },
    },
  };
});

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: mocks.chatMessages,
    status: mocks.chatStatus,
    error: undefined,
    setMessages: mocks.setMessages,
    sendMessage: mocks.sendMessage,
  }),
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    useParams: () => ({ taskId: "task-123" }),
    useSearch: () => mocks.search,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock("./dashboard", () => ({
  dashboardRoute: { id: "__root__/dashboard" },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@xyflow/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    Controls: () => null,
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
    ReactFlowProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ReactFlow: ({
      nodes,
      edges,
      nodesDraggable,
      nodesConnectable,
      edgesReconnectable,
      deleteKeyCode,
      onNodeClick,
      onNodeDragStop,
      children,
    }: {
      nodes: Array<{ id: string; position: { x: number; y: number }; data: { step: { label: string } } }>;
      edges?: Array<{ type?: string }>;
      nodesDraggable?: boolean;
      nodesConnectable?: boolean;
      edgesReconnectable?: boolean;
      deleteKeyCode?: string | string[] | null;
      onNodeClick?: (event: unknown, node: { id: string; data: { step: { label: string } } }) => void;
      onNodeDragStop?: (
        event: unknown,
        node: { id: string; position: { x: number; y: number }; data: { step: { label: string } } },
      ) => void;
      children?: ReactNode;
    }) => (
      <div
        data-testid="automation-flow"
        data-nodes-draggable={String(nodesDraggable)}
        data-nodes-connectable={String(nodesConnectable)}
        data-edges-reconnectable={String(edgesReconnectable)}
        data-delete-key-code={String(deleteKeyCode)}
        data-edge-types={(edges ?? []).map((edge) => edge.type ?? "default").join(",")}
        data-node-positions={nodes.map((node) => `${node.id}:${node.position.x},${node.position.y}`).join("|")}
      >
        {nodes.map((node) => (
          <div key={node.id}>
            <button type="button" onClick={(event) => onNodeClick?.(event, node)}>
              {node.data.step.label}
            </button>
            <button
              type="button"
              aria-label={`Move ${node.data.step.label}`}
              onClick={(event) => onNodeDragStop?.(event, { ...node, position: { x: 333, y: 72 } })}
            >
              Move
            </button>
          </div>
        ))}
        {children}
      </div>
    ),
    MarkerType: { ArrowClosed: "arrowclosed" },
    useEdgesState: (initialEdges: unknown[]) => {
      const [edges, setEdges] = React.useState(initialEdges);
      return [edges, setEdges];
    },
    useNodesState: (initialNodes: unknown[]) => {
      const [nodes, setNodes] = React.useState(initialNodes);
      return [nodes, setNodes, vi.fn()];
    },
    useReactFlow: () => ({ fitView: vi.fn() }),
  };
});

const automation: AutomationDefinition = {
  id: "task-123",
  platform: "slack",
  contextType: "dm",
  deliveryTarget: "D123",
  threadTs: null,
  prompt: "Daily account brief",
  scheduleType: "cron",
  scheduleValue: "0 9 * * *",
  timezone: "UTC",
  sessionMode: "fresh",
  nextRunAt: null,
  lastRunAt: null,
  status: "active",
  createdBy: "user-1",
  createdByName: "Owner Member",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  revision: 1,
  lastEditedBy: null,
  lastEditedByName: null,
  title: "Daily account brief",
  description: "Summarizes account activity every morning.",
  originChat: { platform: "web", conversationId: "chat-alpha", providerThreadId: null, currentMessageId: null },
  delivery: {
    platform: "slack",
    targetType: "dm",
    targetId: "D123",
    threadTs: null,
    mode: "deliver",
    label: "Slack DM",
  },
  steps: [
    {
      id: "trigger",
      type: "trigger",
      label: "Schedule",
      icon: "clock",
      position: { x: 0, y: 0 },
      triggerConfig: {
        type: "schedule",
        scheduleType: "cron",
        scheduleValue: "0 9 * * *",
        timezone: "UTC",
      },
    },
    {
      id: "check",
      type: "agent",
      label: "Check rating",
      icon: "robot",
      position: { x: 230, y: 0 },
      agentMode: "sketch",
    },
  ],
  edges: [{ id: "trigger-check", from: "trigger", to: "check" }],
  stepContent: {
    check: {
      taskId: "task-123",
      stepId: "check",
      contentType: "prompt",
      content: "Summarize accounts",
      apps: ["Slack"],
      updatedAt: null,
    },
  },
  latestRun: null,
  recentRuns: [],
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderBuilder() {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AutomationBuilderPage />
    </QueryClientProvider>,
  );
}

describe("AutomationBuilderPage", () => {
  beforeEach(() => {
    mocks.getAutomation.mockClear();
    mocks.getAutomation.mockResolvedValue(automation);
    mocks.listConversations.mockClear();
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "chat-alpha",
          kinds: ["web_chat"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
      ],
      transcriptAccess: "viewer",
    });
    mocks.loadMessages.mockClear();
    mocks.loadMessages.mockResolvedValue({ messages: [], updatedAt: null });
    mocks.originChatMessages.mockResolvedValue({ messages: [] });
    mocks.createConversation.mockClear();
    mocks.createConversation.mockResolvedValue({
      conversation: {
        conversationId: "builder-new",
        kinds: ["builder"],
        createdAt: "2026-06-02T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
        lastActiveAt: "2026-06-02T00:00:00.000Z",
        archivedAt: null,
        state: "active",
      },
      created: true,
    });
    mocks.selectConversation.mockClear();
    mocks.selectConversation.mockImplementation(async (_taskId: string, conversationId: string) => ({
      conversation: {
        conversationId,
        kinds: ["builder"],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
        lastActiveAt: "2026-06-03T00:00:00.000Z",
        archivedAt: null,
        state: "active",
      },
      created: false,
    }));
    mocks.archiveConversation.mockClear();
    mocks.archiveConversation.mockImplementation(
      async (_taskId: string, conversationId: string, archived: boolean) => ({
        conversation: {
          conversationId,
          kinds: ["builder"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-04T00:00:00.000Z",
          lastActiveAt: "2026-06-03T00:00:00.000Z",
          archivedAt: archived ? "2026-06-04T00:00:00.000Z" : null,
          state: archived ? "archived" : "active",
        },
      }),
    );
    mocks.interruptChat.mockClear();
    mocks.interruptChat.mockResolvedValue({ success: true, interrupted: true });
    mocks.navigate.mockClear();
    mocks.runTask.mockResolvedValue({ status: "queued" });
    mocks.saveAutomation.mockClear();
    mocks.saveAutomation.mockResolvedValue({ ...automation, revision: automation.revision + 1 });
    mocks.testStep.mockResolvedValue({ run: null });
    mocks.sendMessage.mockClear();
    mocks.setMessages.mockClear();
    mocks.originChatMessages.mockClear();
    mocks.search = { conversationId: "chat-alpha" };
    mocks.chatStatus = "ready";
    mocks.chatMessages = [];
  });

  it("renders a Slack channel message trigger and its channel", async () => {
    const user = userEvent.setup();
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      scheduleType: "external",
      scheduleValue: "slack_channel_message",
      steps: [
        {
          ...automation.steps[0],
          label: "Slack channel message",
          icon: "slack",
          triggerConfig: { type: "slack_channel_message", channelId: "C123" },
        },
        ...automation.steps.slice(1),
      ],
    });
    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Slack channel message" }));

    await waitFor(() => expect(screen.getByText("Trigger type")).toBeInTheDocument());
    expect(screen.getAllByDisplayValue("Slack channel message").length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue("C123").length).toBeGreaterThan(0);
  });

  it("opens the selected associated chat and sends the active automation id", async () => {
    const user = userEvent.setup();
    renderBuilder();

    const input = await screen.findByLabelText("Message Sketch");
    await waitFor(() => expect(input).not.toBeDisabled());
    expect(mocks.loadMessages).toHaveBeenCalledWith("chat-alpha");

    await user.type(input, "Make it daily");
    await user.click(screen.getByLabelText("Send message"));

    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Make it daily" }), {
      body: { automationTaskId: "task-123" },
    });
  });

  it("shows an automation-aware empty state for an associated empty chat", async () => {
    const user = userEvent.setup();
    renderBuilder();

    await screen.findByLabelText("Message Sketch");
    expect(screen.getByText("Current builder chat")).toBeInTheDocument();
    expect(screen.getByText("Source chat")).toBeInTheDocument();
    expect(await screen.findByText("What should change?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add a step" }));

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Add one useful step to this automation." }),
      {
        body: { automationTaskId: "task-123" },
      },
    );
  });

  it.each([403, 404])("shows an actionable access state for a %s builder response", async (status) => {
    mocks.getAutomation.mockRejectedValue(new ApiRequestError("Scheduled task not found", status, "NOT_FOUND"));

    renderBuilder();

    expect(await screen.findByTestId("automation-builder-access-error")).toBeInTheDocument();
    expect(screen.getByText("Automation unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Loading builder...")).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Back to automations" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/scheduled-tasks" });
  });

  it("shows a retryable server error instead of an indefinite loading builder", async () => {
    mocks.getAutomation
      .mockRejectedValueOnce(new ApiRequestError("Service unavailable", 500, "INTERNAL_SERVER_ERROR"))
      .mockResolvedValueOnce(automation);

    renderBuilder();

    expect(await screen.findByTestId("automation-builder-server-error")).toBeInTheDocument();
    expect(screen.getByText("Unable to load automation")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("automation-builder-canvas")).toBeInTheDocument();
  });

  it("identifies the foreign owner and acting editor in the builder", async () => {
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      createdBy: "owner-1",
      createdByName: "Alice Member",
      lastEditedBy: "admin-1",
      lastEditedByName: "Karan Admin",
    });

    renderBuilder();

    const ownership = await screen.findByTestId("automation-builder-ownership");
    expect(ownership).toHaveTextContent("Owner Alice Member");
    expect(ownership).toHaveTextContent("Last edited by Karan Admin");
  });
  it("honors an associated source chat search param", async () => {
    mocks.search = { conversationId: "chat-alpha" };
    renderBuilder();

    await screen.findByLabelText("Message Sketch");
    expect(mocks.loadMessages).toHaveBeenCalledWith("chat-alpha");
    expect(mocks.loadMessages).not.toHaveBeenCalledWith(expect.stringMatching(/^builder-task-123-/));
  });

  it("auto-arranges generated vertical workflow positions", async () => {
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      steps: automation.steps.map((step, index) => ({ ...step, position: { x: 0, y: index * 100 } })),
    });
    renderBuilder();

    const flow = await screen.findByTestId("automation-flow");
    expect(flow).toHaveAttribute("data-node-positions", "trigger:0,0|check:245,0");
  });

  it("opens the task chat list without a conversation search param", async () => {
    const user = userEvent.setup();
    mocks.search = {};
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      originChat: { platform: "slack", conversationId: "42", providerThreadId: "1700.1", currentMessageId: 12 },
    });
    renderBuilder();

    expect(await screen.findByText("Builder chats")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message Sketch")).not.toBeInTheDocument();
    expect(mocks.loadMessages).not.toHaveBeenCalled();
    expect(mocks.originChatMessages).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(mocks.createConversation).toHaveBeenCalledWith("task-123", { createNew: true }));
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId: "task-123" },
        search: { conversationId: "builder-new" },
      }),
    );
  });

  it("selects an older task-scoped chat from the sidechat list", async () => {
    const user = userEvent.setup();
    mocks.search = {};
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "chat-alpha",
          kinds: ["builder"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
        {
          conversationId: "chat-beta",
          kinds: ["builder"],
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
          lastActiveAt: "2026-06-02T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
      ],
      transcriptAccess: "viewer",
    });

    renderBuilder();
    await user.click(await screen.findByTestId("automation-builder-conversation-chat-beta"));

    await waitFor(() => expect(mocks.selectConversation).toHaveBeenCalledWith("task-123", "chat-beta", "builder"));
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { conversationId: "chat-beta" } }));
    expect(mocks.loadMessages).not.toHaveBeenCalled();
  });

  it("archives the current chat from the sidechat and returns to history", async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Archive builder chat" }));

    await waitFor(() => expect(mocks.archiveConversation).toHaveBeenCalledWith("task-123", "chat-alpha", true));
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: {}, params: { taskId: "task-123" } }),
    );
  });

  it("shows archived and unrelated route states without loading transcript content", async () => {
    mocks.search = { conversationId: "chat-archived" };
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "chat-archived",
          kinds: ["builder"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: "2026-06-03T00:00:00.000Z",
          state: "archived",
        },
      ],
      transcriptAccess: "viewer",
    });

    const user = userEvent.setup();
    renderBuilder();

    expect(await screen.findByTestId("automation-builder-chat-archived")).toBeInTheDocument();
    expect(mocks.loadMessages).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Restore chat" }));
    await waitFor(() => expect(mocks.archiveConversation).toHaveBeenCalledWith("task-123", "chat-archived", false));

    mocks.search = { conversationId: "not-associated" };
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [],
      transcriptAccess: "viewer",
    });
    renderBuilder();
    expect(await screen.findByTestId("automation-builder-chat-unavailable")).toBeInTheDocument();
    expect(mocks.loadMessages).not.toHaveBeenCalledWith("not-associated");
  });

  it("can stop a stuck builder chat run", async () => {
    const user = userEvent.setup();
    mocks.search = { conversationId: "chat-alpha" };
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      originChat: { platform: "slack", conversationId: "42", providerThreadId: "1700.1", currentMessageId: 12 },
    });
    mocks.chatMessages = [
      {
        id: "a-progress",
        role: "assistant",
        parts: [{ type: "data-progress", data: { lines: ["Running automation update"] } }],
      },
    ];

    renderBuilder();

    await user.click(await screen.findByLabelText("Pause Sketch"));

    expect(mocks.interruptChat).toHaveBeenCalledWith("chat-alpha");
    expect(mocks.interruptChat).not.toHaveBeenCalledWith("42");
  });

  it("shows a stopped builder chat notice after reload", async () => {
    mocks.search = { conversationId: "chat-alpha" };
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      originChat: { platform: "slack", conversationId: "42", providerThreadId: "1700.1", currentMessageId: 12 },
    });
    mocks.chatMessages = [
      {
        id: "a-interrupted",
        role: "assistant",
        parts: [
          {
            type: "data-interruption",
            data: { detail: "Sketch paused.", label: "Tell Sketch what to do differently." },
          },
        ],
      },
    ];

    renderBuilder();

    expect(await screen.findByText("Sketch paused.")).toBeInTheDocument();
    expect(screen.getByText("Tell Sketch what to do differently.")).toBeInTheDocument();
  });

  it("keeps structural fields read-only while allowing agent prompt saves", async () => {
    const user = userEvent.setup();
    renderBuilder();

    const flow = await screen.findByTestId("automation-flow");
    expect(flow).toHaveAttribute("data-nodes-draggable", "true");
    expect(flow).toHaveAttribute("data-nodes-connectable", "false");
    expect(flow).toHaveAttribute("data-edges-reconnectable", "false");
    expect(flow).toHaveAttribute("data-delete-key-code", "null");
    expect(flow).toHaveAttribute("data-edge-types", "default");

    await user.click(screen.getByRole("button", { name: "Check rating" }));

    expect(screen.getByDisplayValue("Check rating")).toHaveAttribute("readonly");
    expect(screen.getByDisplayValue("Slack")).toHaveAttribute("readonly");
    const prompt = screen.getByDisplayValue("Summarize accounts");
    expect(prompt).not.toHaveAttribute("readonly");

    await user.clear(prompt);
    await user.type(prompt, "Summarize enterprise accounts only");
    await user.click(screen.getByRole("button", { name: "Save prompt" }));

    await waitFor(() => expect(mocks.saveAutomation).toHaveBeenCalled());
    expect(mocks.saveAutomation.mock.calls[0][1].stepContent.check.content).toBe("Summarize enterprise accounts only");
  });

  it("persists node positions after drag without enabling connection edits", async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Move Check rating" }));

    await waitFor(() => expect(mocks.saveAutomation).toHaveBeenCalled());
    expect(mocks.saveAutomation.mock.calls[0][1].steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "check", position: { x: 333, y: 72 } })]),
    );
  });

  it("persists the full computed layout when dragging from an auto-arranged workflow", async () => {
    const user = userEvent.setup();
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      steps: [
        { ...automation.steps[0], position: { x: 0, y: 0 } },
        { ...automation.steps[1], position: { x: 0, y: 100 } },
        {
          id: "post",
          type: "action",
          label: "Post result",
          icon: "slack",
          position: { x: 0, y: 200 },
        },
      ],
      edges: [
        { id: "trigger-check", from: "trigger", to: "check" },
        { id: "check-post", from: "check", to: "post" },
      ],
      stepContent: {
        ...automation.stepContent,
        post: {
          taskId: "task-123",
          stepId: "post",
          contentType: "script",
          content: "return input;",
          apps: ["Slack"],
          updatedAt: null,
        },
      },
    });
    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Move Check rating" }));

    await waitFor(() => expect(mocks.saveAutomation).toHaveBeenCalled());
    expect(mocks.saveAutomation.mock.calls[0][1].steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "check", position: { x: 333, y: 72 } }),
        expect.objectContaining({ id: "post", position: { x: 490, y: 0 } }),
      ]),
    );
  });

  it("serializes prompt and drag saves against the latest accepted revision", async () => {
    const user = userEvent.setup();
    const firstSave = deferred<AutomationDefinition>();
    mocks.saveAutomation
      .mockReset()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce({
        ...automation,
        revision: 3,
        steps: automation.steps.map((step) => (step.id === "check" ? { ...step, position: { x: 333, y: 72 } } : step)),
        stepContent: {
          ...automation.stepContent,
          check: { ...automation.stepContent.check, content: "Summarize enterprise accounts only" },
        },
      });

    renderBuilder();
    await user.click(await screen.findByRole("button", { name: "Check rating" }));
    const prompt = screen.getByDisplayValue("Summarize accounts");
    await user.clear(prompt);
    await user.type(prompt, "Summarize enterprise accounts only");
    await user.click(screen.getByRole("button", { name: "Save prompt" }));

    await waitFor(() => expect(mocks.saveAutomation).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Move Check rating" }));
    expect(mocks.saveAutomation).toHaveBeenCalledTimes(1);

    firstSave.resolve({
      ...automation,
      revision: 2,
      stepContent: {
        ...automation.stepContent,
        check: { ...automation.stepContent.check, content: "Summarize enterprise accounts only" },
      },
    });

    await waitFor(() => expect(mocks.saveAutomation).toHaveBeenCalledTimes(2));
    expect(mocks.saveAutomation.mock.calls[1][1]).toMatchObject({
      expectedRevision: 2,
      stepContent: { check: { content: "Summarize enterprise accounts only" } },
      steps: expect.arrayContaining([expect.objectContaining({ id: "check", position: { x: 333, y: 72 } })]),
    });
  });
});
