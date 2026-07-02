import { randomUUID } from "node:crypto";
import type { Insertable, Kysely, Selectable } from "kysely";
import type { DB } from "../schema";

export type AgentOutputDeliveryStatus = "pending" | "sent" | "failed";
export type AgentOutputDeliveryRow = Selectable<DB["agent_output_deliveries"]>;

type NewAgentOutputDelivery = Insertable<DB["agent_output_deliveries"]>;

export function createAgentOutputDeliveryRepository(db: Kysely<DB>) {
  return {
    async createAttempt(params: {
      outputId: string;
      platform: string;
      targetType: string;
      targetId: string;
    }): Promise<AgentOutputDeliveryRow> {
      const now = new Date().toISOString();
      const row: NewAgentOutputDelivery = {
        id: randomUUID(),
        agent_output_id: params.outputId,
        platform: params.platform,
        target_type: params.targetType,
        target_id: params.targetId,
        status: "pending",
        created_at: now,
        updated_at: now,
      };
      await db.insertInto("agent_output_deliveries").values(row).execute();
      return db.selectFrom("agent_output_deliveries").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
    },

    async markSent(id: string, messageRefs: string[]): Promise<void> {
      const now = new Date().toISOString();
      await db
        .updateTable("agent_output_deliveries")
        .set({
          status: "sent",
          message_refs_json: JSON.stringify(messageRefs),
          error_message: null,
          sent_at: now,
          updated_at: now,
        })
        .where("id", "=", id)
        .execute();
    },

    async markFailed(id: string, message: string): Promise<void> {
      await db
        .updateTable("agent_output_deliveries")
        .set({
          status: "failed",
          error_message: message,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", id)
        .execute();
    },
  };
}

export type AgentOutputDeliveryRepository = ReturnType<typeof createAgentOutputDeliveryRepository>;
