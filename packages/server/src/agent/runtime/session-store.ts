import { type Kysely, sql } from "kysely";
import { type AgentMessageRow, createAgentMessagesRepository } from "../../db/repositories/agent-messages";
import type { DB } from "../../db/schema";
import { AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER, readCompactionReplacedPrefixEnd } from "./compaction";
import type { AgentRuntimeMessage, AgentRuntimeSessionStore } from "./contracts";

const CURRENT_TIMESTAMP_TEXT = sql<string>`CAST(CURRENT_TIMESTAMP AS TEXT)`;

function toRuntimeMessage(row: AgentMessageRow): AgentRuntimeMessage {
  return {
    seq: row.seq,
    role: row.role as AgentRuntimeMessage["role"],
    content: row.content,
  };
}

/**
 * A turn only needs rows the reconstruction keeps: the latest compaction marker (whose seq is always above its
 * own replaced-prefix boundary) plus everything appended after that boundary. Rows at or below the boundary are
 * replaced by the marker summary and would be filtered out after loading, so we never read them. Sessions without
 * a marker fall back to a boundary of 0, which loads the full transcript unchanged.
 */
async function resolveTurnLoadBoundary(
  messages: ReturnType<typeof createAgentMessagesRepository>,
  sessionId: string,
): Promise<number> {
  const candidates = await messages.loadContentMatching(sessionId, AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER);
  for (const candidate of candidates) {
    const replacedPrefixEnd = readCompactionReplacedPrefixEnd(candidate.content);
    if (replacedPrefixEnd !== null) return replacedPrefixEnd;
  }
  return 0;
}

/** DB-backed Contract-3 session store over the agent_messages table. */
export function createDbAgentRuntimeSessionStore(db: Kysely<DB>): AgentRuntimeSessionStore {
  const messages = createAgentMessagesRepository(db);

  return {
    async load(sessionId) {
      const boundary = await resolveTurnLoadBoundary(messages, sessionId);
      return (await messages.loadBySessionSince(sessionId, boundary)).map(toRuntimeMessage);
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
