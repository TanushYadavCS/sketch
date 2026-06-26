import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { createAgentRunLimiter } from "./concurrency-limiter";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function captureLogger() {
  const entries: Array<{ fields: Record<string, unknown>; message: string }> = [];
  return {
    entries,
    logger: {
      info: (fields: Record<string, unknown>, message: string) => {
        entries.push({ fields, message });
      },
    } as Pick<Logger, "info">,
  };
}

describe("AgentRunLimiter", () => {
  it("caps concurrent work and starts queued runs FIFO", async () => {
    const { logger, entries } = captureLogger();
    const limiter = createAgentRunLimiter({ limit: 2, logger });
    const releases = Array.from({ length: 5 }, () => deferred<void>());
    const started: number[] = [];
    const finished: number[] = [];
    let active = 0;
    let maxActive = 0;

    const runs = releases.map((release, index) =>
      limiter.run(async () => {
        started.push(index);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await release.promise;
        active -= 1;
        finished.push(index);
        return index;
      }),
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    expect(limiter.snapshot()).toEqual({ limit: 2, active: 2, waiting: 3 });

    releases[0].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    expect(maxActive).toBe(2);
    expect(limiter.snapshot()).toEqual({ limit: 2, active: 2, waiting: 2 });

    releases[1].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));

    releases[2].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));

    releases[3].resolve();
    releases[4].resolve();

    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(finished.sort()).toEqual([0, 1, 2, 3, 4]);
    expect(maxActive).toBe(2);
    expect(entries.map((entry) => entry.fields.event)).toContain("agent_run_limiter_wait");
    expect(entries.map((entry) => entry.fields.event)).toContain("agent_run_limiter_start");
    expect(entries.map((entry) => entry.fields.event)).toContain("agent_run_limiter_finish");
  });

  it("continues queued work after a running task fails", async () => {
    const { logger } = captureLogger();
    const limiter = createAgentRunLimiter({ limit: 1, logger });
    const failFirst = deferred<void>();
    const started: number[] = [];

    const first = limiter.run(async () => {
      started.push(0);
      await failFirst.promise;
      throw new Error("first failed");
    });
    const second = limiter.run(async () => {
      started.push(1);
      return "second complete";
    });

    await vi.waitFor(() => expect(started).toEqual([0]));
    expect(limiter.snapshot()).toEqual({ limit: 1, active: 1, waiting: 1 });

    failFirst.resolve();

    await expect(first).rejects.toThrow("first failed");
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    await expect(second).resolves.toBe("second complete");
    expect(limiter.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 });
  });

  it("lets nested agent work reuse the active slot without bypassing queued independent work", async () => {
    const { logger, entries } = captureLogger();
    const limiter = createAgentRunLimiter({ limit: 1, logger });
    const releaseOuter = deferred<void>();
    const started: string[] = [];

    const outer = limiter.run(async () => {
      started.push("outer");
      const nested = await limiter.run(async () => {
        started.push("nested");
        return "nested complete";
      });
      expect(nested).toBe("nested complete");
      await releaseOuter.promise;
      return "outer complete";
    });

    const independent = limiter.run(async () => {
      started.push("independent");
      return "independent complete";
    });

    await vi.waitFor(() => expect(started).toEqual(["outer", "nested"]));
    expect(limiter.snapshot()).toEqual({ limit: 1, active: 1, waiting: 1 });
    expect(entries.some((entry) => entry.fields.event === "agent_run_limiter_start" && entry.fields.reentrant)).toBe(
      true,
    );

    releaseOuter.resolve();

    await expect(outer).resolves.toBe("outer complete");
    await vi.waitFor(() => expect(started).toEqual(["outer", "nested", "independent"]));
    await expect(independent).resolves.toBe("independent complete");
    expect(limiter.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 });
  });

  it("logs limiter wait, start, and finish fields", async () => {
    const { logger, entries } = captureLogger();
    const limiter = createAgentRunLimiter({ limit: 1, logger });
    const releaseFirst = deferred<void>();

    const first = limiter.run(async () => {
      await releaseFirst.promise;
    });
    const second = limiter.run(async () => undefined);

    await vi.waitFor(() => expect(entries.some((entry) => entry.fields.event === "agent_run_limiter_wait")).toBe(true));
    releaseFirst.resolve();
    await Promise.all([first, second]);

    for (const entry of entries) {
      expect(entry.fields).toMatchObject({
        limit: expect.any(Number),
        active: expect.any(Number),
        waiting: expect.any(Number),
      });
      if (entry.fields.event === "agent_run_limiter_start" || entry.fields.event === "agent_run_limiter_wait") {
        expect(entry.fields.waitMs).toEqual(expect.any(Number));
      }
      if (entry.fields.event === "agent_run_limiter_finish") {
        expect(entry.fields.durationMs).toEqual(expect.any(Number));
      }
    }
  });
});
