import { type WorkflowTriggerConfig, workflowTriggerConfigSchema } from "@sketch/shared";

export const AUTOMATION_WEBHOOK_PATH = "/api/webhooks/wf";

export function buildAutomationWebhookUrl(
  taskId: string,
  options: { baseUrl?: string | null; port?: number } = {},
): string {
  const baseUrl = options.baseUrl?.trim().replace(/\/+$/, "") || `http://localhost:${options.port ?? 3000}`;
  return `${baseUrl}${AUTOMATION_WEBHOOK_PATH}/${encodeURIComponent(taskId)}`;
}

export function isAutomationWebhookTrigger(config: WorkflowTriggerConfig | undefined): boolean {
  return config?.type === "webhook";
}

export function parseAutomationTriggerConfig(
  value: string | null,
  fallback: { scheduleType: string; scheduleValue: string },
): WorkflowTriggerConfig | undefined {
  if (value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        const trigger = parsed.find(
          (step): step is { type: "trigger"; triggerConfig?: unknown } =>
            typeof step === "object" && step !== null && step.type === "trigger",
        );
        const result = workflowTriggerConfigSchema.safeParse(trigger?.triggerConfig);
        if (result.success) return result.data;
      }
    } catch {
      return undefined;
    }
  }

  if (fallback.scheduleType !== "external") return undefined;
  if (fallback.scheduleValue === "webhook") return { type: "webhook" };
  return undefined;
}

export function addWebhookMetadata(
  config: WorkflowTriggerConfig,
  taskId: string,
  options: { baseUrl?: string | null; port?: number } = {},
): WorkflowTriggerConfig {
  if (!isAutomationWebhookTrigger(config)) return config;
  return {
    ...config,
    webhookUrl: buildAutomationWebhookUrl(taskId, options),
    webhookMethod: "POST",
    webhookContentType: "application/json",
  };
}
