import { randomUUID } from "node:crypto";
import type { Kysely, Selectable, Transaction } from "kysely";
import { yieldToEventLoop } from "../../lib/event-loop";
import type { DB, TaskCycleMembershipsTable } from "../schema";
import { isUniqueConstraintError } from "./sub-entities";

export type WorkCycleState = "planned" | "active" | "closed";

export interface UpsertWorkCycleInput {
  scopeEntityId?: string | null;
  connectorConfigId: string;
  source: string;
  externalRef: string;
  name: string;
  sequence?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  state?: WorkCycleState;
  lastSeenSyncRunId?: string | null;
}

export interface AssignMembershipInput {
  taskId: string;
  cycleId: string;
  sourceFactId?: string | null;
  at: string;
}

export interface ReconcileWorkCyclesInput {
  connectorConfigId: string;
  syncRunId: string;
  at: string;
}

export interface CloseOpenMembershipForTaskInput {
  taskId: string;
  at: string;
}

export interface CycleRollup {
  open: number;
  in_progress: number;
  done: number;
  dropped: number;
  total: number;
}

type CurrentMembership = Selectable<TaskCycleMembershipsTable>;
type WorkCycleDb = Kysely<DB> | Transaction<DB>;

export async function upsertWorkCycle(
  db: Kysely<DB>,
  input: UpsertWorkCycleInput,
): Promise<{ cycleId: string; created: boolean }> {
  if (!input.connectorConfigId) throw new Error("Work cycle upsert requires connectorConfigId");
  const existing = await db
    .selectFrom("work_cycles")
    .selectAll()
    .where("connector_config_id", "=", input.connectorConfigId)
    .where("source", "=", input.source)
    .where("external_ref", "=", input.externalRef)
    .executeTakeFirst();
  const now = new Date().toISOString();
  const values = {
    scope_entity_id: input.scopeEntityId ?? null,
    connector_config_id: input.connectorConfigId,
    name: input.name,
    sequence: input.sequence ?? null,
    starts_at: input.startsAt ?? null,
    ends_at: input.endsAt ?? null,
    state: input.state ?? existing?.state ?? "active",
    last_seen_sync_run_id: input.lastSeenSyncRunId ?? null,
    deleted_at: null,
    updated_at: now,
  };

  await db
    .insertInto("work_cycles")
    .values({
      id: existing?.id ?? randomUUID(),
      source: input.source,
      external_ref: input.externalRef,
      ...values,
      state: input.state ?? "active",
    })
    .onConflict((oc) =>
      oc.columns(["connector_config_id", "source", "external_ref"]).doUpdateSet({
        ...values,
      }),
    )
    .execute();

  const row = await db
    .selectFrom("work_cycles")
    .select("id")
    .where("connector_config_id", "=", input.connectorConfigId)
    .where("source", "=", input.source)
    .where("external_ref", "=", input.externalRef)
    .executeTakeFirstOrThrow();
  return { cycleId: row.id, created: !existing };
}

/**
 * Keeps cycle assignment append-only. A concurrent duplicate-open insert is rejected
 * by the partial unique index, after which the current row is re-read and retried once.
 */
export async function assignMembership(
  db: Kysely<DB>,
  input: AssignMembershipInput,
): Promise<{ membershipId: string }> {
  try {
    return await assignMembershipInTransaction(db, input);
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    await selectCurrentMembership(db, input.taskId);
    return assignMembershipInTransaction(db, input);
  }
}

export async function reconcileWorkCycles(db: Kysely<DB>, input: ReconcileWorkCyclesInput): Promise<number> {
  const rows = await db
    .selectFrom("work_cycles")
    .select("id")
    .where("connector_config_id", "=", input.connectorConfigId)
    .where("deleted_at", "is", null)
    .where((eb) => eb.or([eb("last_seen_sync_run_id", "is", null), eb("last_seen_sync_run_id", "!=", input.syncRunId)]))
    .execute();

  let closed = 0;
  for (const row of rows) {
    await db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable("work_cycles")
        .set({ state: "closed", deleted_at: input.at, updated_at: input.at })
        .where("id", "=", row.id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows ?? 0) === 0) return;
      await trx
        .updateTable("task_cycle_memberships")
        .set({ removed_at: input.at })
        .where("cycle_id", "=", row.id)
        .where("removed_at", "is", null)
        .execute();
      closed++;
    });
    await yieldToEventLoop();
  }
  return closed;
}

export async function closeOpenMembershipForTask(
  db: Kysely<DB>,
  input: CloseOpenMembershipForTaskInput,
): Promise<number> {
  const result = await db
    .updateTable("task_cycle_memberships")
    .set({ removed_at: input.at })
    .where("task_id", "=", input.taskId)
    .where("removed_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

export async function getCycleRollup(db: Kysely<DB>, cycleId: string): Promise<CycleRollup> {
  const rows = await db
    .selectFrom("task_cycle_memberships")
    .innerJoin("tasks", "tasks.id", "task_cycle_memberships.task_id")
    .select(["tasks.status as status"])
    .select((eb) => eb.fn.countAll().as("count"))
    .where("task_cycle_memberships.cycle_id", "=", cycleId)
    .where("task_cycle_memberships.removed_at", "is", null)
    .groupBy("tasks.status")
    .execute();

  const rollup: CycleRollup = { open: 0, in_progress: 0, done: 0, dropped: 0, total: 0 };
  for (const row of rows) {
    const count = Number(row.count);
    if (row.status === "open" || row.status === "in_progress" || row.status === "done" || row.status === "dropped") {
      rollup[row.status] = count;
    }
    rollup.total += count;
  }
  return rollup;
}

async function assignMembershipInTransaction(
  db: Kysely<DB>,
  input: AssignMembershipInput,
): Promise<{ membershipId: string }> {
  return db.transaction().execute(async (trx) => {
    const current = await selectCurrentMembership(trx, input.taskId);
    if (current?.cycle_id === input.cycleId) return { membershipId: current.id };

    if (current) {
      await trx
        .updateTable("task_cycle_memberships")
        .set({ removed_at: input.at })
        .where("id", "=", current.id)
        .where("removed_at", "is", null)
        .execute();
    }

    const id = randomUUID();
    await trx
      .insertInto("task_cycle_memberships")
      .values({
        id,
        task_id: input.taskId,
        cycle_id: input.cycleId,
        assigned_at: input.at,
        removed_at: null,
        source_fact_id: input.sourceFactId ?? null,
      })
      .execute();
    return { membershipId: id };
  });
}

async function selectCurrentMembership(db: WorkCycleDb, taskId: string): Promise<CurrentMembership | undefined> {
  return db
    .selectFrom("task_cycle_memberships")
    .selectAll()
    .where("task_id", "=", taskId)
    .where("removed_at", "is", null)
    .executeTakeFirst();
}
