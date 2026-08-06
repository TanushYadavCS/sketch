import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";

export type DeliveryPlatform = "slack" | "whatsapp";
export type DeliveryTargetType = "dm" | "channel" | "group" | "thread";
export type DeliveryMode = "deliver" | "silent";

export interface WorkflowDelivery {
  platform: DeliveryPlatform;
  targetType: DeliveryTargetType;
  targetId: string;
  threadTs: string | null;
  mode: DeliveryMode;
}

export function isSlackUserId(value: string): boolean {
  return value.startsWith("U") || value.startsWith("W");
}

export function isSlackDmChannelId(value: string): boolean {
  return value.startsWith("D");
}

function normalizePlatform(value: string | null): DeliveryPlatform {
  return value === "whatsapp" ? "whatsapp" : "slack";
}

function normalizeMode(value: string | null | undefined): DeliveryMode {
  return value === "silent" ? "silent" : "deliver";
}

function inferTargetType(
  platform: DeliveryPlatform,
  targetId: string,
  fallbackContextType: string,
  threadTs: string | null,
): DeliveryTargetType {
  if (platform === "whatsapp") {
    return targetId.endsWith("@g.us") ? "group" : "dm";
  }
  if (threadTs) return "thread";
  if (isSlackDmChannelId(targetId) || isSlackUserId(targetId)) return "dm";
  if (fallbackContextType === "dm" && !targetId.startsWith("C")) return "dm";
  return "channel";
}

export function resolveWorkflowDelivery(task: ScheduledTaskRow): WorkflowDelivery {
  const targetId = task.output_target ?? task.delivery_target;
  const platform = normalizePlatform(task.output_target ? (task.output_platform ?? task.platform) : task.platform);
  const threadTs = platform === "slack" ? (task.output_thread_ts ?? null) : null;
  return {
    platform,
    targetType: inferTargetType(platform, targetId, task.context_type, threadTs),
    targetId,
    threadTs,
    mode: normalizeMode(task.output_mode),
  };
}
