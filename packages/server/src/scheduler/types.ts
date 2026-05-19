/**
 * Shared types for the scheduled tasks / automations feature.
 *
 * ScheduledTask is the camelCase application-level interface returned by the repository.
 * TaskContext carries the ambient message context (platform, channel, user) that is
 * injected into the agent at run time so the ManageScheduledTasks tool can fill in
 * delivery metadata without requiring the agent to supply it explicitly.
 */

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
  sessionMode: "fresh" | "persistent" | "chat";
  nextRunAt: string | null;
  lastRunAt: string | null;
  status: "active" | "paused" | "completed";
  createdBy: string | null;
  createdAt: string;
  title: string | null;
  description: string | null;
  steps: string | null;
  edges: string | null;
  outputTarget: string | null;
  outputPlatform: string | null;
}

export interface TaskContext {
  platform: "slack" | "whatsapp";
  contextType: "dm" | "channel" | "group";
  deliveryTarget: string;
  createdBy: string | null;
  /**
   * Creator's IANA timezone, used as the default for new scheduled tasks when
   * the agent doesn't pass `timezone` explicitly. Null means "fall through to UTC".
   */
  creatorTimezone?: string | null;
  threadTs?: string;
}
