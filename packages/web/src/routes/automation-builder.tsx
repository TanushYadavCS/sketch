import { ChatThread, type ChatThreadMessage } from "@/components/sketch/chat-thread";
import {
  type AutomationBuilderSaveRequest,
  type AutomationDefinition,
  type AutomationStepContent,
  type StepOutput,
  type WebChatStoredMessage,
  type WorkflowEdge,
  type WorkflowStep,
  api,
} from "@/lib/api";
import { ApiRequestError } from "@/lib/api";
import {
  BracketsCurlyIcon,
  CalendarDotsIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleIcon,
  CodeIcon,
  EnvelopeSimpleIcon,
  EyeIcon,
  GitBranchIcon,
  GlobeHemisphereWestIcon,
  GoogleLogoIcon,
  type IconProps,
  LightningIcon,
  PlayIcon,
  RobotIcon,
  SlackLogoIcon,
  SpinnerGapIcon,
  TableIcon,
  WebhooksLogoIcon,
  WhatsappLogoIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Input } from "@sketch/ui/components/input";
import { Textarea } from "@sketch/ui/components/textarea";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  type CSSProperties,
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";

interface BuilderSearch {
  conversationId?: string;
}

interface DraftAutomation {
  title: string | null;
  description: string | null;
  prompt: string;
  scheduleType: AutomationDefinition["scheduleType"];
  scheduleValue: string;
  timezone: string;
  status: AutomationDefinition["status"];
  delivery: AutomationDefinition["delivery"];
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  stepContent: Record<string, AutomationStepContent>;
  revision: number;
}

type DraftUpdater = (update: (draft: DraftAutomation) => DraftAutomation) => void;
type UiStatus = "idle" | "running" | "success" | "failed" | "skipped";

const canvasToolbarButtonClass =
  "h-8 rounded-[7px] border-white/10 bg-[#101010]/90 text-white/82 shadow-none backdrop-blur hover:bg-[#1b1b1b] hover:text-white";
const builderInputClass =
  "h-10 rounded-[8px] border-white/10 bg-[#101010] text-[13px] text-white shadow-none placeholder:text-white/35 focus-visible:border-brand-accent/55 focus-visible:ring-brand-accent/20";
const builderTextareaClass =
  "rounded-[8px] border-white/10 bg-[#1d1d1b] text-[13px] leading-5 text-white shadow-none placeholder:text-white/35 focus-visible:border-brand-accent/55 focus-visible:ring-brand-accent/20";
const flowEdgeStyle = {
  stroke: "rgba(255, 255, 255, 0.22)",
  strokeWidth: 1.6,
} satisfies CSSProperties;

export const automationBuilderRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/scheduled-tasks/$taskId/edit",
  validateSearch: (search: Record<string, unknown>): BuilderSearch => {
    const conversationId = typeof search.conversationId === "string" ? search.conversationId.trim() : "";
    return conversationId ? { conversationId } : {};
  },
  component: AutomationBuilderPage,
});

function draftFromDefinition(automation: AutomationDefinition): DraftAutomation {
  return {
    title: automation.title,
    description: automation.description,
    prompt: automation.prompt,
    scheduleType: automation.scheduleType,
    scheduleValue: automation.scheduleValue,
    timezone: automation.timezone,
    status: automation.status,
    delivery: automation.delivery,
    steps: automation.steps,
    edges: automation.edges,
    stepContent: automation.stepContent,
    revision: automation.revision,
  };
}

function serializeDraft(draft: DraftAutomation): string {
  return JSON.stringify({
    title: draft.title,
    description: draft.description,
    prompt: draft.prompt,
    scheduleType: draft.scheduleType,
    scheduleValue: draft.scheduleValue,
    timezone: draft.timezone,
    status: draft.status,
    delivery: draft.delivery,
    steps: draft.steps,
    edges: draft.edges,
    stepContent: draft.stepContent,
  });
}

function saveRequestFromDraft(draft: DraftAutomation): AutomationBuilderSaveRequest {
  return {
    expectedRevision: draft.revision,
    title: draft.title?.trim() || draft.prompt,
    description: draft.description,
    prompt: draft.prompt,
    scheduleType: draft.scheduleType,
    scheduleValue: draft.scheduleValue,
    timezone: draft.timezone,
    status: draft.status,
    delivery: draft.delivery,
    steps: draft.steps,
    edges: draft.edges,
    stepContent: draft.stepContent,
  };
}

function AutomationBuilderPage() {
  const { taskId } = useParams({ from: automationBuilderRoute.id });
  const search = useSearch({ from: automationBuilderRoute.id }) as BuilderSearch;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = ["scheduled-tasks", taskId, "builder"];
  const [draft, setDraft] = useState<DraftAutomation | null>(null);
  const [baseline, setBaseline] = useState("");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const automationQuery = useQuery({
    queryKey,
    queryFn: () => api.scheduledTasks.get(taskId),
    refetchInterval: (query) => (query.state.data?.recentRuns.some((run) => run.status === "running") ? 1500 : false),
  });

  useEffect(() => {
    if (!automationQuery.data) return;
    setDraft((current) => current ?? draftFromDefinition(automationQuery.data));
    setBaseline((current) => current || serializeDraft(draftFromDefinition(automationQuery.data)));
  }, [automationQuery.data]);

  useEffect(() => {
    if (!draft) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (serializeDraft(draft) === baseline) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [baseline, draft]);

  const updateDraft: DraftUpdater = useCallback((update) => {
    setDraft((current) => (current ? update(current) : current));
  }, []);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Automation is not loaded");
      return api.scheduledTasks.save(taskId, saveRequestFromDraft(draft));
    },
    onSuccess: (automation) => {
      const next = draftFromDefinition(automation);
      setDraft(next);
      setBaseline(serializeDraft(next));
      setConflict(false);
      queryClient.setQueryData(queryKey, automation);
      toast.success("Automation saved");
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 409) {
        setConflict(true);
        return;
      }
      toast.error(error instanceof Error ? error.message : "Failed to save automation");
    },
  });

  const runMutation = useMutation({
    mutationFn: () => api.scheduledTasks.run(taskId),
    onSuccess: async () => {
      toast.success("Automation run started");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to run automation"),
  });

  const testMutation = useMutation({
    mutationFn: (stepId: string) => api.scheduledTasks.testStep(taskId, stepId, { useLatestUpstreamOutput: true }),
    onSuccess: async () => {
      toast.success("Node test finished");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Node test failed"),
  });

  if (automationQuery.isLoading || !draft || !automationQuery.data) {
    return (
      <div className="flex min-h-[calc(100vh-52px)] items-center justify-center text-sm text-muted-foreground">
        Loading builder...
      </div>
    );
  }

  if (automationQuery.isError) {
    return <div className="p-10 text-sm text-destructive">Failed to load automation.</div>;
  }

  const automation = automationQuery.data;
  const dirty = serializeDraft(draft) !== baseline;
  const selectedRun = selectedRunId
    ? automation.recentRuns.find((run) => run.id === selectedRunId)
    : automation.latestRun;
  const selectedStep = draft.steps.find((step) => step.id === selectedStepId) ?? null;
  const selectedOutput = selectedStep ? selectedRun?.stepOutputs[selectedStep.id] : undefined;
  const builderTitle = draft.title?.trim() || draft.prompt;
  const hasSidecar = Boolean(search.conversationId);
  const scheduleSummary = `${draft.scheduleType === "external" ? "trigger" : draft.scheduleType} · ${draft.scheduleValue}`;

  return (
    <div className="relative flex h-[calc(100vh-52px)] min-h-0 overflow-hidden bg-background">
      {hasSidecar && search.conversationId ? (
        <BuilderChatSidecar conversationId={search.conversationId} title={builderTitle} className="hidden 2xl:flex" />
      ) : null}

      <div className="relative min-h-0 min-w-0 flex-1 bg-[#050505] text-white">
        <div className="pointer-events-none absolute top-4 left-4 right-4 z-10 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div
            className={cn(
              "pointer-events-auto flex min-w-0 flex-wrap items-center gap-2 rounded-[8px] border border-white/10 bg-[#0b0b0b]/88 p-1.5 shadow-[0_10px_34px_rgba(0,0,0,0.34)] backdrop-blur",
              !hasSidecar && "max-w-[min(560px,calc(100vw-2rem))]",
            )}
          >
            {!hasSidecar ? (
              <div className="min-w-[160px] flex-1 px-1.5">
                <p className="truncate text-[13px] font-semibold leading-5 text-white">{builderTitle}</p>
                <p className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-white/42">
                  {scheduleSummary}
                </p>
              </div>
            ) : null}
            <RunsMenu
              runs={automation.recentRuns}
              activeRunId={selectedRun?.id ?? null}
              onSelectRun={(runId) => setSelectedRunId(runId)}
            />
            {selectedRunId ? (
              <Button
                size="sm"
                variant="outline"
                className={canvasToolbarButtonClass}
                onClick={() => setSelectedRunId(null)}
              >
                Latest
              </Button>
            ) : null}
          </div>

          <div className="pointer-events-auto ml-auto flex flex-wrap justify-end gap-2">
            {dirty ? (
              <Badge className="h-6 rounded-full bg-brand-accent px-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#161300]">
                Unsaved
              </Badge>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className={canvasToolbarButtonClass}
              onClick={() => navigate({ to: "/scheduled-tasks" })}
            >
              Close
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-[7px] bg-white text-[#0b0b0b] shadow-none hover:bg-white/88"
              onClick={() => saveMutation.mutate()}
              disabled={!dirty || saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <SpinnerGapIcon size={14} className="animate-spin" />
              ) : (
                <CheckCircleIcon size={14} />
              )}
              Save
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-[7px] bg-brand-accent text-[#161300] shadow-none hover:bg-brand-accent/90"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
            >
              {runMutation.isPending ? (
                <SpinnerGapIcon size={14} className="animate-spin" />
              ) : (
                <PlayIcon size={14} weight="fill" />
              )}
              Run
            </Button>
          </div>
        </div>

        {conflict ? (
          <div className="absolute top-32 right-4 z-20 max-w-sm rounded-[8px] border border-red-400/24 bg-[#101010] px-4 py-3 text-sm text-white shadow-[0_18px_48px_rgba(0,0,0,0.42)] sm:top-16">
            <p className="font-medium text-red-300">Revision conflict</p>
            <p className="mt-1 text-white/58">This automation changed elsewhere. Reload or discard your draft.</p>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                className="rounded-[7px] bg-white text-[#0b0b0b] shadow-none"
                onClick={() => window.location.reload()}
              >
                Reload
              </Button>
              <Button
                size="sm"
                variant="outline"
                className={canvasToolbarButtonClass}
                onClick={() => {
                  const next = draftFromDefinition(automation);
                  setDraft(next);
                  setBaseline(serializeDraft(next));
                  setConflict(false);
                }}
              >
                Discard
              </Button>
            </div>
          </div>
        ) : null}

        <AutomationCanvas
          draft={draft}
          selectedStepId={selectedStepId}
          stepOutputs={selectedRun?.stepOutputs ?? {}}
          runStatus={selectedRun?.status}
          onSelectStep={setSelectedStepId}
          updateDraft={updateDraft}
        />
      </div>

      <NodeDrawer
        key={selectedStep?.id ?? "closed"}
        draft={draft}
        step={selectedStep}
        output={selectedOutput}
        updateDraft={updateDraft}
        onClose={() => setSelectedStepId(null)}
        onTest={(stepId) => testMutation.mutate(stepId)}
        testingStepId={testMutation.variables ?? null}
      />
    </div>
  );
}

function textFromStoredMessage(message: WebChatStoredMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function chatThreadMessages(messages: WebChatStoredMessage[]): ChatThreadMessage[] {
  return messages.flatMap((message) => {
    const text = textFromStoredMessage(message);
    if (!text) return [];
    return [{ id: message.id, role: message.role, text, createdAt: message.createdAt }];
  });
}

function BuilderChatSidecar({
  conversationId,
  title,
  className,
}: {
  conversationId: string;
  title: string;
  className?: string;
}) {
  const query = useQuery({
    queryKey: ["web-chat", conversationId, "builder-sidecar"],
    queryFn: () => api.webChat.messages(conversationId),
  });

  return (
    <aside
      className={cn(
        "w-[400px] min-w-[320px] max-w-[600px] resize-x flex-col overflow-hidden border-r border-white/10 bg-[#050505] text-white",
        className,
      )}
    >
      <div className="border-b border-white/10 px-4 py-3">
        <p className="truncate text-[13px] font-semibold">{title}</p>
      </div>
      <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <ChatThread
          messages={query.data ? chatThreadMessages(query.data.messages) : []}
          conversationId={conversationId}
        />
      </div>
    </aside>
  );
}

function flowPosition(step: WorkflowStep, index: number) {
  const position = step.position;
  if (Math.abs(position.x) <= 10 && Math.abs(position.y) <= 10) {
    return { x: index * 230, y: 0 };
  }
  return position;
}

function outputStatus(
  output: StepOutput | undefined,
  runStatus: "running" | "completed" | "failed" | undefined,
): UiStatus {
  if (!output) return runStatus === "running" ? "running" : "idle";
  if (output.status === "completed") return "success";
  if (output.status === "failed") return "failed";
  return "skipped";
}

type BuilderNodeData = {
  step: WorkflowStep;
  selected: boolean;
  status: UiStatus;
  visual: StepVisual;
};
type BuilderNode = Node<BuilderNodeData>;

type StepVisualKind =
  | "schedule-trigger"
  | "webhook-trigger"
  | "canvas-trigger"
  | "agent"
  | "gmail-action"
  | "sheets-action"
  | "slack-action"
  | "whatsapp-action"
  | "google-action"
  | "web-action"
  | "code-action";

interface StepVisual {
  kind: StepVisualKind;
  icon: ComponentType<IconProps>;
  shape: "notched" | "rounded" | "circle";
  toneClass: string;
  glyphClass: string;
}

const stepVisuals: Record<StepVisualKind, StepVisual> = {
  "schedule-trigger": {
    kind: "schedule-trigger",
    icon: CalendarDotsIcon,
    shape: "notched",
    toneClass: "border-white/[0.15] bg-[#171717]",
    glyphClass: "text-white/70",
  },
  "webhook-trigger": {
    kind: "webhook-trigger",
    icon: WebhooksLogoIcon,
    shape: "notched",
    toneClass: "border-cyan-200/20 bg-[#161818]",
    glyphClass: "text-cyan-100/75",
  },
  "canvas-trigger": {
    kind: "canvas-trigger",
    icon: GitBranchIcon,
    shape: "notched",
    toneClass: "border-violet-200/20 bg-[#18161a]",
    glyphClass: "text-violet-100/75",
  },
  agent: {
    kind: "agent",
    icon: RobotIcon,
    shape: "rounded",
    toneClass: "border-white/[0.15] bg-[#171717]",
    glyphClass: "text-white/72",
  },
  "gmail-action": {
    kind: "gmail-action",
    icon: EnvelopeSimpleIcon,
    shape: "circle",
    toneClass: "border-red-200/20 bg-[#181515]",
    glyphClass: "text-red-100/75",
  },
  "sheets-action": {
    kind: "sheets-action",
    icon: TableIcon,
    shape: "circle",
    toneClass: "border-emerald-200/20 bg-[#141815]",
    glyphClass: "text-emerald-100/75",
  },
  "slack-action": {
    kind: "slack-action",
    icon: SlackLogoIcon,
    shape: "circle",
    toneClass: "border-fuchsia-200/20 bg-[#181618]",
    glyphClass: "text-fuchsia-100/75",
  },
  "whatsapp-action": {
    kind: "whatsapp-action",
    icon: WhatsappLogoIcon,
    shape: "circle",
    toneClass: "border-green-200/20 bg-[#141815]",
    glyphClass: "text-green-100/75",
  },
  "google-action": {
    kind: "google-action",
    icon: GoogleLogoIcon,
    shape: "circle",
    toneClass: "border-blue-200/20 bg-[#15171a]",
    glyphClass: "text-blue-100/75",
  },
  "web-action": {
    kind: "web-action",
    icon: GlobeHemisphereWestIcon,
    shape: "circle",
    toneClass: "border-sky-200/20 bg-[#141719]",
    glyphClass: "text-sky-100/75",
  },
  "code-action": {
    kind: "code-action",
    icon: CodeIcon,
    shape: "circle",
    toneClass: "border-white/[0.14] bg-[#151515]",
    glyphClass: "text-white/72",
  },
};

function stepSignalText(step: WorkflowStep, content: AutomationStepContent | undefined): string {
  return [
    step.type,
    step.id,
    step.label,
    step.icon,
    step.triggerConfig?.type,
    step.triggerConfig?.componentKey,
    step.triggerConfig?.app,
    ...(content?.apps ?? []),
    content?.content.slice(0, 1400),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function resolveStepVisual(step: WorkflowStep, content: AutomationStepContent | undefined): StepVisual {
  if (step.type === "trigger") {
    if (step.triggerConfig?.type === "webhook") return stepVisuals["webhook-trigger"];
    if (step.triggerConfig?.type === "canvas") return stepVisuals["canvas-trigger"];
    return stepVisuals["schedule-trigger"];
  }

  if (step.type === "agent") return stepVisuals.agent;

  const signal = stepSignalText(step, content);
  if (/\b(google-sheets|sheets|spreadsheet|sheet)\b/.test(signal)) return stepVisuals["sheets-action"];
  if (/\b(gmail|email|mail)\b/.test(signal)) return stepVisuals["gmail-action"];
  if (/\b(slack)\b/.test(signal)) return stepVisuals["slack-action"];
  if (/\b(whatsapp|wa-)\b/.test(signal)) return stepVisuals["whatsapp-action"];
  if (/\b(google|drive|docs|calendar)\b/.test(signal)) return stepVisuals["google-action"];
  if (/\b(http|web|url|api)\b/.test(signal)) return stepVisuals["web-action"];
  return stepVisuals["code-action"];
}

function AutomationCanvas({
  draft,
  selectedStepId,
  stepOutputs,
  runStatus,
  onSelectStep,
  updateDraft,
}: {
  draft: DraftAutomation;
  selectedStepId: string | null;
  stepOutputs: Record<string, StepOutput>;
  runStatus?: "running" | "completed" | "failed";
  onSelectStep: (stepId: string | null) => void;
  updateDraft: DraftUpdater;
}) {
  return (
    <ReactFlowProvider>
      <AutomationCanvasFlow
        draft={draft}
        selectedStepId={selectedStepId}
        stepOutputs={stepOutputs}
        runStatus={runStatus}
        onSelectStep={onSelectStep}
        updateDraft={updateDraft}
      />
    </ReactFlowProvider>
  );
}

function AutomationCanvasFlow({
  draft,
  selectedStepId,
  stepOutputs,
  runStatus,
  onSelectStep,
  updateDraft,
}: {
  draft: DraftAutomation;
  selectedStepId: string | null;
  stepOutputs: Record<string, StepOutput>;
  runStatus?: "running" | "completed" | "failed";
  onSelectStep: (stepId: string | null) => void;
  updateDraft: DraftUpdater;
}) {
  const { fitView } = useReactFlow<BuilderNode>();
  const initialNodes = useMemo<BuilderNode[]>(
    () =>
      draft.steps.map((step, index) => ({
        id: step.id,
        type: step.type,
        position: flowPosition(step, index),
        data: {
          step,
          selected: step.id === selectedStepId,
          status: outputStatus(stepOutputs[step.id], runStatus),
          visual: resolveStepVisual(step, draft.stepContent[step.id]),
        },
      })),
    [draft.stepContent, draft.steps, runStatus, selectedStepId, stepOutputs],
  );
  const initialEdges = useMemo<Edge[]>(
    () =>
      draft.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
        animated: runStatus === "running",
        className: "automation-builder-edge",
        interactionWidth: 22,
        style: flowEdgeStyle,
      })),
    [draft.edges, runStatus],
  );
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<BuilderNode>(initialNodes);
  const [edges, setEdges] = useEdgesState(initialEdges);

  useEffect(() => setNodes(initialNodes), [initialNodes, setNodes]);
  useEffect(() => setEdges(initialEdges), [initialEdges, setEdges]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: selectedStepId ? 0.46 : 0.35, maxZoom: 1.05, duration: 180 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, selectedStepId]);

  const onNodesChange = useCallback(
    (changes: NodeChange<BuilderNode>[]) => {
      onNodesChangeBase(changes);
    },
    [onNodesChangeBase],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((current) => applyEdgeChanges(changes, current));
      const removed = changes.filter((change) => change.type === "remove").map((change) => change.id);
      if (removed.length > 0) {
        updateDraft((current) => ({
          ...current,
          edges: current.edges.filter((edge) => !removed.includes(edge.id)),
        }));
      }
    },
    [setEdges, updateDraft],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      const id = `${connection.source}-${connection.target}`;
      updateDraft((current) => {
        if (current.edges.some((edge) => edge.from === connection.source && edge.to === connection.target))
          return current;
        return {
          ...current,
          edges: [...current.edges, { id, from: connection.source as string, to: connection.target as string }],
        };
      });
      setEdges((current) =>
        addEdge(
          { ...connection, id, type: "smoothstep", className: "automation-builder-edge", style: flowEdgeStyle },
          current,
        ),
      );
    },
    [setEdges, updateDraft],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={(_, node) => onSelectStep(node.id)}
      onPaneClick={() => onSelectStep(null)}
      onNodeDragStop={(_, node) => {
        updateDraft((current) => ({
          ...current,
          steps: current.steps.map((step) => (step.id === node.id ? { ...step, position: node.position } : step)),
        }));
      }}
      fitView
      fitViewOptions={{ padding: 0.35, maxZoom: 1.05 }}
      minZoom={0.35}
      maxZoom={1.6}
      snapToGrid
      snapGrid={[18, 18]}
      connectionLineStyle={flowEdgeStyle}
      connectionRadius={28}
      proOptions={{ hideAttribution: true }}
      className="automation-builder-flow"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color="rgba(255,255,255,0.12)" />
      <Controls showInteractive={false} position="bottom-left" className="automation-builder-controls" />
    </ReactFlow>
  );
}

const statusClasses: Record<UiStatus, string> = {
  idle: "bg-white/42",
  running: "animate-pulse bg-brand-accent shadow-[0_0_14px_rgba(254,237,1,0.55)]",
  success: "bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.42)]",
  failed: "bg-red-400 shadow-[0_0_14px_rgba(248,113,113,0.42)]",
  skipped: "bg-white/24",
};

const nodeAccentClasses: Record<UiStatus, string> = {
  idle: "from-white/[0.08] to-transparent",
  running: "from-brand-accent/[0.18] to-transparent",
  success: "from-emerald-400/[0.16] to-transparent",
  failed: "from-red-400/[0.16] to-transparent",
  skipped: "from-white/[0.05] to-transparent",
};

function StepShape({ visual, selected, status }: { visual: StepVisual; selected: boolean; status: UiStatus }) {
  const Icon = visual.icon;
  const triggerShape =
    visual.shape === "notched"
      ? ({ clipPath: "polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%)" } as CSSProperties)
      : undefined;
  return (
    <div className="relative size-[46px]">
      <div
        className={cn(
          "automation-node-shell relative flex size-full items-center justify-center overflow-hidden border text-white/70 shadow-[0_10px_22px_rgba(0,0,0,0.34)] transition-[border-color,background-color,box-shadow,transform]",
          "before:absolute before:inset-0 before:bg-linear-to-br before:from-white/[0.045] before:to-transparent before:content-['']",
          visual.toneClass,
          nodeAccentClasses[status],
          visual.shape === "notched" ? "rounded-[9px]" : visual.shape === "circle" ? "rounded-full" : "rounded-[11px]",
          selected
            ? "border-white/46 bg-[#1c1c1c] text-white shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_14px_30px_rgba(0,0,0,0.46)]"
            : "hover:border-white/24 hover:bg-[#1b1b1b] hover:text-white/86",
        )}
        style={triggerShape}
      >
        <Icon
          size={visual.kind === "agent" ? 18 : 17}
          weight={visual.shape === "notched" || visual.kind === "agent" ? "fill" : "regular"}
          className={cn("relative z-10", visual.glyphClass)}
        />
      </div>
      <span
        className={cn(
          "absolute -top-[4px] left-1/2 z-20 size-[6px] -translate-x-1/2 rounded-full ring-[2px] ring-[#050505]",
          statusClasses[status],
        )}
      />
    </div>
  );
}

function BuilderStepNode({ data, isConnectable }: NodeProps<BuilderNode>) {
  return (
    <div className="group/node flex w-[150px] select-none flex-col items-center gap-2">
      <div className="relative">
        {data.step.type !== "trigger" ? (
          <Handle
            type="target"
            position={Position.Left}
            isConnectable={isConnectable}
            className="automation-builder-handle !left-[-4px]"
          />
        ) : null}
        <StepShape visual={data.visual} selected={data.selected} status={data.status} />
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={isConnectable}
          className="automation-builder-handle !right-[-4px]"
        />
      </div>
      <span className="line-clamp-1 max-w-[150px] text-center text-[11px] font-semibold leading-4 text-white/74 transition-colors group-hover/node:text-white/88">
        {data.step.label}
      </span>
    </div>
  );
}

const nodeTypes = {
  trigger: BuilderStepNode,
  agent: BuilderStepNode,
  action: BuilderStepNode,
};

function RunsMenu({
  runs,
  activeRunId,
  onSelectRun,
}: {
  runs: AutomationDefinition["recentRuns"];
  activeRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const active = activeRunId ? runs.find((run) => run.id === activeRunId) : runs[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className={cn(canvasToolbarButtonClass, "gap-1.5 text-white/68")}>
          {activeRunId ? <EyeIcon size={14} weight="fill" /> : <CaretDownIcon size={13} />}
          {activeRunId && active ? `Viewing · ${formatRunDate(active.startedAt)}` : `Runs · ${runs.length}`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[310px]">
        <DropdownMenuLabel className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          Run history
        </DropdownMenuLabel>
        {runs.length === 0 ? (
          <DropdownMenuItem disabled>No runs yet</DropdownMenuItem>
        ) : (
          runs.map((run, index) => (
            <DropdownMenuItem key={run.id} onSelect={() => onSelectRun(run.id)} className="gap-3">
              <RunIcon status={run.status} />
              <span className="min-w-0 flex-1 truncate text-xs">
                {formatRunDate(run.startedAt)}
                {index === 0 ? " · latest" : ""}
              </span>
              <span className="text-xs capitalize text-muted-foreground">{run.status}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunIcon({ status }: { status: string }) {
  if (status === "running") return <SpinnerGapIcon size={15} className="animate-spin text-muted-foreground" />;
  if (status === "failed") return <XCircleIcon size={15} weight="fill" className="text-destructive" />;
  return <CheckCircleIcon size={15} weight="fill" className="text-emerald-500" />;
}

function formatRunDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function NodeDrawer({
  draft,
  step,
  output,
  updateDraft,
  onClose,
  onTest,
  testingStepId,
}: {
  draft: DraftAutomation;
  step: WorkflowStep | null;
  output?: StepOutput;
  updateDraft: DraftUpdater;
  onClose: () => void;
  onTest: (stepId: string) => void;
  testingStepId: string | null;
}) {
  const [tab, setTab] = useState<"input" | "output">("input");
  useEffect(() => setTab(output?.status === "failed" ? "output" : "input"), [output?.status]);

  if (!step) return null;
  const content = draft.stepContent[step.id];

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex h-full max-h-full w-full max-w-[392px] min-w-0 flex-col overflow-hidden border-l border-white/10 bg-[#050505] text-white shadow-xl xl:relative xl:inset-auto xl:z-auto xl:w-[392px] xl:min-w-[350px] xl:max-w-[540px] xl:resize-x xl:shadow-none">
      <div className="shrink-0 border-b border-white/10 px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-semibold leading-6 text-white">{step.label}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge className="rounded-[5px] border border-white/10 bg-white/[0.06] font-mono text-[10px] uppercase tracking-[0.08em] text-white/62">
                {step.type}
              </Badge>
              <StatusBadge output={output} />
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-[6px] text-white/55 hover:bg-white/[0.08] hover:text-white"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <XIcon size={14} />
          </Button>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
          <div className="flex gap-5">
            <TabButton active={tab === "input"} onClick={() => setTab("input")}>
              Input
            </TabButton>
            <TabButton active={tab === "output"} onClick={() => setTab("output")}>
              Output
            </TabButton>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 gap-1.5 rounded-[6px] bg-white/[0.08] font-mono text-[11px] uppercase tracking-[0.08em] text-white/72 shadow-none hover:bg-white/[0.12] hover:text-white"
            disabled={testingStepId === step.id}
            onClick={() => onTest(step.id)}
          >
            {testingStepId === step.id ? (
              <SpinnerGapIcon size={13} className="animate-spin" />
            ) : (
              <PlayIcon size={13} weight="fill" />
            )}
            Test
          </Button>
        </div>
      </div>

      <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {tab === "input" ? (
          <NodeInputPanel draft={draft} step={step} content={content} updateDraft={updateDraft} />
        ) : (
          <OutputPanel output={output} />
        )}
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "font-mono text-[12px] font-semibold uppercase tracking-[0.1em] transition-colors",
        active ? "text-white" : "text-white/42 hover:text-white/70",
      )}
    >
      {children}
    </button>
  );
}

function StatusBadge({ output }: { output?: StepOutput }) {
  if (!output) {
    return <Badge className="rounded-[5px] border border-white/10 bg-white/[0.04] text-white/52">Idle</Badge>;
  }
  if (output.status === "completed")
    return (
      <Badge className="rounded-[5px] border border-emerald-400/15 bg-emerald-400/12 text-emerald-300">
        Succeeded · {formatDuration(output.duration_ms)}
      </Badge>
    );
  if (output.status === "failed")
    return (
      <Badge className="rounded-[5px] border border-red-400/15 bg-red-400/12 text-red-300">
        Failed · {formatDuration(output.duration_ms)}
      </Badge>
    );
  return <Badge className="rounded-[5px] border border-white/10 bg-white/[0.04] text-white/52">Skipped</Badge>;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function updateStep(
  draft: DraftAutomation,
  stepId: string,
  update: (step: WorkflowStep) => WorkflowStep,
): DraftAutomation {
  return { ...draft, steps: draft.steps.map((step) => (step.id === stepId ? update(step) : step)) };
}

function updateStepContent(
  draft: DraftAutomation,
  step: WorkflowStep,
  update: (content: AutomationStepContent) => AutomationStepContent,
): DraftAutomation {
  const existing =
    draft.stepContent[step.id] ??
    ({
      taskId: "",
      stepId: step.id,
      contentType: step.type === "action" ? "script" : "prompt",
      content: "",
      apps: null,
      updatedAt: null,
    } satisfies AutomationStepContent);
  return { ...draft, stepContent: { ...draft.stepContent, [step.id]: update(existing) } };
}

function NodeInputPanel({
  draft,
  step,
  content,
  updateDraft,
}: {
  draft: DraftAutomation;
  step: WorkflowStep;
  content?: AutomationStepContent;
  updateDraft: DraftUpdater;
}) {
  return (
    <div className="flex min-h-full flex-col gap-5">
      <Field label="Label">
        <Input
          value={step.label}
          className={builderInputClass}
          onChange={(event) =>
            updateDraft((current) => updateStep(current, step.id, (s) => ({ ...s, label: event.target.value })))
          }
        />
      </Field>

      {step.type === "trigger" ? <TriggerFields draft={draft} step={step} updateDraft={updateDraft} /> : null}

      {step.type === "agent" ? (
        <>
          <Field label="Uses">
            <Input
              value={(content?.apps ?? []).join(", ")}
              className={builderInputClass}
              onChange={(event) => {
                const apps = event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean);
                updateDraft((current) =>
                  updateStepContent(current, step, (existing) => ({
                    ...existing,
                    apps: apps.length > 0 ? apps : null,
                  })),
                );
              }}
            />
          </Field>
          <Field label="Prompt" grow>
            <Textarea
              value={content?.content ?? ""}
              className={cn(builderTextareaClass, "min-h-[320px] flex-1 resize-none font-mono")}
              onChange={(event) =>
                updateDraft((current) =>
                  updateStepContent(current, step, (existing) => ({
                    ...existing,
                    contentType: "prompt",
                    content: event.target.value,
                  })),
                )
              }
            />
          </Field>
        </>
      ) : null}

      {step.type === "action" ? (
        <>
          <Field label="Uses">
            <Input
              value={(content?.apps ?? []).join(", ")}
              className={builderInputClass}
              onChange={(event) => {
                const apps = event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean);
                updateDraft((current) =>
                  updateStepContent(current, step, (existing) => ({
                    ...existing,
                    apps: apps.length > 0 ? apps : null,
                  })),
                );
              }}
            />
          </Field>
          <Field label="Script" grow>
            <Textarea
              value={content?.content ?? ""}
              className={cn(builderTextareaClass, "min-h-[340px] flex-1 resize-none font-mono")}
              onChange={(event) =>
                updateDraft((current) =>
                  updateStepContent(current, step, (existing) => ({
                    ...existing,
                    contentType: "script",
                    content: event.target.value,
                  })),
                )
              }
            />
          </Field>
        </>
      ) : null}
    </div>
  );
}

function TriggerFields({
  draft,
  step,
  updateDraft,
}: {
  draft: DraftAutomation;
  step: WorkflowStep;
  updateDraft: DraftUpdater;
}) {
  const config = step.triggerConfig ?? { type: "schedule" as const };
  const setTrigger = (next: WorkflowStep["triggerConfig"]) => {
    updateDraft((current) => updateStep(current, step.id, (s) => ({ ...s, triggerConfig: next })));
  };
  return (
    <>
      <Field label="Trigger type">
        <Input
          value={config.type}
          className={builderInputClass}
          onChange={(event) => setTrigger({ ...config, type: event.target.value as "schedule" | "webhook" | "canvas" })}
        />
      </Field>
      {config.type === "schedule" ? (
        <>
          <Field label="Schedule type">
            <Input
              value={draft.scheduleType === "external" ? "cron" : draft.scheduleType}
              className={builderInputClass}
              onChange={(event) => {
                const scheduleType = event.target.value as "cron" | "interval" | "once";
                updateDraft((current) => ({
                  ...current,
                  scheduleType,
                  steps: current.steps.map((s) =>
                    s.id === step.id
                      ? {
                          ...s,
                          triggerConfig: {
                            ...config,
                            type: "schedule",
                            scheduleType,
                            scheduleValue: current.scheduleValue,
                            timezone: current.timezone,
                          },
                        }
                      : s,
                  ),
                }));
              }}
            />
          </Field>
          <Field label="Schedule value">
            <Input
              value={draft.scheduleValue}
              className={builderInputClass}
              onChange={(event) => {
                const scheduleValue = event.target.value;
                updateDraft((current) => ({
                  ...current,
                  scheduleValue,
                  steps: current.steps.map((s) =>
                    s.id === step.id ? { ...s, triggerConfig: { ...config, type: "schedule", scheduleValue } } : s,
                  ),
                }));
              }}
            />
          </Field>
          <Field label="Timezone">
            <Input
              value={draft.timezone}
              className={builderInputClass}
              onChange={(event) => {
                const timezone = event.target.value;
                updateDraft((current) => ({
                  ...current,
                  timezone,
                  steps: current.steps.map((s) =>
                    s.id === step.id ? { ...s, triggerConfig: { ...config, type: "schedule", timezone } } : s,
                  ),
                }));
              }}
            />
          </Field>
        </>
      ) : null}
    </>
  );
}

function Field({ label, children, grow = false }: { label: string; children: ReactNode; grow?: boolean }) {
  return (
    <div className={cn("space-y-2", grow && "flex min-h-0 flex-1 flex-col")}>
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-white/42">{label}</span>
      {children}
    </div>
  );
}

function OutputPanel({ output }: { output?: StepOutput }) {
  if (!output) {
    return (
      <div className="rounded-[8px] border border-dashed border-white/14 bg-white/[0.03] p-4 text-sm text-white/52">
        No output yet. Run the automation or test this node.
      </div>
    );
  }
  if (output.error) {
    return (
      <pre className="max-w-full overflow-x-hidden whitespace-pre-wrap break-words rounded-[8px] border border-red-400/25 bg-red-400/8 p-3 font-mono text-xs text-red-200 [overflow-wrap:anywhere]">
        {output.error.message}
      </pre>
    );
  }
  if (output.output == null || output.output === "") {
    return (
      <div className="rounded-[8px] border border-white/10 bg-white/[0.04] p-4 text-sm text-white/52">
        No output returned.
      </div>
    );
  }
  return <JsonOutput value={output.output} />;
}

function JsonOutput({ value }: { value: unknown }) {
  const [raw, setRaw] = useState(false);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  let parsed: unknown = value;
  if (typeof value === "string" && (value.trim().startsWith("{") || value.trim().startsWith("["))) {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
  }
  const canTree = parsed !== null && typeof parsed === "object";
  return (
    <div className="flex min-h-[320px] flex-col overflow-hidden rounded-[8px] border border-white/10 bg-[#101010]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-white/42">Output</span>
        <div className="flex items-center gap-1">
          {canTree ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-[6px] text-white/55 hover:bg-white/[0.08] hover:text-white"
              onClick={() => setRaw((current) => !current)}
              aria-label="Toggle output view"
            >
              {raw ? <BracketsCurlyIcon size={14} /> : <CodeIcon size={14} />}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-[6px] text-white/55 hover:bg-white/[0.08] hover:text-white"
            onClick={() => void navigator.clipboard.writeText(text)}
            aria-label="Copy output"
          >
            <CircleIcon size={14} />
          </Button>
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-white/78 [overflow-wrap:anywhere]">
        {canTree && !raw ? JSON.stringify(parsed, null, 2) : text}
      </pre>
    </div>
  );
}
