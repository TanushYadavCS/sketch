import type { Insertable, Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import type { DB, ScheduledTaskBuilderLocksTable, ScheduledTaskConversationsTable } from "../schema";

export type ScheduledTaskConversationRow = Selectable<ScheduledTaskConversationsTable>;
export type ScheduledTaskBuilderLockRow = Selectable<ScheduledTaskBuilderLocksTable>;

export type ScheduledTaskConversationKind = "builder" | "web_chat";

export interface UpsertScheduledTaskConversationInput {
  taskId: string;
  conversationId: string;
  transcriptUserId: string;
  kind: ScheduledTaskConversationKind;
}

export interface ListScheduledTaskConversationOptions {
  includeArchived?: boolean;
  kind?: ScheduledTaskConversationKind;
}

export interface AcquireScheduledTaskBuilderLockInput {
  taskId: string;
  conversationId: string;
  transcriptUserId: string;
  expiresAt: number;
  nowMs: number;
  nowIso: string;
}

export function createScheduledTaskConversationRepository(db: Kysely<DB>) {
  return {
    async upsert(input: UpsertScheduledTaskConversationInput): Promise<ScheduledTaskConversationRow> {
      const values: Insertable<ScheduledTaskConversationsTable> = {
        task_id: input.taskId,
        conversation_id: input.conversationId,
        transcript_user_id: input.transcriptUserId,
        kind: input.kind,
      };

      await db
        .insertInto("scheduled_task_conversations")
        .values(values)
        .onConflict((oc) =>
          oc.columns(["task_id", "conversation_id", "transcript_user_id", "kind"]).doUpdateSet({
            updated_at: sql<string>`CURRENT_TIMESTAMP`,
            last_active_at: sql<string>`CURRENT_TIMESTAMP`,
            archived_at: null,
          }),
        )
        .execute();

      return db
        .selectFrom("scheduled_task_conversations")
        .selectAll()
        .where("task_id", "=", input.taskId)
        .where("conversation_id", "=", input.conversationId)
        .where("transcript_user_id", "=", input.transcriptUserId)
        .where("kind", "=", input.kind)
        .executeTakeFirstOrThrow();
    },

    async listByTaskAndTranscriptUser(
      taskId: string,
      transcriptUserId: string,
      options: ListScheduledTaskConversationOptions = {},
    ): Promise<ScheduledTaskConversationRow[]> {
      let query = db
        .selectFrom("scheduled_task_conversations")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("transcript_user_id", "=", transcriptUserId);

      if (!options.includeArchived) query = query.where("archived_at", "is", null);
      if (options.kind) query = query.where("kind", "=", options.kind);

      return query.orderBy("last_active_at", "desc").orderBy("created_at", "desc").orderBy("kind", "asc").execute();
    },

    async listByTaskConversation(taskId: string, conversationId: string): Promise<ScheduledTaskConversationRow[]> {
      return db
        .selectFrom("scheduled_task_conversations")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("conversation_id", "=", conversationId)
        .orderBy("transcript_user_id", "asc")
        .orderBy("kind", "asc")
        .execute();
    },

    async listByTaskConversationForTranscriptUser(
      taskId: string,
      conversationId: string,
      transcriptUserId: string,
      options: { includeArchived?: boolean } = {},
    ): Promise<ScheduledTaskConversationRow[]> {
      let query = db
        .selectFrom("scheduled_task_conversations")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("conversation_id", "=", conversationId)
        .where("transcript_user_id", "=", transcriptUserId);

      if (!options.includeArchived) query = query.where("archived_at", "is", null);

      return query.orderBy("kind", "asc").execute();
    },

    async setArchivedForTaskConversation(
      taskId: string,
      conversationId: string,
      transcriptUserId: string,
      archived: boolean,
    ): Promise<boolean> {
      const result = await db
        .updateTable("scheduled_task_conversations")
        .set({
          archived_at: archived ? sql<string>`CURRENT_TIMESTAMP` : null,
          updated_at: sql<string>`CURRENT_TIMESTAMP`,
          ...(archived ? {} : { last_active_at: sql<string>`CURRENT_TIMESTAMP` }),
        })
        .where("task_id", "=", taskId)
        .where("conversation_id", "=", conversationId)
        .where("transcript_user_id", "=", transcriptUserId)
        .executeTakeFirst();

      return (result.numUpdatedRows ?? 0n) > 0n;
    },

    async getBuilderLock(taskId: string): Promise<ScheduledTaskBuilderLockRow | undefined> {
      return db.selectFrom("scheduled_task_builder_locks").selectAll().where("task_id", "=", taskId).executeTakeFirst();
    },

    async acquireBuilderLock(
      input: AcquireScheduledTaskBuilderLockInput,
    ): Promise<{ acquired: boolean; lock: ScheduledTaskBuilderLockRow }> {
      await db
        .insertInto("scheduled_task_builder_locks")
        .values({
          task_id: input.taskId,
          conversation_id: input.conversationId,
          transcript_user_id: input.transcriptUserId,
          acquired_at: input.nowIso,
          renewed_at: input.nowIso,
          expires_at: input.expiresAt,
        })
        .onConflict((oc) => oc.column("task_id").doNothing())
        .execute();

      const result = await db
        .updateTable("scheduled_task_builder_locks")
        .set({
          conversation_id: input.conversationId,
          transcript_user_id: input.transcriptUserId,
          acquired_at: input.nowIso,
          renewed_at: input.nowIso,
          expires_at: input.expiresAt,
        })
        .where("task_id", "=", input.taskId)
        .where((eb) =>
          eb.or([
            eb("expires_at", "<=", input.nowMs),
            eb.and([
              eb("conversation_id", "=", input.conversationId),
              eb("transcript_user_id", "=", input.transcriptUserId),
            ]),
          ]),
        )
        .executeTakeFirst();

      const lock = await db
        .selectFrom("scheduled_task_builder_locks")
        .selectAll()
        .where("task_id", "=", input.taskId)
        .executeTakeFirstOrThrow();
      return { acquired: Number(result.numUpdatedRows ?? 0) > 0, lock };
    },

    async releaseBuilderLock(taskId: string, conversationId: string, transcriptUserId: string): Promise<boolean> {
      const result = await db
        .deleteFrom("scheduled_task_builder_locks")
        .where("task_id", "=", taskId)
        .where("conversation_id", "=", conversationId)
        .where("transcript_user_id", "=", transcriptUserId)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },

    async deleteByTaskId(taskId: string): Promise<void> {
      await db.deleteFrom("scheduled_task_conversations").where("task_id", "=", taskId).execute();
      await db.deleteFrom("scheduled_task_builder_locks").where("task_id", "=", taskId).execute();
    },
  };
}
