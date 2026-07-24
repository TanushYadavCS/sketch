import { createHash, randomUUID } from "node:crypto";
import { type Kysely, type Transaction, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import type { DB } from "../schema";
import {
  type AgentOutputItemInput,
  type SummarizerSeedCandidate,
  createAgentOutputRepository,
  extractSummarizerSeedCandidates,
} from "./agent-outputs";
import { type ConversationTaskSourceAnchor, createTaskRepository } from "./tasks";

const SEED_LOOKBACK_DAYS = 7;
const SEED_OUTPUT_LIMIT = 10;
const TRANSITION_ROUTE_LIMIT = 100;
const TRANSITION_PENDING_LIMIT = 25;
const TRANSITION_SUPPRESSION_LIMIT = 100;
const REVIEW_CODE_LENGTH = 8;
const REVIEW_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
const UNTRACKED_LABEL = "Reconstructed from recent summaries; not yet tracked.";

export type TaskDurabilityMode = "hybrid" | "durable_only";
export type SeedReviewDecision = "track" | "dismiss";
export type SeedReviewSurface = "slack" | "whatsapp" | string;

type SeedState = "pending" | "reviewed";
type ClockValue = Date | string;

export interface EnsureRouteTransitionInput {
  agentKey: string;
  userId: string;
  routeId: string;
  sourceKey: string;
  sourceKeys?: string[];
  allowedConversationIds?: number[];
  now: ClockValue;
}

export interface EnsureRouteTransitionResult extends Record<string, unknown> {
  initialized: boolean;
  mode: TaskDurabilityMode;
  seedState: SeedState;
  pendingCount: number;
  createdCount: number;
  skippedCount: number;
  lastError: string | null;
}

export interface ReviewSeedCandidateInput {
  userId: string;
  code: string;
  decision: SeedReviewDecision;
  surface: SeedReviewSurface;
  now: ClockValue;
}

export interface ReviewSeedCandidateByIdInput {
  userId: string;
  id: string;
  decision: SeedReviewDecision;
  surface: SeedReviewSurface;
  now: ClockValue;
}

export type SeedReviewResult =
  | { status: "not_found" }
  | {
      status: "accepted";
      taskId: string;
      mode: TaskDurabilityMode;
    }
  | {
      status: "dismissed";
      mode: TaskDurabilityMode;
    }
  | {
      status: "already_reviewed";
      decision: SeedReviewDecision;
      taskId?: string;
      mode: TaskDurabilityMode;
    };

export interface RecordIncrementalSuccessInput {
  agentKey: string;
  userId: string;
  routeId: string;
  expectedSourceKey: string;
  now: ClockValue;
}

export interface ActiveTaskDurabilityRoute {
  routeId: string;
  sourceKey: string;
  sourceKeys: string[];
}

export interface GetUserTransitionInput {
  agentKey: string;
  userId: string;
  activeRoutes?: ActiveTaskDurabilityRoute[];
  now?: ClockValue;
}

export interface UserTaskDurabilityRoute {
  routeId: string;
  sourceKey: string;
  mode: TaskDurabilityMode;
  seedState: SeedState;
  lastError: string | null;
}

export interface UserTaskDurabilityUntrackedItem {
  id: string;
  code: string;
  title: string;
  label: string;
  proposedAssigneeName: string | null;
  sourcePlatform: "slack" | "whatsapp";
}

export interface UserTaskDurabilityTransition {
  mode: TaskDurabilityMode;
  overflow: boolean;
  routes: UserTaskDurabilityRoute[];
  untracked: UserTaskDurabilityUntrackedItem[];
  suppressedLegacy: Array<{ title: string; sourceKey: string; sourceAnchorKey: string }>;
}

interface ResolvedSeedCandidate {
  candidate: SummarizerSeedCandidate;
  anchor: ConversationTaskSourceAnchor;
  messageIds: number[];
  evidenceFingerprint: string;
  proposedAssigneeName: string | null;
}

interface EvidenceMessageRow {
  id: number;
  conversation_id: number;
  provider_thread_id: string | null;
  is_thread_reply: number;
  platform: string;
  kind: string;
  provider_conversation_id: string;
}

class RouteSourceChangedError extends Error {}

export function createTaskDurabilityTransitionRepository(db: Kysely<DB>) {
  const outputRepo = createAgentOutputRepository(db);

  return {
    async ensureRouteTransition(input: EnsureRouteTransitionInput): Promise<EnsureRouteTransitionResult> {
      const now = toIso(input.now);
      const existing = await loadRouteState(db, input);
      const initialized = !existing;
      const sourceChanged = Boolean(existing && existing.source_key !== input.sourceKey);
      if (!existing) {
        await db
          .insertInto("task_durability_route_state")
          .values({
            agent_key: input.agentKey,
            user_id: input.userId,
            route_id: input.routeId,
            source_key: input.sourceKey,
            mode: "hybrid",
            seed_state: "pending",
            seed_started_at: now,
            seed_reviewed_at: null,
            incremental_success_at: null,
            last_error: null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((oc) => oc.columns(["agent_key", "user_id", "route_id"]).doNothing())
          .execute();
      } else if (sourceChanged) {
        const reset = await db.transaction().execute(async (trx) => {
          const updated = await trx
            .updateTable("task_durability_route_state")
            .set({
              source_key: input.sourceKey,
              mode: "hybrid",
              seed_state: "pending",
              seed_started_at: now,
              seed_reviewed_at: null,
              incremental_success_at: null,
              last_error: null,
              updated_at: now,
            })
            .where("agent_key", "=", input.agentKey)
            .where("user_id", "=", input.userId)
            .where("route_id", "=", input.routeId)
            .where("source_key", "=", existing.source_key)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows ?? 0) === 0) return false;
          await trx
            .deleteFrom("task_seed_candidates")
            .where("agent_key", "=", input.agentKey)
            .where("user_id", "=", input.userId)
            .where("route_id", "=", input.routeId)
            .where("source_key", "=", existing.source_key)
            .where("review_state", "in", ["pending", "processing"])
            .execute();
          return true;
        });
        if (!reset) {
          const changed = await loadRouteState(db, input);
          if (!changed) throw new Error("Task durability route state disappeared during source transition.");
          return transitionResultFromState(changed, await countPendingCandidates(db, input), false);
        }
      }

      let current = await loadRouteState(db, input);
      if (!current) throw new Error("Failed to initialize task durability route state.");
      if (current.source_key !== input.sourceKey) {
        return transitionResultFromState(current, await countPendingCandidates(db, input), initialized);
      }
      const retiredCount = await reconcileInvalidPendingCandidates(
        db,
        {
          agentKey: input.agentKey,
          userId: input.userId,
          routeId: input.routeId,
          sourceKey: input.sourceKey,
          sourceKeys: input.sourceKeys ?? [],
          allowedConversationIds: input.allowedConversationIds,
        },
        now,
      );
      if (retiredCount > 0) current = (await loadRouteState(db, input)) ?? current;
      const pendingBefore = await countPendingCandidates(db, input);
      const shouldSeed = pendingBefore === 0 && (current.seed_state !== "reviewed" || retiredCount > 0);
      if (!shouldSeed) {
        return {
          initialized,
          mode: asMode(current.mode),
          seedState: asSeedState(current.seed_state),
          pendingCount: pendingBefore,
          createdCount: 0,
          skippedCount: 0,
          lastError: current.last_error,
        };
      }

      try {
        const since = sevenDayBoundary(now);
        const seedSourceKeys = eligibleSeedSourceKeys(input.sourceKey, input.sourceKeys);
        const outputs = await outputRepo.listCompletedForScopesSince(
          input.agentKey,
          input.userId,
          seedSourceKeys,
          since,
          { limit: SEED_OUTPUT_LIMIT },
        );
        const candidates = extractSummarizerSeedCandidates(outputs);
        const resolved: ResolvedSeedCandidate[] = [];
        let skippedCount = 0;
        for (const candidate of candidates) {
          const value = await resolveSeedCandidate(
            db,
            candidate,
            input.sourceKey,
            input.allowedConversationIds ? new Set(input.allowedConversationIds) : null,
            seedSourceKeys,
          );
          if (value) resolved.push(value);
          else skippedCount += 1;
        }

        const persisted = await db.transaction().execute(async (trx) => {
          let createdCount = 0;
          for (const candidate of resolved) {
            if (await persistSeedCandidate(trx, input, candidate, now)) createdCount += 1;
          }
          const pendingCount = await countPendingCandidates(trx, input);
          const seedReviewed = pendingCount === 0;
          const mode = seedReviewed && current.incremental_success_at ? "durable_only" : "hybrid";
          const updated = await trx
            .updateTable("task_durability_route_state")
            .set({
              mode,
              seed_state: seedReviewed ? "reviewed" : "pending",
              seed_started_at: current.seed_started_at ?? now,
              seed_reviewed_at: seedReviewed ? (current.seed_reviewed_at ?? now) : null,
              last_error: null,
              updated_at: now,
            })
            .where("agent_key", "=", input.agentKey)
            .where("user_id", "=", input.userId)
            .where("route_id", "=", input.routeId)
            .where("source_key", "=", input.sourceKey)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows ?? 0) === 0) {
            throw new RouteSourceChangedError();
          }
          return {
            createdCount,
            pendingCount,
            seedState: (seedReviewed ? "reviewed" : "pending") as SeedState,
            mode: mode as TaskDurabilityMode,
          };
        });

        return {
          initialized,
          ...persisted,
          skippedCount,
          lastError: null,
        };
      } catch (error) {
        if (error instanceof RouteSourceChangedError) {
          const changed = await loadRouteState(db, input);
          if (!changed) throw error;
          return transitionResultFromState(changed, await countPendingCandidates(db, input), initialized);
        }
        const lastError = errorMessage(error);
        await db
          .updateTable("task_durability_route_state")
          .set({
            mode: "hybrid",
            seed_state: "pending",
            seed_reviewed_at: null,
            last_error: lastError,
            updated_at: now,
          })
          .where("agent_key", "=", input.agentKey)
          .where("user_id", "=", input.userId)
          .where("route_id", "=", input.routeId)
          .where("source_key", "=", input.sourceKey)
          .execute();
        return {
          initialized,
          mode: "hybrid",
          seedState: "pending",
          pendingCount: await countPendingCandidates(db, input),
          createdCount: 0,
          skippedCount: 0,
          lastError,
        };
      }
    },

    async reviewSeedCandidateById(input: ReviewSeedCandidateByIdInput): Promise<SeedReviewResult> {
      const seed = await db
        .selectFrom("task_seed_candidates")
        .select("review_code")
        .where("id", "=", input.id)
        .where("user_id", "=", input.userId)
        .executeTakeFirst();
      if (!seed) return { status: "not_found" };
      return createTaskDurabilityTransitionRepository(db).reviewSeedCandidate({
        userId: input.userId,
        code: seed.review_code,
        decision: input.decision,
        surface: input.surface,
        now: input.now,
      });
    },

    async reviewSeedCandidate(input: ReviewSeedCandidateInput): Promise<SeedReviewResult> {
      const code = input.code.trim().toUpperCase();
      if (!REVIEW_CODE_PATTERN.test(code)) return { status: "not_found" };
      const now = toIso(input.now);
      void input.surface;

      return db.transaction().execute(async (trx) => {
        const seed = await trx
          .selectFrom("task_seed_candidates")
          .selectAll()
          .where("user_id", "=", input.userId)
          .where("review_code", "=", code)
          .executeTakeFirst();
        if (!seed) return { status: "not_found" };

        const route = await loadRouteState(trx, {
          agentKey: seed.agent_key,
          userId: seed.user_id,
          routeId: seed.route_id,
        });
        const currentMode = asMode(route?.mode ?? "hybrid");
        if (!route || route.source_key !== seed.source_key) {
          await trx
            .deleteFrom("task_seed_candidates")
            .where("id", "=", seed.id)
            .where("review_state", "=", "pending")
            .execute();
          return { status: "not_found" };
        }
        if (seed.review_state !== "pending") {
          const decision = seed.review_state === "accepted" ? "track" : "dismiss";
          return {
            status: "already_reviewed",
            decision,
            ...(seed.accepted_task_id ? { taskId: seed.accepted_task_id } : {}),
            mode: currentMode,
          };
        }
        let sourceCandidate: ResolvedSeedCandidate | null = null;
        if (input.decision === "track") {
          const output = seed.origin_agent_output_id
            ? await createAgentOutputRepository(trx).getByIdForUser(
                seed.agent_key,
                seed.origin_agent_output_id,
                input.userId,
              )
            : null;
          sourceCandidate = output
            ? await findOriginatingCandidate(trx, output, seed.evidence_fingerprint, seed.source_key, null, [
                output.output.source_key,
              ])
            : null;
          if (!sourceCandidate) {
            await trx
              .deleteFrom("task_seed_candidates")
              .where("id", "=", seed.id)
              .where("review_state", "=", "pending")
              .execute();
            await finishSeedReviewIfComplete(trx, seed, now);
            return { status: "not_found" };
          }
        }
        const claimed = await trx
          .updateTable("task_seed_candidates")
          .set({ review_state: "processing", updated_at: now })
          .where("id", "=", seed.id)
          .where("review_state", "=", "pending")
          .executeTakeFirst();
        if (Number(claimed.numUpdatedRows ?? 0) === 0) {
          const reviewed = await trx
            .selectFrom("task_seed_candidates")
            .select(["review_state", "accepted_task_id"])
            .where("id", "=", seed.id)
            .executeTakeFirstOrThrow();
          return {
            status: "already_reviewed",
            decision: reviewed.review_state === "accepted" ? "track" : "dismiss",
            ...(reviewed.accepted_task_id ? { taskId: reviewed.accepted_task_id } : {}),
            mode: currentMode,
          };
        }
        const routeClaimed = await trx
          .updateTable("task_durability_route_state")
          .set({ updated_at: sql<string>`updated_at` })
          .where("agent_key", "=", seed.agent_key)
          .where("user_id", "=", seed.user_id)
          .where("route_id", "=", seed.route_id)
          .where("source_key", "=", seed.source_key)
          .executeTakeFirst();
        if (Number(routeClaimed.numUpdatedRows ?? 0) === 0) {
          await trx
            .deleteFrom("task_seed_candidates")
            .where("id", "=", seed.id)
            .where("review_state", "=", "processing")
            .execute();
          return { status: "not_found" };
        }

        if (input.decision === "dismiss") {
          await trx
            .updateTable("task_seed_candidates")
            .set({
              review_state: "dismissed",
              reviewed_at: now,
              reviewed_by_user_id: input.userId,
              updated_at: now,
            })
            .where("id", "=", seed.id)
            .where("review_state", "=", "processing")
            .execute();
          const mode = await finishSeedReviewIfComplete(trx, seed, now);
          return { status: "dismissed", mode };
        }

        if (!seed.origin_agent_output_id || !sourceCandidate) return { status: "not_found" };

        const item: AgentOutputItemInput = {
          sectionKey: "action_items",
          title: sourceCandidate.candidate.title,
          summary: sourceCandidate.candidate.summary,
          priority: sourceCandidate.candidate.priority,
          label: sourceCandidate.candidate.label,
          displayRef: sourceCandidate.candidate.displayRef,
          actionType: sourceCandidate.candidate.actionType,
          actionLabel: sourceCandidate.candidate.actionLabel,
          actionPrompt: sourceCandidate.candidate.actionPrompt,
          sourceUrl: sourceCandidate.candidate.sourceUrl,
          structuredPayload: sourceCandidate.candidate.structuredPayload,
          knowledgeRefs: sourceCandidate.candidate.knowledgeRefs,
          sortOrder: 0,
        };
        const promoted = await createTaskRepository(trx).promoteSummaryTask({
          userId: input.userId,
          item,
          sourceAnchor: sourceCandidate.anchor,
          originOutputId: seed.origin_agent_output_id,
        });
        for (const messageId of sourceCandidate.messageIds) {
          await trx
            .insertInto("task_message_evidence")
            .values({
              task_id: promoted.taskId,
              conversation_message_id: messageId,
              source_platform: sourceCandidate.anchor.platform,
              source_conversation_id: sourceCandidate.anchor.conversationId,
              source_provider_thread_id: sourceCandidate.anchor.providerThreadId,
              source_anchor_key: sourceCandidate.anchor.key,
              created_at: now,
            })
            .onConflict((oc) => oc.columns(["task_id", "conversation_message_id"]).doNothing())
            .execute();
        }
        await trx
          .updateTable("task_seed_candidates")
          .set({
            review_state: "accepted",
            accepted_task_id: promoted.taskId,
            reviewed_at: now,
            reviewed_by_user_id: input.userId,
            updated_at: now,
          })
          .where("id", "=", seed.id)
          .where("review_state", "=", "processing")
          .execute();
        const mode = await finishSeedReviewIfComplete(trx, seed, now);
        return { status: "accepted", taskId: promoted.taskId, mode };
      });
    },

    async recordIncrementalSuccess(input: RecordIncrementalSuccessInput): Promise<{ mode: TaskDurabilityMode }> {
      const now = toIso(input.now);
      const state = await loadRouteState(db, input);
      if (!state || state.source_key !== input.expectedSourceKey) return { mode: "hybrid" };
      const mode: TaskDurabilityMode = state.seed_state === "reviewed" ? "durable_only" : "hybrid";
      const updated = await db
        .updateTable("task_durability_route_state")
        .set({
          incremental_success_at: now,
          mode,
          updated_at: now,
        })
        .where("agent_key", "=", input.agentKey)
        .where("user_id", "=", input.userId)
        .where("route_id", "=", input.routeId)
        .where("source_key", "=", input.expectedSourceKey)
        .executeTakeFirst();
      return { mode: Number(updated.numUpdatedRows ?? 0) > 0 ? mode : "hybrid" };
    },

    async getUserTransition(input: GetUserTransitionInput): Promise<UserTaskDurabilityTransition> {
      const now = toIso(input.now ?? new Date());
      const activeRoutes = input.activeRoutes ? dedupeActiveRoutes(input.activeRoutes) : null;
      const activeRouteById = activeRoutes ? new Map(activeRoutes.map((route) => [route.routeId, route])) : null;
      const loadRoutes = async () => {
        let query = db
          .selectFrom("task_durability_route_state")
          .selectAll()
          .where("agent_key", "=", input.agentKey)
          .where("user_id", "=", input.userId);
        if (activeRoutes) {
          query = query.where((eb) =>
            activeRoutes.length > 0
              ? eb.or(
                  activeRoutes.map((route) =>
                    eb.and([eb("route_id", "=", route.routeId), eb("source_key", "=", route.sourceKey)]),
                  ),
                )
              : sql<boolean>`0 = 1`,
          );
        }
        return query
          .orderBy("route_id", "asc")
          .limit((activeRoutes?.length ?? TRANSITION_ROUTE_LIMIT) + 1)
          .execute();
      };
      let loadedRoutes = await loadRoutes();
      let routes = loadedRoutes.slice(0, activeRoutes?.length ?? TRANSITION_ROUTE_LIMIT);
      for (const route of routes) {
        const active = activeRouteById?.get(route.route_id);
        await reconcileInvalidPendingCandidates(
          db,
          {
            agentKey: input.agentKey,
            userId: input.userId,
            routeId: route.route_id,
            sourceKey: route.source_key,
            sourceKeys: active?.sourceKeys ?? [],
          },
          now,
        );
      }
      if (routes.length > 0) {
        loadedRoutes = await loadRoutes();
        routes = loadedRoutes.slice(0, activeRoutes?.length ?? TRANSITION_ROUTE_LIMIT);
      }
      let candidateQuery = db
        .selectFrom("task_seed_candidates")
        .select([
          "review_code",
          "title",
          "proposed_assignee_name",
          "source_platform",
          "route_id",
          "source_key",
          "created_at",
          "id",
        ])
        .where("agent_key", "=", input.agentKey)
        .where("user_id", "=", input.userId)
        .where("review_state", "=", "pending");
      if (activeRoutes) {
        candidateQuery = candidateQuery.where((eb) =>
          activeRoutes.length > 0
            ? eb.or(
                activeRoutes.map((route) =>
                  eb.and([eb("route_id", "=", route.routeId), eb("source_key", "=", route.sourceKey)]),
                ),
              )
            : sql<boolean>`0 = 1`,
        );
      }
      const loadedCandidates = await candidateQuery
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(TRANSITION_PENDING_LIMIT + 1)
        .execute();
      let dismissedQuery = db
        .selectFrom("task_seed_candidates")
        .select(["title", "source_key", "source_anchor_key", "route_id"])
        .where("agent_key", "=", input.agentKey)
        .where("user_id", "=", input.userId)
        .where("review_state", "=", "dismissed");
      if (activeRoutes) {
        dismissedQuery = dismissedQuery.where((eb) =>
          activeRoutes.length > 0
            ? eb.or(
                activeRoutes.map((route) =>
                  eb.and([eb("route_id", "=", route.routeId), eb("source_key", "=", route.sourceKey)]),
                ),
              )
            : sql<boolean>`0 = 1`,
        );
      }
      const loadedDismissed = await dismissedQuery
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(TRANSITION_SUPPRESSION_LIMIT + 1)
        .execute();
      const candidates = loadedCandidates.slice(0, TRANSITION_PENDING_LIMIT);
      const dismissed = loadedDismissed.slice(0, TRANSITION_SUPPRESSION_LIMIT);
      const allActiveRowsPresent = !activeRoutes || routes.length === activeRoutes.length;
      const overflow =
        loadedRoutes.length > (activeRoutes?.length ?? TRANSITION_ROUTE_LIMIT) ||
        loadedCandidates.length > TRANSITION_PENDING_LIMIT ||
        loadedDismissed.length > TRANSITION_SUPPRESSION_LIMIT;

      return {
        mode:
          !overflow &&
          routes.length > 0 &&
          allActiveRowsPresent &&
          routes.every((route) => route.mode === "durable_only")
            ? "durable_only"
            : "hybrid",
        overflow,
        routes: routes.map((route) => ({
          routeId: route.route_id,
          sourceKey: route.source_key,
          mode: asMode(route.mode),
          seedState: asSeedState(route.seed_state),
          lastError: route.last_error,
        })),
        untracked: candidates.map((candidate) => ({
          id: candidate.id,
          code: candidate.review_code,
          title: candidate.title,
          label: UNTRACKED_LABEL,
          proposedAssigneeName: candidate.proposed_assignee_name,
          sourcePlatform: candidate.source_platform as "slack" | "whatsapp",
        })),
        suppressedLegacy: dismissed.map((candidate) => ({
          title: candidate.title,
          sourceKey: candidate.source_key,
          sourceAnchorKey: candidate.source_anchor_key,
        })),
      };
    },
  };
}

function transitionResultFromState(
  state: Awaited<ReturnType<typeof loadRouteState>> & {},
  pendingCount: number,
  initialized: boolean,
): EnsureRouteTransitionResult {
  return {
    initialized,
    mode: asMode(state.mode),
    seedState: asSeedState(state.seed_state),
    pendingCount,
    createdCount: 0,
    skippedCount: 0,
    lastError: state.last_error,
  };
}

function activeRouteIdentity(routeId: string, sourceKey: string): string {
  return JSON.stringify([routeId, sourceKey]);
}

function dedupeActiveRoutes(routes: ActiveTaskDurabilityRoute[]): ActiveTaskDurabilityRoute[] {
  const byIdentity = new Map<string, ActiveTaskDurabilityRoute>();
  for (const route of routes) {
    if (!route.routeId || !route.sourceKey) continue;
    const identity = activeRouteIdentity(route.routeId, route.sourceKey);
    if (byIdentity.has(identity)) continue;
    byIdentity.set(identity, {
      routeId: route.routeId,
      sourceKey: route.sourceKey,
      sourceKeys: [...new Set(route.sourceKeys)].sort(),
    });
  }
  return [...byIdentity.values()];
}

async function reconcileInvalidPendingCandidates(
  db: Kysely<DB>,
  route: ActiveTaskDurabilityRoute & { agentKey: string; userId: string; allowedConversationIds?: number[] },
  now: string,
): Promise<number> {
  const pending = await db
    .selectFrom("task_seed_candidates")
    .selectAll()
    .where("agent_key", "=", route.agentKey)
    .where("user_id", "=", route.userId)
    .where("route_id", "=", route.routeId)
    .where("source_key", "=", route.sourceKey)
    .where("review_state", "=", "pending")
    .limit(TRANSITION_PENDING_LIMIT + 1)
    .execute();
  if (pending.length > TRANSITION_PENDING_LIMIT) return 0;
  if (pending.length === 0) return 0;

  const allowedConversationIds =
    route.allowedConversationIds !== undefined
      ? new Set(route.allowedConversationIds)
      : await resolveAllowedConversationIds(db, route.sourceKey, route.sourceKeys);
  let retiredCount = 0;
  for (const seed of pending) {
    const output = seed.origin_agent_output_id
      ? await createAgentOutputRepository(db).getByIdForUser(route.agentKey, seed.origin_agent_output_id, route.userId)
      : null;
    const resolved = output
      ? await findOriginatingCandidate(
          db,
          output,
          seed.evidence_fingerprint,
          seed.source_key,
          allowedConversationIds,
          route.sourceKeys,
        )
      : null;
    if (resolved?.anchor.key === seed.source_anchor_key) continue;
    const deleted = await db
      .deleteFrom("task_seed_candidates")
      .where("id", "=", seed.id)
      .where("review_state", "=", "pending")
      .executeTakeFirst();
    retiredCount += Number(deleted.numDeletedRows ?? 0);
  }
  if (retiredCount === 0) return 0;

  const pendingCount = await countPendingCandidates(db, route);
  const state = await loadRouteState(db, route);
  if (!state || state.source_key !== route.sourceKey) return retiredCount;
  const reviewed = pendingCount === 0;
  const mode: TaskDurabilityMode = reviewed && state.incremental_success_at ? "durable_only" : "hybrid";
  await db
    .updateTable("task_durability_route_state")
    .set({
      seed_state: reviewed ? "reviewed" : "pending",
      seed_reviewed_at: reviewed ? (state.seed_reviewed_at ?? now) : null,
      mode,
      updated_at: now,
    })
    .where("agent_key", "=", route.agentKey)
    .where("user_id", "=", route.userId)
    .where("route_id", "=", route.routeId)
    .where("source_key", "=", route.sourceKey)
    .execute();
  return retiredCount;
}

async function resolveAllowedConversationIds(
  db: Kysely<DB>,
  routeSourceKey: string,
  sourceKeys: string[],
): Promise<Set<number> | null> {
  const directSourceKeys =
    sourceKeys.length > 0 ? sourceKeys : routeSourceKey.startsWith("route:") ? [] : [routeSourceKey];
  if (directSourceKeys.length === 0) return null;
  const allowed = new Set<number>();
  for (const sourceKey of directSourceKeys) {
    const parsed = parseDirectSourceKey(sourceKey);
    if (!parsed) continue;
    let query = db
      .selectFrom("conversations")
      .select("id")
      .where("platform", "=", parsed.platform)
      .where("kind", "=", parsed.targetType);
    if (parsed.targetType === "dm") {
      const conversationId = Number(parsed.targetId);
      if (!Number.isSafeInteger(conversationId) || conversationId <= 0) continue;
      query = query.where("id", "=", conversationId);
    } else {
      query = query.where("provider_conversation_id", "=", parsed.targetId);
    }
    const rows = await query.limit(1).execute();
    for (const row of rows) allowed.add(row.id);
  }
  return allowed;
}

async function persistSeedCandidate(
  db: Transaction<DB>,
  input: EnsureRouteTransitionInput,
  resolved: ResolvedSeedCandidate,
  now: string,
): Promise<boolean> {
  const accepted = await db
    .selectFrom("task_seed_candidates")
    .select("id")
    .where("agent_key", "=", input.agentKey)
    .where("user_id", "=", input.userId)
    .where("evidence_fingerprint", "=", resolved.evidenceFingerprint)
    .where("review_state", "=", "accepted")
    .executeTakeFirst();
  if (accepted) return false;

  const activeTasks = await db
    .selectFrom("tasks")
    .select(["assignee_name", "proposed_assignee_name", "parent_entity_id", "parent_source_ref", "parent_name"])
    .where("source", "=", "summary")
    .where("created_by_user_id", "=", input.userId)
    .where("normalized_title", "=", normalizeName(resolved.candidate.title))
    .where("source_anchor_key", "=", resolved.anchor.key)
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"])
    .execute();
  if (
    activeTasks.some(
      (task) =>
        seedOwnerMatchesTask(resolved.proposedAssigneeName, task) &&
        seedParentMatchesTask(resolved.candidate.structuredPayload, task),
    )
  )
    return false;

  const existing = await db
    .selectFrom("task_seed_candidates")
    .select("id")
    .where("agent_key", "=", input.agentKey)
    .where("user_id", "=", input.userId)
    .where("route_id", "=", input.routeId)
    .where("evidence_fingerprint", "=", resolved.evidenceFingerprint)
    .executeTakeFirst();
  if (existing) return false;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reviewCode = await generateReviewCode(db);
    try {
      await db
        .insertInto("task_seed_candidates")
        .values({
          id: randomUUID(),
          agent_key: input.agentKey,
          user_id: input.userId,
          route_id: input.routeId,
          source_key: input.sourceKey,
          origin_agent_output_id: resolved.candidate.outputId,
          origin_agent_output_item_id: null,
          title: resolved.candidate.title.trim(),
          normalized_title: normalizeName(resolved.candidate.title),
          proposed_assignee_name: resolved.proposedAssigneeName,
          source_platform: resolved.anchor.platform,
          source_conversation_id: resolved.anchor.conversationId,
          source_provider_thread_id: resolved.anchor.providerThreadId,
          source_anchor_key: resolved.anchor.key,
          evidence_fingerprint: resolved.evidenceFingerprint,
          review_code: reviewCode,
          review_state: "pending",
          accepted_task_id: null,
          reviewed_at: null,
          reviewed_by_user_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      return true;
    } catch (error) {
      const duplicate = await db
        .selectFrom("task_seed_candidates")
        .select("id")
        .where("agent_key", "=", input.agentKey)
        .where("user_id", "=", input.userId)
        .where("route_id", "=", input.routeId)
        .where("evidence_fingerprint", "=", resolved.evidenceFingerprint)
        .executeTakeFirst();
      if (duplicate) return false;
      if (!isUniqueConstraintError(error)) throw error;
    }
  }
  throw new Error("Unable to allocate a unique task seed review code.");
}

function seedOwnerMatchesTask(
  proposedAssigneeName: string | null,
  task: { assignee_name: string | null; proposed_assignee_name: string | null },
): boolean {
  const taskName = task.proposed_assignee_name ?? task.assignee_name;
  if (!taskName) return true;
  if (!proposedAssigneeName) return false;
  return normalizeName(taskName) === normalizeName(proposedAssigneeName);
}

function seedParentMatchesTask(
  payload: Record<string, unknown> | null | undefined,
  task: { parent_entity_id: string | null; parent_source_ref: string | null; parent_name: string | null },
): boolean {
  const parentEntityId = readIdentityString(payload?.parentEntityId);
  if (parentEntityId) return task.parent_entity_id === parentEntityId;
  const parentSourceRef = readIdentityString(payload?.parentSourceRef);
  if (parentSourceRef) return task.parent_source_ref === parentSourceRef;
  const parentName = readIdentityString(payload?.parentName);
  if (parentName) return task.parent_name !== null && normalizeName(task.parent_name) === normalizeName(parentName);
  return task.parent_entity_id === null && task.parent_source_ref === null && task.parent_name === null;
}

function readIdentityString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function generateReviewCode(db: Transaction<DB>): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = randomUUID().replaceAll("-", "").slice(0, REVIEW_CODE_LENGTH).toUpperCase();
    const seed = await db
      .selectFrom("task_seed_candidates")
      .select("id")
      .where("review_code", "=", code)
      .executeTakeFirst();
    if (seed) continue;
    const recommendation = await db
      .selectFrom("task_completion_recommendations")
      .select("id")
      .where("review_code", "=", code)
      .executeTakeFirst();
    if (!recommendation) return code;
  }
  throw new Error("Unable to allocate a unique task review code.");
}

async function findOriginatingCandidate(
  db: Kysely<DB>,
  output: Awaited<ReturnType<ReturnType<typeof createAgentOutputRepository>["getByIdForUser"]>>,
  fingerprint: string,
  sourceKey: string,
  allowedConversationIds: Set<number> | null = null,
  sourceKeys: string[] = [],
): Promise<ResolvedSeedCandidate | null> {
  if (!output) return null;
  for (const candidate of extractSummarizerSeedCandidates([output])) {
    const resolved = await resolveSeedCandidate(db, candidate, sourceKey, allowedConversationIds, sourceKeys);
    if (resolved?.evidenceFingerprint === fingerprint) return resolved;
  }
  return null;
}

async function resolveSeedCandidate(
  db: Kysely<DB>,
  candidate: SummarizerSeedCandidate,
  sourceKey: string,
  allowedConversationIds: Set<number> | null = null,
  sourceKeys: string[] = [],
): Promise<ResolvedSeedCandidate | null> {
  if (!eligibleSeedSourceKeys(sourceKey, sourceKeys).includes(candidate.sourceKey)) return null;
  const messageIds = readInternalMessageIds(candidate.structuredPayload);
  if (!messageIds) return null;
  const messages = (await db
    .selectFrom("conversation_messages as m")
    .innerJoin("conversations as c", "c.id", "m.conversation_id")
    .select([
      "m.id",
      "m.conversation_id",
      "m.provider_thread_id",
      "m.is_thread_reply",
      "c.platform",
      "c.kind",
      "c.provider_conversation_id",
    ])
    .where("m.id", "in", messageIds)
    .limit(messageIds.length)
    .execute()) as EvidenceMessageRow[];
  if (messages.length !== messageIds.length) return null;

  const anchors = new Map<string, ConversationTaskSourceAnchor>();
  for (const message of messages) {
    if (message.platform !== "slack" && message.platform !== "whatsapp") return null;
    if (allowedConversationIds && !allowedConversationIds.has(message.conversation_id)) return null;
    if (!messageMatchesSourceKey(message, candidate.sourceKey)) return null;
    const providerThreadId =
      message.platform === "slack" && message.is_thread_reply === 1 ? message.provider_thread_id : null;
    const key = sourceAnchorKey(message.platform, message.conversation_id, providerThreadId);
    anchors.set(key, {
      platform: message.platform,
      conversationId: message.conversation_id,
      providerThreadId,
      key,
    });
  }
  if (anchors.size !== 1) return null;
  const anchor = anchors.values().next().value;
  if (!anchor) return null;
  const proposedAssigneeName = readProposedAssigneeName(candidate.structuredPayload);
  return {
    candidate,
    anchor,
    messageIds: [...messageIds].sort((left, right) => left - right),
    evidenceFingerprint: createEvidenceFingerprint(candidate.title, anchor.key, messageIds),
    proposedAssigneeName,
  };
}

function eligibleSeedSourceKeys(routeSourceKey: string, sourceKeys: string[] = []): string[] {
  const members = routeSourceKey.startsWith("route:")
    ? sourceKeys.filter((sourceKey) => parseDirectSourceKey(sourceKey) !== null)
    : [];
  return [...new Set([routeSourceKey, ...members])];
}

function readInternalMessageIds(payload: Record<string, unknown> | null | undefined): number[] | null {
  const value = payload?.messageIds;
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids: number[] = [];
  for (const entry of value) {
    const parsed =
      typeof entry === "number" && Number.isSafeInteger(entry)
        ? entry
        : typeof entry === "string" && /^\d+$/.test(entry.trim())
          ? Number(entry.trim())
          : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    ids.push(parsed);
  }
  return [...new Set(ids)];
}

function readProposedAssigneeName(payload: Record<string, unknown> | null | undefined): string | null {
  for (const key of ["assigneeName", "ownerName", "owner", "assigneeEmail", "ownerEmail"]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function messageMatchesSourceKey(message: EvidenceMessageRow, sourceKey: string): boolean {
  const parsed = parseDirectSourceKey(sourceKey);
  if (!parsed) return sourceKey.startsWith("route:");
  if (parsed.targetType === "dm") {
    const conversationId = Number(parsed.targetId);
    return (
      Number.isSafeInteger(conversationId) &&
      conversationId > 0 &&
      message.platform === parsed.platform &&
      message.conversation_id === conversationId &&
      message.kind === "dm"
    );
  }
  return (
    message.platform === parsed.platform &&
    message.provider_conversation_id === parsed.targetId &&
    message.kind === parsed.targetType
  );
}

function parseDirectSourceKey(
  sourceKey: string,
): { platform: "slack" | "whatsapp"; targetType: string; targetId: string } | null {
  const match = /^(slack|whatsapp):([^:]+):(.+)$/.exec(sourceKey);
  if (!match) return null;
  return {
    platform: match[1] as "slack" | "whatsapp",
    targetType: match[2],
    targetId: match[3],
  };
}

function sourceAnchorKey(platform: string, conversationId: number, providerThreadId: string | null): string {
  return `${platform}:${conversationId}:${providerThreadId ?? "root"}`;
}

function createEvidenceFingerprint(title: string, anchorKey: string, messageIds: number[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify([normalizeName(title), anchorKey, [...new Set(messageIds)].sort((left, right) => left - right)]),
    )
    .digest("hex");
}

async function finishSeedReviewIfComplete(
  db: Transaction<DB>,
  seed: {
    agent_key: string;
    user_id: string;
    route_id: string;
    source_key: string;
  },
  now: string,
): Promise<TaskDurabilityMode> {
  const pendingCount = await countPendingCandidates(db, {
    agentKey: seed.agent_key,
    userId: seed.user_id,
    routeId: seed.route_id,
  });
  const route = await loadRouteState(db, {
    agentKey: seed.agent_key,
    userId: seed.user_id,
    routeId: seed.route_id,
  });
  const reviewed = pendingCount === 0;
  const mode: TaskDurabilityMode = reviewed && route?.incremental_success_at ? "durable_only" : "hybrid";
  await db
    .updateTable("task_durability_route_state")
    .set({
      seed_state: reviewed ? "reviewed" : "pending",
      seed_reviewed_at: reviewed ? (route?.seed_reviewed_at ?? now) : null,
      mode,
      updated_at: now,
    })
    .where("agent_key", "=", seed.agent_key)
    .where("user_id", "=", seed.user_id)
    .where("route_id", "=", seed.route_id)
    .where("source_key", "=", seed.source_key)
    .execute();
  return mode;
}

async function loadRouteState(db: Kysely<DB>, input: { agentKey: string; userId: string; routeId: string }) {
  return db
    .selectFrom("task_durability_route_state")
    .selectAll()
    .where("agent_key", "=", input.agentKey)
    .where("user_id", "=", input.userId)
    .where("route_id", "=", input.routeId)
    .executeTakeFirst();
}

async function countPendingCandidates(
  db: Kysely<DB>,
  input: { agentKey: string; userId: string; routeId: string },
): Promise<number> {
  const row = await db
    .selectFrom("task_seed_candidates")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("agent_key", "=", input.agentKey)
    .where("user_id", "=", input.userId)
    .where("route_id", "=", input.routeId)
    .where("review_state", "=", "pending")
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

function sevenDayBoundary(now: string): string {
  const value = new Date(now);
  value.setUTCDate(value.getUTCDate() - SEED_LOOKBACK_DAYS);
  return value.toISOString();
}

function toIso(value: ClockValue): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid transition timestamp.");
  return date.toISOString();
}

function asMode(value: string): TaskDurabilityMode {
  return value === "durable_only" ? "durable_only" : "hybrid";
}

function asSeedState(value: string): SeedState {
  return value === "reviewed" ? "reviewed" : "pending";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique constraint") || message.includes("duplicate key");
}
