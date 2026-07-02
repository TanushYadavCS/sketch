import { randomUUID } from "node:crypto";
import type { Insertable, Kysely, Selectable } from "kysely";
import type { DB, WhatsAppProviderEventsTable } from "../schema";

export type WhatsAppProviderEventRow = Selectable<WhatsAppProviderEventsTable>;

export interface WhatsAppProviderEventInput {
  provider: string;
  providerMessageId?: string | null;
  providerConversationId?: string | null;
  eventType?: string | null;
  status?: string | null;
  failureCode?: string | null;
  failureDetail?: string | null;
  providerTimestamp?: string | null;
  rawProviderPayload?: unknown;
}

export function normalizeWhatsAppProviderEventFamily(input: {
  eventType?: string | null;
  status?: string | null;
}): string {
  const status =
    input.status
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_") ?? "";
  const eventType =
    input.eventType
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_") ?? "";
  const combined = `${eventType}:${status}`;

  if (combined.includes("failed") || combined.includes("fail")) return "failed";
  if (combined.includes("read")) return "read";
  if (combined.includes("delivered")) return "delivered";
  if (combined.includes("replied")) return "replied";
  if (combined.includes("sent")) return "sent";
  return status || eventType || "unknown";
}

export function createWhatsAppProviderEventRepository(db: Kysely<DB>) {
  async function findByDedupeKey(provider: string, dedupeKey: string): Promise<WhatsAppProviderEventRow | undefined> {
    return db
      .selectFrom("whatsapp_provider_events")
      .selectAll()
      .where("provider", "=", provider)
      .where("dedupe_key", "=", dedupeKey)
      .executeTakeFirst();
  }

  return {
    async upsertDeliveryStatus(
      input: WhatsAppProviderEventInput,
    ): Promise<{ row: WhatsAppProviderEventRow; inserted: boolean }> {
      const eventFamily = normalizeWhatsAppProviderEventFamily(input);
      const providerMessageId = input.providerMessageId ?? null;
      const fallbackId = input.providerConversationId ?? input.providerTimestamp ?? input.eventType ?? "unknown";
      const dedupeKey = `${providerMessageId ?? fallbackId}:${eventFamily}`;
      const rawPayloadJson =
        input.rawProviderPayload === undefined ? null : JSON.stringify(input.rawProviderPayload).slice(0, 100_000);
      const now = new Date().toISOString();

      const existing = await findByDedupeKey(input.provider, dedupeKey);
      if (existing) {
        await db
          .updateTable("whatsapp_provider_events")
          .set({
            provider_message_id: providerMessageId,
            provider_conversation_id: input.providerConversationId ?? null,
            event_type: input.eventType ?? null,
            status: input.status ?? null,
            failure_code: input.failureCode ?? null,
            failure_detail: input.failureDetail ?? null,
            provider_timestamp: input.providerTimestamp ?? null,
            raw_payload_json: rawPayloadJson,
            updated_at: now,
          })
          .where("id", "=", existing.id)
          .execute();
        return {
          row: await db
            .selectFrom("whatsapp_provider_events")
            .selectAll()
            .where("id", "=", existing.id)
            .executeTakeFirstOrThrow(),
          inserted: false,
        };
      }

      const values: Insertable<WhatsAppProviderEventsTable> = {
        id: randomUUID(),
        provider: input.provider,
        dedupe_key: dedupeKey,
        provider_message_id: providerMessageId,
        provider_conversation_id: input.providerConversationId ?? null,
        event_family: eventFamily,
        event_type: input.eventType ?? null,
        status: input.status ?? null,
        failure_code: input.failureCode ?? null,
        failure_detail: input.failureDetail ?? null,
        provider_timestamp: input.providerTimestamp ?? null,
        raw_payload_json: rawPayloadJson,
      };

      try {
        await db.insertInto("whatsapp_provider_events").values(values).execute();
        return {
          row: await db
            .selectFrom("whatsapp_provider_events")
            .selectAll()
            .where("id", "=", values.id)
            .executeTakeFirstOrThrow(),
          inserted: true,
        };
      } catch {
        const row = await findByDedupeKey(input.provider, dedupeKey);
        if (row) return { row, inserted: false };
        throw new Error("Failed to record WhatsApp provider event");
      }
    },

    async listRecent(provider?: string, limit = 50): Promise<WhatsAppProviderEventRow[]> {
      let query = db.selectFrom("whatsapp_provider_events").selectAll();
      if (provider) query = query.where("provider", "=", provider);
      return query
        .orderBy("created_at", "desc")
        .limit(Math.max(1, Math.min(limit, 200)))
        .execute();
    },
  };
}
