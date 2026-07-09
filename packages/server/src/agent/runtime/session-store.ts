import { type Kysely, sql } from "kysely";
import { type AgentMessageRow, createAgentMessagesRepository } from "../../db/repositories/agent-messages";
import type { DB } from "../../db/schema";
import type { AgentRuntimeMessage, AgentRuntimeSessionStore } from "./contracts";

const CURRENT_TIMESTAMP_TEXT = sql<string>`CAST(CURRENT_TIMESTAMP AS TEXT)`;

function toRuntimeMessage(row: AgentMessageRow): AgentRuntimeMessage {
  return {
    seq: row.seq,
    role: row.role as AgentRuntimeMessage["role"],
    content: row.content,
  };
}

/** DB-backed Contract-3 session store over the agent_messages table. */
export function createDbAgentRuntimeSessionStore(db: Kysely<DB>): AgentRuntimeSessionStore {
  const messages = createAgentMessagesRepository(db);

  return {
    async load(sessionId) {
      return (await messages.loadBySession(sessionId)).map(toRuntimeMessage);
    },

    async appendTransactional(sessionId, batch) {
      await messages.appendBatchAllocatingSeq(
        sessionId,
        batch.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      );
    },

    async archive(params) {
      if (params.sessionId) {
        await db
          .updateTable("chat_sessions")
          .set({ archived_at: CURRENT_TIMESTAMP_TEXT })
          .where("runtime", "=", params.runtime)
          .where("session_id", "=", params.sessionId)
          .where("archived_at", "is", null)
          .execute();
        return;
      }

      await db
        .updateTable("chat_sessions")
        .set({ archived_at: CURRENT_TIMESTAMP_TEXT })
        .where("runtime", "=", params.runtime)
        .where("archived_at", "is", null)
        .$if(params.workspaceKey !== undefined, (qb) => qb.where("workspace_key", "=", params.workspaceKey ?? ""))
        .$if(params.threadKey !== undefined, (qb) => qb.where("thread_key", "=", params.threadKey ?? ""))
        .execute();
    },
  };
}
