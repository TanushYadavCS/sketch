import type { Insertable, Kysely, Selectable } from "kysely";
import type { DB, WhatsAppGroupMemberLabelsTable, WhatsAppGroupsTable } from "../schema";

export type WhatsAppGroupRow = Selectable<WhatsAppGroupsTable>;
export type NewWhatsAppGroup = Insertable<WhatsAppGroupsTable>;
export type WhatsAppGroupMemberLabelRow = Selectable<WhatsAppGroupMemberLabelsTable>;

export interface WhatsAppGroupIndexingConfig {
  jid: string;
  name: string;
  description: string | null;
  indexEnabled: boolean;
  sliceGapMinutes: number | null;
  sliceMaxAgeMinutes: number | null;
  sliceMaxMessages: number | null;
}

export interface WhatsAppGroupIndexingOverrides {
  sliceGapMinutes?: number | null;
  sliceMaxAgeMinutes?: number | null;
  sliceMaxMessages?: number | null;
}

export interface WhatsAppGroupMemberLabelInput {
  groupJid: string;
  phoneE164: string;
  displayName: string;
  companyName?: string | null;
  createdBy: string;
}

function toIndexingConfig(row: WhatsAppGroupRow): WhatsAppGroupIndexingConfig {
  return {
    jid: row.jid,
    name: row.name,
    description: row.description,
    indexEnabled: row.index_enabled === 1,
    sliceGapMinutes: row.slice_gap_minutes,
    sliceMaxAgeMinutes: row.slice_max_age_minutes,
    sliceMaxMessages: row.slice_max_messages,
  };
}

export function createWhatsAppGroupRepository(db: Kysely<DB>) {
  return {
    async getByJid(jid: string): Promise<WhatsAppGroupRow | undefined> {
      return db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
    },

    async list(): Promise<WhatsAppGroupRow[]> {
      return db.selectFrom("whatsapp_groups").selectAll().orderBy("updated_at", "desc").execute();
    },

    async getIndexingConfig(jid: string): Promise<WhatsAppGroupIndexingConfig | undefined> {
      const row = await db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
      return row ? toIndexingConfig(row) : undefined;
    },

    async listIndexEnabled(): Promise<WhatsAppGroupIndexingConfig[]> {
      const rows = await db
        .selectFrom("whatsapp_groups")
        .selectAll()
        .where("index_enabled", "=", 1)
        .orderBy("updated_at", "desc")
        .execute();
      return rows.map(toIndexingConfig);
    },

    async upsert(group: NewWhatsAppGroup): Promise<WhatsAppGroupRow> {
      await db
        .insertInto("whatsapp_groups")
        .values(group)
        .onConflict((oc) =>
          oc.column("jid").doUpdateSet({
            name: group.name,
            description: group.description ?? null,
            tool_progress: group.tool_progress ?? null,
            reasoning_text: group.reasoning_text ?? null,
            updated_at: group.updated_at,
          }),
        )
        .execute();

      return db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", group.jid).executeTakeFirstOrThrow();
    },

    async updateProgressSettings(
      jid: string,
      settings: { toolProgress?: string | null; reasoningText?: boolean | null },
    ): Promise<WhatsAppGroupRow | undefined> {
      const values: Record<string, unknown> = {};
      if (settings.toolProgress !== undefined) values.tool_progress = settings.toolProgress;
      if (settings.reasoningText !== undefined) {
        values.reasoning_text = settings.reasoningText == null ? null : settings.reasoningText ? 1 : 0;
      }
      if (Object.keys(values).length > 0) {
        await db.updateTable("whatsapp_groups").set(values).where("jid", "=", jid).execute();
      }
      return db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
    },

    async setIndexEnabled(
      jid: string,
      enabled: boolean,
      overrides: WhatsAppGroupIndexingOverrides = {},
    ): Promise<WhatsAppGroupIndexingConfig | undefined> {
      const values: Record<string, unknown> = { index_enabled: enabled ? 1 : 0 };
      if (overrides.sliceGapMinutes !== undefined) values.slice_gap_minutes = overrides.sliceGapMinutes;
      if (overrides.sliceMaxAgeMinutes !== undefined) values.slice_max_age_minutes = overrides.sliceMaxAgeMinutes;
      if (overrides.sliceMaxMessages !== undefined) values.slice_max_messages = overrides.sliceMaxMessages;
      await db.updateTable("whatsapp_groups").set(values).where("jid", "=", jid).execute();
      const row = await db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
      return row ? toIndexingConfig(row) : undefined;
    },

    async upsertMemberLabel(input: WhatsAppGroupMemberLabelInput): Promise<WhatsAppGroupMemberLabelRow> {
      await db
        .insertInto("whatsapp_group_member_labels")
        .values({
          group_jid: input.groupJid,
          phone_e164: input.phoneE164,
          display_name: input.displayName,
          company_name: input.companyName ?? null,
          created_by: input.createdBy,
        })
        .onConflict((oc) =>
          oc.columns(["group_jid", "phone_e164"]).doUpdateSet({
            display_name: input.displayName,
            company_name: input.companyName ?? null,
            created_by: input.createdBy,
          }),
        )
        .execute();

      return db
        .selectFrom("whatsapp_group_member_labels")
        .selectAll()
        .where("group_jid", "=", input.groupJid)
        .where("phone_e164", "=", input.phoneE164)
        .executeTakeFirstOrThrow();
    },

    async getMemberLabel(groupJid: string, phoneE164: string): Promise<WhatsAppGroupMemberLabelRow | undefined> {
      return db
        .selectFrom("whatsapp_group_member_labels")
        .selectAll()
        .where("group_jid", "=", groupJid)
        .where("phone_e164", "=", phoneE164)
        .executeTakeFirst();
    },

    async listMemberLabels(groupJid: string): Promise<WhatsAppGroupMemberLabelRow[]> {
      return db
        .selectFrom("whatsapp_group_member_labels")
        .selectAll()
        .where("group_jid", "=", groupJid)
        .orderBy("display_name", "asc")
        .orderBy("phone_e164", "asc")
        .execute();
    },

    async deleteMemberLabel(groupJid: string, phoneE164: string): Promise<boolean> {
      const result = await db
        .deleteFrom("whatsapp_group_member_labels")
        .where("group_jid", "=", groupJid)
        .where("phone_e164", "=", phoneE164)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },

    async listJidsByAgent(agentUserId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("whatsapp_groups")
        .select("jid")
        .where("agent_user_id", "=", agentUserId)
        .execute();
      return rows.map((r) => r.jid);
    },

    async listAllAgentBindings(): Promise<Array<{ agentUserId: string; jid: string }>> {
      const rows = await db
        .selectFrom("whatsapp_groups")
        .select(["agent_user_id", "jid"])
        .where("agent_user_id", "is not", null)
        .execute();
      return rows
        .filter((r): r is { agent_user_id: string; jid: string } => r.agent_user_id !== null)
        .map((r) => ({ agentUserId: r.agent_user_id, jid: r.jid }));
    },

    async setAgentForJids(agentUserId: string, jids: string[]): Promise<void> {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("whatsapp_groups")
          .set({ agent_user_id: null })
          .where("agent_user_id", "=", agentUserId)
          .execute();
        if (jids.length === 0) return;
        await trx.updateTable("whatsapp_groups").set({ agent_user_id: agentUserId }).where("jid", "in", jids).execute();
      });
    },
  };
}
