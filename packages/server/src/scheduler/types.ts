/**
 * Shared types for the scheduled tasks / automations feature.
 *
 * ScheduledTask is the camelCase application-level interface returned by the repository.
 * TaskContext carries the ambient message context (platform, channel, user) that is
 * injected into the agent at run time so the ManageScheduledTasks tool can fill in
 * delivery metadata without requiring the agent to supply it explicitly.
 */

import type { WorkflowEdge, WorkflowStep } from "@sketch/shared";
import type { WorkflowDelivery } from "../workflows/delivery";

export interface ScheduledTask {
  id: string;
  platform: "slack" | "whatsapp";
  contextType: "dm" | "channel" | "group";
  deliveryTarget: string;
  threadTs: string | null;
  prompt: string;
  scheduleType: "cron" | "interval" | "once" | "external";
  scheduleValue: string;
  timezone: string;
  sessionMode: "fresh";
  nextRunAt: string | null;
  lastRunAt: string | null;
  status: "active" | "paused" | "completed";
  createdBy: string | null;
  createdAt: string;
  revision: number;
  title: string | null;
  description: string | null;
  originChat: TaskOriginChat | null;
  steps: string | null;
  edges: string | null;
  outputTarget: string | null;
  outputPlatform: string | null;
  outputThreadTs: string | null;
  outputMode: "deliver" | "silent";
  delivery: WorkflowDelivery;
}

export interface CurrentAutomationBuilderState {
  title: string | null;
  description: string | null;
  prompt: string;
  scheduleType: ScheduledTask["scheduleType"];
  scheduleValue: string;
  timezone: string;
  status: ScheduledTask["status"];
  delivery: WorkflowDelivery;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  stepContent: Record<
    string,
    {
      contentType: "prompt" | "script";
      content: string;
      apps: string[] | null;
    }
  >;
}

/**
 * Request-scoped builder alignment created only after the current task passed
 * the normal owner/admin access check. The builder state is deliberately
 * bounded; persisted task data remains authoritative for edits.
 */
export interface CurrentAutomation {
  taskId: string;
  revision: number;
  builderConversationId: string;
  builderState: CurrentAutomationBuilderState;
}

export interface TaskOriginChat {
  platform: "web" | "slack" | "whatsapp";
  conversationId: string;
  providerThreadId: string | null;
  currentMessageId: number | null;
}

export interface TaskContext {
  platform: "slack" | "whatsapp";
  contextType: "dm" | "channel" | "group";
  deliveryTarget: string;
  createdBy: string | null;
  conversationKind?: "web_chat" | "builder";
  /**
   * Creator's IANA timezone, used as the default for new scheduled tasks when
   * the agent doesn't pass `timezone` explicitly. Null means "fall through to UTC".
   */
  creatorTimezone?: string | null;
  threadTs?: string;
  origin?: TaskOriginChat;
  canManageAnyTask?: boolean;
  currentAutomation?: CurrentAutomation;
  authoringLease?: { sessionId: string; generation: number };
  planOnly?: boolean;
}
