import { describe, expect, it } from "vitest";
import { Semaphore, createTokenBucketRateLimiter } from "./rate-limit";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("token bucket rate limiter", () => {
  it("limits by the provided key", () => {
    const limiter = createTokenBucketRateLimiter({ capacity: 2, refillPerMinute: 0 });

    expect(limiter.consume("token-1")).toBe(true);
    expect(limiter.consume("token-1")).toBe(true);
    expect(limiter.consume("token-1")).toBe(false);
    expect(limiter.consume("token-2")).toBe(true);
  });
});

describe("Semaphore", () => {
  it("never runs more than max tasks concurrently", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let maxSeen = 0;
    const releases = Array.from({ length: 8 }, () => deferred());

    const tasks = releases.map((release) =>
      semaphore.run(async () => {
        active += 1;
        maxSeen = Math.max(maxSeen, active);
        await release.promise;
        active -= 1;
      }),
    );

    await Promise.resolve();
    expect(maxSeen).toBe(2);

    for (const release of releases) {
      release.resolve();
      await Promise.resolve();
      expect(maxSeen).toBeLessThanOrEqual(2);
    }

    await Promise.all(tasks);
    expect(active).toBe(0);
  });
});
