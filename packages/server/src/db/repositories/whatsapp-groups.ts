import type { Insertable, Kysely, Selectable } from "kysely";
import type { DB, WhatsAppGroupsTable } from "../schema";

export type WhatsAppGroupRow = Selectable<WhatsAppGroupsTable>;
export type NewWhatsAppGroup = Insertable<WhatsAppGroupsTable>;

export function createWhatsAppGroupRepository(db: Kysely<DB>) {
  return {
    async getByJid(jid: string): Promise<WhatsAppGroupRow | undefined> {
      return db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
    },

    async list(): Promise<WhatsAppGroupRow[]> {
      return db.selectFrom("whatsapp_groups").selectAll().orderBy("updated_at", "desc").execute();
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
