import type {
  AutomationArtifact,
  WebChatIntegrationConnectionData,
  WebChatQuestion,
  WebChatQuestionBatch,
  WebChatQuestionInteraction,
} from "@sketch/shared";
import type { Kysely, Selectable } from "kysely";
import type { ChatAutomationAuthoring } from "../../automation/chat-authoring";
import type { AccessPrincipalInput } from "../../connectors/types";
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
import type { CurrentAutomation, TaskContext } from "../../scheduler/types";
import type { SlackBot } from "../../slack/bot";
import type { TranscriptionSettings } from "../../transcription/service";
import type { VisionConfig } from "../../vision/service";
import type { WhatsAppTemplateRequest } from "../../whatsapp/templates";
import type { AuxCostCollector } from "../aux-cost";
import type { QuestionInteractionCapabilities } from "../interactions/types";
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

export class AutomationArtifactCollector {
  private pending: AutomationArtifact[] = [];

  collect(artifact: AutomationArtifact): void {
    this.pending.push(artifact);
  }

  drain(): AutomationArtifact[] {
    const artifacts = [...this.pending];
    this.pending = [];
    return artifacts;
  }
}

export class QuestionCollector {
  private pending: WebChatQuestionInteraction | null = null;

  collect(question: WebChatQuestion): void {
    this.collectInteraction(question);
  }

  collectBatch(batch: WebChatQuestionBatch): void {
    this.collectInteraction(batch);
  }

  private collectInteraction(interaction: WebChatQuestionInteraction): void {
    if (this.pending) throw new Error("Only one pending question interaction is allowed per agent run.");
    this.pending = interaction;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  drain(): WebChatQuestionInteraction | null {
    const interaction = this.pending;
    this.pending = null;
    return interaction;
  }
}

export interface SketchMcpDeps {
  uploadCollector: UploadCollector;
  integrationConnectionCollector?: IntegrationConnectionCollector;
  automationArtifactCollector?: AutomationArtifactCollector;
  questionCollector?: QuestionCollector;
  questionInteractionCapabilities?: QuestionInteractionCapabilities;
  responseSurface?: "web" | "slack" | "whatsapp";
  workspaceDir: string;
  db?: Kysely<DB>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  validateAgentSkills?: (
    ownerUserId: string,
    skillIds: string[],
    taskContext?: Pick<TaskContext, "platform" | "contextType" | "deliveryTarget" | "createdBy">,
  ) => Promise<string[]>;
  taskContext?: TaskContext;
  currentAutomation?: CurrentAutomation;
  getSlack?: () => SlackBot | null;
  scheduler?: TaskScheduler;
  chatAuthoring?: ChatAutomationAuthoring;
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
  slackEntitySyncEnabled?: boolean;
  /** Mirrors DEV_TOOLS_ENABLED. Gates dev-tools search-trace capture; off means no capture at all. */
  devToolsEnabled?: boolean;
  /** Pre-assigned trace id, set only by the dev-tools search runner so it can read the
   * finished trace back without racing the fire-and-forget write. */
  devSearchTraceId?: string;
  localDeviceInvoker?: Pick<LocalDeviceGateway, "invoke">;
  localClaudeSessionService?: LocalClaudeSessionService;
  workspaceKey?: string;
  originThreadTs?: string;
  activeQueueKey?: string;
  sendDm?: (params: {
    userId: string;
    platform: string;
    message: string;
    template?: WhatsAppTemplateRequest;
    senderUserId?: string;
    storeInInbox?: boolean;
    inboxKind?: string;
    inboxMetadata?: Record<string, unknown> | null;
  }) => Promise<{
    channelId: string;
    messageRef: string;
    inboxMessageId?: string;
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
    isThreadReply?: boolean;
  };
  agentInstructions?: string | null;
  agentAllowedTools?: string[] | null;
  agentOutputWriter?: AgentOutputWriter;
  originOrgContextEnabled?: boolean;
  publicMcp?: {
    userPrincipals?: AccessPrincipalInput[];
    filterEntityMetadata?: boolean;
    maxFileContentChars?: number;
  };
}

export type ToolResult = { content: { type: "text"; text: string }[] };
