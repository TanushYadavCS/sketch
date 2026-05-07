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

    async update(
      id: string,
      data: {
        name?: string;
        type?: string;
        toolProgress?: string | null;
        reasoningText?: boolean | null;
        agentUserId?: string | null;
      },
    ) {
      const values: Record<string, unknown> = {};
      if (data.name !== undefined) values.name = data.name;
      if (data.type !== undefined) values.type = data.type;
      if (data.toolProgress !== undefined) values.tool_progress = data.toolProgress;
      if (data.reasoningText !== undefined)
        values.reasoning_text = data.reasoningText == null ? null : data.reasoningText ? 1 : 0;
      if (data.agentUserId !== undefined) values.agent_user_id = data.agentUserId;

      if (Object.keys(values).length > 0) {
        await db.updateTable("channels").set(values).where("id", "=", id).execute();
      }

      return db.selectFrom("channels").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async upsertBySlackChannelId(data: { slackChannelId: string; name: string; type: string }) {
      const existing = await db
        .selectFrom("channels")
        .selectAll()
        .where("slack_channel_id", "=", data.slackChannelId)
        .executeTakeFirst();
      if (existing) return existing;
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

    async listSlackChannelIdsByAgent(agentUserId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("channels")
        .select("slack_channel_id")
        .where("agent_user_id", "=", agentUserId)
        .execute();
      return rows.map((r) => r.slack_channel_id);
    },

    async listAllSlackChannelBindings(): Promise<Array<{ agentUserId: string; slackChannelId: string }>> {
      const rows = await db
        .selectFrom("channels")
        .select(["agent_user_id", "slack_channel_id"])
        .where("agent_user_id", "is not", null)
        .execute();
      return rows
        .filter((r): r is { agent_user_id: string; slack_channel_id: string } => r.agent_user_id !== null)
        .map((r) => ({ agentUserId: r.agent_user_id, slackChannelId: r.slack_channel_id }));
    },

    async setAgentForSlackChannelIds(agentUserId: string, slackChannelIds: string[]): Promise<void> {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("channels")
          .set({ agent_user_id: null })
          .where("agent_user_id", "=", agentUserId)
          .execute();
        if (slackChannelIds.length === 0) return;
        await trx
          .updateTable("channels")
          .set({ agent_user_id: agentUserId })
          .where("slack_channel_id", "in", slackChannelIds)
          .execute();
      });
    },
  };
}
