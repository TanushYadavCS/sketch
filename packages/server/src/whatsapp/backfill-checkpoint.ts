/**
 * WhatsApp backfill checkpoints are durable progress/status records for
 * observability and ops. Baileys history arrives as passive push, not through a
 * fetch-from-key API; correctness comes from replaying delivered history and
 * idempotent conversation message inserts.
 */
import type { WhatsAppInboundMessage } from "./provider";

const CHECKPOINT_VERSION = "v1";
const TIMESTAMP_WIDTH = 13;

export interface WhatsAppBackfillCheckpointMessage {
  providerTimestamp: string | null;
  providerMessageId: string;
}

/**
 * Encodes a backfill checkpoint as `v1:<epoch_ms_13_digits>:<encoded_provider_message_id>`.
 * The zero-padded millisecond timestamp keeps lexical ordering identical to
 * chronological ordering, and the provider message id provides a deterministic
 * tie-breaker for same-millisecond messages.
 */
export function encodeWhatsAppBackfillCheckpointKey(message: WhatsAppBackfillCheckpointMessage): string | null {
  const timestampMs = message.providerTimestamp ? Date.parse(message.providerTimestamp) : Number.NaN;
  if (!Number.isFinite(timestampMs) || timestampMs < 0 || !message.providerMessageId) return null;
  return [
    CHECKPOINT_VERSION,
    String(timestampMs).padStart(TIMESTAMP_WIDTH, "0"),
    encodeURIComponent(message.providerMessageId),
  ].join(":");
}

export function compareWhatsAppBackfillCheckpointKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function oldestWhatsAppBackfillCheckpointKey(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return compareWhatsAppBackfillCheckpointKeys(left, right) <= 0 ? left : right;
}

export function oldestWhatsAppBackfillCheckpointKeyForMessages(
  messages: WhatsAppBackfillCheckpointMessage[],
): string | null {
  let oldestKey: string | null = null;
  for (const message of messages) {
    oldestKey = oldestWhatsAppBackfillCheckpointKey(oldestKey, encodeWhatsAppBackfillCheckpointKey(message));
  }
  return oldestKey;
}

export function checkpointMessageFromInbound(message: WhatsAppInboundMessage): WhatsAppBackfillCheckpointMessage {
  return {
    providerTimestamp: message.providerTimestamp,
    providerMessageId: message.providerMessageId,
  };
}
