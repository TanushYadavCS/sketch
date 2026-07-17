import type { Kysely, Selectable } from "kysely";
import type { AgentRunAdmissionOptions } from "../../agent/concurrency-limiter";
import type { McpServerConfig, RunAgentParams, RunAgentResult } from "../../agent/runner";
import type { Config } from "../../config";
import type {
  AgentDeliveryConfig,
  AgentDeliveryModel,
  AgentMasthead,
  AgentOutputRow,
  AgentOutputTriggerType,
  AgentRoute,
  AgentSourceConfig,
} from "../../db/repositories/agent-outputs";
import type { createSettingsRepository } from "../../db/repositories/settings";
import type { createUserRepository } from "../../db/repositories/users";
import type { DB, UsersTable } from "../../db/schema";
import type { IntegrationProvider } from "../../integrations/types";
import type { Logger } from "../../logger";
import type { QueueManager } from "../../queue";
import type { SlackBot } from "../../slack/bot";
import type { WhatsAppBot } from "../../whatsapp/bot";
import type { AgentOutputDeliveryPublisher } from "../output-delivery";
import type { AgentApiItem, AgentDefinition, AgentSourceConfigDef } from "../types";

export type UserRow = Selectable<UsersTable>;

export type AgentViewerRole = "admin" | "member";

export type AgentGenerationScope =
  | { kind: "combined"; sourceKey: string; sourceLabel: string | null }
  | { kind: "source"; source: AgentSourceConfig; sourceKey: string; sourceLabel: string | null };

export type ResolvedRoute = AgentRoute & { resolvedSources: AgentSourceConfig[] };

export type AgentExpectedScope = AgentGenerationScope & { sources: AgentSourceConfig[]; route?: ResolvedRoute };

export interface AgentRunServiceDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  users: ReturnType<typeof createUserRepository>;
  settings: ReturnType<typeof createSettingsRepository>;
  runAgent: (params: RunAgentParams) => Promise<RunAgentResult>;
  runScheduledAgent: (params: RunAgentParams, admission?: AgentRunAdmissionOptions) => Promise<RunAgentResult>;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  queueManager?: QueueManager;
  outputDelivery?: AgentOutputDeliveryPublisher;
  getSlack?: () => Pick<SlackBot, "isUserInChannel" | "listChannels"> | null;
  getWhatsApp?: () =>
    | (Pick<WhatsAppBot, "getGroupMetadata"> & {
        resolveJidToPhone?: (jid: string) => Promise<string | null>;
      })
    | null;
}

export interface RequestAgentGenerationParams {
  agentKey: string;
  userId: string;
  outputDate?: string;
  periodKey?: string;
  triggerType: AgentOutputTriggerType;
  skipIfCompleted?: boolean;
  scopeKeys?: string[];
  routeIds?: string[];
}

export interface AgentDueGenerationGroup {
  outputDate: string;
  periodKey: string;
  scopeKeys: string[];
}

export interface ResolvedAgentConfig {
  enabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  timezone: string | null;
  maxItemsPerSection: number;
  enabledSections: Record<string, boolean>;
  focus: string | null;
  delivery: AgentDeliveryConfig | null;
  deliveryModel: AgentDeliveryModel;
  sources: AgentSourceConfig[];
  routes: ResolvedRoute[];
  configuredRoutes: AgentRoute[];
  createTasks: boolean;
}

export interface AgentSectionView {
  key: string;
  title: string;
  enabled: boolean;
}

export interface AgentConfigView {
  agentKey: string;
  title: string;
  tagline: string;
  description: string;
  enabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  timezone: string | null;
  maxItemsPerSection: number;
  itemsPerSectionRange: { min: number; max: number };
  focus: string | null;
  delivery: AgentDeliveryConfig | null;
  deliveryModel: AgentDeliveryModel;
  sourceConfig: AgentSourceConfigDef | null;
  sources: AgentSourceConfig[];
  routes: AgentConfigRouteView[];
  sections: AgentSectionView[];
  createTasks: boolean;
}

export interface AgentRouteOwnerView {
  userId: string;
  name: string;
  email: string | null;
  authRole: string;
}

export type AgentConfigRouteView = AgentRoute & { owner?: AgentRouteOwnerView };

export interface AgentRouteMember {
  userId: string;
  name: string;
  slackUserId: string;
}

export interface AgentWhatsAppDmMember {
  userId: string;
  name: string;
}

export interface AgentOutputApi {
  id: string;
  agentKey: string;
  userId: string;
  outputDate: string;
  timezone: string;
  status: string;
  sourceKey: string;
  sourceLabel: string | null;
  generatedAt: string | null;
  masthead: AgentMasthead | null;
  sections: Record<string, AgentApiItem[]>;
}

export interface AgentSummaryView {
  key: string;
  title: string;
  tagline: string;
  description: string;
  category: string;
  version: string;
  enabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  sourceConfig: AgentSourceConfigDef | null;
  sources: AgentSourceConfig[];
  routes: AgentConfigRouteView[];
}

export interface AgentConfigUpdatePatch {
  enabled?: boolean;
  scheduleHour?: number;
  scheduleMinute?: number;
  maxItemsPerSection?: number;
  sections?: Record<string, boolean>;
  focus?: string | null;
  delivery?: AgentDeliveryConfig | null;
  deliveryModel?: AgentDeliveryModel;
  sources?: AgentSourceConfig[];
  routes?: AgentConfigRouteView[];
  createTasks?: boolean;
}

export class AgentDeliveryTargetError extends Error {}
export class AgentSourceTargetError extends Error {}
