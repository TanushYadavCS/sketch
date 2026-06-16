import type { Logger } from "../logger";
import type { DailyBriefService } from "./service";

export interface DailyBriefSchedulerDeps {
  service: DailyBriefService;
  logger: Logger;
  intervalMs?: number;
}

export class DailyBriefScheduler {
  private deps: DailyBriefSchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: DailyBriefSchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.deps.logger.error({ err }, "Daily Brief scheduler tick failed");
      });
    }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const users = await this.deps.service.listSchedulableUsers();
      for (const user of users) {
        try {
          const due = await this.deps.service.shouldGenerateForUser(user, now);
          if (!due) continue;
          await this.deps.service.requestGenerationForUser({
            userId: user.id,
            briefDate: due.briefDate,
            triggerType: "scheduled",
            skipIfCompleted: true,
          });
        } catch (err) {
          this.deps.logger.warn({ err, userId: user.id }, "Daily Brief scheduler skipped user");
        }
      }
    } finally {
      this.running = false;
    }
  }
}
