import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema";
import { createEntityReviewRepo } from "./entity-review";
import { ensureEntitiesForUsersWithOutcomes, ensureUserEntityLinksForEntities } from "./user-entity-linking";
import type { UserEntityLinkOutcome } from "./user-entity-linking";
import type { UserRepository } from "./users";

const RUN_KEY = "user-entity-link-sweep";
const ENTITY_STAGE = "entities-without-links";
const USER_STAGE = "human-users-without-links";
const COMPLETED_STAGE = "completed";
const RUNNING = "running";
const QUEUED = "queued";
const COMPLETED = "completed";
const FAILED = "failed";
const TERMINAL_REVIEW_STATUSES = ["confirmed", "rejected", "confirming", "dismissed"];
const LEASE_DURATION_MS = 30 * 60 * 1000;

export type UserEntityLinkSweepResult = {
  status: string;
  stage: string;
  linkedByEmail: number;
  linkedByPhone: number;
  linkedByUserCreation: number;
  provisioned: number;
  reviewQueued: number;
  skipped: number;
};

export interface UserEntityLinkSweepService {
  runOnce(): Promise<UserEntityLinkSweepResult>;
  start(): void;
  stop(): Promise<void>;
}

type SweepDeps = {
  db: Kysely<DB>;
  users: UserRepository;
  batchSize?: number;
  intervalMs?: number;
  logger?: { error(bindings: Record<string, unknown>, message: string): void };
};

function timestamp(): string {
  return new Date().toISOString();
}

function countersFromRun(run: Awaited<ReturnType<typeof ensureRun>>) {
  return {
    linkedByEmail: run.linked_by_email,
    linkedByPhone: run.linked_by_phone,
    linkedByUserCreation: run.linked_by_user_creation,
    provisioned: run.provisioned,
    reviewQueued: run.review_queued,
    skipped: run.skipped,
  };
}

async function ensureRun(db: Kysely<DB>) {
  const existing = await db
    .selectFrom("user_entity_link_sweep_runs")
    .selectAll()
    .where("run_key", "=", RUN_KEY)
    .executeTakeFirst();
  if (existing) return existing;
  await db
    .insertInto("user_entity_link_sweep_runs")
    .values({ id: randomUUID(), run_key: RUN_KEY, status: QUEUED, stage: ENTITY_STAGE })
    .onConflict((oc) => oc.column("run_key").doNothing())
    .execute();
  return db
    .selectFrom("user_entity_link_sweep_runs")
    .selectAll()
    .where("run_key", "=", RUN_KEY)
    .executeTakeFirstOrThrow();
}

async function queueStaleLinkReview(
  db: Kysely<DB>,
  entityId: string,
  userId: string,
  mergedIntoEntityId: string,
  proposedName?: string,
): Promise<boolean> {
  const existing = await db
    .selectFrom("entity_review_queue")
    .select("status")
    .where("source", "=", "user_entity_link")
    .where("source_id", "=", entityId)
    .executeTakeFirst();
  if (existing && !TERMINAL_REVIEW_STATUSES.includes(existing.status)) return false;
  const entity = proposedName
    ? { id: entityId, name: proposedName }
    : await db.selectFrom("entities").select(["id", "name"]).where("id", "=", entityId).executeTakeFirst();
  if (!entity) return false;
  const result = await createEntityReviewRepo(db).upsertUserEntityLinkReview({
    entityId,
    proposedName: entity.name,
    candidateUserIds: [userId],
    candidateEntityIds: [entityId, mergedIntoEntityId],
    candidateReason: "stale-merged-link",
    triggeredByUserId: "system",
  });
  return result.wrote;
}

function incrementOutcome(
  outcome: UserEntityLinkOutcome,
  counters: {
    linkedByEmail: number;
    linkedByPhone: number;
    linkedByUserCreation: number;
    provisioned: number;
    reviewQueued: number;
    skipped: number;
  },
): void {
  if (outcome.outcome === "review_queued") counters.reviewQueued += 1;
  else if (outcome.outcome === "skipped") counters.skipped += 1;
  else if (outcome.outcome === "linked") {
    if (outcome.matchedVia === "email") counters.linkedByEmail += 1;
    if (outcome.matchedVia === "phone") counters.linkedByPhone += 1;
    if (outcome.matchedVia === "user_creation") counters.linkedByUserCreation += 1;
    if (outcome.matchedVia === "provisioning") counters.provisioned += 1;
  }
}

export function createUserEntityLinkSweepService(deps: SweepDeps): UserEntityLinkSweepService {
  const batchSize = deps.batchSize ?? 100;
  const intervalMs = deps.intervalMs ?? 7 * 24 * 60 * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<UserEntityLinkSweepResult> | null = null;
  let ownedRunId: string | null = null;
  let ownedLeaseToken: string | null = null;

  async function runOnce(): Promise<UserEntityLinkSweepResult> {
    if (inflight) return inflight;
    inflight = runSweep().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function runSweep(): Promise<UserEntityLinkSweepResult> {
    const current = await ensureRun(deps.db);
    const cutoff = new Date(Date.now() - LEASE_DURATION_MS).toISOString();
    if (
      current.status === RUNNING &&
      ownedRunId !== current.id &&
      current.heartbeat_at !== null &&
      current.heartbeat_at >= cutoff
    ) {
      return {
        status: current.status,
        stage: current.stage,
        linkedByEmail: current.linked_by_email,
        linkedByPhone: current.linked_by_phone,
        linkedByUserCreation: current.linked_by_user_creation,
        provisioned: current.provisioned,
        reviewQueued: current.review_queued,
        skipped: current.skipped,
      };
    }
    const now = timestamp();
    const leaseToken = ownedRunId === current.id ? ownedLeaseToken : randomUUID();
    const run =
      ownedRunId === current.id
        ? current
        : await deps.db
            .updateTable("user_entity_link_sweep_runs")
            .set({
              lease_token: leaseToken,
              status: RUNNING,
              stage: current.status === COMPLETED ? ENTITY_STAGE : current.stage,
              entity_cursor: current.status === COMPLETED ? null : current.entity_cursor,
              user_cursor: current.status === COMPLETED ? null : current.user_cursor,
              heartbeat_at: now,
              started_at: current.status === COMPLETED ? now : current.started_at,
              completed_at: null,
              error: null,
              updated_at: now,
            })
            .where("id", "=", current.id)
            .where((eb) =>
              eb.or([eb("status", "!=", RUNNING), eb("heartbeat_at", "is", null), eb("heartbeat_at", "<", cutoff)]),
            )
            .returningAll()
            .executeTakeFirst();
    if (!run) return { status: current.status, stage: current.stage, ...countersFromRun(current) };
    if (!leaseToken) throw new Error("user entity link sweep lease token missing");
    const ownedRun = run;
    ownedRunId = run.id;
    ownedLeaseToken = leaseToken;

    async function updateOwnedRun(values: Record<string, unknown>) {
      const updated = await deps.db
        .updateTable("user_entity_link_sweep_runs")
        .set(values)
        .where("id", "=", ownedRun.id)
        .where("lease_token", "=", leaseToken)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new Error("user entity link sweep lease lost");
      return updated;
    }

    const counters = {
      linkedByEmail: run.linked_by_email,
      linkedByPhone: run.linked_by_phone,
      linkedByUserCreation: run.linked_by_user_creation,
      provisioned: run.provisioned,
      reviewQueued: run.review_queued,
      skipped: run.skipped,
    };
    const dbCounters = () => ({
      linked_by_email: counters.linkedByEmail,
      linked_by_phone: counters.linkedByPhone,
      linked_by_user_creation: counters.linkedByUserCreation,
      provisioned: counters.provisioned,
      review_queued: counters.reviewQueued,
      skipped: counters.skipped,
    });
    let entityCursor = run.entity_cursor;
    let userCursor = run.user_cursor;
    let stage = run.stage;
    try {
      while (stage !== COMPLETED_STAGE) {
        if (stage === ENTITY_STAGE) {
          const entityQuery = deps.db
            .selectFrom("entities")
            .select(["id", "name", "merged_into_entity_id"])
            .where("source_type", "=", "person")
            .where((eb) => eb.or([eb("deleted_at", "is", null), eb("merged_into_entity_id", "is not", null)]));
          const entities = await (entityCursor ? entityQuery.where("id", ">", entityCursor) : entityQuery)
            .orderBy("id", "asc")
            .limit(batchSize)
            .execute();
          const links =
            entities.length === 0
              ? []
              : await deps.db
                  .selectFrom("user_entity_links")
                  .select(["entity_id", "user_id"])
                  .where(
                    "entity_id",
                    "in",
                    entities.map((entity) => entity.id),
                  )
                  .execute();
          const linksByEntity = new Map(links.map((link) => [link.entity_id, link]));
          const unlinkedEntityIds: string[] = [];
          for (const entity of entities) {
            const link = linksByEntity.get(entity.id);
            if (link && entity.merged_into_entity_id) {
              if (
                await queueStaleLinkReview(deps.db, entity.id, link.user_id, entity.merged_into_entity_id, entity.name)
              ) {
                counters.reviewQueued += 1;
              }
            } else if (!link) {
              unlinkedEntityIds.push(entity.id);
            }
          }
          const outcomes = await ensureUserEntityLinksForEntities(deps.db, unlinkedEntityIds, { users: deps.users });
          for (const outcome of outcomes) incrementOutcome(outcome, counters);
          stage = entities.length < batchSize ? USER_STAGE : ENTITY_STAGE;
          entityCursor = entities.at(-1)?.id ?? entityCursor;
          await updateOwnedRun({
            stage,
            entity_cursor: entityCursor,
            heartbeat_at: timestamp(),
            ...dbCounters(),
            updated_at: timestamp(),
          });
          continue;
        }

        if (stage !== USER_STAGE) throw new Error(`unknown user entity link sweep stage: ${stage}`);
        const userQuery = deps.db.selectFrom("users").select(["id"]).where("type", "=", "human");
        const users = await (userCursor ? userQuery.where("id", ">", userCursor) : userQuery)
          .orderBy("id", "asc")
          .limit(batchSize)
          .execute();
        const beforeLinks =
          users.length === 0
            ? []
            : await deps.db
                .selectFrom("user_entity_links")
                .select(["user_id"])
                .where(
                  "user_id",
                  "in",
                  users.map((user) => user.id),
                )
                .execute();
        const beforeLinkedUserIds = new Set(beforeLinks.map((link) => link.user_id));
        const ensured = await ensureEntitiesForUsersWithOutcomes(
          deps.db,
          users.filter((user) => !beforeLinkedUserIds.has(user.id)).map((user) => user.id),
        );
        for (const user of users) {
          if (beforeLinkedUserIds.has(user.id)) continue;
          const outcome = ensured.get(user.id)?.outcome;
          if (outcome) incrementOutcome(outcome, counters);
          else counters.skipped += 1;
        }
        const done = users.length < batchSize;
        stage = done ? COMPLETED_STAGE : USER_STAGE;
        userCursor = users.at(-1)?.id ?? userCursor;
        const updated = await updateOwnedRun({
          status: done ? COMPLETED : RUNNING,
          stage,
          user_cursor: userCursor,
          heartbeat_at: timestamp(),
          completed_at: done ? timestamp() : null,
          ...dbCounters(),
          updated_at: timestamp(),
        });
        if (updated.status === COMPLETED) {
          ownedRunId = null;
          ownedLeaseToken = null;
          return {
            status: updated.status,
            stage: updated.stage,
            ...counters,
          };
        }
      }
      throw new Error("user entity link sweep completed without a terminal update");
    } catch (error) {
      ownedRunId = null;
      ownedLeaseToken = null;
      await deps.db
        .updateTable("user_entity_link_sweep_runs")
        .set({
          status: FAILED,
          error: error instanceof Error ? error.message : "sweep failed",
          heartbeat_at: null,
          updated_at: timestamp(),
        })
        .where("id", "=", run.id)
        .where("lease_token", "=", leaseToken)
        .execute();
      throw error;
    }
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      void runOnce().catch((error) => deps.logger?.error({ err: error }, "User entity link sweep failed"));
      timer = setInterval(
        () => void runOnce().catch((error) => deps.logger?.error({ err: error }, "User entity link sweep failed")),
        intervalMs,
      );
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await inflight;
    },
  };
}
