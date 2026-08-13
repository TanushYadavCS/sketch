import type { AutomationDefinition, AutomationShare, User } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationBuilderPage } from "./automation-builder";

const mocks = vi.hoisted(() => ({
  getAutomation: vi.fn(),
  listConversations: vi.fn(),
  webChatConversations: vi.fn(),
  loadMessages: vi.fn(),
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
  testStep: vi.fn(),
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  listShares: vi.fn(),
  grantShare: vi.fn(),
  revokeShare: vi.fn(),
  listUsers: vi.fn(),
  search: { conversationId: "chat-alpha" } as Record<string, unknown>,
  chatMessages: [] as Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }>,
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
        run: mocks.runTask,
        getRun: mocks.getRun,
        save: mocks.saveAutomation,
        selectSetupExecutionMode: mocks.selectSetupExecutionMode,
        remove: mocks.removeAutomation,
        testStep: mocks.testStep,
        listShares: mocks.listShares,
        grantShare: mocks.grantShare,
        revokeShare: mocks.revokeShare,
      },
      webChat: {
        messages: mocks.loadMessages,
        conversations: mocks.webChatConversations,
        interrupt: mocks.interruptChat,
        uploadAttachment: vi.fn(),
        transcribe: vi.fn(),
      },
      users: {
        list: mocks.listUsers,
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
    Background: () => <div data-testid="automation-background" />,
    BackgroundVariant: { Dots: "dots" },
    Controls: () => <div data-testid="automation-controls" />,
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
    ReactFlowProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ReactFlow: ({
      nodes,
      nodeTypes,
      children,
    }: {
      nodes: Array<{ id: string; type?: string; data: { step: { label: string } } }>;
      nodeTypes?: Record<string, React.ComponentType<{ data: { step: { label: string } }; isConnectable?: boolean }>>;
      children?: ReactNode;
    }) => (
      <div data-testid="automation-flow">
        {nodes.map((node) =>
          node.type && nodeTypes?.[node.type] ? (
            <div key={node.id}>
              {React.createElement(nodeTypes[node.type], { data: node.data, isConnectable: false })}
            </div>
          ) : null,
        )}
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
      triggerConfig: { type: "schedule", scheduleType: "cron", scheduleValue: "0 9 * * *", timezone: "UTC" },
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
  stepContent: {},
  latestRun: null,
  recentRuns: [],
};

const members: User[] = [
  {
    id: "user-1",
    name: "Owner Member",
    email: "owner@example.com",
    email_verified_at: null,
    auth_role: "member",
    slack_user_id: null,
    whatsapp_number: null,
    description: null,
    type: "human",
    role: null,
    reports_to: null,
    allowed_tools: null,
    slack_channel_ids: [],
    whatsapp_group_jids: [],
    is_whatsapp_fallback: false,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "user-2",
    name: "Grantee Member",
    email: "grantee@example.com",
    email_verified_at: null,
    auth_role: "member",
    slack_user_id: null,
    whatsapp_number: null,
    description: null,
    type: "human",
    role: null,
    reports_to: null,
    allowed_tools: null,
    slack_channel_ids: [],
    whatsapp_group_jids: [],
    is_whatsapp_fallback: false,
    created_at: "2026-01-02T00:00:00.000Z",
  },
];

function shareFor(userId: string): AutomationShare {
  return {
    userId,
    name: "Grantee Member",
    email: "grantee@example.com",
    grantedByUserId: "user-1",
    grantedAt: "2026-06-02T00:00:00.000Z",
  };
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

describe("AutomationBuilderPage sharing", () => {
  beforeEach(() => {
    mocks.getAutomation.mockReset();
    mocks.getAutomation.mockResolvedValue(automation);
    mocks.listConversations.mockReset();
    mocks.listConversations.mockResolvedValue({
      taskId: "task-123",
      conversations: [],
      builderLock: { state: "available", conversationId: null, owner: null, expiresAt: null },
      transcriptAccess: "viewer",
    });
    mocks.webChatConversations.mockReset();
    mocks.webChatConversations.mockResolvedValue({ conversations: [] });
    mocks.loadMessages.mockReset();
    mocks.loadMessages.mockResolvedValue({ messages: [], updatedAt: null });
    mocks.originChatMessages.mockResolvedValue({ messages: [] });
    mocks.createConversation.mockResolvedValue({ created: false, conversation: null, builderLock: null });
    mocks.selectConversation.mockResolvedValue({ created: false, conversation: null, builderLock: null });
    mocks.archiveConversation.mockResolvedValue({ conversation: null, builderLock: null });
    mocks.interruptChat.mockResolvedValue({ success: true, interrupted: true });
    mocks.clearError.mockClear();
    mocks.navigate.mockClear();
    mocks.runTask.mockResolvedValue({ status: "triggered", runId: "run-test" });
    mocks.getRun.mockResolvedValue({ run: null });
    mocks.saveAutomation.mockResolvedValue(automation);
    mocks.selectSetupExecutionMode.mockResolvedValue(automation);
    mocks.removeAutomation.mockResolvedValue(undefined);
    mocks.testStep.mockResolvedValue({ run: null });
    mocks.sendMessage.mockClear();
    mocks.setMessages.mockClear();
    mocks.listShares.mockReset();
    mocks.listShares.mockResolvedValue({ shares: [] });
    mocks.grantShare.mockReset();
    mocks.grantShare.mockResolvedValue({ success: true });
    mocks.revokeShare.mockReset();
    mocks.revokeShare.mockResolvedValue({ success: true });
    mocks.listUsers.mockReset();
    mocks.listUsers.mockResolvedValue({ users: members });
    mocks.search = { conversationId: "chat-alpha" };
    mocks.chatStatus = "ready";
    mocks.chatMessages = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a Share button with the share count to the owner and opens the member dialog", async () => {
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      isOwner: true,
      canShare: true,
      shares: [shareFor("user-2")],
    });

    const user = userEvent.setup();
    renderBuilder();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Share · 1/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Share · 1/i }));
    expect(await screen.findByText(/Share "Daily account brief"/)).toBeInTheDocument();
    expect(mocks.listShares).toHaveBeenCalledWith("task-123");
    expect(mocks.listUsers).toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Share with Grantee Member" })).toBeInTheDocument();
  });

  it("hides the Share button and shows the shared-with-you hint for a grantee", async () => {
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      isOwner: false,
      canShare: false,
      canEdit: true,
      shares: [],
    });

    renderBuilder();

    expect(await screen.findByTestId("automation-shared-hint")).toBeInTheDocument();
    expect(screen.getByText("Shared with you · runs execute with the owner's integrations")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Share/i })).not.toBeInTheDocument();
  });

  it("shows neither the Share button nor the hint when sharing fields are absent", async () => {
    renderBuilder();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Share/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("automation-shared-hint")).not.toBeInTheDocument();
  });

  it("attributes runs to the member who triggered them", async () => {
    mocks.getAutomation.mockResolvedValue({
      ...automation,
      isOwner: true,
      canShare: true,
      shares: [shareFor("user-2")],
      latestRun: {
        id: "run-1",
        taskId: automation.id,
        triggerData: null,
        status: "completed",
        stepOutputs: {},
        errorMessage: null,
        startedAt: "2026-06-03T09:00:00.000Z",
        completedAt: "2026-06-03T09:00:01.000Z",
        triggeredByUserId: "user-2",
      },
      recentRuns: [
        {
          id: "run-1",
          taskId: automation.id,
          triggerData: null,
          status: "completed",
          stepOutputs: {},
          errorMessage: null,
          startedAt: "2026-06-03T09:00:00.000Z",
          completedAt: "2026-06-03T09:00:01.000Z",
          triggeredByUserId: "user-2",
        },
      ],
    });

    const user = userEvent.setup();
    renderBuilder();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Viewing/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Viewing/ }));
    expect(screen.getByRole("menuitem", { name: /by Grantee Member/ })).toBeInTheDocument();
  });
});
