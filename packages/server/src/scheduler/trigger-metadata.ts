import type { WorkflowStep } from "../workflows/types";

type ScheduleType = "cron" | "interval" | "once" | "external";
type LocalScheduleType = Exclude<ScheduleType, "external">;

export function formatIntervalScheduleLabel(rawSeconds: string): string {
  const seconds = Number.parseInt(rawSeconds, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return `Every ${rawSeconds} seconds`;
  }

  const units: Array<{ seconds: number; label: string }> = [
    { seconds: 86_400, label: "day" },
    { seconds: 3_600, label: "hour" },
    { seconds: 60, label: "minute" },
  ];

  for (const unit of units) {
    if (seconds % unit.seconds === 0) {
      const count = seconds / unit.seconds;
      return `Every ${count} ${unit.label}${count === 1 ? "" : "s"}`;
    }
  }

  return `Every ${seconds} seconds`;
}

export function formatScheduleTriggerLabel(params: {
  scheduleType: ScheduleType;
  scheduleValue: string;
  timezone: string;
}): string {
  if (params.scheduleType === "interval") {
    return formatIntervalScheduleLabel(params.scheduleValue);
  }

  if (params.scheduleType === "once") {
    return `Once at ${params.scheduleValue}`;
  }

  if (params.scheduleType === "cron") {
    const parts = params.scheduleValue.trim().split(/\s+/);
    if (parts.length === 5 && /^\*\/\d+$/.test(parts[0]) && parts.slice(1).every((part) => part === "*")) {
      const minutes = Number.parseInt(parts[0].slice(2), 10);
      if (Number.isFinite(minutes) && minutes > 0) {
        return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
      }
    }

    return `Cron: ${params.scheduleValue} (${params.timezone})`;
  }

  return "External trigger";
}

export function normalizeScheduleTriggerSteps(
  steps: WorkflowStep[],
  params: {
    scheduleType: LocalScheduleType;
    scheduleValue: string;
    timezone: string;
  },
): WorkflowStep[] {
  let updated = false;
  const next = steps.map((step) => {
    if (step.type !== "trigger" || step.triggerConfig?.type !== "schedule") return step;
    updated = true;
    return {
      ...step,
      label: formatScheduleTriggerLabel(params),
      triggerConfig: {
        ...step.triggerConfig,
        scheduleType: params.scheduleType,
        scheduleValue: params.scheduleValue,
        timezone: params.timezone,
      },
    };
  });

  return updated ? next : steps;
}

export function normalizeScheduleTriggerStepsJson(
  stepsValue: string | null | undefined,
  params: {
    scheduleType: LocalScheduleType;
    scheduleValue: string;
    timezone: string;
  },
): string | null | undefined {
  if (!stepsValue) return stepsValue;

  try {
    const parsed = JSON.parse(stepsValue) as WorkflowStep[];
    if (!Array.isArray(parsed)) return stepsValue;
    const normalized = normalizeScheduleTriggerSteps(parsed, params);
    return normalized === parsed ? stepsValue : JSON.stringify(normalized);
  } catch {
    return stepsValue;
  }
}
