import { randomUUID } from "node:crypto";
import type { Insertable, Kysely, Selectable } from "kysely";
import type { DB, WhatsAppTemplateMappingsTable } from "../schema";

export const DEFAULT_WHATSAPP_TEMPLATE_LANGUAGE = "en_US";

export type WhatsAppTemplateMappingRow = Selectable<WhatsAppTemplateMappingsTable>;

export interface WhatsAppTemplateMappingInput {
  provider: string;
  logicalKey: string;
  providerTemplateName: string;
  language?: string | null;
  status?: string | null;
  category?: string | null;
  parameterMap?: Record<string, string> | null;
}

export interface ProviderTemplateSummary {
  providerTemplateName: string;
  language: string;
  status: string | null;
  category: string | null;
  rawProviderPayload?: unknown;
}

function normalizeLanguage(value: string | null | undefined): string {
  return value?.trim() || DEFAULT_WHATSAPP_TEMPLATE_LANGUAGE;
}

function normalizeStatus(value: string | null | undefined): string {
  return value?.trim().toLowerCase() || "approved";
}

function parseParameterMap(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
    );
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

function toMapping(row: WhatsAppTemplateMappingRow) {
  return {
    ...row,
    parameterMap: parseParameterMap(row.parameter_map_json),
  };
}

export function createWhatsAppTemplateMappingRepository(db: Kysely<DB>) {
  async function findByLogicalKey(provider: string, logicalKey: string, language: string) {
    return db
      .selectFrom("whatsapp_template_mappings")
      .selectAll()
      .where("provider", "=", provider)
      .where("logical_key", "=", logicalKey)
      .where("language", "=", language)
      .executeTakeFirst();
  }

  return {
    async upsertMapping(input: WhatsAppTemplateMappingInput): Promise<WhatsAppTemplateMappingRow> {
      const language = normalizeLanguage(input.language);
      const now = new Date().toISOString();
      const parameterMapJson = input.parameterMap ? JSON.stringify(input.parameterMap) : null;
      const existing = await findByLogicalKey(input.provider, input.logicalKey, language);

      if (existing) {
        await db
          .updateTable("whatsapp_template_mappings")
          .set({
            provider_template_name: input.providerTemplateName,
            status: normalizeStatus(input.status),
            category: input.category ?? null,
            parameter_map_json: parameterMapJson,
            updated_at: now,
          })
          .where("id", "=", existing.id)
          .execute();
        return db
          .selectFrom("whatsapp_template_mappings")
          .selectAll()
          .where("id", "=", existing.id)
          .executeTakeFirstOrThrow();
      }

      const values: Insertable<WhatsAppTemplateMappingsTable> = {
        id: randomUUID(),
        provider: input.provider,
        logical_key: input.logicalKey,
        provider_template_name: input.providerTemplateName,
        language,
        status: normalizeStatus(input.status),
        category: input.category ?? null,
        parameter_map_json: parameterMapJson,
        last_synced_at: null,
      };

      try {
        await db.insertInto("whatsapp_template_mappings").values(values).execute();
      } catch {
        const row = await findByLogicalKey(input.provider, input.logicalKey, language);
        if (row) return row;
        throw new Error("Failed to upsert WhatsApp template mapping");
      }

      return db
        .selectFrom("whatsapp_template_mappings")
        .selectAll()
        .where("id", "=", values.id)
        .executeTakeFirstOrThrow();
    },

    async findApprovedMapping(
      provider: string,
      logicalKey: string,
      language?: string | null,
    ): Promise<(WhatsAppTemplateMappingRow & { parameterMap: Record<string, string> | null }) | null> {
      const requestedLanguage = normalizeLanguage(language);
      const exact = await db
        .selectFrom("whatsapp_template_mappings")
        .selectAll()
        .where("provider", "=", provider)
        .where("logical_key", "=", logicalKey)
        .where("language", "=", requestedLanguage)
        .where("status", "=", "approved")
        .orderBy("updated_at", "desc")
        .executeTakeFirst();
      return exact ? toMapping(exact) : null;
    },

    async listMappings(provider?: string): Promise<WhatsAppTemplateMappingRow[]> {
      let query = db.selectFrom("whatsapp_template_mappings").selectAll();
      if (provider) query = query.where("provider", "=", provider);
      return query.orderBy("provider", "asc").orderBy("logical_key", "asc").orderBy("language", "asc").execute();
    },

    async syncProviderTemplates(provider: string, templates: ProviderTemplateSummary[]): Promise<number> {
      let updated = 0;
      const now = new Date().toISOString();

      for (const template of templates) {
        const rows = await db
          .selectFrom("whatsapp_template_mappings")
          .select(["id"])
          .where("provider", "=", provider)
          .where("provider_template_name", "=", template.providerTemplateName)
          .where("language", "=", normalizeLanguage(template.language))
          .execute();

        for (const row of rows) {
          await db
            .updateTable("whatsapp_template_mappings")
            .set({
              status: normalizeStatus(template.status),
              category: template.category ?? null,
              last_synced_at: now,
              updated_at: now,
            })
            .where("id", "=", row.id)
            .execute();
          updated += 1;
        }
      }

      return updated;
    },
  };
}
