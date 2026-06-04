import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema";
import { isRoleAccountEmail } from "../../entities/affiliations";
import type { SuppressedEmailRecord } from "../types";
import { classifyBulk } from "./bulk-classifier";
import type { NormalizedEmail } from "./normalized-email";
import { normalizeEmailValue, visibleParticipantEmails } from "./normalized-email";
import { classifyOperational } from "./operational-classifier";
import type { EmailSeedGate } from "./seed-gate";
import { createSeedGate } from "./seed-gate";

export type EmailSuppressionReason = "bulk" | "operational" | "role_account" | "inbound_only" | "missing_counterparty";

export type EmailSuppressionDecision =
  | { suppressed: true; reason: EmailSuppressionReason; detail?: string }
  | { suppressed: false; gate: EmailSeedGate };

export function shouldSuppressEmail(
  email: NormalizedEmail,
  reciprocitySet: ReadonlySet<string>,
): EmailSuppressionDecision {
  const bulk = classifyBulk(email.headers);
  if (bulk.isBulk) return { suppressed: true, reason: "bulk", detail: bulk.reason };

  const operational = classifyOperational(email);
  if (operational.isOperational) return { suppressed: true, reason: "operational", detail: operational.reason };

  const owner = normalizeEmailValue(email.ownerEmail);
  const counterparties = visibleParticipantEmails(email).filter((participant) => participant !== owner);
  if (counterparties.length === 0) return { suppressed: true, reason: "missing_counterparty" };
  if (counterparties.every(isRoleAccountEmail)) return { suppressed: true, reason: "role_account" };

  const reciprocal = counterparties.some((participant) => reciprocitySet.has(participant));
  if (!reciprocal && email.folder === "inbox") return { suppressed: true, reason: "inbound_only" };

  return { suppressed: false, gate: createSeedGate(email, reciprocitySet) };
}

export async function recordSuppressedEmail(
  db: Kysely<DB>,
  input: {
    connectorConfigId: string;
    email: NormalizedEmail;
    reason: EmailSuppressionReason | string;
    observedAt?: string;
  },
): Promise<void> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  await db
    .insertInto("email_suppressed_messages")
    .values({
      id: randomUUID(),
      connector_config_id: input.connectorConfigId,
      provider_file_id: input.email.providerFileId,
      provider_message_id: input.email.providerMessageId,
      thread_id: input.email.threadId,
      reason: input.reason,
      observed_at: observedAt,
    })
    .onConflict((oc) =>
      oc.columns(["connector_config_id", "provider_file_id"]).doUpdateSet({
        provider_message_id: input.email.providerMessageId,
        thread_id: input.email.threadId,
        reason: input.reason,
        observed_at: observedAt,
      }),
    )
    .execute();
}

export async function recordSuppressedEmailRecord(
  db: Kysely<DB>,
  input: {
    connectorConfigId: string;
    record: SuppressedEmailRecord;
    observedAt?: string;
  },
): Promise<void> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  await db
    .insertInto("email_suppressed_messages")
    .values({
      id: randomUUID(),
      connector_config_id: input.connectorConfigId,
      provider_file_id: input.record.providerFileId,
      provider_message_id: input.record.providerMessageId ?? null,
      thread_id: input.record.threadId ?? null,
      reason: input.record.reason,
      observed_at: observedAt,
    })
    .onConflict((oc) =>
      oc.columns(["connector_config_id", "provider_file_id"]).doUpdateSet({
        provider_message_id: input.record.providerMessageId ?? null,
        thread_id: input.record.threadId ?? null,
        reason: input.record.reason,
        observed_at: observedAt,
      }),
    )
    .execute();
}
