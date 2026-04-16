import type { Insertable, Kysely, Selectable } from "kysely";
import type { DB, WhatsAppGroupsTable } from "../schema";

export type WhatsAppGroupRow = Selectable<WhatsAppGroupsTable>;
export type NewWhatsAppGroup = Insertable<WhatsAppGroupsTable>;

export function createWhatsAppGroupRepository(db: Kysely<DB>) {
  return {
    async getByJid(jid: string): Promise<WhatsAppGroupRow | undefined> {
      return db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
    },

    async upsert(group: NewWhatsAppGroup): Promise<WhatsAppGroupRow> {
      await db
        .insertInto("whatsapp_groups")
        .values(group)
        .onConflict((oc) =>
          oc.column("jid").doUpdateSet({
            name: group.name,
            description: group.description ?? null,
            output_style: group.output_style ?? null,
            updated_at: group.updated_at,
          }),
        )
        .execute();

      return db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", group.jid).executeTakeFirstOrThrow();
    },

    async updateOutputStyle(jid: string, outputStyle: string | null): Promise<WhatsAppGroupRow | undefined> {
      await db.updateTable("whatsapp_groups").set({ output_style: outputStyle }).where("jid", "=", jid).execute();
      return db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
    },
  };
}
