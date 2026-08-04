import { resolve } from "node:path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createWriteAgentOutputTool } from "./tools/agent-output";
import { createReadChatHistoryTool, createSearchChatHistoryTool } from "./tools/chat-history";
import { ChatHistoryAccessResolver } from "./tools/chat-search";
import { createSearchDeliveryTargetsTool } from "./tools/delivery-targets";
import { createInboxWorkflowTools } from "./tools/inbox-workflows";
import { createListFollowupsTool } from "./tools/list-followups";
import { createListTasksTool } from "./tools/list-tasks";
import { createLocalClaudeSessionTool } from "./tools/local-claude-session";
import { createLocalRunCommandTool } from "./tools/local-command";
import { createMessagingTools } from "./tools/messaging";
import { createProviderConfigTool } from "./tools/provider-config";
import { createManageScheduledTasksTool } from "./tools/scheduled-tasks";
import { createSearchTools } from "./tools/search";
import { createTeamTools } from "./tools/team";
import { createTranscribeAudioTool } from "./tools/transcribe-audio";
import {
  AutomationArtifactCollector,
  IntegrationConnectionCollector,
  type SketchMcpDeps,
  UploadCollector,
} from "./tools/types";
import { createSendFileToChatTool } from "./tools/upload";
import { createVisualAnalysisTool } from "./tools/visual-analysis";

export { handleResolveInboxWorkflow, handleUpdateInboxWorkflow } from "./tools/inbox-workflows";
export { handleSearchUsers, handleSendMessageToUser, handleSendMessageToUsers } from "./tools/messaging";
export { handleManageScheduledTasks } from "./tools/scheduled-tasks";
export { handleGetTeamDirectory, handleSetUserTimezone } from "./tools/team";
export { UploadCollector };
export { IntegrationConnectionCollector };
export { AutomationArtifactCollector };
export type { SketchMcpDeps };

export function createSketchMcpToolDefinitions(deps: SketchMcpDeps) {
  const absWorkspace = resolve(deps.workspaceDir);
  const chatHistoryAccess = new ChatHistoryAccessResolver(deps);
  return [
    createSendFileToChatTool(deps, absWorkspace),
    createReadChatHistoryTool(deps, chatHistoryAccess),
    createSearchChatHistoryTool(deps, chatHistoryAccess),
    createProviderConfigTool(deps),
    createSearchDeliveryTargetsTool(deps),
    createLocalRunCommandTool(deps),
    createLocalClaudeSessionTool(deps),
    createManageScheduledTasksTool({
      scheduler: deps.scheduler,
      db: deps.db,
      chatAuthoring: deps.chatAuthoring,
      taskContext: deps.taskContext,
      currentAutomation: deps.currentAutomation ?? deps.taskContext?.currentAutomation,
      stepContentRepo: deps.stepContentRepo,
      automationRunsRepo: deps.automationRunsRepo,
      userRepo: deps.userRepo,
      loadIntegrationProvider: deps.loadIntegrationProvider,
      queueManager: deps.queueManager,
      activeQueueKey: deps.activeQueueKey,
      config: deps.toolConfig,
      automationArtifactCollector: deps.automationArtifactCollector,
    }),
    ...createTeamTools(deps),
    ...createMessagingTools(deps),
    ...createInboxWorkflowTools(deps),
    createWriteAgentOutputTool(deps.agentOutputWriter),
    ...(deps.transcriptionEnabled
      ? [
          createTranscribeAudioTool({
            absWorkspace,
            loadSettings: deps.loadTranscriptionSettings,
            logger: deps.logger,
            onUsage: deps.auxCostCollector ? (call) => deps.auxCostCollector?.collect(call) : undefined,
          }),
        ]
      : []),
    ...(deps.visionAnalysisEnabled && deps.visionConfig
      ? [
          createVisualAnalysisTool({
            absWorkspace,
            config: deps.visionConfig,
            logger: deps.logger,
            onUsage: deps.auxCostCollector ? (call) => deps.auxCostCollector?.collect(call) : undefined,
          }),
        ]
      : []),
    ...createSearchTools(deps),
    createListFollowupsTool(deps),
    createListTasksTool(deps),
  ];
}

export function createSketchMcpServer(deps: SketchMcpDeps) {
  return createSdkMcpServer({ name: "sketch", tools: createSketchMcpToolDefinitions(deps) });
}
