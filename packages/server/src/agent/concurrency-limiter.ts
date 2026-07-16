import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "../logger";

interface AgentRunLimiterOptions {
  limit: number;
  queue: "interactive" | "scheduled";
  logger: Pick<Logger, "info">;
  now?: () => number;
}

export interface AgentRunAdmissionOptions {
  signal?: AbortSignal;
  onStart?: () => void;
}

export class AgentRunAdmissionCancelledError extends Error {
  constructor() {
    super("Agent run admission cancelled");
    this.name = "AgentRunAdmissionCancelledError";
  }
}

interface Waiter {
  queuedAt: number;
  resolve: (waitMs: number) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ActiveRunContext {
  active: boolean;
}

export class AgentRunLimiter {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private readonly limit: number;
  private readonly queue: "interactive" | "scheduled";
  private readonly logger: Pick<Logger, "info">;
  private readonly now: () => number;
  private readonly activeRunContext = new AsyncLocalStorage<ActiveRunContext>();

  constructor(options: AgentRunLimiterOptions) {
    this.limit = options.limit;
    this.queue = options.queue;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  async run<T>(work: () => Promise<T>, admission: AgentRunAdmissionOptions = {}): Promise<T> {
    if (admission.signal?.aborted) throw new AgentRunAdmissionCancelledError();
    if (this.activeRunContext.getStore()?.active) {
      admission.onStart?.();
      return this.runReentrant(work);
    }

    const admissionResult = this.acquire(admission.signal);
    const waitMs = typeof admissionResult === "number" ? admissionResult : await admissionResult;
    admission.onStart?.();
    const startedAt = this.now();
    const runContext: ActiveRunContext = { active: true };

    this.logger.info(
      {
        event: "agent_run_limiter_start",
        queue: this.queue,
        limit: this.limit,
        active: this.active,
        waiting: this.waiting.length,
        waitMs,
      },
      "Agent run limiter started run",
    );

    try {
      return await this.activeRunContext.run(runContext, work);
    } finally {
      runContext.active = false;
      const durationMs = this.now() - startedAt;
      this.release();
      this.logger.info(
        {
          event: "agent_run_limiter_finish",
          queue: this.queue,
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

  private async runReentrant<T>(work: () => Promise<T>): Promise<T> {
    const startedAt = this.now();

    this.logger.info(
      {
        event: "agent_run_limiter_start",
        queue: this.queue,
        limit: this.limit,
        active: this.active,
        waiting: this.waiting.length,
        waitMs: 0,
        reentrant: true,
      },
      "Agent run limiter started run",
    );

    try {
      return await work();
    } finally {
      const durationMs = this.now() - startedAt;
      this.logger.info(
        {
          event: "agent_run_limiter_finish",
          queue: this.queue,
          limit: this.limit,
          active: this.active,
          waiting: this.waiting.length,
          waitMs: 0,
          durationMs,
          reentrant: true,
        },
        "Agent run limiter finished run",
      );
    }
  }

  snapshot() {
    return { limit: this.limit, active: this.active, waiting: this.waiting.length };
  }

  private acquire(signal?: AbortSignal): number | Promise<number> {
    if (signal?.aborted) throw new AgentRunAdmissionCancelledError();
    if (this.active < this.limit) {
      this.active += 1;
      return 0;
    }

    const queuedAt = this.now();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { queuedAt, resolve, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index === -1) return;
          this.waiting.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort as () => void);
          reject(new AgentRunAdmissionCancelledError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiting.push(waiter);
      this.logger.info(
        {
          event: "agent_run_limiter_wait",
          queue: this.queue,
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

    if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
    this.active += 1;
    next.resolve(this.now() - next.queuedAt);
  }
}

export function createAgentRunLimiter(options: AgentRunLimiterOptions) {
  return new AgentRunLimiter(options);
}
