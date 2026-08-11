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

export class WorkflowMessageDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowMessageDeliveryError";
  }
}

function isSerializedJsonDocument(value: string): boolean {
  let candidate = value.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

export function requireWorkflowMessageText(output: unknown): string {
  if (typeof output !== "string" || output.trim().length === 0) {
    throw new WorkflowMessageDeliveryError(
      "Message delivery requires the final workflow step to return a non-empty human-readable string",
    );
  }
  const message = output.trim();
  if (isSerializedJsonDocument(message)) {
    throw new WorkflowMessageDeliveryError(
      "Message delivery cannot contain serialized JSON; return a human-readable message string instead",
    );
  }
  return message;
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
