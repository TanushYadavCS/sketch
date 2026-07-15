import { createHash, randomUUID } from "node:crypto";
import { type Insertable, type Kysely, type Selectable, type Transaction, sql } from "kysely";
import { isPg } from "../dialect";
import type { DB, WhatsAppInboundEventsTable } from "../schema";

export const WHATSAPP_INBOUND_MAX_ATTEMPTS = 5;
export const WHATSAPP_INBOUND_CLAIM_BATCH_SIZE = 25;
export const WHATSAPP_INBOUND_ENVELOPE_MAX_BYTES = 256 * 1024;
export const WHATSAPP_INBOUND_SWEEP_BATCH_SIZE = 500;

export type WhatsAppInboundEventKind = "message" | "history_message" | "history_batch";
export type WhatsAppInboundEventOrigin = "gateway" | "inprocess";
export type WhatsAppInboundEventStatus = "pending" | "processing" | "captured" | "consumed" | "dead";
export type WhatsAppInboundEventRow = Selectable<WhatsAppInboundEventsTable>;
type WhatsAppInboundDb = Kysely<DB> | Transaction<DB>;

export interface WhatsAppInboundEventInsert {
  kind: WhatsAppInboundEventKind;
  origin: WhatsAppInboundEventOrigin;
  eventKey?: string | null;
  providerMessageId?: string | null;
  envelope: string;
  batchId?: string | null;
  chunkIndex?: number | null;
  chunkCount?: number | null;
  status?: "pending" | "dead";
  lastError?: string | null;
}

export interface SqliteRetryOptions {
  maxAttempts?: number;
  budgetMs?: number;
  minJitterMs?: number;
  maxJitterMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function createWhatsAppEventKey(
  providerConversationId: string,
  providerMessageId: string,
  fromMe: boolean,
): string | null {
  if (!providerMessageId) return null;
  return createHash("sha256")
    .update(`${providerConversationId}\x1f${providerMessageId}\x1f${String(fromMe)}`)
    .digest("hex");
}

function isSqliteContention(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const code = "code" in current ? String(current.code) : "";
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || code.startsWith("SQLITE_BUSY_")) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Runs SQLite writes within the gateway's five-attempt, five-second contention budget. */
export async function withBoundedSqliteRetry<T>(
  db: WhatsAppInboundDb,
  operation: (remainingBudgetMs: number) => Promise<T>,
  options: SqliteRetryOptions = {},
): Promise<T> {
  if (isPg(db)) return operation(Number.POSITIVE_INFINITY);

  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 5, 5));
  const budgetMs = Math.max(1, Math.min(options.budgetMs ?? 5_000, 5_000));
  const minJitterMs = Math.max(50, Math.min(options.minJitterMs ?? 50, 250));
  const maxJitterMs = Math.max(minJitterMs, Math.min(options.maxJitterMs ?? 250, 250));
  const now = options.now ?? performance.now.bind(performance);
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  const busyTimeoutResult = await sql<{ timeout: number }>`PRAGMA busy_timeout`.execute(db);
  const originalBusyTimeout = Number(busyTimeoutResult.rows[0]?.timeout ?? 0);
  let lastContentionError: unknown;

  try {
    for (let attempt = 1; ; attempt += 1) {
      const remainingBeforeAttempt = Math.max(0, budgetMs - (now() - startedAt));
      if (remainingBeforeAttempt <= 0) throw lastContentionError ?? new Error("SQLite retry budget exhausted");
      const attemptBusyTimeout = Math.min(originalBusyTimeout, Math.floor(remainingBeforeAttempt));
      await sql.raw(`PRAGMA busy_timeout = ${attemptBusyTimeout}`).execute(db);

      try {
        return await operation(remainingBeforeAttempt);
      } catch (error) {
        const remaining = Math.max(0, budgetMs - (now() - startedAt));
        if (!isSqliteContention(error) || attempt >= maxAttempts || remaining <= 0) throw error;
        lastContentionError = error;
        const jitter = minJitterMs + random() * Math.max(0, maxJitterMs - minJitterMs);
        await sleep(Math.min(jitter, remaining));
      }
    }
  } finally {
    await sql.raw(`PRAGMA busy_timeout = ${originalBusyTimeout}`).execute(db);
  }
}

function truncateError(error: string | null | undefined): string | null {
  return error ? error.slice(0, 1024) : null;
}

function providerTimestampFromEnvelope(envelope: string): string | null {
  try {
    const parsed = JSON.parse(envelope) as { providerTimestamp?: unknown };
    return typeof parsed.providerTimestamp === "string" ? parsed.providerTimestamp : null;
  } catch {
    return null;
  }
}

export function createWhatsAppInboundEventsRepository(db: WhatsAppInboundDb, retryOptions: SqliteRetryOptions = {}) {
  async function findByEventKey(eventKey: string): Promise<WhatsAppInboundEventRow | undefined> {
    return db.selectFrom("whatsapp_inbound_events").selectAll().where("event_key", "=", eventKey).executeTakeFirst();
  }

  async function insertOn(executor: WhatsAppInboundDb, data: WhatsAppInboundEventInsert) {
    if (data.eventKey) {
      const existing = await executor
        .selectFrom("whatsapp_inbound_events")
        .selectAll()
        .where("event_key", "=", data.eventKey)
        .executeTakeFirst();
      if (existing) return { row: existing, inserted: false };
    }

    const oversized = Buffer.byteLength(data.envelope, "utf8") > WHATSAPP_INBOUND_ENVELOPE_MAX_BYTES;
    const status = oversized || data.status === "dead" ? "dead" : "pending";
    const values: Insertable<WhatsAppInboundEventsTable> = {
      kind: data.kind,
      origin: data.origin,
      status,
      event_key: data.eventKey ?? null,
      provider_message_id: data.providerMessageId ?? null,
      envelope: data.envelope,
      batch_id: data.batchId ?? null,
      chunk_index: data.chunkIndex ?? null,
      chunk_count: data.chunkCount ?? null,
      last_error: oversized ? "serialized envelope exceeds 256KB" : truncateError(data.lastError),
    };

    try {
      const inserted = await executor
        .insertInto("whatsapp_inbound_events")
        .values(values)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { row: inserted, inserted: true };
    } catch (error) {
      if (data.eventKey) {
        const existing = await executor
          .selectFrom("whatsapp_inbound_events")
          .selectAll()
          .where("event_key", "=", data.eventKey)
          .executeTakeFirst();
        if (existing) return { row: existing, inserted: false };
      }
      throw error;
    }
  }

  async function insert(data: WhatsAppInboundEventInsert) {
    return withBoundedSqliteRetry(db, () => insertOn(db, data), retryOptions);
  }

  async function insertManyAtomic(data: WhatsAppInboundEventInsert[]) {
    return withBoundedSqliteRetry(
      db,
      () =>
        db.transaction().execute(async (trx) => {
          const results: Array<{ row: WhatsAppInboundEventRow; inserted: boolean }> = [];
          for (const item of data) results.push(await insertOn(trx, item));
          return results;
        }),
      retryOptions,
    );
  }

  async function claim(claimToken: string = randomUUID()): Promise<WhatsAppInboundEventRow[]> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        if (isPg(db)) {
          await sql`
            UPDATE whatsapp_inbound_events
            SET status = CASE WHEN attempts >= ${WHATSAPP_INBOUND_MAX_ATTEMPTS} THEN 'dead' ELSE 'processing' END,
                claim_token = CASE WHEN attempts >= ${WHATSAPP_INBOUND_MAX_ATTEMPTS} THEN NULL ELSE ${claimToken} END,
                claimed_at = CASE WHEN attempts >= ${WHATSAPP_INBOUND_MAX_ATTEMPTS} THEN NULL ELSE CURRENT_TIMESTAMP::text END,
                next_attempt_at = CASE WHEN attempts >= ${WHATSAPP_INBOUND_MAX_ATTEMPTS}
                  THEN CURRENT_TIMESTAMP::text ELSE next_attempt_at END,
                attempts = CASE WHEN attempts >= ${WHATSAPP_INBOUND_MAX_ATTEMPTS} THEN attempts ELSE attempts + 1 END
            WHERE (
                status = 'pending'
                OR (status = 'captured' AND next_attempt_at::timestamptz <= CURRENT_TIMESTAMP)
                OR (status = 'processing' AND claimed_at::timestamptz < CURRENT_TIMESTAMP - INTERVAL '120 seconds')
              )
              AND id IN (
                SELECT id FROM whatsapp_inbound_events
                WHERE (
                    status = 'pending'
                    OR (status = 'captured' AND next_attempt_at::timestamptz <= CURRENT_TIMESTAMP)
                    OR (status = 'processing' AND claimed_at::timestamptz < CURRENT_TIMESTAMP - INTERVAL '120 seconds')
                  )
                ORDER BY id LIMIT ${WHATSAPP_INBOUND_CLAIM_BATCH_SIZE}
              )
          `.execute(db);
        } else {
          await sql`
            UPDATE whatsapp_inbound_events
            SET status = CASE WHEN attempts >= ${WHATSAPP_INBOUND_MAX_ATTEMPTS} THEN 'dead' ELSE 'processing' END,
                claim_token = CASE WHEN attempts >= ${WHATSAPP_INBOUND_MAX_ATTEMPTS} THEN NULL ELSE ${claimToken} END,
                claimed_at = CASE WHEN attempts >= ${WHATSAPP_INBOUND_MAX_ATTEMPTS} THEN NULL ELSE CURRENT_TIMESTAMP END,
                next_attempt_at = CASE WHEN attempts >= ${WHATSAPP_INBOUND_MAX_ATTEMPTS}
                  THEN CURRENT_TIMESTAMP ELSE next_attempt_at END,
                attempts = CASE WHEN attempts >= ${WHATSAPP_INBOUND_MAX_ATTEMPTS} THEN attempts ELSE attempts + 1 END
            WHERE (
                status = 'pending'
                OR (status = 'captured' AND datetime(next_attempt_at) <= CURRENT_TIMESTAMP)
                OR (status = 'processing' AND datetime(claimed_at) < datetime(CURRENT_TIMESTAMP, '-120 seconds'))
              )
              AND id IN (
                SELECT id FROM whatsapp_inbound_events
                WHERE (
                    status = 'pending'
                    OR (status = 'captured' AND datetime(next_attempt_at) <= CURRENT_TIMESTAMP)
                    OR (status = 'processing' AND datetime(claimed_at) < datetime(CURRENT_TIMESTAMP, '-120 seconds'))
                  )
                ORDER BY id LIMIT ${WHATSAPP_INBOUND_CLAIM_BATCH_SIZE}
              )
          `.execute(db);
        }

        const rows = await db
          .selectFrom("whatsapp_inbound_events")
          .selectAll()
          .where("claim_token", "=", claimToken)
          .orderBy("id", "asc")
          .execute();
        return rows.sort((left, right) => {
          const leftTimestamp = providerTimestampFromEnvelope(left.envelope);
          const rightTimestamp = providerTimestampFromEnvelope(right.envelope);
          if (leftTimestamp === rightTimestamp) return left.id - right.id;
          if (leftTimestamp === null) return 1;
          if (rightTimestamp === null) return -1;
          return leftTimestamp.localeCompare(rightTimestamp);
        });
      },
      retryOptions,
    );
  }

  async function markCaptured(id: number, claimToken: string): Promise<boolean> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        const result = await db
          .updateTable("whatsapp_inbound_events")
          .set({ status: "captured", next_attempt_at: sql`CURRENT_TIMESTAMP`, consumed_at: null })
          .where("id", "=", id)
          .where("claim_token", "=", claimToken)
          .where("status", "=", "processing")
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      },
      retryOptions,
    );
  }

  async function markConsumed(id: number, claimToken: string): Promise<boolean> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        const result = await db
          .updateTable("whatsapp_inbound_events")
          .set({ status: "consumed", consumed_at: sql`CURRENT_TIMESTAMP` })
          .where("id", "=", id)
          .where("claim_token", "=", claimToken)
          .where("status", "=", "captured")
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      },
      retryOptions,
    );
  }

  async function revertToCaptured(id: number, claimToken: string, error?: string | null): Promise<boolean> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        const nextAttemptAt = isPg(db)
          ? sql<string>`(
              CURRENT_TIMESTAMP +
              (CASE WHEN attempts >= 5 THEN 900 ELSE (CAST(1 AS bigint) << attempts) * 30 END) * INTERVAL '1 second'
            )::text`
          : sql<string>`datetime(
              CURRENT_TIMESTAMP,
              '+' || (CASE WHEN attempts >= 5 THEN 900 ELSE (1 << attempts) * 30 END) || ' seconds'
            )`;
        const result = await db
          .updateTable("whatsapp_inbound_events")
          .set({
            status: "captured",
            next_attempt_at: nextAttemptAt,
            consumed_at: null,
            last_error: truncateError(error),
          })
          .where("id", "=", id)
          .where("claim_token", "=", claimToken)
          .where("status", "in", ["processing", "captured", "consumed"])
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      },
      retryOptions,
    );
  }

  async function markDead(id: number, claimToken: string, error: string): Promise<boolean> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        const result = await db
          .updateTable("whatsapp_inbound_events")
          .set({ status: "dead", next_attempt_at: sql`CURRENT_TIMESTAMP`, last_error: truncateError(error) })
          .where("id", "=", id)
          .where("claim_token", "=", claimToken)
          .where("status", "in", ["processing", "captured"])
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      },
      retryOptions,
    );
  }

  async function isBatchComplete(batchId: string): Promise<boolean> {
    const row = await db
      .selectFrom("whatsapp_inbound_events")
      .select("id")
      .where("batch_id", "=", batchId)
      .where("status", "not in", ["consumed", "dead"])
      .limit(1)
      .executeTakeFirst();
    return row === undefined;
  }

  async function markConsumedAndCheckBatch(
    id: number,
    claimToken: string,
  ): Promise<{ transitioned: boolean; batchComplete: boolean }> {
    const row = await db
      .selectFrom("whatsapp_inbound_events")
      .select("batch_id")
      .where("id", "=", id)
      .executeTakeFirst();
    const transitioned = await markConsumed(id, claimToken);
    return {
      transitioned,
      batchComplete: transitioned && row?.batch_id ? await isBatchComplete(row.batch_id) : false,
    };
  }

  async function sweep(): Promise<{ consumed: number; dead: number }> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        const consumedCutoff = isPg(db)
          ? sql<boolean>`consumed_at::timestamptz < CURRENT_TIMESTAMP - INTERVAL '24 hours'`
          : sql<boolean>`datetime(consumed_at) < datetime(CURRENT_TIMESTAMP, '-24 hours')`;
        const deadCutoff = isPg(db)
          ? sql<boolean>`next_attempt_at::timestamptz < CURRENT_TIMESTAMP - INTERVAL '7 days'`
          : sql<boolean>`datetime(next_attempt_at) < datetime(CURRENT_TIMESTAMP, '-7 days')`;

        const consumedIds = await db
          .selectFrom("whatsapp_inbound_events")
          .select("id")
          .where("status", "=", "consumed")
          .where(consumedCutoff)
          .orderBy("id")
          .limit(WHATSAPP_INBOUND_SWEEP_BATCH_SIZE)
          .execute();
        const deadIds = await db
          .selectFrom("whatsapp_inbound_events")
          .select("id")
          .where("status", "=", "dead")
          .where(deadCutoff)
          .orderBy("id")
          .limit(WHATSAPP_INBOUND_SWEEP_BATCH_SIZE)
          .execute();

        if (consumedIds.length > 0) {
          await db
            .deleteFrom("whatsapp_inbound_events")
            .where(
              "id",
              "in",
              consumedIds.map((row) => row.id),
            )
            .execute();
        }
        if (deadIds.length > 0) {
          await db
            .deleteFrom("whatsapp_inbound_events")
            .where(
              "id",
              "in",
              deadIds.map((row) => row.id),
            )
            .execute();
        }
        return { consumed: consumedIds.length, dead: deadIds.length };
      },
      retryOptions,
    );
  }

  return {
    insert,
    insertManyAtomic,
    findByEventKey,
    claim,
    markCaptured,
    markConsumed,
    revertToCaptured,
    markDead,
    isBatchComplete,
    markConsumedAndCheckBatch,
    sweep,
  };
}
