import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import type { ScheduledTask, TaskContext } from "./types";

export function getScheduledTaskRowQueueKey(task: ScheduledTaskRow): string {
  if (task.session_mode === "chat") {
    const userId = task.created_by ?? task.delivery_target;
    if (task.context_type === "dm") return userId;
    if (task.platform === "slack" && task.context_type === "channel") {
      return task.thread_ts ? `${task.delivery_target}:${task.thread_ts}` : task.delivery_target;
    }
    return `wa-group-${task.delivery_target}`;
  }

  return `task-${task.id}`;
}

export function getScheduledTaskQueueKey(task: ScheduledTask): string {
  if (task.sessionMode === "chat") {
    const userId = task.createdBy ?? task.deliveryTarget;
    if (task.contextType === "dm") return userId;
    if (task.platform === "slack" && task.contextType === "channel") {
      return task.threadTs ? `${task.deliveryTarget}:${task.threadTs}` : task.deliveryTarget;
    }
    return `wa-group-${task.deliveryTarget}`;
  }

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
