import type { EntityReviewQueueRow } from "@/lib/api";

/**
 * Source-band label for a review row. The Org Review tab groups rows into
 * bands by where the candidate came from.
 *
 * D3 will add a richer `contextLabel` (WhatsApp group subject, connector name).
 * This helper already prefers it, so when the field lands the band labels
 * upgrade with no call-site change. Until then it falls back to the plain
 * `source` / `seed_source` fields ("WHATSAPP", "TRACKER"-style).
 */
export function reviewBandLabel(row: EntityReviewQueueRow): string {
  const contextLabel = (row as { contextLabel?: string | null }).contextLabel;
  if (contextLabel) return contextLabel;
  const raw = row.source ?? row.seed_source;
  if (!raw) return "Other";
  return raw.replace(/_/g, " ").toUpperCase();
}
