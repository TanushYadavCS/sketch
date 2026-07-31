import { resolve } from "node:path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { notifyStealRequested } from "../whatsapp/lock-confirmations";
import { createWriteAgentOutputTool } from "./tools/agent-output";
import { createManageAutomationSharesTool } from "./tools/automation-shares";
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
import { createAskUserQuestionTool, createAskUserQuestionsTool } from "./tools/questions";
import { createManageScheduledTasksTool } from "./tools/scheduled-tasks";
import { createSearchTools } from "./tools/search";
import { createTeamTools } from "./tools/team";
import { createTranscribeAudioTool } from "./tools/transcribe-audio";
import {
  AutomationArtifactCollector,
  IntegrationConnectionCollector,
  QuestionCollector,
  type SketchMcpDeps,
  UploadCollector,
} from "./tools/types";
import { createSendFileToChatTool } from "./tools/upload";
import { createVisualAnalysisTool } from "./tools/visual-analysis";

export { handleResolveInboxWorkflow, handleUpdateInboxWorkflow } from "./tools/inbox-workflows";
export { handleSearchUsers, handleSendMessage, handleSendMessageToUsers } from "./tools/messaging";
export { handleManageScheduledTasks } from "./tools/scheduled-tasks";
export { handleManageAutomationShares } from "./tools/automation-shares";
export { handleGetTeamDirectory, handleSetUserTimezone } from "./tools/team";
export { UploadCollector };
export { IntegrationConnectionCollector };
export { AutomationArtifactCollector };
export { QuestionCollector };
export type { SketchMcpDeps };

function channelQuestionInteractionsAvailable(deps: SketchMcpDeps): boolean {
  const capabilities = deps.questionInteractionCapabilities;
  return Boolean(capabilities?.available && (capabilities.interactiveSingleSelect || capabilities.textFallback));
}

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
      validateAgentSkills: deps.validateAgentSkills,
      queueManager: deps.queueManager,
      activeQueueKey: deps.activeQueueKey,
      config: deps.toolConfig,
      encryptionKey: deps.settingsEncryptionKey,
      automationArtifactCollector: deps.automationArtifactCollector,
      notifyStealRequest:
        deps.getSlack && deps.logger && deps.db
          ? (
              (stealSlack, stealLogger, stealDb) => (taskId: string) =>
                notifyStealRequested({
                  db: stealDb,
                  logger: stealLogger,
                  taskId,
                  senders: {
                    slack: {
                      postLockStealRequest: async (p) => {
                        const slack = stealSlack();
                        if (!slack) return;
                        return slack.postLockStealRequestMessage(p.channelId, p);
                      },
                      sendText: async (channelId, text) => {
                        const slack = stealSlack();
                        if (!slack) return;
                        return slack.postMessage(channelId, text);
                      },
                    },
                  },
                })
            )(deps.getSlack, deps.logger, deps.db)
          : undefined,
    }),
    createManageAutomationSharesTool({
      scheduler: deps.scheduler,
      taskContext: deps.taskContext,
      db: deps.db,
      userRepo: deps.userRepo,
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
    ...(deps.questionCollector && (deps.responseSurface === "web" || channelQuestionInteractionsAvailable(deps))
      ? [createAskUserQuestionTool(deps), createAskUserQuestionsTool(deps)]
      : []),
  ];
}

export function createSketchMcpServer(deps: SketchMcpDeps) {
  return createSdkMcpServer({ name: "sketch", tools: createSketchMcpToolDefinitions(deps) });
}
