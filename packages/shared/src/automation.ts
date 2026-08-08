import { z } from "zod";

export const canvasWebhookEndpointSchema = z
  .object({
    url: z.string().url(),
    method: z.literal("POST"),
    authentication: z.literal("none"),
    contentType: z.literal("application/json"),
    payload: z.string().default("Any JSON value"),
  })
  .strict();

export type CanvasWebhookEndpoint = z.infer<typeof canvasWebhookEndpointSchema>;

export const workflowTriggerConfigSchema = z
  .object({
    type: z.enum(["webhook", "schedule", "canvas", "slack_channel_message"]),
    channelId: z.string().trim().min(1).optional(),
    scheduleType: z.enum(["cron", "interval", "once"]).optional(),
    scheduleValue: z.string().optional(),
    timezone: z.string().optional(),
    app: z.string().optional(),
    eventDescription: z.string().optional(),
    componentKey: z.string().optional(),
    webhookUrl: z.string().url().optional(),
    webhookMethod: z.literal("POST").optional(),
    webhookContentType: z.literal("application/json").optional(),
    canvasEndpoint: canvasWebhookEndpointSchema.optional(),
    configuredProps: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["pending_canvas_setup", "active", "error"]).optional(),
    canvasWorkflowId: z.string().optional(),
    canvasTriggerNodeId: z.string().optional(),
    canvasActionNodeId: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "slack_channel_message" && !value.channelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channelId"],
        message: "Slack channel message trigger requires channelId",
      });
    }
  });

export type WorkflowTriggerConfig = z.infer<typeof workflowTriggerConfigSchema>;

export const automationSketchToolNameSchema = z.enum(["search", "searchEntities", "getEntityContext", "findTeammate"]);

export type AutomationSketchToolName = z.infer<typeof automationSketchToolNameSchema>;

export const automationActionCapabilitiesSchema = z
  .object({
    sketchTools: z.array(automationSketchToolNameSchema).max(8),
    usesIntegrationActions: z.boolean(),
  })
  .strict();

export type AutomationActionCapabilities = z.infer<typeof automationActionCapabilitiesSchema>;

export const workflowStepSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(["trigger", "action", "agent"]),
  label: z.string().trim().min(1),
  icon: z.string().trim().min(1).default("circle"),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  agentMode: z.enum(["light", "sketch"]).optional(),
  agentSkills: z.array(z.string()).optional(),
  agentModel: z.string().optional(),
  agentMcpServers: z.array(z.string()).optional(),
  actionCapabilities: automationActionCapabilitiesSchema.optional(),
  timeout: z.number().int().positive().optional(),
  triggerConfig: workflowTriggerConfigSchema.optional(),
});

export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowEdgeSchema = z.object({
  id: z.string().trim().min(1),
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  condition: z.string().optional(),
  label: z.string().optional(),
});

export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowDeliverySchema = z.object({
  platform: z.enum(["slack", "whatsapp"]),
  targetType: z.enum(["dm", "channel", "group", "thread"]),
  targetId: z.string().trim().min(1),
  threadTs: z.string().nullable(),
  mode: z.enum(["deliver", "silent"]),
  label: z.string().optional(),
});

export type WorkflowDelivery = z.infer<typeof workflowDeliverySchema>;

export const automationOriginChatSchema = z.object({
  platform: z.enum(["web", "slack", "whatsapp"]),
  conversationId: z.string().trim().min(1),
  providerThreadId: z.string().nullable(),
  currentMessageId: z.number().int().positive().nullable(),
});

export type AutomationOriginChat = z.infer<typeof automationOriginChatSchema>;

export const automationStepContentSchema = z.object({
  taskId: z.string(),
  stepId: z.string(),
  contentType: z.enum(["prompt", "script"]),
  content: z.string(),
  apps: z.array(z.string()).nullable(),
  updatedAt: z.string().nullable().optional(),
});

export type AutomationStepContent = z.infer<typeof automationStepContentSchema>;

export const stepOutputSchema = z.object({
  output: z.unknown(),
  status: z.enum(["completed", "failed", "skipped"]),
  duration_ms: z.number(),
  error: z.object({ message: z.string(), stack: z.string().optional() }).optional(),
});

export type StepOutput = z.infer<typeof stepOutputSchema>;

export const automationRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  triggerData: z.unknown().nullable(),
  status: z.enum(["running", "completed", "failed"]),
  stepOutputs: z.record(z.string(), stepOutputSchema),
  errorMessage: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});

export type AutomationRun = z.infer<typeof automationRunSchema>;

export const automationDefinitionSchema = z.object({
  id: z.string(),
  platform: z.enum(["slack", "whatsapp"]),
  contextType: z.enum(["dm", "channel", "group"]),
  deliveryTarget: z.string(),
  threadTs: z.string().nullable(),
  prompt: z.string(),
  scheduleType: z.enum(["cron", "interval", "once", "external"]),
  scheduleValue: z.string(),
  timezone: z.string(),
  sessionMode: z.literal("fresh"),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  status: z.enum(["active", "paused", "completed"]),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
  lastEditedBy: z.string().nullable(),
  lastEditedByName: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  originChat: automationOriginChatSchema.nullable(),
  delivery: workflowDeliverySchema,
  steps: z.array(workflowStepSchema),
  edges: z.array(workflowEdgeSchema),
  stepContent: z.record(z.string(), automationStepContentSchema),
  latestRun: automationRunSchema.nullable(),
  recentRuns: z.array(automationRunSchema),
});

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;

export const automationArtifactSchema = z.object({
  taskId: z.string(),
  kind: z.string().default("New automation"),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  scheduleLabel: z.string(),
  deliveryLabel: z.string(),
  builderUrl: z.string(),
  status: z.enum(["active", "paused", "completed"]),
});

export type AutomationArtifact = z.infer<typeof automationArtifactSchema>;

export const automationBuilderSaveRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative().optional(),
  title: z.string().trim().min(1).nullable(),
  description: z.string().nullable(),
  prompt: z.string().trim().min(1),
  scheduleType: z.enum(["cron", "interval", "once", "external"]),
  scheduleValue: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
  status: z.enum(["active", "paused", "completed"]),
  delivery: workflowDeliverySchema,
  steps: z.array(workflowStepSchema).min(2),
  edges: z.array(workflowEdgeSchema),
  stepContent: z.record(z.string(), automationStepContentSchema),
});

export type AutomationBuilderSaveRequest = z.infer<typeof automationBuilderSaveRequestSchema>;

export function workflowStepUsesIntegrationActions(step: Pick<WorkflowStep, "type" | "actionCapabilities">): boolean {
  if (step.type !== "action") return false;
  if (!step.actionCapabilities) return true;
  const parsed = automationActionCapabilitiesSchema.safeParse(step.actionCapabilities);
  return !parsed.success || parsed.data.usesIntegrationActions;
}

export type AutomationUiStepStatus = "idle" | "running" | "success" | "failed" | "skipped";

export function automationUiStatusFromRunStatus(
  status: StepOutput["status"] | "running" | undefined,
): AutomationUiStepStatus {
  if (!status) return "idle";
  if (status === "completed") return "success";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "running";
}
