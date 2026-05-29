/**
 * In-process single-flight: collapse concurrent calls for the same key into
 * one underlying call. Each key holds a Promise while in flight; on
 * resolution (or rejection) the key is deleted so the next caller can
 * re-trigger if inputs change.
 *
 * Not distributed — multi-instance deployments may briefly double-do work
 * within the same overlap window. Acceptable trade-off vs the complexity
 * of a Redis-backed lock; swap that in without changing call sites if it
 * ever matters.
 */
export interface SingleFlight {
  do<T>(key: string, fn: () => Promise<T>): Promise<T>;
  inFlight(key: string): boolean;
}

export function createSingleFlight(): SingleFlight {
  const inFlight = new Map<string, Promise<unknown>>();

  return {
    do<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key) as Promise<T> | undefined;
      if (existing) return existing;
      const promise = (async () => {
        try {
          return await fn();
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, promise);
      return promise;
    },
    inFlight(key: string): boolean {
      return inFlight.has(key);
    },
  };
}
