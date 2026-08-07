import { AsyncLocalStorage } from "node:async_hooks";

export interface ActiveRunMetadata {
  platform: "slack" | "web";
  channelId?: string;
  threadTs?: string | null;
}

export interface ActiveRunEntry {
  key: string;
  controller: AbortController;
  metadata?: ActiveRunMetadata;
}

const activeRuns = new Map<string, ActiveRunEntry>();
const activeRunContext = new AsyncLocalStorage<{
  controller: AbortController;
  metadata?: ActiveRunMetadata;
}>();

export function registerActiveRun(key: string, controller: AbortController, metadata?: ActiveRunMetadata): void {
  activeRuns.set(key, { key, controller, metadata });
}

/** Only the controller that owns the current entry may remove it. */
export function unregisterActiveRun(key: string, controller: AbortController): void {
  if (activeRuns.get(key)?.controller === controller) activeRuns.delete(key);
}

export function abortActiveRun(key: string): boolean {
  const activeRun = activeRuns.get(key);
  if (!activeRun || activeRun.controller.signal.aborted) return false;
  activeRun.controller.abort();
  return true;
}

export function abortActiveRuns(predicate: (entry: ActiveRunEntry) => boolean): number {
  let aborted = 0;
  for (const entry of activeRuns.values()) {
    if (!predicate(entry) || entry.controller.signal.aborted) continue;
    entry.controller.abort();
    aborted += 1;
  }
  return aborted;
}

export function createChildAbortController(parentSignal?: AbortSignal): AbortController {
  const childController = new AbortController();
  if (!parentSignal) return childController;

  const combinedSignal = AbortSignal.any([parentSignal, childController.signal]);
  const abortChild = () => childController.abort(combinedSignal.reason);
  if (combinedSignal.aborted) {
    abortChild();
  } else {
    combinedSignal.addEventListener("abort", abortChild, { once: true });
  }
  return childController;
}

export function getActiveRunContext():
  | {
      controller: AbortController;
      metadata?: ActiveRunMetadata;
    }
  | undefined {
  return activeRunContext.getStore();
}

export function isActiveRun(key: string): boolean {
  const activeRun = activeRuns.get(key);
  return Boolean(activeRun && !activeRun.controller.signal.aborted);
}

export function listActiveRuns(): ActiveRunEntry[] {
  return [...activeRuns.values()];
}

export async function withActiveRun<T>(
  key: string,
  controller: AbortController,
  fn: () => Promise<T>,
  metadata?: ActiveRunMetadata,
): Promise<T> {
  registerActiveRun(key, controller, metadata);
  try {
    return await activeRunContext.run({ controller, metadata }, fn);
  } finally {
    unregisterActiveRun(key, controller);
  }
}

export function webChatRunKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

export function builderWebChatRunKey(taskId: string): string {
  return `builder:${taskId}`;
}

export function withActiveWebChatRun<T>(
  userId: string,
  conversationId: string,
  abortController: AbortController,
  fn: () => Promise<T>,
): Promise<T> {
  return withActiveRun(webChatRunKey(userId, conversationId), abortController, fn, { platform: "web" });
}

export function withActiveBuilderWebChatRun<T>(
  taskId: string,
  abortController: AbortController,
  fn: () => Promise<T>,
): Promise<T> {
  return withActiveRun(builderWebChatRunKey(taskId), abortController, fn, { platform: "web" });
}

export function interruptActiveWebChatRun(userId: string, conversationId: string): boolean {
  return abortActiveRun(webChatRunKey(userId, conversationId));
}

export function interruptActiveBuilderWebChatRun(taskId: string): boolean {
  return abortActiveRun(builderWebChatRunKey(taskId));
}
