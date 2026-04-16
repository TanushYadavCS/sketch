import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema";

export function createChannelRepository(db: Kysely<DB>) {
  return {
    async findBySlackChannelId(slackChannelId: string) {
      return db.selectFrom("channels").selectAll().where("slack_channel_id", "=", slackChannelId).executeTakeFirst();
    },

    async findById(id: string) {
      return db.selectFrom("channels").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async create(data: { slackChannelId: string; name: string; type: string }) {
      const id = randomUUID();
      await db
        .insertInto("channels")
        .values({
          id,
          slack_channel_id: data.slackChannelId,
          name: data.name,
          type: data.type,
        })
        .execute();

      return db.selectFrom("channels").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async update(id: string, data: { name?: string; type?: string; outputStyle?: string | null }) {
      const values: Record<string, unknown> = {};
      if (data.name !== undefined) values.name = data.name;
      if (data.type !== undefined) values.type = data.type;
      if (data.outputStyle !== undefined) values.output_style = data.outputStyle;

      if (Object.keys(values).length > 0) {
        await db.updateTable("channels").set(values).where("id", "=", id).execute();
      }

      return db.selectFrom("channels").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },
  };
}
