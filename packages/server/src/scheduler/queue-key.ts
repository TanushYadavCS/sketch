import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import type { ScheduledTask, TaskContext } from "./types";

export function getScheduledTaskRowQueueKey(task: ScheduledTaskRow): string {
  return `task-${task.id}`;
}

export function getScheduledTaskQueueKey(task: ScheduledTask): string {
  return `task-${task.id}`;
}

export function getActiveTaskContextQueueKey(ctx: TaskContext): string | null {
  if (ctx.contextType === "dm") return ctx.createdBy ?? ctx.deliveryTarget;
  if (ctx.platform === "slack" && ctx.contextType === "channel") {
    return ctx.threadTs ? `${ctx.deliveryTarget}:${ctx.threadTs}` : null;
  }
  if (ctx.platform === "whatsapp" && ctx.contextType === "group") {
    return `wa-group-${ctx.deliveryTarget}`;
  }
  return null;
}
