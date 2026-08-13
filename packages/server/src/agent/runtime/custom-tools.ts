import { resolve } from "node:path";
import type { WebChatQuestion, WebChatQuestionInteraction } from "@sketch/shared";
import { type JSONValue, type Tool, type ToolSet, jsonSchema, tool } from "ai";
import { z } from "zod/v4";
import {
  type IntegrationProgressEventLike,
  collectIntegrationCardsFromProgressEvents,
  projectToolResultForProgressLog,
} from "../../integrations/cards";
import { AuxCostCollector, sumAuxCost } from "../aux-cost";
import type { RunAgentParams } from "../runner";
import { createSketchMcpToolDefinitions } from "../sketch-tools";
import { WRITE_AGENT_OUTPUT_TOOL_NAME } from "../tools/agent-output";
import {
  AutomationArtifactCollector,
  IntegrationConnectionCollector,
  QuestionCollector,
  UploadCollector,
} from "../tools/types";
import type { SketchMcpDeps } from "../tools/types";
import type { AgentRuntimeCustomToolProvider, AgentRuntimeToolEnd, AgentRuntimeToolStart } from "./contracts";

const SKETCH_MCP_SERVER_NAME = "sketch";

interface RuntimeSdkMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

type ToolToModelOutput = NonNullable<Tool["toModelOutput"]>;

export interface AgentRuntimeCustomToolEffects {
  uploadCollector: UploadCollector;
  integrationConnectionCollector: IntegrationConnectionCollector;
  automationArtifactCollector: AutomationArtifactCollector;
  questionCollector: QuestionCollector;
  auxCostCollector: AuxCostCollector;
  integrationProgressEvents: IntegrationProgressEventLike[];
  onToolStart(event: AgentRuntimeToolStart): void;
  onToolEnd(event: AgentRuntimeToolEnd): void;
  collectIntegrationCards(params: RunAgentParams): Promise<void>;
  drain(params: RunAgentParams): {
    pendingUploads: string[];
    pendingIntegrationConnections: ReturnType<IntegrationConnectionCollector["drain"]>;
    automationArtifacts: ReturnType<AutomationArtifactCollector["drain"]>;
    pendingInteraction: WebChatQuestionInteraction | null;
    pendingQuestion: WebChatQuestion | null;
    auxLlmCalls: ReturnType<AuxCostCollector["drain"]>;
    auxCostUsd: number;
  };
}

export interface AgentRuntimeCustomToolProviderDeps {
  effects: AgentRuntimeCustomToolEffects;
  transcriptionEnabled: boolean;
  visionAnalysisEnabled: boolean;
  visionConfig: SketchMcpDeps["visionConfig"];
}

function namespacedMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

function agentAllowsTool(agentAllowedTools: string[] | null | undefined, toolName: string): boolean {
  return agentAllowedTools == null || agentAllowedTools.includes(toolName);
}

function toInputSchema(inputSchema: RuntimeSdkMcpToolDefinition["inputSchema"]) {
  return z.object(inputSchema);
}

function toRuntimeInputSchema(sdkTool: RuntimeSdkMcpToolDefinition) {
  const inputSchema = toInputSchema(sdkTool.inputSchema);
  if (sdkTool.name !== WRITE_AGENT_OUTPUT_TOOL_NAME) return inputSchema;
  const advertisedSchema = z.toJSONSchema(inputSchema) as Parameters<typeof jsonSchema<Record<string, unknown>>>[0];
  return jsonSchema<Record<string, unknown>>(advertisedSchema, {
    validate: (value) => ({ success: true, value: value as Record<string, unknown> }),
  });
}

function mcpToModelOutput({ output }: Parameters<ToolToModelOutput>[0]): ReturnType<ToolToModelOutput> {
  const result = output as { content?: unknown };

  if (!("content" in result) || !Array.isArray(result.content)) {
    return { type: "json", value: result as JSONValue };
  }

  const convertedContent = result.content.map((part: { type: string; [key: string]: unknown }) => {
    if (part.type === "text" && "text" in part) {
      return { type: "text" as const, text: part.text as string };
    }
    if (part.type === "image" && "data" in part && "mimeType" in part) {
      return {
        type: "file" as const,
        mediaType: part.mimeType as string,
        data: { type: "data" as const, data: part.data as string },
      };
    }
    return { type: "text" as const, text: JSON.stringify(part) };
  });

  return { type: "content", value: convertedContent };
}

function toAiSdkTool(sdkTool: RuntimeSdkMcpToolDefinition) {
  return tool({
    description: sdkTool.description,
    inputSchema: toRuntimeInputSchema(sdkTool),
    execute: async (input) => sdkTool.handler(input, {}),
    toModelOutput: mcpToModelOutput,
  });
}

export function createAgentRuntimeCustomToolEffects(): AgentRuntimeCustomToolEffects {
  const uploadCollector = new UploadCollector();
  const integrationConnectionCollector = new IntegrationConnectionCollector();
  const automationArtifactCollector = new AutomationArtifactCollector();
  const questionCollector = new QuestionCollector();
  const auxCostCollector = new AuxCostCollector();
  const integrationProgressEvents: IntegrationProgressEventLike[] = [];

  return {
    uploadCollector,
    integrationConnectionCollector,
    automationArtifactCollector,
    questionCollector,
    auxCostCollector,
    integrationProgressEvents,
    onToolStart(event) {
      integrationProgressEvents.push({ kind: "tool_use", toolName: event.name, input: event.input });
    },
    onToolEnd(event) {
      integrationProgressEvents.push({
        kind: "tool_result",
        toolName: event.name,
        input: event.input,
        output: projectToolResultForProgressLog(event.error ? event.error : event.result),
        isError: event.error !== undefined,
      });
    },
    async collectIntegrationCards(params) {
      if (params.contextType === "scheduled_task") return;
      await collectIntegrationCardsFromProgressEvents({
        events: integrationProgressEvents,
        loadIntegrationProvider: params.loadIntegrationProvider,
        cliIntegrations: params.cliIntegrations,
        currentUserId: params.currentUserId,
        runtimeContext:
          params.taskContext?.contextType === "channel" && params.platform === "slack"
            ? { platform: "slack", deliveryTarget: params.taskContext.deliveryTarget }
            : params.taskContext?.contextType === "group" && params.platform === "whatsapp"
              ? { platform: "whatsapp", deliveryTarget: params.taskContext.deliveryTarget }
              : undefined,
        collector: integrationConnectionCollector,
        userEmail: params.userEmail ?? null,
        userName: params.userName,
      });
    },
    drain(params) {
      const pendingUploads = uploadCollector.drain();
      const drainedIntegrationConnections = integrationConnectionCollector.drain();
      const responseSurface = params.responseSurface ?? params.platform;
      const pendingIntegrationConnections =
        responseSurface === "web"
          ? drainedIntegrationConnections
          : drainedIntegrationConnections.filter((card) => (card.state ?? "connect") === "connect");
      const automationArtifacts = automationArtifactCollector.drain();
      const pendingInteraction = questionCollector.drain();
      const pendingQuestion = pendingInteraction && !("batchId" in pendingInteraction) ? pendingInteraction : null;
      const auxLlmCalls = auxCostCollector.drain();
      return {
        pendingUploads,
        pendingIntegrationConnections,
        automationArtifacts,
        pendingInteraction,
        pendingQuestion,
        auxLlmCalls,
        auxCostUsd: sumAuxCost(auxLlmCalls),
      };
    },
  };
}

function buildSketchMcpDeps(params: RunAgentParams, deps: AgentRuntimeCustomToolProviderDeps): SketchMcpDeps {
  return {
    uploadCollector: deps.effects.uploadCollector,
    integrationConnectionCollector: deps.effects.integrationConnectionCollector,
    automationArtifactCollector: deps.effects.automationArtifactCollector,
    questionCollector: deps.effects.questionCollector,
    responseSurface: params.responseSurface ?? params.platform,
    questionInteractionCapabilities: params.questionInteractionCapabilities,
    auxCostCollector: deps.effects.auxCostCollector,
    workspaceDir: resolve(params.workspaceDir),
    db: params.db,
    getSlack: params.getSlack,
    loadIntegrationProvider: params.loadIntegrationProvider,
    validateAgentSkills: params.validateAgentSkills,
    taskContext: params.taskContext,
    currentAutomation: params.currentAutomation ?? params.taskContext?.currentAutomation,
    scheduler: params.scheduler,
    chatAuthoring: params.chatAutomationAuthoring,
    stepContentRepo: params.stepContentRepo,
    automationRunsRepo: params.automationRunsRepo,
    queueManager: params.queueManager,
    activeQueueKey: params.activeQueueKey,
    toolConfig: params.toolConfig,
    geminiConfig: params.geminiConfig,
    openRouterApiKey: params.openRouterApiKey,
    settingsEncryptionKey: params.settingsEncryptionKey,
    inboxMessagesRepo: params.inboxMessagesRepo,
    userRepo: params.userRepo,
    currentUserId: params.currentUserId ?? undefined,
    currentUserEmail: params.userEmail ?? null,
    currentUserName: params.userName,
    slackEntitySyncEnabled: params.slackEntitySyncEnabled,
    localDeviceInvoker: params.localDeviceInvoker,
    localClaudeSessionService: params.localClaudeSessionService,
    workspaceKey: params.workspaceKey,
    originThreadTs: params.threadTs,
    sendDm: params.sendDm,
    enqueueMessage: params.enqueueMessage,
    loadTranscriptionSettings: params.loadTranscriptionSettings,
    transcriptionEnabled: deps.transcriptionEnabled,
    visionConfig: deps.visionConfig,
    visionAnalysisEnabled: deps.visionAnalysisEnabled,
    logger: params.logger,
    conversationRepo: params.conversationRepo,
    conversationContext: params.conversationContext,
    agentInstructions: params.agentInstructions,
    agentAllowedTools: params.agentAllowedTools,
    agentOutputWriter: params.agentOutputWriter,
    originOrgContextEnabled: params.claudeConfigDir !== undefined,
  };
}

export class DefaultAgentRuntimeCustomToolProvider implements AgentRuntimeCustomToolProvider {
  constructor(private readonly deps: AgentRuntimeCustomToolProviderDeps) {}

  async createTools(params: RunAgentParams): Promise<ToolSet> {
    const tools: ToolSet = {};
    const sdkTools = createSketchMcpToolDefinitions(
      buildSketchMcpDeps(params, this.deps),
    ) as RuntimeSdkMcpToolDefinition[];

    for (const sdkTool of sdkTools) {
      const name = namespacedMcpToolName(SKETCH_MCP_SERVER_NAME, sdkTool.name);
      if (!agentAllowsTool(params.agentAllowedTools, name)) continue;
      tools[name] = toAiSdkTool(sdkTool);
    }

    return tools;
  }
}

export function createDefaultAgentRuntimeCustomToolProvider(
  deps: AgentRuntimeCustomToolProviderDeps,
): AgentRuntimeCustomToolProvider {
  return new DefaultAgentRuntimeCustomToolProvider(deps);
}
