import { resolve } from "node:path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createReadChatHistoryTool, createSearchChatHistoryTool } from "./tools/chat-history";
import { createSearchDeliveryTargetsTool } from "./tools/delivery-targets";
import { createInboxWorkflowTools } from "./tools/inbox-workflows";
import { createLocalRunCommandTool } from "./tools/local-command";
import { createMessagingTools } from "./tools/messaging";
import { createProviderConfigTool } from "./tools/provider-config";
import { createManageScheduledTasksTool } from "./tools/scheduled-tasks";
import { createSearchTools } from "./tools/search";
import { createTeamTools } from "./tools/team";
import { createTranscribeAudioTool } from "./tools/transcribe-audio";
import { type SketchMcpDeps, UploadCollector } from "./tools/types";
import { createSendFileToChatTool } from "./tools/upload";
import { createVisualAnalysisTool } from "./tools/visual-analysis";

export { handleResolveInboxWorkflow, handleUpdateInboxWorkflow } from "./tools/inbox-workflows";
export { handleSearchUsers, handleSendMessageToUser, handleSendMessageToUsers } from "./tools/messaging";
export { handleManageScheduledTasks } from "./tools/scheduled-tasks";
export { handleGetTeamDirectory, handleSetUserTimezone } from "./tools/team";
export { UploadCollector };
export type { SketchMcpDeps };

export function createSketchMcpServer(deps: SketchMcpDeps) {
  const absWorkspace = resolve(deps.workspaceDir);
  const tools = [
    createSendFileToChatTool(deps, absWorkspace),
    createReadChatHistoryTool(deps),
    createSearchChatHistoryTool(deps),
    createProviderConfigTool(deps),
    createSearchDeliveryTargetsTool(deps),
    createLocalRunCommandTool(deps),
    createManageScheduledTasksTool({
      scheduler: deps.scheduler,
      taskContext: deps.taskContext,
      stepContentRepo: deps.stepContentRepo,
      automationRunsRepo: deps.automationRunsRepo,
      loadIntegrationProvider: deps.loadIntegrationProvider,
      queueManager: deps.queueManager,
      activeQueueKey: deps.activeQueueKey,
      config: deps.toolConfig,
    }),
    ...createTeamTools(deps),
    ...createMessagingTools(deps),
    ...createInboxWorkflowTools(deps),
    ...(deps.transcriptionEnabled
      ? [
          createTranscribeAudioTool({
            absWorkspace,
            loadSettings: deps.loadTranscriptionSettings,
            logger: deps.logger,
          }),
        ]
      : []),
    ...(deps.visionAnalysisEnabled && deps.visionConfig
      ? [
          createVisualAnalysisTool({
            absWorkspace,
            config: deps.visionConfig,
            logger: deps.logger,
          }),
        ]
      : []),
    ...createSearchTools(deps),
  ];

  return createSdkMcpServer({ name: "sketch", tools });
}
