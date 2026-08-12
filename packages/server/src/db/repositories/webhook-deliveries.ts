import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import type { DB, WebhookDeliveriesTable } from "../schema";

export type WebhookDeliveryStatus = "pending" | "queued" | "processing" | "completed" | "failed" | "cancelled";
export type WebhookDeliveryRow = Selectable<WebhookDeliveriesTable>;

export interface WebhookDeliveryInsertInput {
  readonly id?: string;
  readonly endpointId: string;
  readonly taskId: string;
  readonly eventId: string;
  readonly payloadHash: string;
  readonly triggerData: unknown;
  readonly taskRevision: number;
  readonly endpointGeneration: number;
  readonly status?: WebhookDeliveryStatus;
  readonly createdAt?: string;
}

export interface WebhookDeliveryListOptions {
  readonly endpointId?: string;
  readonly taskId?: string;
  readonly statuses?: readonly WebhookDeliveryStatus[];
  readonly limit?: number;
  readonly before?: string;
  readonly after?: string;
}

export interface WebhookDeliveryRepositoryOptions {
  readonly now?: () => string;
  readonly idGenerator?: () => string;
}

function serializeTriggerData(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("triggerData must be JSON-serializable");
  return serialized;
}

function parseOptions(options?: WebhookDeliveryRepositoryOptions): Required<WebhookDeliveryRepositoryOptions> {
  return {
    now: options?.now ?? (() => new Date().toISOString()),
    idGenerator: options?.idGenerator ?? randomUUID,
  };
}

export function createWebhookDeliveriesRepository(db: Kysely<DB>, options?: WebhookDeliveryRepositoryOptions) {
  const repositoryOptions = parseOptions(options);

  async function getById(id: string): Promise<WebhookDeliveryRow | undefined> {
    return db.selectFrom("webhook_deliveries").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async function updateById(
    id: string,
    updates: Record<string, unknown>,
    options: { readonly statuses?: readonly WebhookDeliveryStatus[]; readonly runId?: string } = {},
  ): Promise<WebhookDeliveryRow | undefined> {
    let query = db.updateTable("webhook_deliveries").set(updates).where("id", "=", id);
    if (options.statuses && options.statuses.length > 0) query = query.where("status", "in", options.statuses);
    if (options.runId !== undefined) query = query.where("run_id", "=", options.runId);
    const result = await query.executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return undefined;
    return getById(id);
  }

  return {
    async insertOrGet(input: WebhookDeliveryInsertInput): Promise<{ delivery: WebhookDeliveryRow; created: boolean }> {
      const timestamp = input.createdAt ?? repositoryOptions.now();
      const result = await db
        .insertInto("webhook_deliveries")
        .values({
          id: input.id ?? repositoryOptions.idGenerator(),
          endpoint_id: input.endpointId,
          task_id: input.taskId,
          event_id: input.eventId,
          payload_hash: input.payloadHash,
          trigger_data: serializeTriggerData(input.triggerData),
          status: input.status ?? "pending",
          task_revision: input.taskRevision,
          endpoint_generation: input.endpointGeneration,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .onConflict((oc) => oc.columns(["endpoint_id", "event_id"]).doNothing())
        .executeTakeFirst();
      const delivery = await db
        .selectFrom("webhook_deliveries")
        .selectAll()
        .where("endpoint_id", "=", input.endpointId)
        .where("event_id", "=", input.eventId)
        .executeTakeFirst();
      if (!delivery) throw new Error("Webhook delivery could not be inserted or loaded");
      return { delivery, created: Number(result.numInsertedOrUpdatedRows ?? 0) > 0 };
    },

    async get(id: string): Promise<WebhookDeliveryRow | undefined> {
      return getById(id);
    },

    async getById(id: string): Promise<WebhookDeliveryRow | undefined> {
      return getById(id);
    },

    async getByEventId(endpointId: string, eventId: string): Promise<WebhookDeliveryRow | undefined> {
      return db
        .selectFrom("webhook_deliveries")
        .selectAll()
        .where("endpoint_id", "=", endpointId)
        .where("event_id", "=", eventId)
        .executeTakeFirst();
    },

    async list(
      taskIdOrOptions?: string | WebhookDeliveryListOptions,
      fallbackLimit = 100,
    ): Promise<WebhookDeliveryRow[]> {
      const options: WebhookDeliveryListOptions =
        typeof taskIdOrOptions === "string"
          ? { taskId: taskIdOrOptions, limit: fallbackLimit }
          : (taskIdOrOptions ?? {});
      let query = db.selectFrom("webhook_deliveries").selectAll();
      if (options.endpointId) query = query.where("endpoint_id", "=", options.endpointId);
      if (options.taskId) query = query.where("task_id", "=", options.taskId);
      if (options.statuses && options.statuses.length > 0) query = query.where("status", "in", options.statuses);
      if (options.before) query = query.where("created_at", "<", options.before);
      if (options.after) query = query.where("created_at", ">", options.after);
      return query
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(options.limit ?? fallbackLimit)
        .execute();
    },

    async listForRecovery(
      options: { readonly before: string; readonly limit?: number } = { before: repositoryOptions.now() },
    ) {
      return db
        .selectFrom("webhook_deliveries")
        .selectAll()
        .where("status", "=", "processing")
        .where("claimed_at", "is not", null)
        .where("claimed_at", "<", options.before)
        .orderBy("claimed_at", "asc")
        .limit(options.limit ?? 100)
        .execute();
    },

    async markQueued(id: string, runId?: string): Promise<WebhookDeliveryRow | undefined> {
      const timestamp = repositoryOptions.now();
      const updates: Record<string, unknown> = { status: "queued", updated_at: timestamp, error_message: null };
      if (runId !== undefined) updates.run_id = runId;
      await db
        .updateTable("webhook_deliveries")
        .set(updates)
        .where("id", "=", id)
        .where("status", "=", "pending")
        .execute();
      return getById(id);
    },

    async claim(id: string, options: { readonly runId?: string; readonly now?: string } = {}) {
      const timestamp = options.now ?? repositoryOptions.now();
      const updates: Record<string, unknown> = {
        status: "processing",
        claimed_at: timestamp,
        updated_at: timestamp,
      };
      if (options.runId !== undefined) updates.run_id = options.runId;
      await db
        .updateTable("webhook_deliveries")
        .set({ ...updates, attempt_count: sql<number>`attempt_count + 1` })
        .where("id", "=", id)
        .where("status", "=", "queued")
        .execute();
      return getById(id);
    },

    async claimNext(options: { readonly taskId?: string; readonly endpointId?: string; readonly runId?: string } = {}) {
      const candidates = await this.list({ ...options, statuses: ["queued"], limit: 10 });
      for (const candidate of candidates) {
        const claimed = await this.claim(candidate.id, { runId: options.runId });
        if (claimed?.status === "processing") return claimed;
      }
      return undefined;
    },

    async heartbeat(id: string, runId: string, now = repositoryOptions.now()): Promise<boolean> {
      const result = await db
        .updateTable("webhook_deliveries")
        .set({ claimed_at: now, updated_at: now })
        .where("id", "=", id)
        .where("status", "=", "processing")
        .where("run_id", "=", runId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },

    async complete(id: string, runId?: string, completedAt?: string): Promise<WebhookDeliveryRow | undefined> {
      const timestamp = completedAt ?? repositoryOptions.now();
      const updates: Record<string, unknown> = {
        status: "completed",
        completed_at: timestamp,
        updated_at: timestamp,
        error_message: null,
      };
      if (runId !== undefined) updates.run_id = runId;
      return updateById(id, updates, { statuses: ["processing"], ...(runId ? { runId } : {}) });
    },

    async fail(
      id: string,
      errorMessage: string,
      completedAt?: string,
      runId?: string,
    ): Promise<WebhookDeliveryRow | undefined> {
      const timestamp = completedAt ?? repositoryOptions.now();
      return updateById(
        id,
        {
          status: "failed",
          error_message: errorMessage,
          completed_at: timestamp,
          updated_at: timestamp,
        },
        { statuses: ["pending", "queued", "processing"], ...(runId ? { runId } : {}) },
      );
    },

    async cancel(
      id: string,
      errorMessage?: string,
      completedAt?: string,
      runId?: string,
    ): Promise<WebhookDeliveryRow | undefined> {
      const timestamp = completedAt ?? repositoryOptions.now();
      return updateById(
        id,
        {
          status: "cancelled",
          error_message: errorMessage ?? null,
          completed_at: timestamp,
          updated_at: timestamp,
        },
        { statuses: ["pending", "queued", "processing"], ...(runId ? { runId } : {}) },
      );
    },

    async reset(id: string, errorMessage?: string, runId?: string): Promise<WebhookDeliveryRow | undefined> {
      return updateById(
        id,
        {
          status: "queued",
          claimed_at: null,
          error_message: errorMessage ?? null,
          completed_at: null,
          updated_at: repositoryOptions.now(),
        },
        { statuses: ["queued", "processing"], ...(runId ? { runId } : {}) },
      );
    },

    async recoverStale(
      options: { readonly before: string; readonly limit?: number } = { before: repositoryOptions.now() },
    ) {
      const stale = await this.listForRecovery(options);
      for (const row of stale)
        await this.reset(row.id, "Recovered after an interrupted webhook delivery", row.run_id ?? undefined);
      return stale.length;
    },

    async deleteByTaskId(taskId: string): Promise<void> {
      await db.deleteFrom("webhook_deliveries").where("task_id", "=", taskId).execute();
    },
  };
}

export const createWebhookDeliveryRepository = createWebhookDeliveriesRepository;
