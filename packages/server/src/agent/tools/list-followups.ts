import { createHash } from "node:crypto";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Kysely } from "kysely";
import type { z } from "zod/v4";
import { normalizeName } from "../../connectors/name-normalize";
import {
  type AgentOutputWithItems,
  type AgentRoute,
  type AgentUserConfig,
  createAgentOutputRepository,
  extractSummarizerSeedCandidates,
} from "../../db/repositories/agent-outputs";
import { createConversationFollowupsRepository } from "../../db/repositories/conversation-followups";
import {
  type ActiveTaskDurabilityRoute,
  type UserTaskDurabilityTransition,
  createTaskDurabilityTransitionRepository,
} from "../../db/repositories/task-durability-transition";
import { resolvePersonEntitiesForUser } from "../../db/repositories/user-entity-resolver";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import type { SketchMcpDeps, ToolResult } from "./types";

export const listFollowupsToolDescription =
  "Read the user's conversation-derived follow-up state. A status of ok is authoritative durable state. If status is inactive, continue normal chat-derived reminder behavior. If status is error, retain chat-derived reminders and use the returned fallback rather than treating missing items as complete.";

export const listFollowupsToolSchema = {};

type ListFollowupsArgs = z.infer<z.ZodObject<typeof listFollowupsToolSchema>>;

const SUMMARIZER_AGENT_KEY = "conversation_summary";
const LEGACY_LOOKBACK_DAYS = 7;
const LEGACY_OUTPUT_LIMIT_PER_ROUTE = 10;
const LEGACY_HISTORY_PAGE_SIZE = 25;
const LEGACY_HISTORY_PAGE_LIMIT = 2;
const REMINDER_UNTRACKED_LIMIT = 25;
const LEGACY_LABEL = "Reconstructed from a recent summary; not yet tracked.";

class ReminderHistoryOverflowError extends Error {}

type LegacyCandidate = {
  title: string;
  sourceKey: string;
  scopedSourceKey: string;
  sourceAnchorKey: string | null;
  sourcePlatform: "slack" | "whatsapp" | null;
};

type FollowupItem = {
  title: string;
  reviewCode: string | null;
  proposedAssigneeName: string | null;
  sourcePlatform: "slack" | "whatsapp" | null;
  label: string;
  sourceKey?: string;
};

export async function handleListFollowups(_args: ListFollowupsArgs, deps: SketchMcpDeps): Promise<ToolResult> {
  if (!deps.db || !deps.currentUserId) {
    return { content: [{ type: "text", text: "Follow-up tracking is not available in this context." }] };
  }
  const outputRepo = createAgentOutputRepository(deps.db);
  let activeRoutes: ActiveTaskDurabilityRoute[];
  try {
    const config = await outputRepo.getConfig(SUMMARIZER_AGENT_KEY, deps.currentUserId);
    activeRoutes = activeSummaryRoutes(config);
  } catch {
    return followupErrorResult("durable_query_failed", []);
  }
  if (activeRoutes.length === 0) {
    try {
      const verifiedEmails = await createUserRepository(deps.db).getVerifiedEmailsForUser(deps.currentUserId);
      const peopleByEmail = await resolvePersonEntitiesForUser(deps.db, deps.currentUserId, verifiedEmails);
      const assigneeEntityIds = [...new Set([...peopleByEmail.values()].flat().map((person) => person.id))];
      const assigned = await createConversationFollowupsRepository(deps.db).queryPersonalReminders({
        userId: deps.currentUserId,
        assigneeEntityIds,
        activeSourceKeys: [],
        now: new Date().toISOString(),
      });
      if (assigned.status === "error") return followupErrorResult(assigned.code, []);
      if (assigned.status === "ok" && (assigned.pending.length > 0 || assigned.looksResolved.length > 0)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "ok",
                authoritative: true,
                mode: "durable_only",
                pending: assigned.pending,
                looksResolved: assigned.looksResolved,
                untracked: [],
                suppressedTitles: assigned.suppressedTitles,
              }),
            },
          ],
        };
      }
    } catch {
      return followupErrorResult("durable_query_failed", []);
    }
    return inactiveFollowupResult();
  }

  const now = new Date();
  let legacyCandidates: LegacyCandidate[];
  try {
    legacyCandidates = await buildLegacyCandidates(deps.db, outputRepo, deps.currentUserId, activeRoutes, now);
  } catch (error) {
    return followupErrorResult(
      error instanceof ReminderHistoryOverflowError ? "reminder_history_overflow" : "durable_query_failed",
      [],
    );
  }

  let transition: UserTaskDurabilityTransition;
  try {
    transition = await createTaskDurabilityTransitionRepository(deps.db).getUserTransition({
      agentKey: SUMMARIZER_AGENT_KEY,
      userId: deps.currentUserId,
      activeRoutes,
      now,
    });
  } catch {
    return followupErrorResult("durable_transition_failed", legacyCandidates.map(legacyFollowupItem));
  }

  let transitionItems: FollowupItem[];
  try {
    transitionItems = await transitionFollowupItems(deps.db, transition);
  } catch {
    return followupErrorResult("durable_query_failed", legacyCandidates.map(legacyFollowupItem));
  }
  if (transition.overflow) {
    return followupErrorResult(
      "durable_transition_overflow",
      mergeFollowupItems(transitionItems, legacyCandidates.map(legacyFollowupItem)),
    );
  }
  const transitionFilteredLegacy = legacyCandidates.filter(
    (candidate) => !transition.suppressedLegacy.some((suppressed) => isTransitionSuppressed(candidate, suppressed)),
  );
  const legacyByIdentity = new Map(
    transitionFilteredLegacy.map((candidate) => [
      legacyIdentity(candidate.title, candidate.scopedSourceKey),
      candidate,
    ]),
  );

  try {
    const verifiedEmails = await createUserRepository(deps.db).getVerifiedEmailsForUser(deps.currentUserId);
    const peopleByEmail = await resolvePersonEntitiesForUser(deps.db, deps.currentUserId, verifiedEmails);
    const assigneeEntityIds = [...new Set([...peopleByEmail.values()].flat().map((person) => person.id))];
    const reminders = await createConversationFollowupsRepository(deps.db).queryPersonalReminders({
      userId: deps.currentUserId,
      assigneeEntityIds,
      activeSourceKeys: activeReminderSourceKeys(activeRoutes),
      legacyCandidates:
        transition.mode === "hybrid"
          ? transitionFilteredLegacy.map((candidate) => ({
              title: candidate.title,
              sourceKey: candidate.scopedSourceKey,
              sourceAnchorKey: candidate.sourceAnchorKey,
            }))
          : [],
      suppressedLegacyCandidates: transition.suppressedLegacy
        .filter((candidate) => !candidate.sourceKey.startsWith("route:"))
        .map((candidate) => ({ title: candidate.title, sourceKey: candidate.sourceKey })),
      now: now.toISOString(),
    });
    const legacyItems = reminders.untracked.map((candidate) =>
      legacyFollowupItem(
        legacyByIdentity.get(legacyIdentity(candidate.title, candidate.sourceKey ?? null)) ?? {
          title: candidate.title,
          sourceKey: candidate.sourceKey ?? "",
          scopedSourceKey: candidate.sourceKey ?? "",
          sourceAnchorKey: null,
          sourcePlatform: sourcePlatformFromKey(candidate.sourceKey ?? ""),
        },
      ),
    );
    const untracked = mergeFollowupItems(transitionItems, legacyItems);
    if (reminders.status === "error") {
      return followupErrorResult(
        reminders.code,
        mergeFollowupItems(transitionItems, transitionFilteredLegacy.map(legacyFollowupItem)),
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "ok",
            authoritative: true,
            mode: transition.mode,
            pending: reminders.pending,
            looksResolved: reminders.looksResolved,
            untracked,
            suppressedTitles: reminders.suppressedTitles,
          }),
        },
      ],
    };
  } catch {
    return followupErrorResult(
      "durable_query_failed",
      mergeFollowupItems(transitionItems, transitionFilteredLegacy.map(legacyFollowupItem)),
    );
  }
}

function inactiveFollowupResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "inactive",
          code: "durability_not_enabled",
          authoritative: false,
          useChatHistory: true,
          message:
            "Durable follow-up tracking is not enabled for any active Summarizer route. Continue using chat history and existing reminder behavior.",
        }),
      },
    ],
  };
}

function followupErrorResult(code: string, fallback: FollowupItem[]): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "error",
          code,
          retryable: true,
          mode: "hybrid",
          authoritative: false,
          fallback,
        }),
      },
    ],
  };
}

function routeSourceKey(sources: readonly string[]): string {
  if (sources.length === 1) return sources[0] ?? "";
  const hash = createHash("sha256")
    .update([...sources].sort().join("|"))
    .digest("hex")
    .slice(0, 12);
  return `route:${hash}`;
}

function activeSummaryRoutes(config: AgentUserConfig): ActiveTaskDurabilityRoute[] {
  if (!config.enabled || config.prefs?.createTasks !== true) return [];
  const configuredRoutes = config.prefs.routes;
  let routes: Array<Pick<AgentRoute, "id" | "sources" | "enabled">>;
  if (configuredRoutes) {
    routes = configuredRoutes;
  } else {
    const sources = (config.prefs.sources ?? []).map(
      (source) => `${source.platform}:${source.targetType}:${source.targetId}` as const,
    );
    if (config.prefs.deliveryModel?.mode === "combined" && sources.length > 0) {
      const sourceKey = routeSourceKey(sources);
      routes = [{ id: sourceKey, sources, enabled: true }];
    } else {
      routes = sources.map((sourceKey) => ({ id: sourceKey, sources: [sourceKey], enabled: true }));
    }
  }
  const seen = new Set<string>();
  return routes.flatMap((route) => {
    const sourceKeys = [...new Set(route.sources)].filter(Boolean);
    if (!route.enabled || sourceKeys.length === 0) return [];
    const sourceKey = routeSourceKey(sourceKeys);
    const identity = JSON.stringify([route.id, sourceKey]);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ routeId: route.id, sourceKey, sourceKeys }];
  });
}

function activeReminderSourceKeys(activeRoutes: ActiveTaskDurabilityRoute[]): string[] {
  return [...new Set(activeRoutes.flatMap((route) => [route.sourceKey, ...route.sourceKeys]))];
}

async function buildLegacyCandidates(
  db: Kysely<DB>,
  outputRepo: ReturnType<typeof createAgentOutputRepository>,
  userId: string,
  activeRoutes: ActiveTaskDurabilityRoute[],
  now: Date,
): Promise<LegacyCandidate[]> {
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - LEGACY_LOOKBACK_DAYS);
  const scopedOutputs = (
    await Promise.all(
      activeRoutes.map((route) =>
        outputRepo.listCompletedForScopeSince(SUMMARIZER_AGENT_KEY, userId, route.sourceKey, since.toISOString(), {
          limit: LEGACY_OUTPUT_LIMIT_PER_ROUTE,
        }),
      ),
    )
  ).flat();
  const historical = await listAllCompletedSummaries(
    outputRepo,
    userId,
    since.toISOString(),
    activeReminderSourceKeys(activeRoutes),
  );
  if (historical.overflow) throw new ReminderHistoryOverflowError();
  const candidateOutputs = [
    ...new Map([...scopedOutputs, ...historical.outputs].map((output) => [output.output.id, output])).values(),
  ];
  const outputs = await selectOutputsPerActiveRoute(db, candidateOutputs, activeRoutes, LEGACY_OUTPUT_LIMIT_PER_ROUTE);
  const candidates = await resolveLegacyCandidates(db, outputs);
  const activeRouteKeys = new Set(activeRoutes.flatMap((route) => [route.sourceKey, ...route.sourceKeys]));
  const activeConversationIds = await resolveActiveRouteConversationIds(db, activeRoutes);
  return candidates.filter((candidate) => {
    if (activeRouteKeys.has(candidate.sourceKey)) return true;
    const conversationId = conversationIdFromAnchor(candidate.sourceAnchorKey);
    return conversationId !== null && activeConversationIds.has(conversationId);
  });
}

async function listAllCompletedSummaries(
  outputRepo: ReturnType<typeof createAgentOutputRepository>,
  userId: string,
  since: string,
  activeSourceKeys: string[],
): Promise<{ outputs: AgentOutputWithItems[]; overflow: boolean }> {
  const outputs: AgentOutputWithItems[] = [];
  let before: { generatedAt: string; id: string } | undefined;
  for (let pageIndex = 0; pageIndex < LEGACY_HISTORY_PAGE_LIMIT; pageIndex += 1) {
    const page = await outputRepo.listCompletedForUserSince(SUMMARIZER_AGENT_KEY, userId, since, {
      limit: LEGACY_HISTORY_PAGE_SIZE,
      sourceKeys: activeSourceKeys,
      ...(before ? { before } : {}),
    });
    outputs.push(...page);
    if (page.length < LEGACY_HISTORY_PAGE_SIZE) return { outputs, overflow: false };
    const oldest = page.reduce((candidate, output) =>
      `${output.output.generated_at ?? ""}:${output.output.id}` <
      `${candidate.output.generated_at ?? ""}:${candidate.output.id}`
        ? output
        : candidate,
    );
    if (!oldest.output.generated_at) return { outputs, overflow: true };
    before = { generatedAt: oldest.output.generated_at, id: oldest.output.id };
  }
  return { outputs, overflow: true };
}

async function selectOutputsPerActiveRoute(
  db: Kysely<DB>,
  outputs: AgentOutputWithItems[],
  activeRoutes: ActiveTaskDurabilityRoute[],
  limit: number,
): Promise<AgentOutputWithItems[]> {
  const messageIdsByOutput = new Map(
    outputs.map((output) => [
      output.output.id,
      extractSummarizerSeedCandidates([output]).flatMap((candidate) =>
        readMessageIds(candidate.structuredPayload?.messageIds),
      ),
    ]),
  );
  const allMessageIds = [...new Set([...messageIdsByOutput.values()].flat())];
  const rows =
    allMessageIds.length === 0
      ? []
      : await db
          .selectFrom("conversation_messages")
          .select(["id", "conversation_id"])
          .where("id", "in", allMessageIds)
          .limit(allMessageIds.length)
          .execute();
  const conversationByMessage = new Map(rows.map((row) => [row.id, row.conversation_id]));
  const ordered = [...outputs].sort((a, b) => (b.output.generated_at ?? "").localeCompare(a.output.generated_at ?? ""));
  const selected = new Map<string, AgentOutputWithItems>();
  for (const route of activeRoutes) {
    const routeConversationIds = await resolveActiveRouteConversationIds(db, [route]);
    let count = 0;
    for (const output of ordered) {
      const belongs =
        output.output.source_key === route.sourceKey ||
        (messageIdsByOutput.get(output.output.id) ?? []).some((id) =>
          routeConversationIds.has(conversationByMessage.get(id) ?? -1),
        );
      if (!belongs) continue;
      selected.set(output.output.id, output);
      count += 1;
      if (count >= limit) break;
    }
  }
  return [...selected.values()];
}

async function resolveActiveRouteConversationIds(
  db: Kysely<DB>,
  activeRoutes: ActiveTaskDurabilityRoute[],
): Promise<Set<number>> {
  const result = new Set<number>();
  for (const sourceKey of activeRoutes.flatMap((route) => route.sourceKeys)) {
    const match = /^(slack|whatsapp):(channel|group|dm):(.+)$/.exec(sourceKey);
    if (!match) continue;
    const [, platform, kind, targetId] = match;
    if (kind === "dm") {
      const id = Number(targetId);
      if (Number.isSafeInteger(id) && id > 0) result.add(id);
      continue;
    }
    const rows = await db
      .selectFrom("conversations")
      .select("id")
      .where("platform", "=", platform)
      .where("kind", "=", kind)
      .where("provider_conversation_id", "=", targetId)
      .limit(1)
      .execute();
    for (const row of rows) result.add(row.id);
  }
  return result;
}

function conversationIdFromAnchor(anchor: string | null): number | null {
  if (!anchor) return null;
  const id = Number(anchor.split(":")[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function resolveLegacyCandidates(db: Kysely<DB>, outputs: AgentOutputWithItems[]): Promise<LegacyCandidate[]> {
  const candidates = extractSummarizerSeedCandidates(outputs).map((candidate) => ({
    title: candidate.title,
    sourceKey: candidate.sourceKey,
    messageIds: readMessageIds(candidate.structuredPayload?.messageIds),
  }));
  const messageIds = [...new Set(candidates.flatMap((candidate) => candidate.messageIds))];
  const messages =
    messageIds.length === 0
      ? []
      : await db
          .selectFrom("conversation_messages as m")
          .innerJoin("conversations as c", "c.id", "m.conversation_id")
          .select(["m.id", "m.conversation_id", "m.provider_thread_id", "m.is_thread_reply", "c.platform"])
          .where("m.id", "in", messageIds)
          .limit(messageIds.length)
          .execute();
  const anchorByMessageId = new Map(
    messages.map((message) => [
      message.id,
      {
        anchor: `${message.platform}:${message.conversation_id}:${
          message.platform === "slack" && message.is_thread_reply === 1
            ? (message.provider_thread_id ?? "root")
            : "root"
        }`,
        platform: message.platform === "slack" ? ("slack" as const) : ("whatsapp" as const),
      },
    ]),
  );
  return candidates.map((candidate) => {
    const anchors = new Set(candidate.messageIds.flatMap((id) => anchorByMessageId.get(id)?.anchor ?? []));
    const platforms = new Set(candidate.messageIds.flatMap((id) => anchorByMessageId.get(id)?.platform ?? []));
    const sourceAnchorKey = anchors.size === 1 ? (anchors.values().next().value ?? null) : null;
    return {
      title: candidate.title,
      sourceKey: candidate.sourceKey,
      scopedSourceKey:
        candidate.sourceKey.startsWith("route:") && sourceAnchorKey
          ? `${candidate.sourceKey}:${sourceAnchorKey}`
          : candidate.sourceKey,
      sourceAnchorKey,
      sourcePlatform:
        platforms.size === 1 ? (platforms.values().next().value ?? null) : sourcePlatformFromKey(candidate.sourceKey),
    };
  });
}

function readMessageIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((entry) => (typeof entry === "number" ? entry : Number(entry)))
        .filter((entry) => Number.isSafeInteger(entry) && entry > 0),
    ),
  ];
}

function isTransitionSuppressed(
  candidate: LegacyCandidate,
  suppressed: UserTaskDurabilityTransition["suppressedLegacy"][number],
): boolean {
  if (normalizeName(candidate.title) !== normalizeName(suppressed.title)) return false;
  if (candidate.sourceAnchorKey && suppressed.sourceAnchorKey) {
    return candidate.sourceAnchorKey === suppressed.sourceAnchorKey;
  }
  if (candidate.sourceKey !== suppressed.sourceKey) return false;
  return candidate.sourceKey.startsWith("route:")
    ? Boolean(candidate.sourceAnchorKey && candidate.sourceAnchorKey === suppressed.sourceAnchorKey)
    : true;
}

async function transitionFollowupItems(
  db: Kysely<DB>,
  transition: UserTaskDurabilityTransition,
): Promise<FollowupItem[]> {
  const codes = transition.untracked.map((item) => item.code);
  const rows =
    codes.length === 0
      ? []
      : await db
          .selectFrom("task_seed_candidates")
          .select(["review_code", "source_key", "source_anchor_key"])
          .where("review_code", "in", codes)
          .limit(codes.length)
          .execute();
  const sourceByCode = new Map(
    rows.map((row) => [
      row.review_code,
      row.source_key.startsWith("route:") ? `${row.source_key}:${row.source_anchor_key}` : row.source_key,
    ]),
  );
  return transition.untracked.map((item) => {
    const sourceKey = sourceByCode.get(item.code);
    return {
      title: item.title,
      reviewCode: item.code,
      proposedAssigneeName: item.proposedAssigneeName,
      sourcePlatform: item.sourcePlatform,
      label: item.label,
      ...(sourceKey ? { sourceKey } : {}),
    };
  });
}

function legacyFollowupItem(candidate: LegacyCandidate): FollowupItem {
  return {
    title: candidate.title,
    reviewCode: null,
    proposedAssigneeName: null,
    sourcePlatform: candidate.sourcePlatform,
    label: LEGACY_LABEL,
    ...(candidate.scopedSourceKey ? { sourceKey: candidate.scopedSourceKey } : {}),
  };
}

function mergeFollowupItems(primary: FollowupItem[], secondary: FollowupItem[]): FollowupItem[] {
  const result: FollowupItem[] = [];
  const seen = new Set<string>();
  for (const item of [...primary, ...secondary]) {
    const identity = legacyIdentity(item.title, item.sourceKey ?? null);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(item);
  }
  return result.slice(0, REMINDER_UNTRACKED_LIMIT);
}

function legacyIdentity(title: string, sourceKey: string | null): string {
  return JSON.stringify([normalizeName(title), sourceKey]);
}

function sourcePlatformFromKey(sourceKey: string): "slack" | "whatsapp" | null {
  if (sourceKey.startsWith("slack:")) return "slack";
  if (sourceKey.startsWith("whatsapp:")) return "whatsapp";
  return null;
}

export function createListFollowupsTool(deps: SketchMcpDeps) {
  return tool("ListFollowups", listFollowupsToolDescription, listFollowupsToolSchema, (args) =>
    handleListFollowups(args, deps),
  );
}
