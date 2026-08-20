import type {
  AutomationDefinition,
  WebChatQuestion,
  WebChatQuestionBatch,
  WebChatQuestionBatchAnswer,
  WorkflowTriggerConfig,
} from "@/lib/api";
import { ApiRequestError } from "@/lib/api";
import { AUTOMATION_REFRESH_INTERVAL_MS } from "@/lib/automation-refresh";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutomationBuilderPage,
  automationRunLifecycleState,
  builderChatThreadMessages,
  outgoingBuilderQuestionAnswerMessage,
  outgoingBuilderQuestionBatchAnswerMessage,
  validateAutomationBuilderSearch,
} from "./automation-builder";

const mocks = vi.hoisted(() => ({
  getAutomation: vi.fn(),
  listConversations: vi.fn(),
  webChatConversations: vi.fn(),
  loadMessages: vi.fn(),
  conversationMessages: vi.fn(),
  releaseLock: vi.fn(),
  acquireLock: vi.fn(),
  navigate: vi.fn(),
  originChatMessages: vi.fn(),
  createConversation: vi.fn(),
  selectConversation: vi.fn(),
  archiveConversation: vi.fn(),
  interruptChat: vi.fn(),
  clearError: vi.fn(),
  runTask: vi.fn(),
  getRun: vi.fn(),
  saveAutomation: vi.fn(),
  selectSetupExecutionMode: vi.fn(),
  removeAutomation: vi.fn(),
  pauseAutomation: vi.fn(),
  resumeAutomation: vi.fn(),
  testStep: vi.fn(),
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  search: { conversationId: "chat-alpha" } as Record<string, unknown>,
  chatMessages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Create an automation" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "All set." }] },
  ] as Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }>,
  chatStatus: "ready",
  chatError: undefined as Error | undefined,
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
        conversationMessages: mocks.conversationMessages,
        releaseLock: mocks.releaseLock,
        acquireLock: mocks.acquireLock,
        run: mocks.runTask,
        getRun: mocks.getRun,
        save: mocks.saveAutomation,
        selectSetupExecutionMode: mocks.selectSetupExecutionMode,
        remove: mocks.removeAutomation,
        pause: mocks.pauseAutomation,
        resume: mocks.resumeAutomation,
        testStep: mocks.testStep,
      },
      webChat: {
        messages: mocks.loadMessages,
        conversations: mocks.webChatConversations,
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
    error: mocks.chatError,
    clearError: mocks.clearError,
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
  useDashboardAuth: () => ({
    userId: "user-1",
    role: "member",
    displayName: "Owner Member",
    displayIdentifier: "owner@example.com",
  }),
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
    Background: ({ color }: { color?: string }) => <div data-testid="automation-background" data-color={color} />,
    BackgroundVariant: { Dots: "dots" },
    Controls: ({ className }: { className?: string }) => (
      <div data-testid="automation-controls" className={className} />
    ),
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
    ReactFlowProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ReactFlow: ({
      nodes,
      nodeTypes,
      edges,
      nodesDraggable,
      nodesConnectable,
      nodesFocusable,
      edgesReconnectable,
      deleteKeyCode,
      onNodeClick,
      onNodeDragStop,
      children,
    }: {
      nodes: Array<{
        id: string;
        type?: string;
        position: { x: number; y: number };
        data: { step: { label: string }; [key: string]: unknown };
      }>;
      nodeTypes?: Record<string, React.ComponentType<{ data: { step: { label: string } }; isConnectable?: boolean }>>;
      edges?: Array<{ id?: string; type?: string; animated?: boolean }>;
      nodesDraggable?: boolean;
      nodesConnectable?: boolean;
      nodesFocusable?: boolean;
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
        data-nodes-focusable={String(nodesFocusable)}
        data-edges-reconnectable={String(edgesReconnectable)}
        data-delete-key-code={String(deleteKeyCode)}
        data-edge-types={(edges ?? []).map((edge) => edge.type ?? "default").join(",")}
        data-edge-animations={(edges ?? []).map((edge) => `${edge.id ?? ""}:${Boolean(edge.animated)}`).join("|")}
        data-node-positions={nodes.map((node) => `${node.id}:${node.position.x},${node.position.y}`).join("|")}
      >
        {nodes.map((node) => (
          <div key={node.id}>
            {node.type && nodeTypes?.[node.type]
              ? React.createElement(nodeTypes[node.type], { data: node.data, isConnectable: false })
              : null}
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
    useNodesInitialized: () => true,
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
  executionMode: "hybrid",
  executionModeRecommendation: {
    mode: "agent-led",
    reason: "Best when the work needs AI judgment from start to finish.",
  },
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

function automationWithStepOutput(output: string): AutomationDefinition {
  const run: NonNullable<AutomationDefinition["latestRun"]> = {
    id: `run-${output}`,
    taskId: automation.id,
    triggerData: null,
    status: "completed",
    stepOutputs: {
      check: { output, status: "completed", duration_ms: 10 },
    },
    errorMessage: null,
    startedAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:00:01.000Z",
  };
  return { ...automation, latestRun: run, recentRuns: [run] };
}

const stepTestFailures = [
  ["ordinary failure", () => new Error("Node test failed")],
  ["timeout", () => Object.assign(new Error("Node test timed out"), { name: "TimeoutError" })],
  ["interruption", () => Object.assign(new Error("Node test interrupted"), { name: "AbortError" })],
  ["malformed response", () => new TypeError("Malformed step-test response")],
] as const;

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

function mockInitialExecutionModeSetup() {
  mocks.getAutomation.mockResolvedValue({
    ...automation,
    isPlaceholderDraft: true,
    originChat: {
      platform: "web",
      conversationId: "chat-setup-source",
      providerThreadId: null,
      currentMessageId: null,
    },
  });
  mocks.search = { conversationId: "builder-setup" };
  mocks.listConversations.mockResolvedValue({
    taskId: "task-123",
    conversations: [
      {
        conversationId: "builder-setup",
        kinds: ["builder"],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        lastActiveAt: "2026-06-01T00:00:00.000Z",
        archivedAt: null,
        state: "active",
      },
    ],
    transcriptAccess: "owner",
  });
  mocks.loadMessages.mockImplementation(async (conversationId: string) =>
    conversationId === "chat-setup-source"
      ? {
          messages: [{ id: "setup-source", role: "user", parts: [{ type: "text", text: "Set this automation up." }] }],
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : { messages: [], updatedAt: null },
  );
}

describe("AutomationBuilderPage", () => {
  it("validates run search independently and ignores unsafe run IDs", () => {
    expect(validateAutomationBuilderSearch({ conversationId: " chat-alpha ", runId: "run-old_1" })).toEqual({
      conversationId: "chat-alpha",
      runId: "run-old_1",
    });
    expect(validateAutomationBuilderSearch({ conversationId: "chat-alpha", runId: "../other-run" })).toEqual({
      conversationId: "chat-alpha",
    });
    expect(validateAutomationBuilderSearch({ runId: "run-only" })).toEqual({ runId: "run-only" });
  });

  it.each([
    ["pending", "pending", undefined],
    ["running", "running", undefined],
    ["completed", "success", undefined],
    ["failed", "failure", undefined],
    ["failed", "aborted", "Run aborted by the user"],
  ] as const)("maps persisted %s runs to the %s lifecycle state", (status, expected, errorMessage) => {
    expect(automationRunLifecycleState({ status, errorMessage })).toBe(expected);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    mocks.webChatConversations.mockClear();
    mocks.webChatConversations.mockResolvedValue({
      conversations: [
        {
          id: "chat-alpha",
          title: "Create an automation",
          channel: "web",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    mocks.loadMessages.mockClear();
    mocks.loadMessages.mockResolvedValue({ messages: [], updatedAt: null });
    mocks.conversationMessages.mockClear();
    mocks.conversationMessages.mockResolvedValue({ messages: [], updatedAt: null });
    mocks.releaseLock.mockClear();
    mocks.releaseLock.mockResolvedValue({ success: true });
    mocks.acquireLock.mockClear();
    mocks.acquireLock.mockResolvedValue({
      lock: {
        heldByUserId: "user-1",
        heldByName: "Owner Member",
        heldByPlatform: "web",
        heldBySurface: "builder",
        expiresAt: "2026-06-01T00:05:00.000Z",
        generation: 1,
        isHeldByMe: true,
        stealPending: null,
      },
    });
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
    mocks.selectConversation.mockImplementation(
      async (_taskId: string, conversationId: string, kind: "builder" | "web_chat" = "builder") => ({
        conversation: {
          conversationId,
          kinds: [kind],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-03T00:00:00.000Z",
          lastActiveAt: "2026-06-03T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
        created: false,
      }),
    );
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
    mocks.clearError.mockClear();
    mocks.chatError = undefined;
    mocks.navigate.mockClear();
    mocks.runTask.mockClear();
    mocks.runTask.mockResolvedValue({ status: "triggered", runId: "run-test" });
    mocks.getRun.mockClear();
    mocks.getRun.mockResolvedValue({ run: null });
    mocks.saveAutomation.mockClear();
    mocks.saveAutomation.mockImplementation(async (_taskId, request) => ({
      ...automation,
      revision: automation.revision + 1,
      executionMode: request.executionMode,
    }));
    mocks.selectSetupExecutionMode.mockClear();
    mocks.selectSetupExecutionMode.mockResolvedValue({ ...automation, isPlaceholderDraft: true });
    mocks.removeAutomation.mockClear();
    mocks.removeAutomation.mockResolvedValue(undefined);
    mocks.pauseAutomation.mockClear();
    mocks.pauseAutomation.mockResolvedValue({ id: "task-123", status: "paused" });
    mocks.resumeAutomation.mockClear();
    mocks.resumeAutomation.mockResolvedValue({ id: "task-123", status: "active" });
    mocks.testStep.mockResolvedValue({ run: null });
    mocks.sendMessage.mockClear();
    mocks.setMessages.mockClear();
    mocks.originChatMessages.mockClear();
    mocks.search = { conversationId: "chat-alpha" };
    mocks.chatStatus = "ready";
    mocks.chatMessages = [];
  });

  it("keeps a strict placeholder empty and greets setup with the description prompt", async () => {
    const placeholder = { ...automation, isPlaceholderDraft: true };
    mocks.getAutomation.mockReset().mockResolvedValue(placeholder);

    renderBuilder();

    expect(await screen.findByTestId("automation-builder-empty-canvas")).toBeInTheDocument();
    expect(document.querySelector(".automation-builder-empty-grid")).toBeInTheDocument();
    expect(screen.getByText("Workflow preview")).toBeInTheDocument();
    expect(screen.getByText("Trigger")).toBeInTheDocument();
    expect(screen.getByText("Action")).toBeInTheDocument();
    expect(screen.getByText("Delivery")).toBeInTheDocument();
    expect(document.querySelectorAll(".automation-builder-empty-edge-track")).toHaveLength(2);
    expect(screen.getByTestId("automation-builder-graph-loading")).toHaveTextContent("Workflow canvas");
    expect(await screen.findByText("What should this automation do?")).toBeInTheDocument();
    expect(screen.queryByTestId("automation-setup-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("automation-builder-question-dock")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check rating" })).not.toBeInTheDocument();
  });

  it("carries the originating web-chat request into setup and asks for execution mode next", async () => {
    const placeholder = {
      ...automation,
      isPlaceholderDraft: true,
      originChat: {
        platform: "web" as const,
        conversationId: "chat-alpha",
        providerThreadId: null,
        currentMessageId: null,
      },
    };
    mocks.getAutomation.mockResolvedValue(placeholder);
    mocks.search = { conversationId: "builder-alpha" };
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "builder-alpha",
          kinds: ["builder"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
      ],
      transcriptAccess: "viewer",
    });
    mocks.loadMessages.mockImplementation(async (conversationId: string) =>
      conversationId === "chat-alpha"
        ? {
            messages: [
              {
                id: "source-user",
                role: "user",
                parts: [{ type: "text", text: "Create a daily ClickUp summary and send it to Slack." }],
              },
            ],
            updatedAt: "2026-06-01T00:00:00.000Z",
          }
        : { messages: [], updatedAt: null },
    );

    renderBuilder();

    expect(await screen.findByTestId("automation-builder-source-context")).toHaveTextContent(
      "Create a daily ClickUp summary and send it to Slack.",
    );
    expect(screen.getByTestId("automation-setup-card")).toBeInTheDocument();
    expect(screen.getByText("How should Sketch run this automation?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Hybrid" })).not.toBeChecked();
    expect(screen.queryByText("What should this automation do?")).not.toBeInTheDocument();
  });

  it("keeps the originating request visible after the execution-mode message is added", async () => {
    const placeholder = {
      ...automation,
      isPlaceholderDraft: true,
      originChat: {
        platform: "web" as const,
        conversationId: "chat-alpha",
        providerThreadId: null,
        currentMessageId: null,
      },
    };
    mocks.getAutomation.mockResolvedValue(placeholder);
    mocks.search = { conversationId: "builder-alpha" };
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "builder-alpha",
          kinds: ["builder"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
      ],
      transcriptAccess: "viewer",
    });
    mocks.chatMessages = [
      {
        id: "mode-selection",
        role: "user",
        parts: [{ type: "text", text: "Deterministic selected." }],
      },
    ];
    mocks.loadMessages.mockImplementation(async (conversationId: string) =>
      conversationId === "chat-alpha"
        ? {
            messages: [
              {
                id: "source-user",
                role: "user",
                parts: [{ type: "text", text: "Create a daily ClickUp summary and send it to Slack." }],
              },
            ],
            updatedAt: "2026-06-01T00:00:00.000Z",
          }
        : { messages: [], updatedAt: null },
    );

    renderBuilder();

    expect(await screen.findByTestId("automation-builder-source-context")).toHaveTextContent(
      "Create a daily ClickUp summary and send it to Slack.",
    );
    expect(screen.getByText("Deterministic selected.")).toBeInTheDocument();
  });

  it("discards an untouched setup only after deletion succeeds", async () => {
    mocks.getAutomation.mockResolvedValue({ ...automation, isPlaceholderDraft: true });
    renderBuilder();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Discard setup" }));
    await waitFor(() => expect(mocks.removeAutomation).toHaveBeenCalledWith("task-123"));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/scheduled-tasks" }));
  });

  it("keeps an untouched setup open when discard fails and never deletes a non-placeholder", async () => {
    mocks.getAutomation.mockResolvedValue({ ...automation, isPlaceholderDraft: true });
    mocks.removeAutomation.mockRejectedValue(new Error("Delete failed"));
    renderBuilder();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Discard setup" }));
    await waitFor(() => expect(mocks.removeAutomation).toHaveBeenCalledWith("task-123"));
    expect(mocks.navigate).not.toHaveBeenCalled();

    mocks.getAutomation.mockResolvedValue({ ...automation, isPlaceholderDraft: false });
    renderBuilder();
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(mocks.removeAutomation).toHaveBeenCalledTimes(1);
  });

  it("returns from an automation thread to its thread list and can delete a saved automation", async () => {
    renderBuilder();
    const user = userEvent.setup();

    await screen.findByRole("button", { name: "Back to chats" });
    expect(
      within(screen.getByTestId("automation-builder-chat-sidecar")).getByRole("button", {
        name: "Back to chats",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("automation-builder-chat-sidecar")).queryByRole("button", {
        name: "Back to automations",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("automation-builder-canvas")).queryByRole("button", {
        name: "Back to automations",
      }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to chats" }));
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId: "task-123" },
        search: {},
      }),
    );

    mocks.navigate.mockClear();
    await user.click(screen.getByRole("button", { name: "Delete automation" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Daily account brief");
    await user.click(within(dialog).getByRole("button", { name: "Delete automation" }));

    await waitFor(() =>
      expect(mocks.removeAutomation).toHaveBeenCalledWith(
        "task-123",
        expect.objectContaining({ clientSessionId: expect.any(String), generation: 1 }),
      ),
    );
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/scheduled-tasks" }));
  });

  it("uses the automation-list nav only from the automation thread list", async () => {
    mocks.search = {};
    renderBuilder();

    const user = userEvent.setup();
    const sidecar = await screen.findByTestId("automation-builder-chat-sidecar");
    await within(sidecar).findByText("Chats");
    expect(within(sidecar).getByRole("button", { name: "Back to automations" })).toBeInTheDocument();
    expect(within(sidecar).queryByRole("button", { name: "Back to chats" })).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("automation-builder-canvas")).queryByRole("button", { name: "Back to automations" }),
    ).not.toBeInTheDocument();

    await user.click(within(sidecar).getByRole("button", { name: "Back to automations" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/scheduled-tasks" });
  });

  it("opens the existing builder chat as a drawer on smaller viewports", async () => {
    const user = userEvent.setup();
    renderBuilder();

    const sidecar = await screen.findByTestId("automation-builder-chat-sidecar");
    expect(sidecar).toHaveClass("absolute", "inset-0", "flex", "lg:static");

    await user.click(screen.getByRole("button", { name: "Close automation chat" }));
    expect(sidecar).toHaveClass("hidden", "lg:flex");

    await user.click(screen.getByRole("button", { name: "Open automation chat" }));
    expect(sidecar).toHaveClass("absolute", "inset-0", "flex", "lg:static");
  });

  it("resolves an old run by exact ID without falling back to latest", async () => {
    const latestRun = automationWithStepOutput("latest output").latestRun;
    const oldRun = automationWithStepOutput("old exact output").latestRun;
    mocks.search = { conversationId: "chat-alpha", runId: "run-old-exact" };
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      latestRun,
      recentRuns: [latestRun].filter((run): run is NonNullable<typeof run> => Boolean(run)),
    });
    mocks.getRun.mockResolvedValue({
      run: {
        ...oldRun,
        id: "run-old-exact",
        stepOutputs: { check: { output: "old exact output", status: "completed", duration_ms: 12 } },
      },
    });

    renderBuilder();

    await waitFor(() => expect(mocks.getRun).toHaveBeenCalledWith("task-123", "run-old-exact"));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Check rating" }));
    await userEvent.setup().click(screen.getByRole("tab", { name: "Output" }));
    expect(await screen.findByText(/old exact output/)).toBeInTheDocument();
    expect(screen.queryByText("latest output")).not.toBeInTheDocument();
  });

  it("shows a prominent unavailable state for a stale run without breaking the builder", async () => {
    mocks.search = { conversationId: "chat-alpha", runId: "run-stale" };
    mocks.getRun.mockRejectedValue(new ApiRequestError("Run not found", 404, "NOT_FOUND"));

    renderBuilder();

    expect(await screen.findByTestId("automation-run-unavailable")).toHaveTextContent("Run unavailable");
    expect(screen.getByTestId("automation-builder-canvas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check rating" })).toBeInTheDocument();
  });

  it("navigates to and polls one exact manual run while preventing duplicates", async () => {
    const user = userEvent.setup();
    const runningRun = {
      ...automationWithStepOutput("running output").latestRun,
      id: "run-test",
      status: "running" as const,
      completedAt: null,
    };
    mocks.getRun.mockResolvedValue({ run: runningRun });

    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Run" }));
    await waitFor(() => expect(mocks.runTask).toHaveBeenCalledTimes(1));
    expect(mocks.runTask).toHaveBeenCalledWith("task-123", "manual", {
      clientSessionId: expect.any(String),
      generation: 1,
    });
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: { conversationId: "chat-alpha", runId: "run-test" },
      }),
    );
    await waitFor(() => expect(mocks.getRun).toHaveBeenCalledWith("task-123", "run-test"));
    expect(await screen.findByTestId("automation-run-state")).toHaveTextContent("Running");

    await user.click(screen.getByRole("button", { name: "Running" }));
    expect(mocks.runTask).toHaveBeenCalledTimes(1);
  });

  it("pauses an active owned automation from the builder", async () => {
    renderBuilder();

    await userEvent.setup().click(await screen.findByRole("button", { name: "Pause automation" }));

    await waitFor(() =>
      expect(mocks.pauseAutomation).toHaveBeenCalledWith("task-123", {
        clientSessionId: expect.any(String),
        generation: 1,
      }),
    );
    expect(mocks.resumeAutomation).not.toHaveBeenCalled();
  });

  it("resumes a paused owned automation from the builder", async () => {
    mocks.getAutomation.mockResolvedValue({ ...automation, status: "paused" });
    renderBuilder();

    await userEvent.setup().click(await screen.findByRole("button", { name: "Resume automation" }));

    await waitFor(() =>
      expect(mocks.resumeAutomation).toHaveBeenCalledWith("task-123", {
        clientSessionId: expect.any(String),
        generation: 1,
      }),
    );
    expect(mocks.pauseAutomation).not.toHaveBeenCalled();
  });

  it("does not offer status controls to a member viewing someone else's automation", async () => {
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      createdBy: "user-2",
      createdByName: "Another Member",
      isOwner: false,
      canEdit: true,
    });
    renderBuilder();

    await screen.findByTestId("automation-builder-canvas");
    expect(screen.queryByRole("button", { name: "Pause automation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume automation" })).not.toBeInTheDocument();
  });

  it("starts a full test run from the builder without depending on the delivery platform", async () => {
    const user = userEvent.setup();
    mocks.getAutomation.mockResolvedValue({ ...automation, platform: "whatsapp", contextType: "group" });

    renderBuilder();

    const testButton = await screen.findByRole("button", { name: "Test automation" });
    expect(testButton).toHaveAttribute("title", "Run without sending output to configured channels");
    await user.click(testButton);

    await waitFor(() =>
      expect(mocks.runTask).toHaveBeenCalledWith("task-123", "test", {
        clientSessionId: expect.any(String),
        generation: 1,
      }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: { conversationId: "chat-alpha", runId: "run-test" },
      }),
    );
  });

  it("shows the three execution modes and leaves the recommendation advisory", async () => {
    const user = userEvent.setup();
    mocks.chatMessages = [];
    mockInitialExecutionModeSetup();

    renderBuilder();

    expect(await screen.findByTestId("automation-setup-card")).toBeInTheDocument();
    expect(screen.getByTestId("automation-mode-deterministic")).toHaveTextContent("Deterministic");
    expect(screen.getByTestId("automation-mode-hybrid")).toHaveTextContent("Hybrid");
    expect(screen.getByTestId("automation-mode-agent-led")).toHaveTextContent("Agent");
    expect(screen.getByTestId("automation-mode-agent-led")).toHaveTextContent("Recommended");

    await user.click(screen.getByTestId("automation-mode-deterministic"));

    await waitFor(() =>
      expect(mocks.selectSetupExecutionMode).toHaveBeenCalledWith(
        "task-123",
        "deterministic",
        expect.objectContaining({ clientSessionId: expect.any(String), generation: 1 }),
      ),
    );
    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '[automation-setup-mode-selection] I chose the "deterministic" execution mode (Deterministic) for this automation. Please continue by asking the next relevant automation questions.',
        }),
        {
          body: expect.objectContaining({
            automationTaskId: "task-123",
            clientSessionId: expect.any(String),
            generation: 1,
          }),
        },
      ),
    );
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["hybrid", "Hybrid"],
    ["agent-led", "Agent"],
  ] as const)("saves and sends the %s execution mode choice", async (mode, label) => {
    const user = userEvent.setup();
    mockInitialExecutionModeSetup();
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      executionMode: "deterministic",
      isPlaceholderDraft: true,
      originChat: {
        platform: "web",
        conversationId: "chat-setup-source",
        providerThreadId: null,
        currentMessageId: null,
      },
    });
    mocks.chatMessages = [];

    renderBuilder();

    await user.click(await screen.findByRole("radio", { name: label }));

    await waitFor(() =>
      expect(mocks.selectSetupExecutionMode).toHaveBeenCalledWith(
        "task-123",
        mode,
        expect.objectContaining({ clientSessionId: expect.any(String), generation: 1 }),
      ),
    );
    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: `[automation-setup-mode-selection] I chose the "${mode}" execution mode (${label}) for this automation. Please continue by asking the next relevant automation questions.`,
        }),
        {
          body: expect.objectContaining({
            automationTaskId: "task-123",
            clientSessionId: expect.any(String),
            generation: 1,
          }),
        },
      ),
    );
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("only asks for an execution mode after a builder chat is open", async () => {
    mocks.search = {};

    renderBuilder();

    expect(await screen.findByText("Chats")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Agent" })).not.toBeInTheDocument();
    expect(mocks.saveAutomation).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
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

  it("renders the Canvas-managed webhook contract and active setup guidance", async () => {
    const user = userEvent.setup();
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      scheduleType: "external",
      scheduleValue: "canvas",
      steps: [
        {
          ...automation.steps[0],
          label: "Canvas webhook trigger",
          icon: "webhooks",
          triggerConfig: {
            type: "canvas",
            app: "Canvas",
            eventDescription: "webhook received",
            componentKey: "webhook-trigger",
            status: "active",
            canvasEndpoint: {
              url: "https://sketch.example/api/webhooks/wf/task-123",
              method: "POST",
              authentication: "none",
              contentType: "application/json",
              payload: "JSON object",
            },
          },
        },
        ...automation.steps.slice(1),
      ],
    });
    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Canvas webhook trigger" }));

    expect(await screen.findByTestId("canvas-trigger-details")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://sketch.example/api/webhooks/wf/task-123")).toBeInTheDocument();
    expect(screen.getByDisplayValue("POST")).toBeInTheDocument();
    expect(screen.getByDisplayValue("None required")).toBeInTheDocument();
    expect(screen.getByDisplayValue("application/json")).toBeInTheDocument();
    expect(screen.getByDisplayValue("JSON object")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-trigger-setup-guidance")).toHaveTextContent(
      "Canvas setup is complete. Send POST requests with JSON to the canonical URL above; no authentication is required.",
    );
  });

  it.each([
    [
      "pending_canvas_setup",
      "Setup pending",
      "Canvas is still setting up this trigger. Complete setup in Canvas before sending requests.",
    ],
    [
      "error",
      "Setup error",
      "Canvas could not finish setting up this trigger. Fix the trigger in Canvas and retry setup.",
    ],
  ] as const)("shows explicit Canvas %s guidance", async (status, statusLabel, guidance) => {
    const user = userEvent.setup();
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      scheduleType: "external",
      scheduleValue: "canvas",
      steps: [
        {
          ...automation.steps[0],
          label: "Canvas trigger",
          icon: "webhooks",
          triggerConfig: {
            type: "canvas",
            componentKey: "webhook-trigger",
            status,
            ...(status === "error" ? { errorMessage: "Canvas setup failed" } : {}),
          },
        },
        ...automation.steps.slice(1),
      ],
    });
    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Canvas trigger" }));

    expect(await screen.findByText(statusLabel)).toBeInTheDocument();
    const guidanceRegion = screen.getByTestId("canvas-trigger-setup-guidance");
    expect(guidanceRegion).toHaveTextContent(guidance);
    if (status === "error") {
      expect(guidanceRegion).toHaveAttribute("role", "alert");
      expect(guidanceRegion).toHaveTextContent("Canvas error: Canvas setup failed");
    }
  });

  it("keeps the native Sketch webhook trigger out of the Canvas setup panel", async () => {
    const user = userEvent.setup();
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      scheduleType: "external",
      scheduleValue: "webhook",
      steps: [
        {
          ...automation.steps[0],
          label: "Sketch webhook",
          triggerConfig: {
            type: "webhook",
            webhookUrl: "https://sketch.example/api/webhooks/v1/endpoint-123",
            webhookEndpointId: "endpoint-123",
            webhookMethod: "POST",
            webhookContentType: "application/json",
            webhookAuthentication: "none",
            webhookStatus: "active",
          } as WorkflowTriggerConfig,
        },
        ...automation.steps.slice(1),
      ],
    });
    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Sketch webhook" }));

    expect(await screen.findByDisplayValue("webhook")).toBeInTheDocument();
    expect(screen.queryByTestId("canvas-trigger-details")).not.toBeInTheDocument();
  });

  it("renders the native webhook with the same simple contract as the Canvas webhook", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      scheduleType: "external",
      scheduleValue: "webhook",
      steps: [
        {
          ...automation.steps[0],
          label: "Sketch webhook",
          triggerConfig: {
            type: "webhook",
            webhookUrl: "https://sketch.example/api/webhooks/v1/endpoint-123",
            webhookEndpointId: "endpoint-123",
            webhookMethod: "POST",
            webhookContentType: "application/json",
            webhookAuthentication: "none",
            webhookStatus: "active",
          } as WorkflowTriggerConfig,
        },
        ...automation.steps.slice(1),
      ],
    });

    renderBuilder();
    await user.click(await screen.findByRole("button", { name: "Sketch webhook" }));

    const panel = await screen.findByTestId("native-webhook-details");
    expect(panel).toHaveTextContent("Active");
    expect(panel).toHaveTextContent(
      "Send POST requests with JSON to the canonical URL above; no authentication is required.",
    );
    expect(screen.getByDisplayValue("POST")).toBeInTheDocument();
    expect(screen.getByDisplayValue("application/json")).toBeInTheDocument();
    expect(screen.getByDisplayValue("None required")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Any JSON value")).toBeInTheDocument();
    expect(panel).not.toHaveTextContent("HMAC");
    expect(panel).not.toHaveTextContent("Bearer");
    expect(screen.queryByRole("button", { name: "Generate secret" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke endpoint" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy canonical Sketch webhook URL" }));
    expect(writeText).toHaveBeenCalledWith("https://sketch.example/api/webhooks/v1/endpoint-123");
  });

  it("shows setup pending when the native webhook endpoint is unavailable", async () => {
    const user = userEvent.setup();
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      scheduleType: "external",
      scheduleValue: "webhook",
      steps: [
        {
          ...automation.steps[0],
          label: "Sketch webhook",
          triggerConfig: { type: "webhook", webhookStatus: "unavailable" } as WorkflowTriggerConfig,
        },
        ...automation.steps.slice(1),
      ],
    });

    renderBuilder();
    await user.click(await screen.findByRole("button", { name: "Sketch webhook" }));

    const panel = await screen.findByTestId("native-webhook-details");
    expect(panel).toHaveTextContent("Setup pending");
    expect(panel).toHaveTextContent("Sketch is still setting up this trigger");
    expect(screen.getByDisplayValue("Webhook endpoint is not available yet")).toBeInTheDocument();
  });

  it("opens the selected associated chat and sends the active automation id", async () => {
    const user = userEvent.setup();
    renderBuilder();

    const input = await screen.findByLabelText("Message Sketch");
    await waitFor(() => expect(input).not.toBeDisabled());
    expect(mocks.conversationMessages).toHaveBeenCalledWith("task-123", "chat-alpha");

    await user.type(input, "Make it daily");
    await user.click(screen.getByLabelText("Send message"));

    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Make it daily" }), {
      body: expect.objectContaining({
        automationTaskId: "task-123",
        clientSessionId: expect.any(String),
        generation: 1,
      }),
    });
  });

  it("keeps the loaded transcript mounted when the same editing lease is renewed", async () => {
    mocks.chatMessages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "Keep this transcript visible" }] }];
    renderBuilder();

    expect(await screen.findByText("Keep this transcript visible")).toBeInTheDocument();
    await waitFor(() => expect(mocks.selectConversation).toHaveBeenCalledTimes(1));
    const acquireCallsBeforeFocus = mocks.acquireLock.mock.calls.length;

    act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() => expect(mocks.acquireLock.mock.calls.length).toBeGreaterThan(acquireCallsBeforeFocus));
    expect(mocks.selectConversation).toHaveBeenCalledTimes(1);
    expect(mocks.conversationMessages).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Loading chat…")).not.toBeInTheDocument();
    expect(screen.getByText("Keep this transcript visible")).toBeInTheDocument();
  });

  it("reloads persisted chat progress when returning to the builder window", async () => {
    mocks.chatMessages = [
      {
        id: "a-progress",
        role: "assistant",
        parts: [{ type: "data-progress", data: { lines: ["Updating automation"] } }],
      },
    ];
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    renderBuilder();

    const input = await screen.findByLabelText("Message Sketch");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "");
    await waitFor(() => expect(mocks.conversationMessages).toHaveBeenCalledWith("task-123", "chat-alpha"));
    mocks.conversationMessages.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() =>
      expect(mocks.conversationMessages).toHaveBeenCalledWith("task-123", "chat-alpha", expect.any(Object)),
    );
  });

  it("refreshes the graph and latest run after an external automation update", async () => {
    vi.useFakeTimers();
    const refreshedAutomation = automationWithStepOutput("fresh run output");
    refreshedAutomation.revision = automation.revision + 1;
    refreshedAutomation.steps = [
      ...refreshedAutomation.steps,
      {
        id: "notify",
        type: "action",
        label: "Notify Slack",
        icon: "slack",
        position: { x: 460, y: 0 },
      },
    ];
    refreshedAutomation.edges = [...refreshedAutomation.edges, { id: "check-notify", from: "check", to: "notify" }];
    refreshedAutomation.stepContent.notify = {
      taskId: automation.id,
      stepId: "notify",
      contentType: "script",
      content: "return input;",
      apps: ["Slack"],
      updatedAt: null,
    };
    mocks.getAutomation.mockReset().mockResolvedValueOnce(automation).mockResolvedValue(refreshedAutomation);

    renderBuilder();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("button", { name: "Check rating" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Notify Slack" })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATION_REFRESH_INTERVAL_MS);
    });

    expect(screen.getByRole("button", { name: "Notify Slack" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Viewing/ })).toBeInTheDocument();
    expect(mocks.getAutomation).toHaveBeenCalledTimes(2);
  });

  it("does not rebuild the workflow for a same-revision background refresh", async () => {
    vi.useFakeTimers();
    const volatileRefresh = {
      ...automation,
      lock: {
        heldByUserId: "user-1",
        heldByName: "Owner Member",
        heldByPlatform: "web",
        heldBySurface: "builder",
        expiresAt: "2026-06-01T00:10:00.000Z",
        generation: 1,
        isHeldByMe: true,
        stealPending: null,
      },
      steps: [
        ...automation.steps,
        { id: "volatile", type: "action", label: "Must not appear", icon: "slack", position: { x: 460, y: 0 } },
      ],
    };
    mocks.getAutomation.mockReset().mockResolvedValueOnce(automation).mockResolvedValue(volatileRefresh);

    renderBuilder();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("button", { name: "Check rating" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATION_REFRESH_INTERVAL_MS);
    });

    expect(screen.queryByRole("button", { name: "Must not appear" })).not.toBeInTheDocument();
    expect(mocks.getAutomation).toHaveBeenCalledTimes(2);
  });

  it("keeps the active run label constrained inside the builder toolbar", async () => {
    mocks.getAutomation.mockResolvedValue(automationWithStepOutput("latest step output"));

    renderBuilder();

    const viewingButton = await screen.findByRole("button", { name: /Viewing/ });
    expect(viewingButton).toHaveClass("min-w-0", "max-w-full");
    expect(viewingButton.querySelector("span")).toHaveClass("min-w-0", "max-w-full", "truncate");
  });

  it("uses a normal prompt instead of repeating execution-mode setup in a new chat", async () => {
    renderBuilder();

    expect(await screen.findByLabelText("Message Sketch")).toBeInTheDocument();
    expect(screen.getByText("Create an automation")).toBeInTheDocument();
    expect(screen.queryByTestId("automation-builder-empty-canvas")).not.toBeInTheDocument();
    expect(screen.queryByTestId("automation-setup-card")).not.toBeInTheDocument();
    expect(await screen.findByText("What should this automation do?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a step" })).not.toBeInTheDocument();
  });

  it.each([403, 404])("shows an actionable access state for a %s builder response", async (status) => {
    mocks.getAutomation.mockRejectedValue(new ApiRequestError("Scheduled task not found", status, "NOT_FOUND"));

    renderBuilder();

    expect(await screen.findByTestId("automation-builder-access-error")).toBeInTheDocument();
    expect(screen.getByText("Automation unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Loading automation…")).not.toBeInTheDocument();

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

  it("uses theme tokens and paired theme classes across builder surfaces", async () => {
    const user = userEvent.setup();
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      steps: [
        automation.steps[0],
        automation.steps[1],
        {
          id: "post",
          type: "action",
          label: "Post to Slack",
          icon: "slack",
          position: { x: 460, y: 0 },
        },
      ],
      edges: [...automation.edges, { id: "check-post", from: "check", to: "post" }],
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
      latestRun: {
        id: "run-theme",
        taskId: "task-123",
        triggerData: null,
        status: "completed",
        stepOutputs: {
          check: { output: "theme output", status: "completed", duration_ms: 10 },
        },
        errorMessage: null,
        startedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T00:00:01.000Z",
      },
      recentRuns: [
        {
          id: "run-theme",
          taskId: "task-123",
          triggerData: null,
          status: "completed",
          stepOutputs: {
            check: { output: "theme output", status: "completed", duration_ms: 10 },
          },
          errorMessage: null,
          startedAt: "2026-06-01T00:00:00.000Z",
          completedAt: "2026-06-01T00:00:01.000Z",
        },
      ],
    });
    renderBuilder();

    const canvas = await screen.findByTestId("automation-builder-canvas");
    const toolbar = screen.getByTestId("automation-builder-toolbar");
    const sidecar = screen.getByTestId("automation-builder-chat-sidecar");
    expect(canvas).toHaveClass("bg-background", "text-foreground");
    expect(toolbar).toHaveClass("border-border/70", "bg-card/90");
    expect(sidecar).toHaveClass("border-border/80", "bg-background", "text-foreground");
    expect(screen.getByTestId("automation-background")).toHaveAttribute("data-color", "var(--automation-builder-grid)");
    expect(screen.getByTestId("automation-controls")).toHaveClass("automation-builder-controls");

    const nodeShells = screen.getAllByTestId("automation-node-shell");
    expect(nodeShells.some((node) => node.className.includes("dark:bg-"))).toBe(true);
    for (const surface of [canvas, toolbar, sidecar, ...nodeShells]) {
      expect(surface.className).not.toMatch(/(?:bg|text|border)-(?:\[#|white)/);
    }

    await user.click(screen.getByRole("button", { name: "Check rating" }));
    const drawer = screen.getByTestId("automation-builder-drawer");
    expect(drawer).toHaveClass("border-border/80", "bg-background", "text-foreground");
    expect(screen.getByDisplayValue("Summarize accounts")).toHaveClass("border-input", "bg-card");

    await user.click(screen.getByRole("tab", { name: "Output" }));
    const output = screen.getByTestId("automation-builder-output");
    expect(output).toHaveClass("border-border", "bg-card");
    expect(output.className).not.toMatch(/(?:bg|text|border)-(?:\[#|white)/);
  });

  it("only marks the next unresolved non-trigger node as running for a persisted run", async () => {
    const runningRun: NonNullable<AutomationDefinition["latestRun"]> = {
      id: "run-running",
      taskId: "task-123",
      triggerData: null,
      status: "running",
      stepOutputs: {
        check: { output: "checked", status: "completed", duration_ms: 18 },
      },
      errorMessage: null,
      startedAt: "2026-06-01T00:00:00.000Z",
      completedAt: null,
    };
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      steps: [
        ...automation.steps,
        {
          id: "post",
          type: "action",
          label: "Post summary",
          icon: "slack",
          position: { x: 460, y: 0 },
        },
      ],
      edges: [...automation.edges, { id: "check-post", from: "check", to: "post" }],
      latestRun: runningRun,
      recentRuns: [runningRun],
    });

    renderBuilder();

    const flow = await screen.findByTestId("automation-flow");
    await waitFor(() => {
      expect(flow).toHaveAttribute("data-nodes-focusable", "true");
      expect(screen.getByTestId("automation-node-trigger")).toHaveAttribute("data-state", "idle");
      expect(screen.getByTestId("automation-node-check")).toHaveAttribute("data-state", "success");
      expect(
        screen.getByTestId("automation-node-check").querySelector('[data-testid="automation-node-status-marker"]'),
      ).toHaveClass("bg-transparent", "text-emerald-700", "dark:text-emerald-300");
      expect(screen.getByTestId("automation-node-post")).toHaveAttribute("data-state", "running");
      expect(screen.getByTestId("automation-node-post")).toHaveAttribute("data-execution-activity", "run");
      expect(flow).toHaveAttribute("data-edge-animations", "trigger-check:false|check-post:true");
    });
  });

  it("marks persisted step failures in the graph and drawer", async () => {
    const failedRun: NonNullable<AutomationDefinition["latestRun"]> = {
      id: "run-failed",
      taskId: "task-123",
      triggerData: null,
      status: "failed",
      stepOutputs: {
        check: {
          output: null,
          status: "failed",
          duration_ms: 42,
          error: { message: "Slack is unavailable" },
        },
      },
      errorMessage: "Step failed",
      startedAt: "2026-06-01T00:00:00.000Z",
      completedAt: "2026-06-01T00:00:01.000Z",
    };
    mocks.getAutomation.mockResolvedValue({ ...automation, latestRun: failedRun, recentRuns: [failedRun] });
    const user = userEvent.setup();

    renderBuilder();

    const failedNode = await screen.findByTestId("automation-node-check");
    expect(failedNode).toHaveAttribute("data-state", "failed");
    expect(failedNode.querySelector('[data-testid="automation-node-shell"]')).toHaveClass("automation-node-failed");
    expect(failedNode.querySelector('[data-testid="automation-node-status-marker"]')).toHaveClass(
      "bg-transparent",
      "text-destructive",
    );

    await user.click(screen.getByRole("button", { name: "Check rating" }));
    expect(screen.getByText("Failed · 42ms")).toBeInTheDocument();
    expect(screen.getByText(/Latest result/)).toBeInTheDocument();
  });

  it("honors an associated source chat search param", async () => {
    mocks.search = { conversationId: "chat-alpha" };
    renderBuilder();

    await screen.findByLabelText("Message Sketch");
    expect(screen.getByText("Create an automation")).toBeInTheDocument();
    expect(screen.queryByText("chat-alpha")).not.toBeInTheDocument();
    expect(mocks.conversationMessages).toHaveBeenCalledWith("task-123", "chat-alpha");
    expect(mocks.conversationMessages).not.toHaveBeenCalledWith(
      "task-123",
      expect.stringMatching(/^builder-task-123-/),
    );
  });

  it("hydrates batched builder questions and preserves the ordered outgoing answer", () => {
    const batch: WebChatQuestionBatch = {
      batchId: "builder-batch",
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
    const answer: WebChatQuestionBatchAnswer = {
      batchId: "builder-batch",
      answers: [
        { questionId: "source", optionId: "drive" },
        { questionId: "delivery", optionId: "slack" },
      ],
    };

    const messages = builderChatThreadMessages([
      {
        id: "assistant-builder-batch",
        role: "assistant",
        parts: [{ type: "data-question-batch", id: "batch-part", data: batch }],
      },
      {
        id: "user-builder-answer",
        role: "user",
        parts: [{ type: "data-question-batch-answer", id: "answer-part", data: answer }],
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: "assistant-builder-batch", questionBatch: batch });
    expect(messages[1]).toMatchObject({ id: "user-builder-answer", role: "user", text: "Submitted answers" });

    expect(outgoingBuilderQuestionBatchAnswerMessage(batch, answer)).toMatchObject({
      parts: [
        { type: "text", text: "Google Drive · Slack" },
        { type: "data-question-batch-answer", data: answer },
      ],
    });
  });

  it("uses custom responses as outgoing answer text and normalizes legacy setup continuations", () => {
    const question: WebChatQuestion = {
      id: "goal",
      prompt: "What should this automate?",
      options: [
        { id: "brief", label: "Daily brief" },
        { id: "alerts", label: "Alerts" },
      ],
    };
    expect(
      outgoingBuilderQuestionAnswerMessage(question, { questionId: "goal", customResponse: "A weekly scorecard" }),
    ).toMatchObject({
      parts: [
        { type: "text", text: "A weekly scorecard" },
        { type: "data-question-answer", data: { questionId: "goal", customResponse: "A weekly scorecard" } },
      ],
    });
    expect(
      builderChatThreadMessages([
        {
          id: "mode-selection",
          role: "user",
          parts: [
            {
              type: "text",
              text: '[automation-setup-mode-selection] I chose the "hybrid" execution mode (Recipe + AI).',
            },
          ],
        },
      ]),
    ).toMatchObject([{ role: "user", text: "Hybrid selected." }]);
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

    expect(await screen.findByText("Chats")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message Sketch")).not.toBeInTheDocument();
    expect(mocks.conversationMessages).not.toHaveBeenCalled();
    expect(mocks.originChatMessages).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() =>
      expect(mocks.createConversation).toHaveBeenCalledWith("task-123", {
        createNew: true,
        clientSessionId: expect.any(String),
        generation: 1,
      }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId: "task-123" },
        search: { conversationId: "builder-new" },
      }),
    );
  });

  it("uses viewer-scoped transcript summaries for builder chat labels and hides source chats", async () => {
    mocks.search = {};
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "chat-source",
          kinds: ["web_chat"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
        {
          conversationId: "chat-builder",
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
    mocks.webChatConversations.mockResolvedValue({
      conversations: [
        {
          id: "chat-source",
          title: "Review the source thread",
          channel: "web",
          updatedAt: "2026-06-03T00:00:00.000Z",
        },
        {
          id: "chat-builder",
          title: "Continue the builder plan",
          channel: "web",
          updatedAt: "2026-06-04T00:00:00.000Z",
        },
      ],
    });

    renderBuilder();

    expect(await screen.findByText("Continue the builder plan")).toBeInTheDocument();
    expect(screen.queryByText("Review the source thread")).not.toBeInTheDocument();
    expect(screen.queryByText("chat-source")).not.toBeInTheDocument();
    expect(screen.queryByText("chat-builder")).not.toBeInTheDocument();
    expect(screen.getAllByText("Automation").length).toBeGreaterThan(0);
    expect(screen.getByText(/(?:Jun 4|4 Jun)/)).toBeInTheDocument();
  });

  it("labels conversations with the transcript user name in owner/admin views", async () => {
    mocks.search = {};
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "chat-maya",
          kinds: ["builder"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          state: "active",
          transcriptUserName: "Maya Chen",
        },
        {
          conversationId: "chat-owner",
          kinds: ["builder"],
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
          lastActiveAt: "2026-06-02T00:00:00.000Z",
          archivedAt: null,
          state: "active",
          transcriptUserName: "Alice Smith",
        },
      ],
      transcriptAccess: "owner",
    });
    mocks.webChatConversations.mockResolvedValue({ conversations: [] });

    renderBuilder();

    expect(await screen.findByText("by Maya Chen")).toBeInTheDocument();
    expect(screen.getByText("by Alice Smith")).toBeInTheDocument();
  });

  it("omits the transcript user label for viewer-scoped lists", async () => {
    mocks.search = {};
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "chat-own",
          kinds: ["builder"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
      ],
      transcriptAccess: "viewer",
    });
    mocks.webChatConversations.mockResolvedValue({ conversations: [] });

    renderBuilder();

    expect(await screen.findByText("Automation chat")).toBeInTheDocument();
    expect(screen.queryByText(/by /)).not.toBeInTheDocument();
  });

  it("uses a generic title and subdued diagnostic ID when a transcript summary is missing", async () => {
    mocks.search = {};
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "chat-missing-summary",
          kinds: ["builder"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
      ],
      transcriptAccess: "viewer",
    });
    mocks.webChatConversations.mockResolvedValue({ conversations: [] });

    renderBuilder();

    expect((await screen.findAllByText("Automation chat")).length).toBeGreaterThan(0);
    const diagnostic = screen.getByText("Chat chat-missing-summary");
    expect(diagnostic).toHaveClass("font-mono", "text-muted-foreground/60");
  });

  it("keeps a long chat title in the folded rail without exposing its identifier", async () => {
    const title = "Review account health, incident follow-ups, and customer commitments before the Friday handoff";
    mocks.search = {};
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "chat-with-a-diagnostic-only-id",
          kinds: ["builder"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
      ],
      transcriptAccess: "viewer",
    });
    mocks.webChatConversations.mockResolvedValue({
      conversations: [
        {
          id: "chat-with-a-diagnostic-only-id",
          title,
          channel: "web",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    renderBuilder();

    const row = await screen.findByTestId("automation-builder-conversation-chat-with-a-diagnostic-only-id");
    expect(row).toHaveAttribute("aria-label", `Open chat: ${title}`);
    expect(row).toHaveClass("min-w-0");
    expect(row.querySelector(`[title="${title}"]`)).toHaveClass("truncate");
    expect(row).not.toHaveTextContent("chat-with-a-diagnostic-only-id");
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

    await waitFor(() =>
      expect(mocks.selectConversation).toHaveBeenCalledWith(
        "task-123",
        "chat-beta",
        "builder",
        expect.objectContaining({ clientSessionId: expect.any(String), generation: 1 }),
      ),
    );
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { conversationId: "chat-beta" } }));
    expect(mocks.conversationMessages).not.toHaveBeenCalled();
  });

  it("opens the originating web chat from recents when a builder chat also exists", async () => {
    mocks.search = { conversationId: "chat-alpha" };
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [
        {
          conversationId: "builder-alpha",
          kinds: ["builder"],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          lastActiveAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
        {
          conversationId: "chat-alpha",
          kinds: ["web_chat"],
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
          lastActiveAt: "2026-06-02T00:00:00.000Z",
          archivedAt: null,
          state: "active",
        },
      ],
      transcriptAccess: "owner",
    });

    renderBuilder();

    await waitFor(() => expect(mocks.conversationMessages).toHaveBeenCalledWith("task-123", "chat-alpha"));
    expect(screen.queryByTestId("automation-builder-chat-unavailable")).not.toBeInTheDocument();
    expect(mocks.selectConversation).toHaveBeenCalledWith(
      "task-123",
      "chat-alpha",
      "web_chat",
      expect.objectContaining({ clientSessionId: expect.any(String), generation: 1 }),
    );
  });

  it("archives the current chat from the sidechat and returns to history", async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Archive chat" }));

    await waitFor(() =>
      expect(mocks.archiveConversation).toHaveBeenCalledWith(
        "task-123",
        "chat-alpha",
        true,
        expect.objectContaining({ clientSessionId: expect.any(String), generation: 1 }),
      ),
    );
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
    expect(mocks.conversationMessages).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Restore chat" }));
    await waitFor(() =>
      expect(mocks.archiveConversation).toHaveBeenCalledWith(
        "task-123",
        "chat-archived",
        false,
        expect.objectContaining({ clientSessionId: expect.any(String), generation: 1 }),
      ),
    );

    mocks.search = { conversationId: "not-associated" };
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [],
      transcriptAccess: "viewer",
    });
    renderBuilder();
    expect(await screen.findByTestId("automation-builder-chat-unavailable")).toBeInTheDocument();
    expect(mocks.conversationMessages).not.toHaveBeenCalledWith("task-123", "not-associated");
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

    expect(mocks.interruptChat).toHaveBeenCalledWith(
      "chat-alpha",
      "task-123",
      expect.objectContaining({ clientSessionId: expect.any(String), generation: 1 }),
    );
    expect(mocks.interruptChat).not.toHaveBeenCalledWith("42");
  });

  it("renders a pending setup question in the side chat transcript", async () => {
    mocks.chatMessages = [
      {
        id: "a-question",
        role: "assistant",
        parts: [
          {
            type: "data-question",
            data: {
              id: "source",
              prompt: "Where should I look?",
              options: [
                { id: "gmail", label: "Gmail" },
                { id: "drive", label: "Google Drive" },
              ],
            },
          },
        ],
      },
    ];

    renderBuilder();

    const questionCard = await screen.findByTestId("question-card");
    expect(questionCard).toHaveTextContent("Where should I look?");
    expect(questionCard.closest('[aria-label="Chat thread"]')).toContainElement(questionCard);
    expect(screen.queryByTestId("automation-builder-question-dock")).not.toBeInTheDocument();
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
            data: { detail: "Sketch paused.", label: "What should Sketch do differently?" },
          },
        ],
      },
    ];

    renderBuilder();

    expect(await screen.findByText("Sketch paused.")).toBeInTheDocument();
    expect(screen.getByText("What should Sketch do differently?")).toBeInTheDocument();
  });

  it("returns the step-test button to idle and renders the latest output after success", async () => {
    const user = userEvent.setup();
    const testResult = deferred<{ run: unknown }>();
    const updatedAutomation = automationWithStepOutput("latest step output");
    mocks.getAutomation.mockReset().mockResolvedValueOnce(automation).mockResolvedValue(updatedAutomation);
    mocks.testStep.mockReset().mockReturnValueOnce(testResult.promise);

    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Check rating" }));
    const testButton = screen.getByRole("button", { name: "Test" });
    await user.click(testButton);
    expect(testButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Testing…" })).toBeDisabled();
    await waitFor(() => {
      expect(screen.getByTestId("automation-node-check")).toHaveAttribute("data-state", "running");
      expect(screen.getByTestId("automation-node-check")).toHaveAttribute("data-execution-activity", "test");
      expect(screen.getByTestId("automation-node-execution-summary")).toHaveTextContent("Testing this node");
    });

    testResult.resolve({ run: updatedAutomation.latestRun });

    await waitFor(() => expect(testButton).not.toBeDisabled());
    await user.click(screen.getByRole("tab", { name: "Output" }));
    expect(await screen.findByText(/latest step output/)).toBeInTheDocument();
    expect(mocks.getAutomation).toHaveBeenCalledTimes(2);
  });

  it.each(stepTestFailures)("returns the step-test button to idle after %s", async (_label, createError) => {
    const user = userEvent.setup();
    const testResult = deferred<{ run: unknown }>();
    mocks.testStep.mockReset().mockReturnValueOnce(testResult.promise);

    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Check rating" }));
    const testButton = screen.getByRole("button", { name: "Test" });
    await user.click(testButton);
    expect(testButton).toBeDisabled();

    testResult.reject(createError());
    await waitFor(() => expect(testButton).not.toBeDisabled());
  });

  it("starts a fresh pending state and renders the latest result on repeated tests", async () => {
    const user = userEvent.setup();
    const firstTest = deferred<{ run: unknown }>();
    const secondTest = deferred<{ run: unknown }>();
    const firstAutomation = automationWithStepOutput("first step output");
    const secondAutomation = automationWithStepOutput("second step output");
    mocks.getAutomation
      .mockReset()
      .mockResolvedValueOnce(automation)
      .mockResolvedValueOnce(firstAutomation)
      .mockResolvedValue(secondAutomation);
    mocks.testStep.mockReset().mockReturnValueOnce(firstTest.promise).mockReturnValueOnce(secondTest.promise);

    renderBuilder();

    await user.click(await screen.findByRole("button", { name: "Check rating" }));
    const testButton = screen.getByRole("button", { name: "Test" });
    await user.click(testButton);
    expect(testButton).toBeDisabled();

    firstTest.resolve({ run: firstAutomation.latestRun });
    await waitFor(() => expect(testButton).not.toBeDisabled());
    await user.click(screen.getByRole("tab", { name: "Output" }));
    expect(await screen.findByText(/first step output/)).toBeInTheDocument();

    await user.click(testButton);
    expect(testButton).toBeDisabled();

    secondTest.resolve({ run: secondAutomation.latestRun });
    await waitFor(() => expect(testButton).not.toBeDisabled());
    expect(await screen.findByText(/second step output/)).toBeInTheDocument();
    expect(mocks.getAutomation).toHaveBeenCalledTimes(3);
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
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
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
    await act(async () => {
      vi.advanceTimersByTime(AUTOMATION_REFRESH_INTERVAL_MS);
    });
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
