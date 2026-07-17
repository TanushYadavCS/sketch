import { normalizeName } from "../connectors/name-normalize";
import type { AgentOutputItemInput } from "../db/repositories/agent-outputs";

export interface FollowupReminderTask {
  taskId: string;
  title: string;
  priority: string | null;
  parentEntityId: string | null;
  assigneeEntityId: string | null;
  sourceKey?: string | null;
  sourceAnchorKey?: string | null;
}

export interface FollowupReminderRecommendation {
  recommendationId: string;
  taskId: string;
  title: string;
  rationale: string;
  reviewCode: string;
  parentEntityId: string | null;
  assigneeEntityId: string | null;
  sourceKey?: string | null;
  sourceAnchorKey?: string | null;
}

export interface FollowupReminderUntracked {
  candidateId: string;
  title: string;
  summary: string;
  reviewCode: string | null;
  parentEntityId: string | null;
  assigneeEntityId: string | null;
  sourceKey?: string | null;
  sourceAnchorKey?: string | null;
}

export interface FollowupReminderSuppressed {
  taskId: string;
  title: string;
  sourceKey?: string | null;
  sourceAnchorKey?: string | null;
}

export type FollowupReminderView =
  | {
      status: "ok";
      mode: "hybrid" | "durable_only";
      pending: FollowupReminderTask[];
      looksResolved: FollowupReminderRecommendation[];
      untracked: FollowupReminderUntracked[];
      suppressed?: FollowupReminderSuppressed[];
    }
  | {
      status: "error";
      code: string;
      retryable: boolean;
      fallback: FollowupReminderUntracked[];
    };

function entityRefs(parentEntityId: string | null, assigneeEntityId: string | null): string[] {
  return [...new Set([parentEntityId, assigneeEntityId].filter((id): id is string => Boolean(id)))];
}

function optionalSourceIdentity(sourceKey: string | null | undefined, sourceAnchorKey: string | null | undefined) {
  const normalized = sourceKey?.trim();
  const normalizedAnchor = sourceAnchorKey?.trim();
  return {
    ...(normalized ? { sourceKey: normalized } : {}),
    ...(normalizedAnchor ? { sourceAnchorKey: normalizedAnchor } : {}),
  };
}

function durableTaskItem(task: FollowupReminderTask, sortOrder: number): AgentOutputItemInput {
  return {
    sectionKey: "todos",
    title: task.title,
    summary: "Tracked from conversation follow-up memory.",
    priority: task.priority === "high" || task.priority === "low" ? task.priority : "medium",
    label: "todo",
    actionType: "chat",
    actionLabel: "Plan with Sketch",
    actionPrompt: `Help me plan the next step for "${task.title}".`,
    canonicalTaskId: task.taskId,
    structuredPayload: {
      serverOwnedFollowup: true,
      taskId: task.taskId,
      trackingState: "durable",
      ...optionalSourceIdentity(task.sourceKey, task.sourceAnchorKey),
    },
    knowledgeRefs: {
      entityIds: entityRefs(task.parentEntityId, task.assigneeEntityId),
      fileIds: [],
    },
    sortOrder,
  };
}

function recommendationItem(recommendation: FollowupReminderRecommendation, sortOrder: number): AgentOutputItemInput {
  return {
    sectionKey: "looks_resolved",
    title: recommendation.title,
    summary: `Reply "Confirm done ${recommendation.reviewCode}" or "Keep open ${recommendation.reviewCode}". ${recommendation.rationale}`,
    priority: "medium",
    label: "looks_resolved",
    actionType: "chat",
    actionLabel: "Review with Sketch",
    actionPrompt: `Review whether "${recommendation.title}" is complete.`,
    canonicalTaskId: recommendation.taskId,
    structuredPayload: {
      serverOwnedFollowup: true,
      taskId: recommendation.taskId,
      recommendationId: recommendation.recommendationId,
      reviewCode: recommendation.reviewCode,
      trackingState: "looks_resolved",
      ...optionalSourceIdentity(recommendation.sourceKey, recommendation.sourceAnchorKey),
    },
    knowledgeRefs: {
      entityIds: entityRefs(recommendation.parentEntityId, recommendation.assigneeEntityId),
      fileIds: [],
    },
    sortOrder,
  };
}

function untrackedItem(
  candidate: FollowupReminderUntracked,
  sortOrder: number,
  queryFailed: boolean,
): AgentOutputItemInput {
  const review =
    candidate.reviewCode === null ? "" : `Reply "Track ${candidate.reviewCode}" or "Dismiss ${candidate.reviewCode}". `;
  const availability = queryFailed
    ? " Durable tracking is temporarily unavailable; this reconstructed item is not yet tracked."
    : " Reconstructed from recent summaries; this item is not yet tracked.";
  return {
    sectionKey: "untracked_followups",
    title: candidate.title,
    summary: `${review}${candidate.summary}${availability}`,
    priority: "medium",
    label: "untracked",
    actionType: "chat",
    actionLabel: "Discuss with Sketch",
    actionPrompt: `Review whether "${candidate.title}" should be tracked.`,
    structuredPayload: {
      serverOwnedFollowup: true,
      candidateId: candidate.candidateId,
      reviewCode: candidate.reviewCode,
      trackingState: queryFailed ? "fallback_error" : "untracked",
      ...optionalSourceIdentity(candidate.sourceKey, candidate.sourceAnchorKey),
    },
    knowledgeRefs: {
      entityIds: entityRefs(candidate.parentEntityId, candidate.assigneeEntityId),
      fileIds: [],
    },
    sortOrder,
  };
}

function payloadString(item: AgentOutputItemInput, key: string): string | null {
  const value = item.structuredPayload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sourceScopedIdentity(
  title: string,
  sourceKey: string | null | undefined,
  sourceAnchorKey: string | null | undefined,
): string | null {
  const normalizedAnchor = sourceAnchorKey?.trim();
  if (normalizedAnchor) return JSON.stringify(["anchor", normalizeName(title), normalizedAnchor]);
  const normalizedSourceKey = sourceKey?.trim();
  if (!normalizedSourceKey) return null;
  return JSON.stringify(["source", normalizeName(title), normalizedSourceKey]);
}

function uniqueUntracked(items: FollowupReminderUntracked[]): FollowupReminderUntracked[] {
  const seenCandidateIds = new Set<string>();
  const seenSourceIdentities = new Set<string>();
  return items.filter((item) => {
    const sourceIdentity = sourceScopedIdentity(item.title, item.sourceKey, item.sourceAnchorKey);
    if (sourceIdentity && seenSourceIdentities.has(sourceIdentity)) return false;
    if (seenCandidateIds.has(item.candidateId)) return false;
    seenCandidateIds.add(item.candidateId);
    if (sourceIdentity) seenSourceIdentities.add(sourceIdentity);
    return true;
  });
}

export function reconcileFollowupReminderItems(
  items: AgentOutputItemInput[],
  view: FollowupReminderView,
  maxItemsPerSection = Number.POSITIVE_INFINITY,
): AgentOutputItemInput[] {
  const serverSections = new Set(["looks_resolved", "untracked_followups"]);
  const untracked = uniqueUntracked(view.status === "ok" ? view.untracked : view.fallback);
  const pending = view.status === "ok" ? view.pending : [];
  const looksResolved = view.status === "ok" ? view.looksResolved : [];
  const suppressed = view.status === "ok" ? (view.suppressed ?? []) : [];
  const taskIds = new Set([...pending, ...looksResolved, ...suppressed].map((item) => item.taskId));
  const recommendationIds = new Set(looksResolved.map((item) => item.recommendationId));
  const candidateIds = new Set(untracked.map((item) => item.candidateId));
  const sourceScopedIdentities = new Set(
    [...pending, ...looksResolved, ...untracked, ...suppressed].flatMap((item) => {
      const identity = sourceScopedIdentity(item.title, item.sourceKey, item.sourceAnchorKey);
      return identity ? [identity] : [];
    }),
  );
  const retained = items.filter((item) => {
    if (serverSections.has(item.sectionKey)) return false;
    if (item.sectionKey !== "todos") return true;

    const sourceIdentity = sourceScopedIdentity(
      item.title,
      payloadString(item, "sourceKey"),
      payloadString(item, "sourceAnchorKey"),
    );
    if (sourceIdentity && sourceScopedIdentities.has(sourceIdentity)) return false;

    const taskId = payloadString(item, "taskId");
    const recommendationId = payloadString(item, "recommendationId");
    const candidateId = payloadString(item, "candidateId");
    if (taskId && taskIds.has(taskId)) return false;
    if (recommendationId && recommendationIds.has(recommendationId)) return false;
    if (candidateId && candidateIds.has(candidateId)) return false;
    return true;
  });
  const sectionLimit = Math.max(0, Math.floor(maxItemsPerSection));
  const remainingTodos = Math.max(0, sectionLimit - retained.filter((item) => item.sectionKey === "todos").length);

  if (view.status === "error") {
    return [
      ...retained,
      ...untracked.slice(0, sectionLimit).map((candidate, index) => untrackedItem(candidate, index, true)),
    ];
  }

  return [
    ...retained,
    ...view.pending.slice(0, remainingTodos).map(durableTaskItem),
    ...untracked.slice(0, sectionLimit).map((candidate, index) => untrackedItem(candidate, index, false)),
    ...view.looksResolved.slice(0, sectionLimit).map(recommendationItem),
  ];
}
