import { decrypt, encrypt } from "../auth/encryption";
import type { ConnectorCredentials } from "./types";

export const MAX_ERROR_MESSAGE_LENGTH = 500;

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

export function parseCredentials(stored: string, encryptionKey?: string): ConnectorCredentials {
  if (stored.startsWith("enc:")) {
    if (!encryptionKey) {
      throw new Error("Encrypted connector credentials found but ENCRYPTION_KEY is not set");
    }
    return JSON.parse(decrypt(stored, encryptionKey)) as ConnectorCredentials;
  }
  return JSON.parse(stored) as ConnectorCredentials;
}

export function serializeCredentials(credentials: ConnectorCredentials, encryptionKey?: string): string {
  const plaintext = JSON.stringify(credentials);
  return encryptionKey ? encrypt(plaintext, encryptionKey) : plaintext;
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
