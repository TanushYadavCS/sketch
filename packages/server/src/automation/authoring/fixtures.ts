import type { AutomationDefinition } from "@sketch/shared";
import type { AutomationAuthoringDefinition } from "./schema";

export const validAuthoringDefinition: AutomationAuthoringDefinition = {
  title: "Weekday digest",
  description: "Summarize updates every weekday",
  prompt: "Summarize the completed workflow",
  executionMode: "hybrid",
  scheduleType: "cron",
  scheduleValue: "0 9 * * 1-5",
  timezone: "Asia/Kolkata",
  delivery: {
    platform: "slack",
    targetType: "dm",
    targetId: "U123",
    threadTs: null,
    mode: "deliver",
  },
  steps: [
    {
      id: "trigger",
      type: "trigger",
      label: "Weekday schedule",
      icon: "clock",
      position: { x: 0, y: 0 },
      triggerConfig: {
        type: "schedule",
        scheduleType: "cron",
        scheduleValue: "0 9 * * 1-5",
        timezone: "Asia/Kolkata",
      },
    },
    {
      id: "digest",
      type: "agent",
      label: "Prepare digest",
      icon: "sketch-ai",
      position: { x: 260, y: 0 },
      agentMode: "sketch",
      agentSkills: ["daily-summary"],
      agentMcpServers: ["linear"],
    },
  ],
  edges: [{ id: "trigger-digest", from: "trigger", to: "digest" }],
  stepContent: {
    digest: {
      stepId: "digest",
      contentType: "prompt",
      content: "Summarize updates and call out blockers.",
      apps: ["linear"],
    },
  },
};

export const existingAutomationDefinition: AutomationDefinition = {
  id: "task-123",
  platform: "slack",
  contextType: "dm",
  deliveryTarget: "U123",
  threadTs: null,
  prompt: validAuthoringDefinition.prompt,
  executionMode: validAuthoringDefinition.executionMode,
  executionModeRecommendation: {
    mode: "agent-led",
    reason: "Best when the work needs AI judgment from start to finish.",
  },
  scheduleType: validAuthoringDefinition.scheduleType,
  scheduleValue: validAuthoringDefinition.scheduleValue,
  timezone: validAuthoringDefinition.timezone,
  sessionMode: "fresh",
  nextRunAt: null,
  lastRunAt: null,
  status: "active",
  createdBy: "user-1",
  createdByName: "Owner",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
  revision: 7,
  lastEditedBy: "user-1",
  lastEditedByName: "Owner",
  title: validAuthoringDefinition.title,
  description: validAuthoringDefinition.description,
  originChat: null,
  delivery: validAuthoringDefinition.delivery,
  steps: validAuthoringDefinition.steps.map((step) =>
    step.id === "digest" ? { ...step, agentModel: "xiaomi/mimo-v2.5" } : step,
  ),
  edges: validAuthoringDefinition.edges,
  stepContent: {
    digest: {
      taskId: "task-123",
      ...validAuthoringDefinition.stepContent.digest,
      updatedAt: "2026-07-26T00:00:00.000Z",
    },
  },
  latestRun: null,
  recentRuns: [],
};

export const poorGenerationFixtures = [
  {
    name: "missing agent content",
    draft: {
      ...validAuthoringDefinition,
      stepContent: {},
    },
    expectedIssue: "AGENT_PROMPT_REQUIRED",
  },
  {
    name: "disconnected execution step",
    draft: {
      ...validAuthoringDefinition,
      edges: [],
    },
    expectedIssue: "MISSING_EDGES",
  },
  {
    name: "mismatched trigger schedule",
    draft: {
      ...validAuthoringDefinition,
      scheduleValue: "0 10 * * 1-5",
    },
    expectedIssue: "SCHEDULE_TRIGGER_MISMATCH",
  },
] as const;
