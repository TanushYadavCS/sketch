import type { Logger } from "../logger";

interface AgentRunLimiterOptions {
  limit: number;
  logger: Pick<Logger, "info">;
  now?: () => number;
}

interface Waiter {
  queuedAt: number;
  resolve: (waitMs: number) => void;
}

export class AgentRunLimiter {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private readonly limit: number;
  private readonly logger: Pick<Logger, "info">;
  private readonly now: () => number;

  constructor(options: AgentRunLimiterOptions) {
    this.limit = options.limit;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const waitMs = await this.acquire();
    const startedAt = this.now();

    this.logger.info(
      {
        event: "agent_run_limiter_start",
        limit: this.limit,
        active: this.active,
        waiting: this.waiting.length,
        waitMs,
      },
      "Agent run limiter started run",
    );

    try {
      return await work();
    } finally {
      const durationMs = this.now() - startedAt;
      this.release();
      this.logger.info(
        {
          event: "agent_run_limiter_finish",
          limit: this.limit,
          active: this.active,
          waiting: this.waiting.length,
          waitMs,
          durationMs,
        },
        "Agent run limiter finished run",
      );
    }
  }

  snapshot() {
    return { limit: this.limit, active: this.active, waiting: this.waiting.length };
  }

  private acquire(): Promise<number> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(0);
    }

    const queuedAt = this.now();
    return new Promise((resolve) => {
      this.waiting.push({ queuedAt, resolve });
      this.logger.info(
        {
          event: "agent_run_limiter_wait",
          limit: this.limit,
          active: this.active,
          waiting: this.waiting.length,
          waitMs: 0,
        },
        "Agent run limiter waiting for slot",
      );
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (!next) return;

    this.active += 1;
    next.resolve(this.now() - next.queuedAt);
  }
}

export function createAgentRunLimiter(options: AgentRunLimiterOptions) {
  return new AgentRunLimiter(options);
}
