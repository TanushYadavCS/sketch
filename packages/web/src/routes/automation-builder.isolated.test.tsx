import type { AutomationDefinition } from "@/lib/api";
import { api } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationBuilderPage } from "./automation-builder";

const mocks = vi.hoisted(() => ({
  getAutomation: vi.fn(),
  loadMessages: vi.fn(),
  navigate: vi.fn(),
  runTask: vi.fn(),
  testStep: vi.fn(),
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  search: { conversationId: "chat-alpha" } as Record<string, unknown>,
  chatMessages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Create an automation" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "All set." }] },
  ],
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      scheduledTasks: {
        get: mocks.getAutomation,
        run: mocks.runTask,
        testStep: mocks.testStep,
      },
      webChat: {
        messages: mocks.loadMessages,
        uploadAttachment: vi.fn(),
        transcribe: vi.fn(),
      },
    },
  };
});

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: mocks.chatMessages,
    status: "ready",
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
      nodesDraggable,
      nodesConnectable,
      edgesReconnectable,
      deleteKeyCode,
      onNodeClick,
      children,
    }: {
      nodes: Array<{ id: string; data: { step: { label: string } } }>;
      nodesDraggable?: boolean;
      nodesConnectable?: boolean;
      edgesReconnectable?: boolean;
      deleteKeyCode?: string | string[] | null;
      onNodeClick?: (event: unknown, node: { id: string; data: { step: { label: string } } }) => void;
      children?: ReactNode;
    }) => (
      <div
        data-testid="automation-flow"
        data-nodes-draggable={String(nodesDraggable)}
        data-nodes-connectable={String(nodesConnectable)}
        data-edges-reconnectable={String(edgesReconnectable)}
        data-delete-key-code={String(deleteKeyCode)}
      >
        {nodes.map((node) => (
          <button key={node.id} type="button" onClick={(event) => onNodeClick?.(event, node)}>
            {node.data.step.label}
          </button>
        ))}
        {children}
      </div>
    ),
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
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  revision: 1,
  title: "Daily account brief",
  description: "Summarizes account activity every morning.",
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
    mocks.getAutomation.mockResolvedValue(automation);
    mocks.loadMessages.mockResolvedValue({ messages: [], updatedAt: null });
    mocks.navigate.mockClear();
    mocks.runTask.mockResolvedValue({ status: "queued" });
    mocks.testStep.mockResolvedValue({ run: null });
    mocks.sendMessage.mockClear();
    mocks.setMessages.mockClear();
    mocks.search = { conversationId: "chat-alpha" };
  });

  it("opens the originating chat as a live left pane and sends the active automation id", async () => {
    const user = userEvent.setup();
    renderBuilder();

    const input = await screen.findByLabelText("Message Sketch");
    await waitFor(() => expect(input).not.toBeDisabled());

    await user.type(input, "Make it daily");
    await user.click(screen.getByLabelText("Send message"));

    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Make it daily" }), {
      body: { automationTaskId: "task-123" },
    });
  });

  it("keeps the graph and node detail fields read-only", async () => {
    const user = userEvent.setup();
    renderBuilder();

    const flow = await screen.findByTestId("automation-flow");
    expect(flow).toHaveAttribute("data-nodes-draggable", "false");
    expect(flow).toHaveAttribute("data-nodes-connectable", "false");
    expect(flow).toHaveAttribute("data-edges-reconnectable", "false");
    expect(flow).toHaveAttribute("data-delete-key-code", "null");

    await user.click(screen.getByRole("button", { name: "Check rating" }));

    expect(screen.getByDisplayValue("Check rating")).toHaveAttribute("readonly");
    expect(screen.getByDisplayValue("Slack")).toHaveAttribute("readonly");
    expect(screen.getByDisplayValue("Summarize accounts")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});
