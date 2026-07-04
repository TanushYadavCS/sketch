import type { Logger } from "../logger";
import type { AgentRunService } from "./service";

export interface AgentSchedulerDeps {
  service: AgentRunService;
  logger: Logger;
  intervalMs?: number;
}

/**
 * Periodically walks every prebuilt agent definition against every schedulable user
 * and requests generation for any that are due. Per-user `enabled` (default-on for the
 * Daily Brief, off for future agents) is enforced inside the service.
 */
export class AgentScheduler {
  private deps: AgentSchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: AgentSchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.deps.logger.error({ err }, "Agent scheduler tick failed");
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
      const [users, definitions] = [
        await this.deps.service.listSchedulableUsers(),
        this.deps.service.listDefinitions(),
      ];
      for (const user of users) {
        for (const def of definitions) {
          try {
            const due = await this.deps.service.shouldGenerateForUser(def, user, now);
            if (!due) continue;
            const generations = await this.deps.service.requestGenerationForUser({
              agentKey: def.key,
              userId: user.id,
              outputDate: due.outputDate,
              triggerType: "scheduled",
              skipIfCompleted: true,
            });
            for (const generation of generations) {
              this.deps.logger.debug(
                { userId: user.id, agentKey: def.key, outputId: generation.id, sourceKey: generation.source_key },
                "Agent scheduler generation considered",
              );
            }
          } catch (err) {
            this.deps.logger.warn({ err, userId: user.id, agentKey: def.key }, "Agent scheduler skipped user");
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
