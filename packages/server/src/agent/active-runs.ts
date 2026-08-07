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
    return await fn();
  } finally {
    unregisterActiveRun(key, controller);
  }
}

export function webChatRunKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

export function withActiveWebChatRun<T>(
  userId: string,
  conversationId: string,
  abortController: AbortController,
  fn: () => Promise<T>,
): Promise<T> {
  return withActiveRun(webChatRunKey(userId, conversationId), abortController, fn, { platform: "web" });
}

export function interruptActiveWebChatRun(userId: string, conversationId: string): boolean {
  return abortActiveRun(webChatRunKey(userId, conversationId));
}
