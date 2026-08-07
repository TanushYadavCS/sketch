import { describe, expect, it, vi } from "vitest";
import { ChannelQueue, MAX_QUEUE_DEPTH, QueueManager } from "./queue";

/**
 * Creates a work function whose completion is controlled by an external
 * resolver, so tests can hold a queue busy while asserting backlog behavior.
 */
function createGatedWork(): { work: () => Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { work: () => gate, release };
}

/**
 * Helper that creates a delayed work function.
 * Records execution order in the provided array and optionally delays to simulate async work.
 */
function createWork(order: number[], id: number, delayMs = 0): () => Promise<void> {
  return async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    order.push(id);
  };
}

describe("ChannelQueue", () => {
  it("clears only the backlog and returns the number of dropped items", async () => {
    const queue = new ChannelQueue();
    const running = createGatedWork();
    const completed: number[] = [];

    queue.enqueue(running.work);
    queue.enqueue(async () => {
      completed.push(1);
    });
    queue.enqueue(async () => {
      completed.push(2);
    });

    expect(queue.clear()).toBe(2);
    expect(queue.clear()).toBe(0);
    running.release();

    await vi.waitFor(() => expect(queue.isIdle()).toBe(true));
    expect(completed).toEqual([]);
  });

  it("processes items sequentially in enqueue order", async () => {
    const queue = new ChannelQueue();
    const order: number[] = [];

    queue.enqueue(createWork(order, 1, 10));
    queue.enqueue(createWork(order, 2, 10));
    queue.enqueue(createWork(order, 3, 10));

    await vi.waitFor(() => expect(order).toEqual([1, 2, 3]));
  });

  it("continues processing after an error in a work item", async () => {
    const queue = new ChannelQueue();
    const order: number[] = [];

    queue.enqueue(createWork(order, 1));
    queue.enqueue(async () => {
      throw new Error("boom");
    });
    queue.enqueue(createWork(order, 3));

    await vi.waitFor(() => expect(order).toEqual([1, 3]));
  });

  it("processes items one at a time with no concurrent overlap", async () => {
    const queue = new ChannelQueue();
    let concurrency = 0;
    let maxConcurrency = 0;
    const order: number[] = [];

    for (let i = 0; i < 3; i++) {
      queue.enqueue(async () => {
        concurrency++;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        await new Promise((r) => setTimeout(r, 20));
        order.push(i);
        concurrency--;
      });
    }

    await vi.waitFor(() => expect(order).toEqual([0, 1, 2]));
    expect(maxConcurrency).toBe(1);
  });

  it("does nothing when no items are enqueued", async () => {
    const queue = new ChannelQueue();
    await new Promise((r) => setTimeout(r, 20));
    expect(true).toBe(true);
  });

  it("sheds work once the backlog reaches the depth cap", async () => {
    const warn = vi.fn();
    const queue = new ChannelQueue({ logger: { warn } as never, key: "ch-cap" });

    const running = createGatedWork();
    expect(queue.enqueue(running.work)).toBe(true);

    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
      expect(queue.enqueue(async () => {})).toBe(true);
    }

    expect(queue.enqueue(async () => {})).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueKey: "ch-cap", depth: MAX_QUEUE_DEPTH, cap: MAX_QUEUE_DEPTH }),
      expect.stringContaining("shedding"),
    );

    running.release();
    await vi.waitFor(() => expect(queue.isIdle()).toBe(true));

    expect(queue.enqueue(async () => {})).toBe(true);
  });
});

describe("QueueManager", () => {
  it("clears an existing queue without creating a missing queue", async () => {
    const manager = new QueueManager();
    expect(manager.clear("missing")).toBe(0);
    expect(manager.size()).toBe(0);

    const running = createGatedWork();
    const otherRunning = createGatedWork();
    const queue = manager.getQueue("target");
    const otherQueue = manager.getQueue("other");
    queue.enqueue(running.work);
    queue.enqueue(async () => {});
    queue.enqueue(async () => {});
    otherQueue.enqueue(otherRunning.work);

    expect(manager.clear("target")).toBe(2);
    expect(otherQueue.isIdle()).toBe(false);
    expect(manager.size()).toBe(2);

    running.release();
    await vi.waitFor(() => expect(manager.size()).toBe(1));
    otherRunning.release();
    await vi.waitFor(() => expect(manager.size()).toBe(0));
    expect(manager.clear("target")).toBe(0);
  });

  it("returns the same instance for the same channelId", () => {
    const manager = new QueueManager();
    const q1 = manager.getQueue("channel-1");
    const q2 = manager.getQueue("channel-1");
    expect(q1).toBe(q2);
  });

  it("returns different instances for different channelIds", () => {
    const manager = new QueueManager();
    const q1 = manager.getQueue("channel-1");
    const q2 = manager.getQueue("channel-2");
    expect(q1).not.toBe(q2);
  });

  it("processes queues for different channels independently and concurrently", async () => {
    const manager = new QueueManager();
    const timestamps: { channel: string; event: string; time: number }[] = [];

    const createTimedWork = (channel: string, delayMs: number) => async () => {
      timestamps.push({ channel, event: "start", time: Date.now() });
      await new Promise((r) => setTimeout(r, delayMs));
      timestamps.push({ channel, event: "end", time: Date.now() });
    };

    manager.getQueue("ch-a").enqueue(createTimedWork("ch-a", 50));
    manager.getQueue("ch-b").enqueue(createTimedWork("ch-b", 50));

    await vi.waitFor(() => expect(timestamps).toHaveLength(4));

    const find = (channel: string, event: string) => {
      const entry = timestamps.find((t) => t.channel === channel && t.event === event);
      expect(entry).toBeDefined();
      return entry as { channel: string; event: string; time: number };
    };

    const startA = find("ch-a", "start");
    const startB = find("ch-b", "start");
    const endA = find("ch-a", "end");
    const endB = find("ch-b", "end");

    expect(startA.time).toBeLessThan(endB.time);
    expect(startB.time).toBeLessThan(endA.time);
  });

  it("evicts a queue once it drains to empty", async () => {
    const manager = new QueueManager();
    manager.getQueue("ch-drain").enqueue(async () => {});

    expect(manager.size()).toBe(1);
    await vi.waitFor(() => expect(manager.size()).toBe(0));
  });

  it("returns a fresh instance after a drained queue is evicted", async () => {
    const manager = new QueueManager();
    const first = manager.getQueue("ch-recycle");
    first.enqueue(async () => {});
    await vi.waitFor(() => expect(manager.size()).toBe(0));

    const second = manager.getQueue("ch-recycle");
    expect(second).not.toBe(first);
    expect(manager.size()).toBe(1);
  });

  it("does not evict a queue that receives new work while draining", async () => {
    const manager = new QueueManager();
    const order: number[] = [];
    let secondEnqueued = false;

    manager.getQueue("ch-race").enqueue(async () => {
      order.push(1);
      manager.getQueue("ch-race").enqueue(async () => {
        order.push(2);
      });
      secondEnqueued = true;
    });

    await vi.waitFor(() => expect(secondEnqueued).toBe(true));
    expect(manager.size()).toBe(1);

    await vi.waitFor(() => expect(order).toEqual([1, 2]));
    await vi.waitFor(() => expect(manager.size()).toBe(0));
  });

  it("keeps the same live instance across enqueue while draining", async () => {
    const manager = new QueueManager();
    const running = createGatedWork();
    const instance = manager.getQueue("ch-stable");
    instance.enqueue(running.work);

    expect(manager.getQueue("ch-stable")).toBe(instance);

    running.release();
    await vi.waitFor(() => expect(manager.size()).toBe(0));
  });
});
