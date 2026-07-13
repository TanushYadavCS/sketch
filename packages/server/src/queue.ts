/**
 * Per-channel in-memory message queue.
 * Ensures sequential processing — one agent run at a time per channel.
 * Errors in work items are caught to prevent unhandled rejections.
 */

import type { Logger } from "./logger";

/**
 * Maximum number of items allowed to wait in a single queue's backlog.
 * Bounds memory and downstream cost when a producer (a flooding chat, a
 * misconfigured interval task) outpaces the single-flight consumer. The
 * currently-running item is not counted, so an active run plus a full backlog
 * is MAX_QUEUE_DEPTH + 1 in-flight work functions.
 */
export const MAX_QUEUE_DEPTH = 50;

export interface ChannelQueueOptions {
  logger?: Logger;
  key?: string;
  onIdle?: () => void;
}

export class ChannelQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private readonly logger?: Logger;
  private readonly key?: string;
  private readonly onIdle?: () => void;

  constructor(options: ChannelQueueOptions = {}) {
    this.logger = options.logger;
    this.key = options.key;
    this.onIdle = options.onIdle;
  }

  /**
   * Appends work for sequential processing.
   * Returns true when accepted, false when the backlog is already at
   * MAX_QUEUE_DEPTH and the item is shed. Callers that ignore the result keep
   * the previous fire-and-forget contract for the normal (accepted) path.
   */
  enqueue(work: () => Promise<void>): boolean {
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      this.logger?.warn(
        { queueKey: this.key, depth: this.queue.length, cap: MAX_QUEUE_DEPTH },
        "Queue backlog full, shedding message",
      );
      return false;
    }
    this.queue.push(work);
    this.processNext();
    return true;
  }

  /**
   * True when nothing is queued and nothing is running, so the owner can
   * safely evict this instance without dropping in-flight work.
   */
  isIdle(): boolean {
    return !this.processing && this.queue.length === 0;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const work = this.queue.shift();
    if (!work) {
      this.processing = false;
      return;
    }
    try {
      await work();
    } catch (err) {
      // Errors should be handled inside the work function.
      // This catch prevents unhandled promise rejections from blocking the queue.
      console.error("Unhandled error in queue work item:", err);
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        this.processNext();
      } else {
        this.onIdle?.();
      }
    }
  }
}

export interface QueueManagerOptions {
  logger?: Logger;
}

export class QueueManager {
  private queues = new Map<string, ChannelQueue>();
  private readonly logger?: Logger;

  constructor(options: QueueManagerOptions = {}) {
    this.logger = options.logger;
  }

  getQueue(channelId: string): ChannelQueue {
    const existing = this.queues.get(channelId);
    if (existing) return existing;
    const queue = new ChannelQueue({
      logger: this.logger,
      key: channelId,
      onIdle: () => this.evictIfIdle(channelId, queue),
    });
    this.queues.set(channelId, queue);
    return queue;
  }

  /**
   * Number of live queues. Exposed so callers and tests can observe that
   * drained per-conversation/per-task keys are evicted rather than leaked.
   */
  size(): number {
    return this.queues.size;
  }

  /**
   * Removes a drained queue from the map. Runs synchronously from the queue's
   * onIdle callback, so no enqueue can interleave between the idle check and
   * the delete. The identity guard ensures a queue that was already replaced
   * (or has received new work) is never evicted out from under active work.
   */
  private evictIfIdle(channelId: string, queue: ChannelQueue): void {
    const current = this.queues.get(channelId);
    if (current === queue && queue.isIdle()) {
      this.queues.delete(channelId);
    }
  }
}
