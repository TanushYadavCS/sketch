/**
 * Types for the unified automation model.
 *
 * Every automation is a workflow: a trigger step + one or more execution steps.
 * Simple tasks are single-step workflows (trigger + agent). Multi-step automations
 * have additional action/agent steps.
 *
 * Step content (prompts, scripts) lives in the automation_step_content table,
 * not in these structures. The runtime loads content at execution time.
 */

export interface WorkflowStep {
  id: string;
  type: "trigger" | "action" | "agent";
  label: string;
  icon: string;
  position: { x: number; y: number };

  /** Agent step config. Prompt content lives in automation_step_content. */
  agentMode?: "light" | "sketch";
  agentSkills?: string[];
  agentModel?: string;
  agentMcpServers?: string[];

  /** Timeout in seconds. Default: 1800 (30 min). */
  timeout?: number;

  /** Trigger step config. */
  triggerConfig?: {
    type: "webhook" | "schedule";
    scheduleType?: "cron" | "interval" | "once";
    scheduleValue?: string;
    timezone?: string;
  };
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
  label?: string;
}

export interface StepOutput {
  output: unknown;
  status: "completed" | "failed" | "skipped";
  duration_ms: number;
  error?: {
    message: string;
    stack?: string;
  };
}
