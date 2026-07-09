import type { Insertable, Kysely, Selectable } from "kysely";
import type { AgentMessagesTable, DB } from "../schema";

export type AgentMessageRow = Omit<Selectable<AgentMessagesTable>, "content"> & { content: unknown };
export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessageInsert {
  sessionId: string;
  seq: number;
  role: AgentMessageRole;
  content: unknown;
  createdAt?: string;
}

export interface AgentMessageAppend {
  role: AgentMessageRole;
  content: unknown;
  createdAt?: string;
}

function serializeContent(content: unknown): string {
  return JSON.stringify(content) ?? "null";
}

function parseContent(content: string): unknown {
  return JSON.parse(content) as unknown;
}

function toRow(row: Selectable<AgentMessagesTable>): AgentMessageRow {
  return { ...row, content: parseContent(row.content) };
}

function toInsert(message: AgentMessageInsert): Insertable<AgentMessagesTable> {
  return {
    session_id: message.sessionId,
    seq: message.seq,
    role: message.role,
    content: serializeContent(message.content),
    ...(message.createdAt ? { created_at: message.createdAt } : {}),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique constraint") || message.includes("duplicate key");
}

export function createAgentMessagesRepository(db: Kysely<DB>) {
  return {
    async appendBatch(messages: readonly AgentMessageInsert[]): Promise<void> {
      if (messages.length === 0) return;

      await db.transaction().execute(async (trx) => {
        await trx.insertInto("agent_messages").values(messages.map(toInsert)).execute();
      });
    },

    async appendBatchAllocatingSeq(sessionId: string, messages: readonly AgentMessageAppend[]): Promise<void> {
      if (messages.length === 0) return;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await db.transaction().execute(async (trx) => {
            const row = await trx
              .selectFrom("agent_messages")
              .select((eb) => eb.fn.max<number>("seq").as("max_seq"))
              .where("session_id", "=", sessionId)
              .executeTakeFirst();
            const nextSeq = Number(row?.max_seq ?? 0) + 1;

            await trx
              .insertInto("agent_messages")
              .values(
                messages.map((message, index) =>
                  toInsert({
                    sessionId,
                    seq: nextSeq + index,
                    role: message.role,
                    content: message.content,
                    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
                  }),
                ),
              )
              .execute();
          });
          return;
        } catch (error) {
          if (attempt === 2 || !isUniqueConstraintError(error)) throw error;
        }
      }
    },

    async loadBySession(sessionId: string): Promise<AgentMessageRow[]> {
      const rows = await db
        .selectFrom("agent_messages")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc")
        .execute();
      return rows.map(toRow);
    },
  };
}
