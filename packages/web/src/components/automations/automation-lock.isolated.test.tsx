import {
  AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS,
  AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS,
  AUTOMATION_EDIT_LOCK_TTL_MS,
  lockRemainingLabel,
  lockSinceLabel,
} from "@/components/automations/lock-banner";
import type { AutomationDefinition, AutomationEditLockView } from "@/lib/api";
import { ApiRequestError } from "@/lib/api";
import { AutomationBuilderPage } from "@/routes/automation-builder";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAutomation: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  requestSteal: vi.fn(),
  respondToSteal: vi.fn(),
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
  listShares: vi.fn(),
  grantShare: vi.fn(),
  revokeShare: vi.fn(),
  listUsers: vi.fn(),
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  search: {} as Record<string, unknown>,
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
        acquireLock: mocks.acquireLock,
        releaseLock: mocks.releaseLock,
        requestSteal: mocks.requestSteal,
        respondToStealRequest: mocks.respondToSteal,
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

vi.mock("@/routes/dashboard", () => ({
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
    error: mocks.toastError,
    success: mocks.toastSuccess,
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
      nodesDraggable,
      onNodeClick,
      children,
    }: {
      nodes: Array<{ id: string; type?: string; data: { step: { label: string } } }>;
      nodeTypes?: Record<string, React.ComponentType<{ data: { step: { label: string } }; isConnectable?: boolean }>>;
      nodesDraggable?: boolean;
      onNodeClick?: (event: unknown, node: { id: string; data: { step: { label: string } } }) => void;
      children?: ReactNode;
    }) => (
      <div data-testid="automation-flow" data-nodes-draggable={String(nodesDraggable)}>
        {nodes.map((node) => (
          <div key={node.id}>
            {node.type && nodeTypes?.[node.type]
              ? React.createElement(nodeTypes[node.type], { data: node.data, isConnectable: false })
              : null}
            <button type="button" onClick={(event) => onNodeClick?.(event, node)}>
              {node.data.step.label}
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

function heldByMeLock(overrides: Partial<AutomationEditLockView> = {}): AutomationEditLockView {
  return {
    heldByUserId: "user-1",
    heldByName: "Owner Member",
    heldByPlatform: "web",
    heldBySurface: "builder",
    expiresAt: new Date(Date.now() + AUTOMATION_EDIT_LOCK_TTL_MS).toISOString(),
    isHeldByMe: true,
    stealPending: null,
    ...overrides,
  };
}

function heldByOtherLock(overrides: Partial<AutomationEditLockView> = {}): AutomationEditLockView {
  return {
    heldByUserId: "user-2",
    heldByName: "Bob Jones",
    heldByPlatform: "web",
    heldBySurface: "builder",
    expiresAt: new Date(Date.now() + AUTOMATION_EDIT_LOCK_TTL_MS).toISOString(),
    isHeldByMe: false,
    stealPending: null,
    ...overrides,
  };
}

function lockedError(lock: AutomationEditLockView): ApiRequestError {
  return new ApiRequestError("This automation is being edited by another user.", 409, "LOCKED", { lock });
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

describe("AutomationBuilderPage edit lock", () => {
  beforeEach(() => {
    mocks.getAutomation.mockReset();
    mocks.getAutomation.mockResolvedValue(automation);
    mocks.acquireLock.mockReset();
    mocks.releaseLock.mockReset();
    mocks.releaseLock.mockResolvedValue({ success: true });
    mocks.requestSteal.mockReset();
    mocks.respondToSteal.mockReset();
    mocks.respondToSteal.mockResolvedValue({ success: true });
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
    mocks.listShares.mockResolvedValue({ shares: [] });
    mocks.grantShare.mockResolvedValue({ success: true });
    mocks.revokeShare.mockResolvedValue({ success: true });
    mocks.listUsers.mockResolvedValue({ users: [] });
    mocks.sendMessage.mockClear();
    mocks.setMessages.mockClear();
    mocks.toastError.mockClear();
    mocks.toastSuccess.mockClear();
    mocks.search = {};
    mocks.chatStatus = "ready";
    mocks.chatMessages = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("acquires the whole-automation lock on open and shows the holder banner with a live lease", async () => {
    mocks.acquireLock.mockImplementation(async () => ({ lock: heldByMeLock() }));

    renderBuilder();

    const banner = await screen.findByTestId("automation-lock-banner");
    expect(banner).toHaveAttribute("data-lock-state", "held-by-me");
    expect(screen.getByText("You're editing")).toBeInTheDocument();
    expect(screen.getByTestId("automation-lock-lease").textContent).toMatch(/^\d{2}:\d{2} left$/);
    await waitFor(() => expect(mocks.acquireLock).toHaveBeenCalledWith("task-123"));
  });

  it("keeps the canvas read-only while another member holds the lock", async () => {
    const otherLock = heldByOtherLock();
    mocks.getAutomation.mockImplementation(async () => ({ ...automation, lock: otherLock }));
    mocks.acquireLock.mockRejectedValue(lockedError(otherLock));
    const user = userEvent.setup();

    renderBuilder();

    const banner = await screen.findByTestId("automation-lock-banner");
    expect(banner).toHaveAttribute("data-lock-state", "held-by-other");
    expect(screen.getByText(/Editing by Bob Jones/)).toBeInTheDocument();
    expect(screen.getByTestId("automation-lock-since")).toHaveTextContent(/since/);
    expect(screen.getByRole("button", { name: /Take over editing/ })).toBeInTheDocument();

    expect(screen.getByTestId("automation-flow")).toHaveAttribute("data-nodes-draggable", "false");
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Check rating" }));
    const drawer = await screen.findByTestId("automation-builder-drawer");
    const drawerTextboxes = within(drawer).getAllByRole("textbox");
    expect(drawerTextboxes.length).toBeGreaterThan(0);
    for (const textbox of drawerTextboxes) {
      expect(textbox).toHaveAttribute("readonly");
    }
    expect(within(drawer).getByRole("button", { name: "Save prompt" })).toBeDisabled();
  });

  it("requests a takeover, waits for approval, then starts heartbeat renewals", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const user = userEvent.setup();
    let currentLock: AutomationEditLockView = heldByOtherLock();
    let viewerHolds = false;
    mocks.getAutomation.mockImplementation(async () => ({ ...automation, lock: currentLock }));
    mocks.acquireLock.mockImplementation(async () => {
      if (!viewerHolds) throw lockedError(currentLock);
      return { lock: heldByMeLock() };
    });
    mocks.requestSteal.mockImplementation(async () => {
      currentLock = heldByOtherLock({
        stealPending: {
          requesterName: "Owner Member",
          expiresAt: new Date(Date.now() + AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS).toISOString(),
        },
      });
      return { status: "pending" };
    });

    renderBuilder();

    const banner = await screen.findByTestId("automation-lock-banner");
    expect(banner).toHaveAttribute("data-lock-state", "held-by-other");

    await user.click(screen.getByRole("button", { name: /Take over editing/ }));
    expect(await screen.findByTestId("automation-lock-steal-dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Request takeover" }));
    await waitFor(() => expect(mocks.requestSteal).toHaveBeenCalledWith("task-123"));
    expect(screen.getByText(/Waiting for Bob Jones to approve/)).toBeInTheDocument();

    // The holder approves: the next polled lock view flips to held by the viewer.
    viewerHolds = true;
    currentLock = heldByMeLock();
    await act(async () => {
      vi.advanceTimersByTime(AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("You're now editing"));
    expect(screen.queryByTestId("automation-lock-steal-dialog")).not.toBeInTheDocument();
    expect(banner).toHaveAttribute("data-lock-state", "held-by-me");

    // The 2-minute heartbeat renews the lease while the viewer holds the lock.
    const callsBeforeHeartbeat = mocks.acquireLock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });
    await waitFor(() => expect(mocks.acquireLock.mock.calls.length).toBeGreaterThan(callsBeforeHeartbeat));
  });

  it("shows an error state when the holder denies the takeover", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const user = userEvent.setup();
    let currentLock: AutomationEditLockView = heldByOtherLock();
    mocks.getAutomation.mockImplementation(async () => ({ ...automation, lock: currentLock }));
    mocks.acquireLock.mockRejectedValue(lockedError(currentLock));
    mocks.requestSteal.mockImplementation(async () => {
      currentLock = heldByOtherLock({
        stealPending: {
          requesterName: "Owner Member",
          expiresAt: new Date(Date.now() + AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS).toISOString(),
        },
      });
      return { status: "pending" };
    });

    renderBuilder();

    await screen.findByTestId("automation-lock-banner");
    await user.click(screen.getByRole("button", { name: /Take over editing/ }));
    await user.click(await screen.findByRole("button", { name: "Request takeover" }));
    expect(screen.getByText(/Waiting for Bob Jones to approve/)).toBeInTheDocument();

    // First poll surfaces the pending request (the countdown only renders once
    // the lock view carries it); the next poll shows the request was denied.
    await act(async () => {
      vi.advanceTimersByTime(AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(screen.getByTestId("automation-lock-steal-countdown")).toBeInTheDocument());

    currentLock = heldByOtherLock();
    await act(async () => {
      vi.advanceTimersByTime(AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Your takeover request was not approved"));
    expect(screen.getByTestId("automation-lock-steal-outcome")).toHaveTextContent("The holder denied the takeover.");
  });

  it("shows the timeout state when the holder never responds", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));
    const user = userEvent.setup();
    let currentLock: AutomationEditLockView = heldByOtherLock();
    mocks.getAutomation.mockImplementation(async () => ({ ...automation, lock: currentLock }));
    mocks.acquireLock.mockRejectedValue(lockedError(currentLock));
    mocks.requestSteal.mockImplementation(async () => {
      currentLock = heldByOtherLock({
        stealPending: {
          requesterName: "Owner Member",
          expiresAt: new Date(Date.now() + AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS).toISOString(),
        },
      });
      return { status: "pending" };
    });

    renderBuilder();

    await screen.findByTestId("automation-lock-banner");
    await user.click(screen.getByRole("button", { name: /Take over editing/ }));
    await user.click(await screen.findByRole("button", { name: "Request takeover" }));
    await waitFor(() => expect(screen.getByTestId("automation-lock-steal-countdown")).toBeInTheDocument());

    await act(async () => {
      vi.advanceTimersByTime(AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS + 1000);
    });
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Your takeover request expired"));
    expect(screen.getByTestId("automation-lock-steal-outcome")).toHaveTextContent("The takeover request expired.");

    // The footer Close button is the second "Close" (the content's top-right X renders first).
    const dialogCloseButtons = within(screen.getByTestId("automation-lock-steal-dialog")).getAllByRole("button", {
      name: "Close",
    });
    await user.click(dialogCloseButtons.at(-1) as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByTestId("automation-lock-steal-dialog")).not.toBeInTheDocument());
  });

  it("lets the holder approve or deny a pending takeover request", async () => {
    const pendingLock = heldByMeLock({
      stealPending: {
        requesterName: "Carol Davis",
        expiresAt: new Date(Date.now() + AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS).toISOString(),
      },
    });
    mocks.getAutomation.mockImplementation(async () => ({ ...automation, lock: pendingLock }));
    mocks.acquireLock.mockImplementation(async () => ({ lock: pendingLock }));
    const user = userEvent.setup();

    renderBuilder();

    const banner = await screen.findByTestId("automation-lock-banner");
    expect(banner).toHaveAttribute("data-lock-state", "held-by-me");
    expect(screen.getByText(/Carol Davis wants to take over editing/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Review request/ }));
    expect(await screen.findByTestId("automation-lock-holder-response-dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve takeover" }));
    await waitFor(() => expect(mocks.respondToSteal).toHaveBeenCalledWith("task-123", true));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Editing handed over to Carol Davis");
    expect(screen.queryByTestId("automation-lock-holder-response-dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Review request/ }));
    await user.click(screen.getByRole("button", { name: "Deny takeover" }));
    await waitFor(() => expect(mocks.respondToSteal).toHaveBeenCalledWith("task-123", false));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Takeover request denied");
  });

  it("pauses the heartbeat while the tab is not focused", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mocks.getAutomation.mockImplementation(async () => ({ ...automation, lock: heldByMeLock() }));
    mocks.acquireLock.mockImplementation(async () => ({ lock: heldByMeLock() }));

    renderBuilder();

    await screen.findByTestId("automation-lock-banner");
    expect(mocks.acquireLock).toHaveBeenCalledTimes(1);

    hasFocusSpy.mockReturnValue(false);
    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });
    expect(mocks.acquireLock).toHaveBeenCalledTimes(1);

    hasFocusSpy.mockReturnValue(true);
    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });
    expect(mocks.acquireLock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not acquire the lock for a viewer without edit access", async () => {
    mocks.getAutomation.mockImplementation(async () => ({
      ...automation,
      canEdit: false,
      lock: heldByOtherLock(),
    }));

    renderBuilder();

    const banner = await screen.findByTestId("automation-lock-banner");
    expect(banner).toHaveAttribute("data-lock-state", "held-by-other");
    expect(mocks.acquireLock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Take over editing/ })).not.toBeInTheDocument();
  });
});

describe("edit lock label helpers", () => {
  it("derives the editing-since label from the lease expiry minus the TTL", () => {
    const localAcquired = new Date(2026, 5, 1, 14, 30, 0);
    const expiresAt = new Date(localAcquired.getTime() + AUTOMATION_EDIT_LOCK_TTL_MS).toISOString();
    expect(lockSinceLabel(expiresAt)).toBe(
      new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(localAcquired),
    );
    expect(lockSinceLabel(null)).toBeNull();
    expect(lockSinceLabel("not-a-date")).toBeNull();
  });

  it("formats the remaining lease as mm:ss and floors at zero", () => {
    const deadline = new Date("2026-06-01T09:14:59.000Z").getTime();
    expect(lockRemainingLabel(new Date(deadline).toISOString(), new Date("2026-06-01T09:00:00.000Z").getTime())).toBe(
      "14:59",
    );
    expect(lockRemainingLabel(new Date(deadline).toISOString(), new Date("2026-06-01T09:15:30.000Z").getTime())).toBe(
      "00:00",
    );
    expect(lockRemainingLabel(null)).toBeNull();
  });
});
