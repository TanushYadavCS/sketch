interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function createTokenBucketRateLimiter(options: { capacity: number; refillPerMinute: number }) {
  const buckets = new Map<string, Bucket>();

  return {
    consume(key: string, now = Date.now()): boolean {
      const refillPerMs = options.refillPerMinute / 60_000;
      const bucket = buckets.get(key) ?? { tokens: options.capacity, updatedAt: now };
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = now;

      if (bucket.tokens < 1) {
        buckets.set(key, bucket);
        return false;
      }

      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return true;
    },
  };
}

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}
