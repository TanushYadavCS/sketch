import type { AgentOutputRow, AgentOutputTriggerType } from "../../db/repositories/agent-outputs";
import type { Logger } from "../../logger";
import type { QueueManager } from "../../queue";

export interface ScheduledRunAdmission {
  controller: AbortController;
  state: "queued" | "active" | "promoted";
}

interface AgentOutputRunQueueRepository {
  findById(agentKey: string, outputId: string): Promise<AgentOutputRow | undefined>;
  promoteRunningToManual(agentKey: string, outputId: string): Promise<AgentOutputRow | undefined>;
}

interface AgentOutputRunQueueDeps {
  logger: Pick<Logger, "error">;
  queueManager?: QueueManager;
  repo: AgentOutputRunQueueRepository;
  run: (params: {
    agentKey: string;
    outputId: string;
    userId: string;
    scheduledAdmission?: ScheduledRunAdmission;
  }) => Promise<void>;
}

interface EnqueueRunParams {
  agentKey: string;
  outputId: string;
  userId: string;
  triggerType: AgentOutputTriggerType;
  startWhen?: Promise<boolean>;
}

interface PromoteScheduledRunParams {
  agentKey: string;
  output: AgentOutputRow;
  userId: string;
}

interface ReplacementGate {
  decision: Promise<boolean>;
  accept: () => void;
  reject: () => void;
}

export class AgentOutputRunQueue {
  private readonly scheduledAdmissions = new Map<string, ScheduledRunAdmission>();

  constructor(private readonly deps: AgentOutputRunQueueDeps) {}

  enqueue(params: EnqueueRunParams): boolean {
    const admission = this.createScheduledAdmission(params);
    const task = this.createTask(params, admission);

    if (!this.deps.queueManager) {
      this.runInBackground(task, params);
      return true;
    }

    const accepted = this.deps.queueManager
      .getQueue(`agent-${params.triggerType}-${params.agentKey}-${params.userId}`)
      .enqueue(task);
    if (!accepted) this.removeAdmission(params.outputId, admission);
    return accepted;
  }

  async promoteScheduledToManual(params: PromoteScheduledRunParams): Promise<AgentOutputRow> {
    const admission = this.scheduledAdmissions.get(params.output.id);
    if (admission?.state === "active") return params.output;

    const replacement = this.createReplacementGate();
    const accepted = this.enqueue({
      agentKey: params.agentKey,
      outputId: params.output.id,
      userId: params.userId,
      triggerType: "manual",
      startWhen: replacement.decision,
    });
    if (!accepted) return params.output;

    this.cancelScheduledAdmission(admission);
    try {
      return await this.commitManualPromotion(params, admission, replacement);
    } catch (error) {
      replacement.reject();
      this.restoreScheduledRun(params, admission);
      throw error;
    }
  }

  private async commitManualPromotion(
    params: PromoteScheduledRunParams,
    admission: ScheduledRunAdmission | undefined,
    replacement: ReplacementGate,
  ): Promise<AgentOutputRow> {
    const promoted = await this.deps.repo.promoteRunningToManual(params.agentKey, params.output.id);
    if (promoted) {
      replacement.accept();
      return promoted;
    }

    replacement.reject();
    const current = await this.deps.repo.findById(params.agentKey, params.output.id);
    if (current?.status === "running" && current.trigger_type === "scheduled") {
      this.restoreScheduledRun(params, admission);
    }
    return current ?? params.output;
  }

  private createScheduledAdmission(params: EnqueueRunParams): ScheduledRunAdmission | undefined {
    if (params.triggerType !== "scheduled") return undefined;
    const admission: ScheduledRunAdmission = { controller: new AbortController(), state: "queued" };
    this.scheduledAdmissions.set(params.outputId, admission);
    return admission;
  }

  private createTask(params: EnqueueRunParams, admission: ScheduledRunAdmission | undefined) {
    return async () => {
      try {
        if (params.startWhen && !(await params.startWhen)) return;
        await this.deps.run({
          agentKey: params.agentKey,
          outputId: params.outputId,
          userId: params.userId,
          scheduledAdmission: admission,
        });
      } finally {
        this.removeAdmission(params.outputId, admission);
      }
    };
  }

  private runInBackground(task: () => Promise<void>, params: EnqueueRunParams): void {
    task().catch((error) => {
      this.deps.logger.error(
        { err: error, agentKey: params.agentKey, outputId: params.outputId, userId: params.userId },
        "Agent: background generation failed",
      );
    });
  }

  private cancelScheduledAdmission(admission: ScheduledRunAdmission | undefined): void {
    if (!admission) return;
    admission.state = "promoted";
    admission.controller.abort();
  }

  private restoreScheduledRun(params: PromoteScheduledRunParams, admission: ScheduledRunAdmission | undefined): void {
    if (!admission) return;
    this.enqueue({
      agentKey: params.agentKey,
      outputId: params.output.id,
      userId: params.userId,
      triggerType: "scheduled",
    });
  }

  private removeAdmission(outputId: string, admission: ScheduledRunAdmission | undefined): void {
    if (admission && this.scheduledAdmissions.get(outputId) === admission) {
      this.scheduledAdmissions.delete(outputId);
    }
  }

  private createReplacementGate(): ReplacementGate {
    let resolve!: (run: boolean) => void;
    const decision = new Promise<boolean>((next) => {
      resolve = next;
    });
    return {
      decision,
      accept: () => resolve(true),
      reject: () => resolve(false),
    };
  }
}
