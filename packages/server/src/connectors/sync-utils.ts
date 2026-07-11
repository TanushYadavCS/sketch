import { yieldToEventLoop } from "../lib/event-loop";
import type { ConnectorCredentials } from "./types";

export const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Default batch size for splitting id/key lists that feed SQL `IN (...)` clauses.
 * SQLite caps a prepared statement at 32,766 bound variables, and whole-run sync
 * accumulators (created file ids, seen identity keys) can hold 100k+ entries on an
 * initial full sync. 500 stays well under the limit while keeping each synchronous
 * better-sqlite3 prepare cheap.
 */
export const IN_CLAUSE_CHUNK_SIZE = 500;

/**
 * Split an array into fixed-size chunks (the last chunk holds the remainder).
 * Callers feed each chunk to a separate query so a large id/key set never
 * overflows SQLite's bound-variable limit in a single `IN (...)`.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Run `handler` over `items` in `IN_CLAUSE_CHUNK_SIZE` batches, yielding to the
 * event loop *between* batches (never after the last). Only a genuinely long,
 * multi-batch loop pays the yield; a single-batch call — the common small sync —
 * runs straight through. The yield keeps synchronous better-sqlite3 queries from
 * starving the HTTP server during a large sweep.
 */
export async function forEachChunk<T>(
  items: readonly T[],
  handler: (batch: T[]) => Promise<void>,
  size: number = IN_CLAUSE_CHUNK_SIZE,
): Promise<void> {
  const batches = chunk(items, size);
  for (let i = 0; i < batches.length; i++) {
    await handler(batches[i]);
    if (i < batches.length - 1) await yieldToEventLoop();
  }
}

/**
 * Extract a useful error message from fetch/network errors.
 * Node.js fetch errors bury the real cause inside err.cause, so this pulls it
 * out for operator-facing connector status.
 */
export function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const cause = "cause" in err && err.cause instanceof Error ? err.cause.message : null;
  if (cause && err.message !== cause) {
    return `${err.message} (${cause})`;
  }
  return err.message;
}

/**
 * Cap persisted upstream errors so a large HTML error body cannot break the
 * connectors UI when it renders config.error_message.
 */
export function truncateErrorMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_ERROR_MESSAGE_LENGTH ? `${collapsed.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : collapsed;
}

export function parseCredentials(raw: string): ConnectorCredentials {
  return JSON.parse(raw) as ConnectorCredentials;
}

export function serializeCredentials(credentials: ConnectorCredentials): string {
  return JSON.stringify(credentials);
}

/**
 * Bounded-concurrency runner with Promise.allSettled-style isolation: one item
 * failing inside the worker does not stop the other workers from draining.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(limit, queue.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) return;
          await worker(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

/**
 * Bounded-concurrency async generator: runs `worker` over `items` with at most
 * `limit` in flight and yields each worker's result as soon as that worker
 * settles, instead of buffering the whole result set before the first yield.
 *
 * This exists for connectors whose per-item payload is large (e.g. Teams meeting
 * transcripts): the single shared event loop must not hold the entire corpus in
 * memory before the sync pipeline consumes the first item. Results are yielded
 * in completion order, not input order.
 *
 * Error semantics differ from {@link runWithConcurrency}: a rejected worker is
 * surfaced by throwing out of the generator (aborting the run), matching the
 * fail-the-run behavior connectors relied on when a non-recoverable upstream
 * error propagated out of the concurrent phase. Workers that must be isolated
 * should catch their own recoverable errors before returning.
 */
export async function* streamWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  if (items.length === 0) return;
  const queue = [...items];
  const boundedLimit = Math.max(1, Math.min(limit, queue.length));
  type Settled = { id: symbol; ok: true; value: R } | { id: symbol; ok: false; error: unknown };
  const executing = new Map<symbol, Promise<Settled>>();

  const launch = (item: T): void => {
    const id = Symbol();
    executing.set(
      id,
      worker(item).then(
        (value): Settled => ({ id, ok: true, value }),
        (error): Settled => ({ id, ok: false, error }),
      ),
    );
  };

  for (let i = 0; i < boundedLimit; i++) {
    const item = queue.shift();
    if (item !== undefined) launch(item);
  }

  while (executing.size > 0) {
    const settled = await Promise.race(executing.values());
    executing.delete(settled.id);
    const next = queue.shift();
    if (next !== undefined) launch(next);
    if (!settled.ok) throw settled.error;
    yield settled.value;
  }
}
