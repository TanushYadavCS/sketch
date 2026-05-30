/**
 * better-sqlite3 is synchronous, so `await db.x.execute()` only queues a
 * microtask — libuv never gets a turn between iterations. Tight loops of
 * sync-backed awaits therefore starve the event loop and block incoming
 * HTTP requests (e.g. the entity drawer hangs while enrichment runs).
 *
 * `setImmediate` hands control back to the event loop so I/O callbacks
 * (incoming sockets, timers) can fire between iterations. Use this at the
 * end of any `for`/`while` body whose only awaits are SQLite operations.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
