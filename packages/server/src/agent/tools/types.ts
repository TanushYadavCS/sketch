import type { WebChatIntegrationConnectionData } from "@sketch/shared";
import type { Kysely, Selectable } from "kysely";
import type { createAutomationRunsRepository } from "../../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../../db/repositories/automation-step-content";
import type { createConversationRepository } from "../../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../../db/repositories/inbox-messages";
import type { DB, UsersTable } from "../../db/schema";
import { normalizeIntegrationLookup } from "../../integrations/cards";
import type { IntegrationProvider } from "../../integrations/types";
import type { LocalClaudeSessionService } from "../../local-devices/claude-sessions";
import type { LocalDeviceGateway } from "../../local-devices/gateway";
import type { Logger } from "../../logger";
import type { TaskScheduler } from "../../scheduler/service";
import type { TaskContext } from "../../scheduler/types";
import type { SlackBot } from "../../slack/bot";
import type { TranscriptionSettings } from "../../transcription/service";
import type { VisionConfig } from "../../vision/service";
import type { AuxCostCollector } from "../aux-cost";
import type { AgentOutputWriter } from "./agent-output";

export type SelectableUser = Selectable<UsersTable>;

export interface SearchableUserRepo {
  list: () => Promise<SelectableUser[]>;
  findById: (id: string) => Promise<SelectableUser | undefined>;
  getAllEmailsForUser: (id: string) => Promise<string[]>;
  getVerifiedEmailsForUser?: (id: string) => Promise<string[]>;
  findByEmail?: (email: string) => Promise<SelectableUser | undefined>;
  findBySlackId?: (slackUserId: string) => Promise<SelectableUser | undefined>;
  findByExactName?: (name: string, excludeUserId?: string) => Promise<SelectableUser | undefined>;
  searchByNamePrefix?: (query: string, limit?: number, excludeUserId?: string) => Promise<SelectableUser[]>;
  searchByNameSubstring?: (query: string, limit?: number, excludeUserId?: string) => Promise<SelectableUser[]>;
  update?: (id: string, data: { timezone?: string | null }) => Promise<SelectableUser>;
}

export class UploadCollector {
  private pending: string[] = [];

  collect(filePath: string): void {
    this.pending.push(filePath);
  }

  drain(): string[] {
    const files = [...this.pending];
    this.pending = [];
    return files;
  }
}

export class IntegrationConnectionCollector {
  private pending: WebChatIntegrationConnectionData[] = [];

  collect(card: WebChatIntegrationConnectionData): void {
    const key = `${card.state ?? "connect"}:${normalizeIntegrationLookup(card.appId)}`;
    const existingIndex = this.pending.findIndex(
      (item) => `${item.state ?? "connect"}:${normalizeIntegrationLookup(item.appId)}` === key,
    );
    if (existingIndex !== -1) {
      this.pending[existingIndex] = card;
      return;
    }
    this.pending.push(card);
  }

  drain(): WebChatIntegrationConnectionData[] {
    const cards = [...this.pending];
    this.pending = [];
    return cards;
  }
}

export interface SketchMcpDeps {
  uploadCollector: UploadCollector;
  integrationConnectionCollector?: IntegrationConnectionCollector;
  workspaceDir: string;
  db?: Kysely<DB>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  taskContext?: TaskContext;
  getSlack?: () => SlackBot | null;
  scheduler?: TaskScheduler;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  queueManager?: { getQueue: (key: string) => { enqueue: (fn: () => Promise<void>) => void } };
  toolConfig?: { BASE_URL?: string; PORT: number };
  geminiConfig?: { maxRpm?: number; maxRetries?: number };
  openRouterApiKey?: string;
  settingsEncryptionKey?: string;
  inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
  userRepo?: SearchableUserRepo;
  currentUserId?: string;
  currentUserEmail?: string | null;
  currentUserName?: string | null;
  localDeviceInvoker?: Pick<LocalDeviceGateway, "invoke">;
  localClaudeSessionService?: LocalClaudeSessionService;
  workspaceKey?: string;
  originThreadTs?: string;
  activeQueueKey?: string;
  sendDm?: (params: { userId: string; platform: string; message: string }) => Promise<{
    channelId: string;
    messageRef: string;
  }>;
  enqueueMessage?: (params: { requesterUserId: string; message: string }) => Promise<void>;
  loadTranscriptionSettings?: () => Promise<TranscriptionSettings | null>;
  transcriptionEnabled?: boolean;
  visionConfig?: VisionConfig | null;
  visionAnalysisEnabled?: boolean;
  auxCostCollector?: AuxCostCollector;
  logger?: Logger;
  conversationRepo?: ReturnType<typeof createConversationRepository>;
  conversationContext?: {
    conversationId: number;
    currentMessageId?: number;
    providerThreadId?: string | null;
  };
  agentInstructions?: string | null;
  agentAllowedTools?: string[] | null;
  agentOutputWriter?: AgentOutputWriter;
  originOrgContextEnabled?: boolean;
  publicMcp?: {
    userEmails?: string[];
    filterEntityMetadata?: boolean;
    maxFileContentChars?: number;
  };
}

export type ToolResult = { content: { type: "text"; text: string }[] };
